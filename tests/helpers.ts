import type { TrafficReport } from '../src/report/report.js';
import { reportForStream } from '../src/run.js';
import { DEFAULT_RULES, type RateRule } from '../src/types.js';

export { DEFAULT_RULES };

/** Small seeded PRNG shared by the randomized tests. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Yield a buffer in small pieces to stress the line splitter's remainder handling. */
export async function* chunked(buf: Buffer, size: number): AsyncIterable<Buffer> {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(i + size, buf.length));
  }
}

/** Run the full pipeline over raw bytes and parse the report. */
export async function reportFor(
  input: Buffer | string,
  opts?: { rules?: RateRule[]; chunkSize?: number },
): Promise<TrafficReport> {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const json = await reportForStream(chunked(buf, opts?.chunkSize ?? 7), {
    rules: opts?.rules ?? DEFAULT_RULES,
    workers: 1,
    pretty: false,
  });
  return JSON.parse(json);
}

export function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

let seq = 0;

export function validLine(overrides: Record<string, unknown> = {}): string {
  return line({
    request_id: `r_${seq++}`,
    timestamp: '2024-01-15T10:00:00Z',
    client_id: 'acct_x',
    endpoint: '/v1/widgets',
    status_code: 200,
    ...overrides,
  });
}
