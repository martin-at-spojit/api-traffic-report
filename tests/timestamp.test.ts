import { describe, expect, it } from 'vitest';
import { parseRfc3339 } from '../src/pipeline/timestamp.js';

describe('parseRfc3339', () => {
  it('parses UTC Z timestamps', () => {
    expect(parseRfc3339('2024-01-15T10:00:00Z')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
  });

  it('accepts lowercase t and z', () => {
    expect(parseRfc3339('2024-01-15t10:00:00z')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
  });

  it('applies positive and negative offsets', () => {
    expect(parseRfc3339('2024-01-15T12:00:00+02:00')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
    expect(parseRfc3339('2024-01-15T04:30:00-05:30')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
    expect(parseRfc3339('2024-01-15T10:00:00-00:00')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
  });

  it('truncates fractional seconds to milliseconds', () => {
    expect(parseRfc3339('2024-01-15T10:00:00.123Z')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0, 123));
    expect(parseRfc3339('2024-01-15T10:00:00.123999Z')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0, 123));
    expect(parseRfc3339('2024-01-15T10:00:00.5Z')).toBe(Date.UTC(2024, 0, 15, 10, 0, 0, 500));
  });

  it('accepts arbitrarily many fractional digits (RFC 3339 sets no bound)', () => {
    expect(parseRfc3339('2024-01-15T10:00:00.1234567890Z')).toBe(
      Date.UTC(2024, 0, 15, 10, 0, 0, 123),
    );
    expect(parseRfc3339(`2024-01-15T10:00:00.${'9'.repeat(30)}Z`)).toBe(
      Date.UTC(2024, 0, 15, 10, 0, 0, 999),
    );
    expect(parseRfc3339('2024-01-15T10:00:00.Z')).toBeNull(); // dot with no digits
  });

  it('rejects instants that normalize outside the renderable year range 0000-9999', () => {
    // These parse as calendar dates, but the offset pushes the UTC instant
    // outside what the report can print as RFC 3339.
    expect(parseRfc3339('9999-12-31T23:59:59.999-23:59')).toBeNull();
    expect(parseRfc3339('0000-01-01T00:00:00+00:01')).toBeNull();
    // The extremes themselves are fine.
    expect(parseRfc3339('0000-01-01T00:00:00Z')).toBe(-62_167_219_200_000);
    expect(parseRfc3339('9999-12-31T23:59:59.999Z')).toBe(253_402_300_799_999);
  });

  it('requires an offset', () => {
    expect(parseRfc3339('2024-01-15T10:00:00')).toBeNull();
    expect(parseRfc3339('2024-01-15T10:00:00.123')).toBeNull();
  });

  it('rejects non-timestamp strings and wrong shapes', () => {
    expect(parseRfc3339('')).toBeNull();
    expect(parseRfc3339('yesterday')).toBeNull();
    expect(parseRfc3339('2024-01-15 10:00:00Z')).toBeNull(); // space separator
    expect(parseRfc3339('2024-1-15T10:00:00Z')).toBeNull(); // unpadded
    expect(parseRfc3339('1705312800')).toBeNull(); // epoch number
  });

  it('rejects out-of-range components', () => {
    expect(parseRfc3339('2024-13-01T10:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-00-01T10:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-01-32T10:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-01-15T24:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-01-15T10:60:00Z')).toBeNull();
    expect(parseRfc3339('2024-01-15T10:00:60Z')).toBeNull(); // leap second
    expect(parseRfc3339('2024-01-15T10:00:00+24:00')).toBeNull();
  });

  it('validates calendar dates, including leap years', () => {
    expect(parseRfc3339('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
    expect(parseRfc3339('2023-02-29T00:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-02-30T00:00:00Z')).toBeNull();
    expect(parseRfc3339('2024-04-31T00:00:00Z')).toBeNull();
  });

  it('handles years below 100 without 19xx mapping', () => {
    const ms = parseRfc3339('0099-01-01T00:00:00Z');
    expect(ms).not.toBeNull();
    expect(new Date(ms as number).getUTCFullYear()).toBe(99);
  });
});
