import { createReadStream } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerInput } from '../types.js';
import { ShardBuilder } from './columnar.js';
import { processShard, READ_CHUNK } from './shard.js';

if (parentPort === null) {
  throw new Error('worker.js must be run as a worker thread');
}

const { path, start, end } = workerData as WorkerInput;

// Open one byte early so we can tell whether a line begins exactly at our
// boundary (see ShardIO.skipFirstLine).
const streamStart = start === 0 ? 0 : start - 1;
const stream = createReadStream(path, { start: streamStart, highWaterMark: READ_CHUNK });
const builder = new ShardBuilder();
try {
  await processShard(
    {
      chunks: stream,
      streamStart,
      endOffset: end,
      skipFirstLine: start > 0,
      stripBom: start === 0,
    },
    builder,
  );
} finally {
  stream.destroy();
}

const result = builder.finish();
parentPort.postMessage(result, [
  result.idHashes.buffer,
  result.timestamps.buffer,
  result.clientIdx.buffer,
  result.endpointIdx.buffer,
  result.statusCodes.buffer,
]);
