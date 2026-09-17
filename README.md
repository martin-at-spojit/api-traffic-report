# api-traffic-report

A command-line tool that reads a log of API requests (one JSON object per line) and prints a
single JSON report to stdout. The report shows which clients broke the rate limits, how much
traffic each client and endpoint saw, and how many input lines were malformed.

It is built to run unattended as a platform service. Bad input never crashes it, the same input
always produces the same output byte for byte, and large files are spread across CPU cores.

## Running it

Requires **Node.js 22.12 or newer** (developed and tested on Node 24). No runtime dependencies.

```sh
pnpm install        # dev dependencies only (TypeScript, Vitest, Biome)
pnpm build          # compiles to dist/
node dist/cli.js sample_input/requests.jsonl
```

Give it `-` instead of a filename to read from standard input. That lets the tool sit at the
end of a shell pipeline where no file exists on disk, for example when logs arrive compressed,
need filtering first, or span several files:

```sh
zcat requests-2024-01.jsonl.gz | node dist/cli.js -
grep '"client_id":"acct_42"' requests.jsonl | node dist/cli.js -
cat day1.jsonl day2.jsonl | node dist/cli.js -
```

### Options

```
Usage: api-traffic-report <file.jsonl | -> [options]

  --limit N/W[s|m|h]  Rate-limit rule: "more than N requests in any rolling
                      window of W", e.g. --limit 20/30s or --limit 100/1m.
                      Repeat the flag to check several rules at once. Any
                      --limit replaces the default policy (5/10s + 100/60s).
  --workers N|auto    Worker threads for file input, up to 32
                      (default: auto, sized from the file). Stdin ("-")
                      always processes single-threaded.
  --compact           Minified JSON output (pretty-printed by default).
  -h, --help          Show help.
  -v, --version       Show version.
```

Exit codes: **0** means the report was printed (malformed lines are expected data, not an
error), **1** means the input couldn't be read, **2** means the command line was wrong. When a
report is produced it is the only thing written to stdout, and problems are described on
stderr. The usual exceptions apply: `--help` and `--version` print their text to stdout.

### Custom rate limits

A rule is written as `N/W` with a unit for the window: `s` for seconds, `m` for minutes, `h`
for hours. `--limit 20/30s` means "flag a client that makes more than 20 requests in any
rolling 30 seconds".

```sh
# One custom rule
node dist/cli.js requests.jsonl --limit 20/30s

# Several rules at once: repeat the flag. Each rule is checked independently
# and violations are reported per rule.
node dist/cli.js requests.jsonl --limit 5/10s --limit 100/1m --limit 5000/1h
```

Two things to know. Custom rules replace the default policy entirely, so restate `5/10s` if
you still want the default burst rule alongside your own. Windows are normalised to seconds in
the report, so `--limit 100/1m` shows up as rule `100/60s`.

## How it works

The file is split into equal-sized chunks, one per CPU core. Each chunk goes to a worker thread
that does the heavy lifting: decode the bytes, split them into lines, check each line (valid
JSON? all five fields present and sensible? timestamp readable?), and pack the good records into
flat arrays of numbers, which are cheap to hand back to the main thread. The main thread then
combines the workers' results in file order, drops duplicate requests, and checks every client's
request times against the rate limits.

Two details carry the correctness of the parallel mode:

- **Chunk edges.** A split point usually lands in the middle of a line, so the rule is that a
  line belongs to the chunk where it starts. Each worker skips the partial line at its start
  (the previous worker finishes it) and reads past its end to complete its own last line. Every
  line is processed exactly once, wherever the split points fall.
- **Same answer at any worker count.** Because results are combined in file order,
  "first occurrence wins" deduplication and the line numbers in the report's examples come out
  exactly as a single-threaded run would produce them. A test asserts that 1, 4 and 9 workers
  produce byte-identical reports.

Small files and stdin skip the workers and run the same code single-threaded, so there is one
code path to trust.

### Code layout

The source tree mirrors those stages. The root holds the entry point, the wiring and the shared
types:

```
src/
  cli.ts           argument parsing, usage, exit-code mapping
  run.ts           wiring: chunking, worker fan-out, single-threaded path
  types.ts         shared types, including the worker-to-main-thread result shape
  pipeline/        bytes → checked records (runs inside workers)
    shard.ts         chunk reading, line splitting, size caps, UTF-8 handling
    parse.ts         JSON shape and field validation
    timestamp.ts     strict RFC 3339 timestamp parser
    hash64.ts        request-id fingerprinting for duplicate detection
    columnar.ts      packs a chunk's records into flat arrays
    worker.ts        worker-thread entry
  analysis/        records → totals (main thread)
    aggregate.ts     ordered combining, dedup, count merging
    ratelimit.ts     rolling-window rate-limit check
  report/
    report.ts        deterministic report assembly
```

## The rate-limit rules, and why

This report looks backwards at what clients actually did. It is monitoring, not enforcement,
and that shapes the design:

- **A rolling window, not fixed buckets.** A rule reads "more than 5 requests in _any_
  10-second span". The cheaper alternative of cutting time into fixed 10-second buckets and
  counting within each misses real bursts. 10 requests in one second can land half in one
  bucket and half in the next, and each half stays under the limit. An offline report can
  afford the exact check.
