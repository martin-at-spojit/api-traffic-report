#!/usr/bin/env node
// Reproducible throughput benchmark: generates a synthetic log, then times the
// CLI at several worker counts. Usage: node scripts/bench.mjs [lines]
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const lines = Number(process.argv[2] ?? 2_000_000);
const here = new URL('.', import.meta.url).pathname;
const cli = join(here, '..', 'dist', 'cli.js');
const generator = join(here, 'generate-log.mjs');

const dir = await mkdtemp(join(tmpdir(), 'atr-bench-'));
const file = join(dir, 'bench.jsonl');
try {
  console.error(`generating ${lines.toLocaleString()} lines...`);
  await execFile(process.execPath, [generator, String(lines), file, '42'], {
    maxBuffer: 1 << 20,
  });
  const { size } = await stat(file);
  const mb = size / (1024 * 1024);
  console.error(`input: ${mb.toFixed(0)} MiB, ${availableParallelism()} cores available\n`);

  const counts = [...new Set([1, 2, 4, 8, availableParallelism()])].sort((a, b) => a - b);
  let baseline = 0;
  for (const workers of counts) {
    // Warm-up pass, then two timed passes; report the faster one.
    let best = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const start = process.hrtime.bigint();
      await execFile(process.execPath, [cli, file, '--workers', String(workers), '--compact'], {
        maxBuffer: 256 * 1024 * 1024,
      });
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      if (pass > 0 && seconds < best) best = seconds;
    }
    if (workers === 1) baseline = best;
    const rate = lines / best;
    console.log(
      `workers=${String(workers).padStart(2)}  ${best.toFixed(2)}s  ` +
        `${(rate / 1e6).toFixed(2)}M lines/s  ${(mb / best).toFixed(0)} MiB/s  ` +
        `speedup ${(baseline / best).toFixed(2)}x`,
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
