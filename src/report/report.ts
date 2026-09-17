import type { Aggregator } from '../analysis/aggregate.js';
import { evaluateRule } from '../analysis/ratelimit.js';
import { MALFORMED_REASONS, type RateRule } from '../types.js';

interface Violation {
  client_id: string;
  rule: string;
  requests: number;
  peak_requests_in_window: number;
  excess_requests: number;
  first_violation_at: string;
  last_violation_at: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sortedStatusCodes(counts: Map<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of [...counts.keys()].sort((a, b) => a - b)) {
    out[String(code)] = counts.get(code) as number;
  }
  return out;
}

/**
 * Assemble the report. Deterministic by construction: no wall-clock reads,
 * every array has a defined sort order, object keys are inserted in a fixed
 * order. Identical input (and rules) yields byte-identical output.
 */
export function buildReport(agg: Aggregator, rules: RateRule[], pretty: boolean): string {
  return JSON.stringify(buildReportData(agg, rules), null, pretty ? 2 : undefined);
}

/** The report's shape; `JSON.parse` of the output round-trips to this type. */
export type TrafficReport = ReturnType<typeof buildReportData>;

function buildReportData(agg: Aggregator, rules: RateRule[]) {
  agg.finalize();
  const violations: Violation[] = [];
  const violatingClients = new Set<number>();

  // A client with no more requests in total than the loosest rule allows in
  // one window cannot violate anything; skip building its timeline.
  const smallestLimit = Math.min(...rules.map((r) => r.maxRequests));

  for (let client = 0; client < agg.clients.length; client++) {
    if ((agg.clientRequests[client] as number) <= smallestLimit) continue;
    const timeline = agg.timeline(client);
    for (const rule of rules) {
      const stats = evaluateRule(timeline, rule.maxRequests, rule.windowSeconds * 1000);
      if (stats.excess === 0) continue;
      violatingClients.add(client);
      violations.push({
        client_id: agg.clients[client] as string,
        rule: rule.id,
        requests: agg.clientRequests[client] as number,
        peak_requests_in_window: stats.peak,
        excess_requests: stats.excess,
        first_violation_at: iso(stats.firstViolationMs),
        last_violation_at: iso(stats.lastViolationMs),
      });
    }
  }
  violations.sort(
    (a, b) =>
      b.excess_requests - a.excess_requests ||
      compare(a.client_id, b.client_id) ||
      compare(a.rule, b.rule),
  );

  const clientOrder = [...agg.clients.keys()].sort(
    (a, b) =>
      (agg.clientRequests[b] as number) - (agg.clientRequests[a] as number) ||
      compare(agg.clients[a] as string, agg.clients[b] as string),
  );
  const endpointOrder = [...agg.endpoints.keys()].sort(
    (a, b) =>
      (agg.endpointRequests[b] as number) - (agg.endpointRequests[a] as number) ||
      compare(agg.endpoints[a] as string, agg.endpoints[b] as string),
  );

  const byReason: Record<string, number> = {};
  for (const reason of MALFORMED_REASONS) {
    const count = agg.malformedByReason.get(reason);
    if (count !== undefined && count > 0) byReason[reason] = count;
  }

  return {
    schema_version: '1.0',
    summary: {
      lines_read: agg.linesRead,
      valid_requests: agg.validRequests,
      malformed_lines: agg.malformedCount,
      blank_lines: agg.blankLines,
      duplicate_lines: agg.duplicateLines,
      unique_clients: agg.clients.length,
      unique_endpoints: agg.endpoints.length,
      first_request_at: agg.validRequests > 0 ? iso(agg.minTs) : null,
      last_request_at: agg.validRequests > 0 ? iso(agg.maxTs) : null,
    },
    rate_limit: {
      rules: rules.map((r) => ({
        rule: r.id,
        max_requests: r.maxRequests,
        window_seconds: r.windowSeconds,
        scope: r.scope,
      })),
      violating_client_count: violatingClients.size,
      violations,
    },
    traffic: {
      by_client: clientOrder.map((c) => ({
        client_id: agg.clients[c] as string,
        requests: agg.clientRequests[c] as number,
        status_codes: sortedStatusCodes(agg.clientStatus[c] as Map<number, number>),
      })),
      by_endpoint: endpointOrder.map((e) => ({
        endpoint: agg.endpoints[e] as string,
        requests: agg.endpointRequests[e] as number,
        unique_clients: (agg.endpointClients[e] as Set<number>).size,
        status_codes: sortedStatusCodes(agg.endpointStatus[e] as Map<number, number>),
      })),
      by_status_code: sortedStatusCodes(agg.statusTotals),
    },
    malformed: {
      count: agg.malformedCount,
      by_reason: byReason,
      examples: agg.malformedExamples,
    },
  };
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
