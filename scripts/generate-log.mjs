#!/usr/bin/env node
// Deterministic synthetic JSONL generator for tests and benchmarks.
// Usage: node scripts/generate-log.mjs <lines> <outfile> [seed]
//
// Produces a realistic mix: many well-behaved clients, two bursting abusers,
// ~1% malformed lines of assorted kinds, ~0.5% duplicate request ids, blank
// lines and CRLF endings. Same (lines, seed) always yields identical bytes.
import { createWriteStream } from 'node:fs';

const lines = Number(process.argv[2] ?? 100_000);
const outfile = process.argv[3] ?? 'generated.jsonl';
const seed = Number(process.argv[4] ?? 42);

// mulberry32 PRNG — small, seeded, deterministic.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const clients = Array.from({ length: 60 }, (_, i) => `acct_${String(i).padStart(3, '0')}`);
const abusers = ['acct_abuser_a', 'acct_abuser_b'];
const endpoints = [
  '/v1/widgets',
  '/v1/reports',
  '/v1/users',
  '/v1/orders',
  '/v2/search',
  '/health',
];
const statuses = [200, 200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 429, 500, 503];

const startMs = Date.UTC(2024, 0, 15, 8, 0, 0);
let clockMs = startMs;
let idCounter = 0;
let lastId = 'seed_0';

function validLine(client, tsMs) {
  const id = `req_${(idCounter++).toString(36)}`;
  lastId = id;
  return JSON.stringify({
    request_id: id,
    timestamp: new Date(tsMs).toISOString().replace('.000Z', 'Z'),
    client_id: client,
    endpoint: pick(endpoints),
    status_code: pick(statuses),
  });
}

const malformedKinds = [
  () => '{"request_id": broken json',
  () => '"just a string"',
  () => JSON.stringify({ request_id: `m_${idCounter++}`, timestamp: '2024-01-15T09:00:00Z' }),
  () =>
    JSON.stringify({
      request_id: `m_${idCounter++}`,
      timestamp: '2024-01-15T09:00:00', // no offset
      client_id: 'acct_bad',
      endpoint: '/v1/widgets',
      status_code: 200,
    }),
  () =>
    JSON.stringify({
      request_id: `m_${idCounter++}`,
      timestamp: '2024-01-15T09:00:00Z',
      client_id: 'acct_bad',
      endpoint: '/v1/widgets',
      status_code: 999,
    }),
  () =>
    JSON.stringify({
      request_id: '',
      timestamp: '2024-01-15T09:00:00Z',
      client_id: 'acct_bad',
      endpoint: '/v1/widgets',
      status_code: 200,
    }),
];

const out = createWriteStream(outfile);
let buffer = '';

for (let i = 0; i < lines; i++) {
  clockMs += Math.floor(rand() * 40); // ~25 req/s aggregate
  const roll = rand();
  let line;
  if (roll < 0.01) {
    line = pick(malformedKinds)();
  } else if (roll < 0.012) {
    line = ''; // blank
  } else if (roll < 0.017) {
    // duplicate of the previous request id, possibly with a different payload
    line = JSON.stringify({
      request_id: lastId,
      timestamp: new Date(clockMs).toISOString(),
      client_id: pick(clients),
      endpoint: pick(endpoints),
      status_code: 200,
    });
  } else if (roll < 0.037) {
    // abuser burst: several requests inside a few hundred ms; never emit more
    // physical lines than the request asked for
    const abuser = pick(abusers);
    const burst = Math.min(4 + Math.floor(rand() * 8), lines - i);
    const parts = [];
    for (let b = 0; b < burst; b++) {
      parts.push(validLine(abuser, clockMs + Math.floor(rand() * 400)));
    }
    i += burst - 1; // the outer loop adds the final increment
    line = parts.join('\n');
  } else {
    line = validLine(pick(clients), clockMs);
  }
  buffer += line + (rand() < 0.02 ? '\r\n' : '\n');
  if (buffer.length > 1 << 20) {
    if (!out.write(buffer)) await new Promise((r) => out.once('drain', r));
    buffer = '';
  }
}
out.end(buffer);
await new Promise((r) => out.once('close', r));
console.error(`wrote ${lines} lines to ${outfile} (seed ${seed})`);
