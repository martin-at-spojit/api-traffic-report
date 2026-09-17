import { describe, expect, it } from 'vitest';
import { parseLine } from '../src/pipeline/parse.js';
import { line, validLine } from './helpers.js';

function reasonOf(input: string): string | undefined {
  const p = parseLine(input);
  return p.kind === 'malformed' ? p.reason : undefined;
}

describe('parseLine', () => {
  it('parses a valid line', () => {
    const p = parseLine(
      '{"request_id":"a1_1","timestamp":"2024-01-15T10:00:00Z","client_id":"acct_1","endpoint":"/v1/widgets","status_code":200}',
    );
    expect(p).toEqual({
      kind: 'valid',
      id: 'a1_1',
      tsMs: Date.UTC(2024, 0, 15, 10, 0, 0),
      client: 'acct_1',
      endpoint: '/v1/widgets',
      status: 200,
    });
  });

  it('treats empty and whitespace-only lines as blank', () => {
    expect(parseLine('').kind).toBe('blank');
    expect(parseLine('   \t ').kind).toBe('blank');
  });

  it('ignores unknown extra fields', () => {
    expect(parseLine(validLine({ extra: 'ok', nested: { a: 1 } })).kind).toBe('valid');
  });

  it('rejects broken JSON', () => {
    expect(reasonOf('{"request_id": nope')).toBe('invalid_json');
    expect(reasonOf('{}trailing')).toBe('invalid_json');
  });

  it('rejects non-object JSON values', () => {
    expect(reasonOf('"a string"')).toBe('not_an_object');
    expect(reasonOf('42')).toBe('not_an_object');
    expect(reasonOf('[1,2]')).toBe('not_an_object');
    expect(reasonOf('null')).toBe('not_an_object');
  });

  it('rejects records with missing fields', () => {
    expect(reasonOf('{}')).toBe('missing_field');
    expect(
      reasonOf(line({ request_id: 'x', timestamp: '2024-01-15T10:00:00Z', client_id: 'c' })),
    ).toBe('missing_field');
  });

  it('rejects wrong types and empty strings', () => {
    expect(reasonOf(validLine({ request_id: '' }))).toBe('invalid_field');
    expect(reasonOf(validLine({ client_id: '   ' }))).toBe('invalid_field');
    expect(reasonOf(validLine({ endpoint: 7 }))).toBe('invalid_field');
    expect(reasonOf(validLine({ timestamp: 1705312800 }))).toBe('invalid_field');
    expect(reasonOf(validLine({ status_code: '200' }))).toBe('invalid_field');
    expect(reasonOf(validLine({ status_code: 200.5 }))).toBe('invalid_field');
    expect(reasonOf(validLine({ status_code: null }))).toBe('invalid_field');
  });

  it('rejects status codes outside 100-599', () => {
    expect(reasonOf(validLine({ status_code: 99 }))).toBe('invalid_status_code');
    expect(reasonOf(validLine({ status_code: 600 }))).toBe('invalid_status_code');
    expect(parseLine(validLine({ status_code: 100 })).kind).toBe('valid');
    expect(parseLine(validLine({ status_code: 599 })).kind).toBe('valid');
  });

  it('rejects invalid timestamps', () => {
    expect(reasonOf(validLine({ timestamp: '2024-01-15T10:00:00' }))).toBe('invalid_timestamp');
    expect(reasonOf(validLine({ timestamp: 'not a time' }))).toBe('invalid_timestamp');
  });
});
