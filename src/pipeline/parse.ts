import type { MalformedReason, ParsedLine } from '../types.js';
import { parseRfc3339 } from './timestamp.js';

const BLANK: ParsedLine = { kind: 'blank' };

function malformed(reason: MalformedReason): ParsedLine {
  return { kind: 'malformed', reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Classify one decoded line. Exactly one reason is reported per malformed
 * line — the first failure in the order: JSON syntax, shape, missing fields,
 * field types, status range, timestamp validity.
 *
 * Unknown extra fields are ignored: upstream services evolve, and rejecting
 * lines for adding fields would break the platform promise.
 */
export function parseLine(line: string): ParsedLine {
  if (line.trim() === '') return BLANK;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return malformed('invalid_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformed('not_an_object');
  }
  const record = value as Record<string, unknown>;

  const id = record.request_id;
  const timestamp = record.timestamp;
  const client = record.client_id;
  const endpoint = record.endpoint;
  const status = record.status_code;

  // JSON.parse never produces undefined, so an undefined read means absent.
  if (
    id === undefined ||
    timestamp === undefined ||
    client === undefined ||
    endpoint === undefined ||
    status === undefined
  ) {
    return malformed('missing_field');
  }

  if (!isNonEmptyString(id) || !isNonEmptyString(client) || !isNonEmptyString(endpoint)) {
    return malformed('invalid_field');
  }
  if (typeof timestamp !== 'string' || typeof status !== 'number' || !Number.isInteger(status)) {
    return malformed('invalid_field');
  }
  if (status < 100 || status > 599) {
    return malformed('invalid_status_code');
  }
  const tsMs = parseRfc3339(timestamp);
  if (tsMs === null) {
    return malformed('invalid_timestamp');
  }
  return { kind: 'valid', id, tsMs, client, endpoint, status };
}