- **Per client, not per endpoint.** The brief asks to identify _clients_ who violate, and a
  per-client limit can't be evaded by spreading requests across endpoints.
- **Errors count too.** A request that returned 4xx or 5xx still consumed capacity, and a
  client generating heavy error traffic is exactly who this report should surface.
- **The numbers are settings.** Real products range from 5,000 requests per hour to 100 per
  second, so no fixed threshold is universally "reasonable". The tool owns the mechanism and
  ships an overridable default policy of two rules, the way API gateways usually express
  limits:
  - **burst**, more than 5 requests in any rolling 10 seconds;
  - **sustained**, more than 100 requests in any rolling 60 seconds. This catches the client
    that sends 2 requests every second all day. It never trips the burst rule but still makes
    7,000 requests an hour.

Where do 5 and 10 come from? The brief leaves the numbers open, but the sample input pins the
intent. `acct_1` sends 6 requests in 8 seconds and reads as the client that should be flagged,
while `acct_2` (2 requests in 5 seconds) should pass. Any demonstrable burst rule must sit
between those two behaviours, and "5 in 10 seconds" is the round rule in that range. Override
with repeatable `--limit` flags, e.g. `--limit 10/1s --limit 1000/1h`.

Edge cases are pinned by tests. Two requests exactly 10 seconds apart do **not** share a
window, and requests with identical timestamps are counted in the order they appear. Each
violation is reported with evidence: the busiest window observed, how many requests were over
the limit, and when the violations started and stopped. The report hands an operator a case
file rather than a bare verdict.

## Output specification

One JSON object (pretty-printed by default; `--compact` for pipelines). All timestamps are UTC
RFC 3339 with milliseconds. `schema_version` is bumped on breaking shape changes so downstream
consumers can detect them.

