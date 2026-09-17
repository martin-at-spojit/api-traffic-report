import { describe, expect, it } from 'vitest';
import { reportForFile } from '../src/run.js';
import { makeRule } from '../src/types.js';
import { DEFAULT_RULES, reportFor, validLine } from './helpers.js';

const SAMPLE = new URL('../sample_input/requests.jsonl', import.meta.url).pathname;

describe('sample input (golden)', () => {
  it('produces the exact documented report', async () => {
    const json = await reportForFile(SAMPLE, { rules: DEFAULT_RULES, workers: 1, pretty: false });
    expect(JSON.parse(json)).toEqual({
      schema_version: '1.0',
      summary: {
        lines_read: 8,
        valid_requests: 8,
        malformed_lines: 0,
        blank_lines: 0,
        duplicate_lines: 0,
        unique_clients: 2,
        unique_endpoints: 2,
        first_request_at: '2024-01-15T10:00:00.000Z',
        last_request_at: '2024-01-15T10:05:05.000Z',
      },
      rate_limit: {
        rules: [
          { rule: '5/10s', max_requests: 5, window_seconds: 10, scope: 'client' },
          { rule: '100/60s', max_requests: 100, window_seconds: 60, scope: 'client' },
        ],
        violating_client_count: 1,
        violations: [
          {
            client_id: 'acct_1',
            rule: '5/10s',
            requests: 6,
            peak_requests_in_window: 6,
            excess_requests: 1,
            first_violation_at: '2024-01-15T10:00:08.000Z',
            last_violation_at: '2024-01-15T10:00:08.000Z',
          },
        ],
      },
      traffic: {
        by_client: [
          { client_id: 'acct_1', requests: 6, status_codes: { '200': 6 } },
          { client_id: 'acct_2', requests: 2, status_codes: { '200': 2 } },
        ],
        by_endpoint: [
          { endpoint: '/v1/widgets', requests: 6, unique_clients: 1, status_codes: { '200': 6 } },
          { endpoint: '/v1/reports', requests: 2, unique_clients: 1, status_codes: { '200': 2 } },
        ],
        by_status_code: { '200': 8 },
      },
      malformed: { count: 0, by_reason: {}, examples: [] },
    });
  });
});

