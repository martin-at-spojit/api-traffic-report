/**
 * Rolling-window evaluation over one client's sorted timeline.
 *
 * A request at time t violates a rule when, counting itself, more than
 * maxRequests requests fall inside the window (t - W, t]. The half-open
 * window means two requests exactly W apart do NOT share a window. Ties are
 * evaluated in timeline order: a request is compared against requests at or
 * before its own position, matching how the requests arrived.
 *
 * Two-pointer scan: O(n) after the O(n log n) sort.
 */
export interface RuleStats {
  /** Highest number of requests observed in any single window. */
  peak: number;
  /** Number of requests that individually violated the rule. */
  excess: number;
  firstViolationMs: number;
  lastViolationMs: number;
}

export function evaluateRule(
  timeline: Float64Array,
  maxRequests: number,
  windowMs: number,
): RuleStats {
  let low = 0;
  let peak = 0;
  let excess = 0;
  let firstViolationMs = -1;
  let lastViolationMs = -1;

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i] as number;
    const windowStart = t - windowMs;
    while ((timeline[low] as number) <= windowStart) low++;
    const count = i - low + 1;
    if (count > peak) peak = count;
    if (count > maxRequests) {
      excess++;
      lastViolationMs = t;
      if (firstViolationMs < 0) firstViolationMs = t;
    }
  }
  return { peak, excess, firstViolationMs, lastViolationMs };
}
