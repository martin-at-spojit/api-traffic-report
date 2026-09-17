/** Reasons a line can be rejected, in the order validation applies them. */
export const MALFORMED_REASONS = [
  'line_too_long',
  'invalid_utf8',
  'invalid_json',
  'not_an_object',
  'missing_field',
  'invalid_field',
  'invalid_status_code',
  'invalid_timestamp',
] as const;

export type MalformedReason = (typeof MALFORMED_REASONS)[number];

export type ParsedLine =
  | { kind: 'blank' }
  | { kind: 'malformed'; reason: MalformedReason }
  | { kind: 'valid'; id: string; tsMs: number; client: string; endpoint: string; status: number };

export type RuleScope = 'client';

export interface RateRule {
  /** Canonical id, always in seconds, e.g. "5/10s". */
  id: string;
  maxRequests: number;
  windowSeconds: number;
  scope: RuleScope;
}

/** Single place where a rule's canonical id format is derived. */
export function makeRule(maxRequests: number, windowSeconds: number): RateRule {
  return { id: `${maxRequests}/${windowSeconds}s`, maxRequests, windowSeconds, scope: 'client' };
}

/** The shipped default policy: a burst rule and a sustained rule. */
export const DEFAULT_RULES: RateRule[] = [makeRule(5, 10), makeRule(100, 60)];

/** Example lists (malformed lines, etc.) are capped at this many entries.
 * The per-shard cap and the merge cap must be the same number for a parallel
 * run to report the same examples as a sequential one. */
export const EXAMPLE_CAP = 20;

export interface MalformedExample {
  /** 1-based line number; relative to the shard until merged. */
  line: number;
  reason: MalformedReason;
}

/**
 * Packed (client, endpoint, status) combination key. Fixed radixes keep keys
 * decodable and exact within Number's 2^53 integer range; the implied bounds
 * (2^23 distinct clients, 2^20 distinct endpoints per aggregation scope) are
 * enforced at intern time with a clear error.
 */
export const COMBO_STATUS_RADIX = 600;
export const COMBO_ENDPOINT_RADIX = 1 << 20;
export const MAX_CLIENTS = 1 << 23;

export function packCombo(client: number, endpoint: number, status: number): number {
  return (client * COMBO_ENDPOINT_RADIX + endpoint) * COMBO_STATUS_RADIX + status;
}

export function unpackCombo(combo: number): { client: number; endpoint: number; status: number } {
  const status = combo % COMBO_STATUS_RADIX;
  const rest = (combo - status) / COMBO_STATUS_RADIX;
  const endpoint = rest % COMBO_ENDPOINT_RADIX;
  return { client: (rest - endpoint) / COMBO_ENDPOINT_RADIX, endpoint, status };
}

/** Message sent to a shard worker; both sides type against this. */
export interface WorkerInput {
  path: string;
  start: number;
  end: number;
  index: number;
}

/**
 * Columnar output of one processed shard. Typed-array buffers are transferable,
 * so a worker hands its shard to the main thread without copying. Counts are
 * pre-aggregated per shard as packed-combo maps so the single-threaded merge
 * only performs per-record work for deduplication, not for counting.
 */
export interface ShardResult {
  linesRead: number;
  blankLines: number;
  malformedCount: number;
  malformedByReason: Record<string, number>;
  malformedExamples: MalformedExample[];
  idHashes: BigUint64Array<ArrayBuffer>;
  timestamps: Float64Array<ArrayBuffer>;
  clientIdx: Uint32Array<ArrayBuffer>;
  endpointIdx: Uint32Array<ArrayBuffer>;
  statusCodes: Uint16Array<ArrayBuffer>;
  clients: string[];
  endpoints: string[];
  /** packCombo(localClient, localEndpoint, status) -> request count. */
  comboCounts: Map<number, number>;
}
