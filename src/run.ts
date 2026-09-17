import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { Aggregator } from './analysis/aggregate.js';
import { ShardBuilder } from './pipeline/columnar.js';
import { processShard, READ_CHUNK } from './pipeline/shard.js';
import { buildReport } from './report/report.js';
import type { RateRule, ShardResult, WorkerInput } from './types.js';

export interface RunOptions {
  rules: RateRule[];
  workers: number | 'auto';
  pretty: boolean;
}

/** Below this size the worker startup cost outweighs parallel parsing. */
const MIN_BYTES_PER_WORKER = 4 * 1024 * 1024;
export const MAX_WORKERS = 32;

export async function reportForFile(path: string, opts: RunOptions): Promise<string> {
  const { size } = await stat(path);
  const workers = resolveWorkers(opts.workers, size);

  if (workers <= 1) {
    const stream = createReadStream(path, { highWaterMark: READ_CHUNK });
    return reportForStream(stream, opts);
  }

  const spawned: Worker[] = [];
  let results: ShardResult[];
  try {
    results = await Promise.all(
      shardBounds(size, workers).map((bounds, index) => runWorker(path, bounds, index, spawned)),
    );
  } catch (err) {
    // Don't leave sibling workers parsing their full shards after a failure.
    await Promise.allSettled(spawned.map((worker) => worker.terminate()));
    throw err;
  }

  const totalRecords = results.reduce((sum, r) => sum + r.timestamps.length, 0);
  const agg = new Aggregator(totalRecords);
  for (const result of results) agg.addShard(result);
  return buildReport(agg, opts.rules, opts.pretty);
}

/** Sequential path; also serves stdin, which is not seekable. */
export async function reportForStream(
  chunks: AsyncIterable<Buffer>,
  opts: RunOptions,
): Promise<string> {
  const builder = new ShardBuilder();
  await processShard(
    { chunks, streamStart: 0, endOffset: Infinity, skipFirstLine: false, stripBom: true },
    builder,
  );
  const result = builder.finish();
  const agg = new Aggregator(result.timestamps.length);
  agg.addShard(result);
  return buildReport(agg, opts.rules, opts.pretty);
}

function resolveWorkers(requested: number | 'auto', size: number): number {
  if (requested !== 'auto') return Math.max(1, Math.min(requested, MAX_WORKERS));
  const bySize = Math.floor(size / MIN_BYTES_PER_WORKER);
  return Math.max(1, Math.min(bySize, availableParallelism(), MAX_WORKERS));
}

function shardBounds(size: number, workers: number): { start: number; end: number }[] {
  const bounds: { start: number; end: number }[] = [];
  for (let i = 0; i < workers; i++) {
    const start = Math.floor((size * i) / workers);
    const end = Math.floor((size * (i + 1)) / workers);
    // A file smaller than the worker count yields zero-width ranges. Every
    // shard must own at least one byte: only shards with start > 0 skip the
    // partial first line, so a second shard starting at 0 would process the
    // file's first line again.
    if (end > start) bounds.push({ start, end });
  }
  return bounds;
}

function runWorker(
  path: string,
  bounds: { start: number; end: number },
  index: number,
  spawned: Worker[],
): Promise<ShardResult> {
  return new Promise((resolve, reject) => {
    const input: WorkerInput = { path, start: bounds.start, end: bounds.end, index };
    const worker = new Worker(new URL('./pipeline/worker.js', import.meta.url), {
      workerData: input,
    });
    spawned.push(worker);
    worker.once('message', (result: ShardResult) => resolve(result));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`shard worker ${index} exited with code ${code}`));
    });
  });
}
