import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const GENERATOR = fileURLToPath(new URL('../scripts/generate-log.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../sample_input/requests.jsonl', import.meta.url));
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024 };

let dir: string;
let generated: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atr-e2e-'));
  generated = join(dir, 'generated.jsonl');
  await execFile(process.execPath, [GENERATOR, '120000', generated, '7'], EXEC_OPTS);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[], stdin?: string) {
  const child = execFile(process.execPath, [CLI, ...args], EXEC_OPTS);
  if (stdin !== undefined && child.child.stdin) {
    child.child.stdin.write(stdin);
    child.child.stdin.end();
  }
  return child;
}

describe('CLI', () => {
  it('prints a report for the sample file with clean stderr', async () => {
    const { stdout, stderr } = await run([SAMPLE]);
    const report = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(report.rate_limit.violating_client_count).toBe(1);
    expect(report.rate_limit.violations[0].client_id).toBe('acct_1');
  });

  it('reads from stdin with "-" and matches the file run byte-for-byte', async () => {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(SAMPLE, 'utf8');
    const fromFile = await run([SAMPLE]);
    const fromStdin = await run(['-'], bytes);
    expect(fromStdin.stdout).toBe(fromFile.stdout);
  });

  it('produces byte-identical output regardless of worker count', async () => {
    const [w1, w4, w9, auto] = await Promise.all([
      run([generated, '--workers', '1']),
      run([generated, '--workers', '4']),
      run([generated, '--workers', '9']),
      run([generated]),
    ]);
    expect(w4.stdout).toBe(w1.stdout);
    expect(w9.stdout).toBe(w1.stdout);
    expect(auto.stdout).toBe(w1.stdout);
    // Sanity: the generator wrote exactly the requested number of lines and
    // the log exercises every code path.
    const report = JSON.parse(w1.stdout);
    expect(report.summary.lines_read).toBe(120000);
    expect(report.summary.malformed_lines).toBeGreaterThan(0);
    expect(report.summary.duplicate_lines).toBeGreaterThan(0);
    expect(report.summary.blank_lines).toBeGreaterThan(0);
    expect(report.rate_limit.violating_client_count).toBeGreaterThan(0);
  });

  it('handles more workers than file content', async () => {
    const tiny = join(dir, 'tiny.jsonl');
    await writeFile(
      tiny,
      '{"request_id":"t1","timestamp":"2024-01-15T10:00:00Z","client_id":"c","endpoint":"/x","status_code":200}\n',
    );
    const [w1, w8] = await Promise.all([
      run([tiny, '--workers', '1']),
      run([tiny, '--workers', '8']),
    ]);
    expect(w8.stdout).toBe(w1.stdout);
    expect(JSON.parse(w8.stdout).summary.valid_requests).toBe(1);
  });

  it('handles a file smaller than the worker count in bytes', async () => {
    // Regression: byte-splitting a 2-byte file across 8 workers used to
    // produce several zero-width shards starting at offset 0, each of which
    // processed the first line again (4 malformed lines reported instead of 1).
    const micro = join(dir, 'micro.jsonl');
    await writeFile(micro, 'x\n');
    const [w1, w8] = await Promise.all([
      run([micro, '--workers', '1']),
      run([micro, '--workers', '8']),
    ]);
    expect(w8.stdout).toBe(w1.stdout);
    const summary = JSON.parse(w8.stdout).summary;
    expect(summary.lines_read).toBe(1);
    expect(summary.malformed_lines).toBe(1);
  });

  it('handles an empty file', async () => {
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '');
    const { stdout } = await run([empty]);
    expect(JSON.parse(stdout).summary.lines_read).toBe(0);
  });

  it('emits compact single-line JSON with --compact', async () => {
    const { stdout } = await run([SAMPLE, '--compact']);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout).schema_version).toBe('1.0');
  });

  it('applies --limit overrides', async () => {
    const { stdout } = await run([SAMPLE, '--limit', '1/1h']);
    const report = JSON.parse(stdout);
    expect(report.rate_limit.rules).toEqual([
      { rule: '1/3600s', max_requests: 1, window_seconds: 3600, scope: 'client' },
    ]);
    expect(report.rate_limit.violating_client_count).toBe(2);
  });

  it('exits 1 with a message on a missing file, keeping stdout empty', async () => {
    const err = await run([join(dir, 'nope.jsonl')]).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stdout).toBe('');
    expect(err.stderr).toContain('file not found');
  });

  it('exits 2 on usage errors', async () => {
    const noArgs = await run([]).catch((e) => e);
    expect(noArgs.code).toBe(2);
    const badFlag = await run([SAMPLE, '--frobnicate']).catch((e) => e);
    expect(badFlag.code).toBe(2);
    const badLimit = await run([SAMPLE, '--limit', 'fast']).catch((e) => e);
    expect(badLimit.code).toBe(2);
  });

  it('prints help and version', async () => {
    const help = await run(['--help']);
    expect(help.stdout).toContain('Usage:');
    const version = await run(['--version']);
    expect(version.stdout).toMatch(/api-traffic-report \d+\.\d+\.\d+/);
  });
});
