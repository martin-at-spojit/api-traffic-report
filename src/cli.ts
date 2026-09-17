#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MAX_WORKERS, reportForFile, reportForStream } from './run.js';
import { DEFAULT_RULES, makeRule, type RateRule } from './types.js';

const VERSION = '1.0.0';

const USAGE = `Usage: api-traffic-report <file.jsonl | -> [options]

Reads a JSONL log of API requests and prints one JSON traffic report to stdout.

Options:
  --limit N/W[s|m|h]  Rate-limit rule: "more than N requests in any rolling
                      window of W", e.g. --limit 20/30s or --limit 100/1m.
                      Repeat the flag to check several rules at once. Any
                      --limit replaces the default policy (5/10s + 100/60s).
  --workers N|auto    Worker threads for file input, up to ${MAX_WORKERS}
                      (default: auto, sized from the file). Stdin ("-")
                      always processes single-threaded.
  --compact           Minified JSON output (pretty-printed by default).
  -h, --help          Show this help.
  -v, --version       Show version.

Exit codes: 0 report printed (malformed input lines are data, not errors),
1 runtime failure (unreadable input, worker crash), 2 usage error.`;

const OPTIONS = {
  limit: { type: 'string', multiple: true },
  workers: { type: 'string' },
  compact: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseCliArgs() {
  try {
    return parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };

function parseLimit(raw: string): RateRule {
  const m = /^(\d+)\/(\d+)(s|m|h)$/.exec(raw);
  if (m === null) {
    fail(`invalid --limit "${raw}": expected N/W with unit s, m or h (e.g. 5/10s, 100/1m)`);
  }
  const maxRequests = Number(m[1]);
  const windowSeconds = Number(m[2]) * (UNIT_SECONDS[m[3] as string] as number);
  if (maxRequests < 1 || windowSeconds < 1) {
    fail(`invalid --limit "${raw}": requests and window must be at least 1`);
  }
  return makeRule(maxRequests, windowSeconds);
}

function parseRules(raw: string[] | undefined): RateRule[] {
  if (raw === undefined || raw.length === 0) return DEFAULT_RULES;
  const byId = new Map<string, RateRule>();
  for (const value of raw) {
    const rule = parseLimit(value);
    byId.set(rule.id, rule);
  }
  return [...byId.values()].sort(
    (a, b) => a.windowSeconds - b.windowSeconds || a.maxRequests - b.maxRequests,
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (args.values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.values.version === true) {
    process.stdout.write(`api-traffic-report ${VERSION}\n`);
    return;
  }
  if (args.positionals.length !== 1) {
    fail(USAGE);
  }
  const input = args.positionals[0] as string;

  let workers: number | 'auto' = 'auto';
  if (args.values.workers !== undefined && args.values.workers !== 'auto') {
    workers = Number(args.values.workers);
    if (!Number.isInteger(workers) || workers < 1) {
      fail(`invalid --workers "${args.values.workers}": expected a positive integer or "auto"`);
    }
  }

  const opts = {
    rules: parseRules(args.values.limit),
    workers,
    pretty: args.values.compact !== true,
  };

  try {
    const report =
      input === '-' ? await reportForStream(process.stdin, opts) : await reportForFile(input, opts);
    process.stdout.write(`${report}\n`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      process.stderr.write(`error: file not found: ${input}\n`);
    } else if (e.code === 'EISDIR') {
      process.stderr.write(`error: not a file: ${input}\n`);
    } else if (e.code === 'EACCES') {
      process.stderr.write(`error: permission denied: ${input}\n`);
    } else {
      process.stderr.write(`error: ${e.message}\n`);
    }
    process.exit(1);
  }
}

await main();