describe('pipeline behaviour', () => {
  it('keeps exact line accounting: read = valid + malformed + blank + duplicates', async () => {
    const input = [
      validLine({ request_id: 'w1' }),
      '',
      'broken {json',
      validLine({ request_id: 'w2' }),
      validLine({ request_id: 'w1', client_id: 'other' }), // duplicate id
      '   ',
      '"string"',
      validLine({ request_id: 'w3' }),
    ].join('\n');
    const r = await reportFor(input);
    expect(r.summary.lines_read).toBe(8);
    expect(r.summary.valid_requests).toBe(3);
    expect(r.summary.malformed_lines).toBe(2);
    expect(r.summary.blank_lines).toBe(2);
    expect(r.summary.duplicate_lines).toBe(1);
    expect(
      r.summary.valid_requests +
        r.summary.malformed_lines +
        r.summary.blank_lines +
        r.summary.duplicate_lines,
    ).toBe(r.summary.lines_read);
  });

  it('deduplicates by request_id, first occurrence wins', async () => {
    const input = [
      validLine({ request_id: 'dup', client_id: 'first_client', status_code: 200 }),
      validLine({ request_id: 'dup', client_id: 'second_client', status_code: 500 }),
    ].join('\n');
    const r = await reportFor(input);
    expect(r.summary.valid_requests).toBe(1);
    expect(r.summary.duplicate_lines).toBe(1);
    expect(r.summary.unique_clients).toBe(1);
    expect(r.traffic.by_client[0].client_id).toBe('first_client');
    expect(r.traffic.by_status_code).toEqual({ '200': 1 });
  });

  it('strips a UTF-8 BOM and CRLF line endings', async () => {
    const input = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${validLine({ request_id: 'b1' })}\r\n${validLine({ request_id: 'b2' })}\r\n`),
    ]);
    const r = await reportFor(input);
    expect(r.summary.valid_requests).toBe(2);
    expect(r.summary.malformed_lines).toBe(0);
  });

  it('rejects oversized lines without decoding them', async () => {
    const big = validLine({ request_id: 'big', endpoint: `/v1/${'x'.repeat(1 << 20)}` });
    const input = `${validLine({ request_id: 'ok' })}\n${big}\n`;
    const r = await reportFor(input, { chunkSize: 65536 });
    expect(r.summary.valid_requests).toBe(1);
    expect(r.malformed.by_reason).toEqual({ line_too_long: 1 });
    expect(r.malformed.examples).toEqual([{ line: 2, reason: 'line_too_long' }]);
  });

  it('does not count a CRLF terminator against the line size cap', async () => {
    // Build a line of exactly 1 MiB of content by padding the endpoint.
    const skeleton = validLine({ request_id: 'cap', endpoint: '' });
    const pad = (1 << 20) - Buffer.byteLength(skeleton, 'utf8');
    const exactly = validLine({ request_id: 'cap', endpoint: 'x'.repeat(pad) });
    expect(Buffer.byteLength(exactly, 'utf8')).toBe(1 << 20);

    // At the cap with a CRLF ending: still valid. One byte over with LF: rejected.
    const r1 = await reportFor(`${exactly}\r\n`, { chunkSize: 65536 });
    expect(r1.summary.valid_requests).toBe(1);
    expect(r1.summary.malformed_lines).toBe(0);

    const oneOver = validLine({ request_id: 'cap2', endpoint: 'x'.repeat(pad + 1) });
    const r2 = await reportFor(`${oneOver}\n`, { chunkSize: 65536 });
    expect(r2.malformed.by_reason).toEqual({ line_too_long: 1 });
  });

  it('rejects invalid UTF-8 but keeps genuine U+FFFD characters', async () => {
    const input = Buffer.concat([
      Buffer.from(validLine({ request_id: 'u1', client_id: 'has_�_char' })),
      Buffer.from('\n'),
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), // {<invalid bytes>}
      Buffer.from('\n'),
    ]);
    const r = await reportFor(input);
    expect(r.summary.valid_requests).toBe(1);
    expect(r.malformed.by_reason).toEqual({ invalid_utf8: 1 });
  });

  it('detects violations across mixed timezone offsets', async () => {
    // Six requests in 8 wall-clock seconds, written with three different offsets.
    const times = [
      '2024-01-15T10:00:00Z',
      '2024-01-15T12:00:02+02:00',
      '2024-01-15T04:30:04-05:30',
      '2024-01-15T10:00:05Z',
      '2024-01-15T11:00:06+01:00',
      '2024-01-15T10:00:08Z',
    ];
    const input = times
      .map((t, i) => validLine({ request_id: `tz${i}`, timestamp: t, client_id: 'acct_tz' }))
      .join('\n');
    const r = await reportFor(input);
    expect(r.rate_limit.violations).toHaveLength(1);
    expect(r.rate_limit.violations[0]).toMatchObject({
      client_id: 'acct_tz',
      rule: '5/10s',
      peak_requests_in_window: 6,
      excess_requests: 1,
    });
  });

  it('is order-invariant: shuffled input yields the same aggregates', async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      validLine({
        request_id: `o${i}`,
        client_id: `acct_${i % 5}`,
        timestamp: `2024-01-15T10:${String(i % 60).padStart(2, '0')}:00Z`,
      }),
    );
    const shuffled = [...lines].reverse();
    const a = await reportFor(lines.join('\n'));
    const b = await reportFor(shuffled.join('\n'));
    expect(a).toEqual(b);
  });

  it('applies custom rules and reports one violation entry per rule', async () => {
    const input = Array.from({ length: 4 }, (_, i) =>
      validLine({ request_id: `c${i}`, timestamp: `2024-01-15T10:00:0${i}Z`, client_id: 'c' }),
    ).join('\n');
    const r = await reportFor(input, {
      rules: [makeRule(1, 10), makeRule(2, 60)],
    });
    expect(r.rate_limit.violations).toHaveLength(2);
    expect(r.rate_limit.violating_client_count).toBe(1);
    expect(r.rate_limit.violations.map((v: { rule: string }) => v.rule)).toEqual([
      '1/10s',
      '2/60s',
    ]);
    expect(r.rate_limit.violations[0].excess_requests).toBe(3);
    expect(r.rate_limit.violations[1].excess_requests).toBe(2);
  });

  it('caps malformed examples at 20 while keeping exact counts', async () => {
    const input = Array.from({ length: 30 }, () => 'broken{').join('\n');
    const r = await reportFor(input);
    expect(r.malformed.count).toBe(30);
    expect(r.malformed.examples).toHaveLength(20);
    expect(r.malformed.examples[0]).toEqual({ line: 1, reason: 'invalid_json' });
    expect(r.malformed.examples[19]).toEqual({ line: 20, reason: 'invalid_json' });
  });

  it('handles empty input', async () => {
    const r = await reportFor('');
    expect(r.summary).toMatchObject({
      lines_read: 0,
      valid_requests: 0,
      first_request_at: null,
      last_request_at: null,
    });
    expect(r.rate_limit.violations).toEqual([]);
  });

  it('handles input without a trailing newline', async () => {
    const r = await reportFor(validLine({ request_id: 'nt' }));
    expect(r.summary.lines_read).toBe(1);
    expect(r.summary.valid_requests).toBe(1);
  });
});