| Field                                          | Meaning                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`                               | `"1.0"`                                                                                                                                                                                                             |
| `summary.lines_read`                           | Physical lines in the input                                                                                                                                                                                         |
| `summary.valid_requests`                       | Valid requests after duplicate removal                                                                                                                                                                              |
| `summary.malformed_lines`                      | Lines discarded as malformed                                                                                                                                                                                        |
| `summary.blank_lines`                          | Empty or whitespace-only lines (tracked separately, not malformed)                                                                                                                                                  |
| `summary.duplicate_lines`                      | Valid-looking lines dropped because their `request_id` was already seen                                                                                                                                             |
| `summary.unique_clients` / `unique_endpoints`  | Distinct values among counted requests                                                                                                                                                                              |
| `summary.first_request_at` / `last_request_at` | Time range of counted requests (`null` if none)                                                                                                                                                                     |
| `rate_limit.rules[]`                           | The evaluated policy: `rule` (its id, e.g. `"5/10s"`), `max_requests`, `window_seconds`, `scope`                                                                                                                    |
| `rate_limit.violating_client_count`            | Clients that violated at least one rule                                                                                                                                                                             |
| `rate_limit.violations[]`                      | One entry per client and rule: total `requests`, `peak_requests_in_window` (busiest window observed), `excess_requests` (requests over the limit), `first_violation_at`, `last_violation_at`. Worst offenders first |
| `traffic.by_client[]`                          | Per client: request count and status-code breakdown, busiest first                                                                                                                                                  |
| `traffic.by_endpoint[]`                        | Per endpoint (path reported verbatim): request count, `unique_clients`, status codes; busiest first                                                                                                                 |
| `traffic.by_status_code`                       | Status-code totals across all requests                                                                                                                                                                              |
| `malformed.count` / `by_reason` / `examples[]` | Exact counts per rejection reason; first 20 examples as `{line, reason}`                                                                                                                                            |

The line accounting always balances:
`lines_read = valid_requests + malformed_lines + blank_lines + duplicate_lines`.

Rejection reasons, checked in this order: `line_too_long` (over 1 MiB, not counting the line
terminator), `invalid_utf8`,
`invalid_json`, `not_an_object`, `missing_field`, `invalid_field` (wrong type or empty string),
`invalid_status_code` (outside 100–599), `invalid_timestamp`.

## Decisions and assumptions

| Decision                                                                       | Why                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicate `request_id`s: first one wins, rest counted separately               | Log shippers often deliver a record twice rather than risk losing it. Counting repeats would inflate traffic and could invent violations                                                                     |
| Input order not assumed                                                        | Logs from several services rarely arrive sorted, so each client's timestamps are sorted before checking. Reordering input only affects which copy of a conflicting duplicate is kept (first seen wins) and line numbers in examples                                            |
| Timestamps must state their timezone (`Z` or `±HH:MM`)                         | A local time without a zone can't be placed on a shared timeline without guessing, and guessed data is worse than rejected data                                                                              |
| Timestamps outside years 0000-9999 rejected                                    | The report prints timestamps in RFC 3339 form, which only covers those years; an instant that can't be printed validly is treated as invalid input                                                           |
| Blank lines aren't malformed                                                   | Formatting noise rather than broken records. They are still counted, so the line accounting stays exact                                                                                                      |
| Unknown extra JSON fields are ignored                                          | Upstream services evolve. A platform tool shouldn't reject a line for gaining a field                                                                                                                        |
| Endpoints reported verbatim                                                    | Collapsing `/v1/widgets/123` into `/v1/widgets/{id}` means guessing at URL structure. Listed under future work instead                                                                                       |
| Duplicate detection stores an 8-byte fingerprint of each id, not the id itself | Keeps memory constant per request instead of holding millions of strings. Two different ids sharing a fingerprint is a ~3-in-a-million chance across 10 million requests, a tradeoff accepted and documented |
| Example lists capped at 20 entries                                             | One badly-behaved client can't bloat the report, and the counts stay exact                                                                                                                                   |
| Leap seconds (`:60`) rejected                                                  | None have been issued since 2016, and accepting one would mean inventing a policy for it                                                                                                                     |

## Performance

Measured on a 6-core desktop (12 hardware threads) under normal desktop load, Node 24, with a
generated 5-million-line, 621 MiB log. `pnpm bench` reproduces the whole measurement; expect
run-to-run swings of 10-20% on a shared machine.

| Mode                  | Time   | Throughput                 |
| --------------------- | ------ | -------------------------- |
| `--workers 1`         | ~16 s  | ~0.3M lines/s (~40 MiB/s)  |
| `--workers 12` (auto) | ~6 s   | ~0.8M lines/s (~100 MiB/s) |

Getting there took two rounds of measuring:

1. The first version only reached a 2.5× speedup because the combining step on the main thread
   still did counting work for every single record, so the parallel parsing was waiting on a
   single-threaded tail. Moving the counting into the workers (each ships a small table of
   per-chunk totals, and the main thread only removes duplicates and adjusts the totals for
   them) cut that step from 3.4 s to 0.4 s per 3 million lines.
2. What limits it now is the machine rather than the code. Parsing JSON creates a lot of
   short-lived strings and objects, and with about 8 busy threads the memory system becomes the
   bottleneck. The CPUs sit partly idle waiting on memory, with utilisation topping out around
   65%. More workers stop helping, which is why `auto` caps at the core count.

Memory use is about 26 bytes per valid request, plus tables that grow with the number of
distinct clients and endpoints. That comes to roughly 130 MiB for 5 million requests,
regardless of how long the lines are. Internal limits (8 million distinct clients, 1 million
distinct endpoints) fail with a clear error rather than silently corrupting counts.

## Testing

57 tests, run with `pnpm test`:

- Unit tests for the timestamp parser, line validation, duplicate detection and the
  rolling-window check.
- The window check and the id fingerprint are each verified against a slow but obviously
  correct implementation on hundreds of randomised inputs.
- A golden test pins the exact report for the assessment sample input.
- Pipeline tests cover: duplicates whose copies disagree with each other, byte-order marks,
  Windows line endings, oversized lines, broken UTF-8 (while keeping a genuine `�` character in
  data), timestamps in mixed timezones, shuffled input, example capping, and empty input.
- End-to-end tests run the real CLI: stdin, exit codes, `--limit` overrides, and the key
  property that 1, 4 and 9 workers produce byte-identical output on a generated 120k-line log
  that exercises every malformed, duplicate and burst path.

`pnpm lint` (Biome) and TypeScript strict mode gate the code. CI runs everything on
Node 22, 24 and 26.

## What I'd do differently with more time

- **Unbounded input sizes.** For pre-sorted logs, evaluate and emit as lines stream through,
  keeping only per-client window state in memory. Unsorted logs would need sorting on disk
  first.
- **Endpoint grouping** (`/v1/widgets/{id}`) behind a flag, so per-endpoint stats aggregate
  usefully for APIs with ids in the path.
- **Richer policies.** Per-endpoint or per-plan rules, and a config file instead of flags.
- **Traffic over time.** Per-minute request counts, and a measure of how bursty each
  client's traffic is rather than just whether it crossed a limit.
- **Clock-skew detection.** Rate-limit checks compare timestamps across log sources as if
  they shared one clock; a source running 30 seconds behind can hide a real burst or invent a
  false one. When the same `request_id` was logged twice, the gap between the two copies'
  timestamps measures that skew directly, so the report could warn when its own verdicts are
  built on disagreeing clocks.
- **Feeding it deliberately mangled input** (fuzzing). The malformed-line tests cover the
  kinds of breakage I could think of. A fuzzer generates millions of randomly corrupted
  lines, truncated mid-character, bit-flipped, absurdly sized, and checks that none of them
  can crash the tool or unbalance the line accounting. That defends the "bad input never
  crashes it" promise against the inputs nobody imagined.

## AI usage

This solution was built pair-programming with an AI assistant (Claude), which drafted code and
tests under direction. The problem analysis, rate-limit policy, architecture decisions and
tradeoffs were reviewed and owned by me. The test suite exists to verify the generated code
rather than trust it: the fast algorithms are checked against slow, obviously correct versions
of themselves on randomised inputs, and a dedicated test proves the parallel and
single-threaded paths produce byte-identical reports.
