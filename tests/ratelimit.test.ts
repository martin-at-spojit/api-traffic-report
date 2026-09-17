import { describe, expect, it } from 'vitest';
import { evaluateRule } from '../src/analysis/ratelimit.js';
import { mulberry32 } from './helpers.js';

const f64 = (values: number[]): Float64Array => Float64Array.from(values);

/** O(n^2) reference: for each request, count requests at or before it within (t-W, t]. */
function naive(timeline: Float64Array, maxRequests: number, windowMs: number) {
  let peak = 0;
  let excess = 0;
  let firstViolationMs = -1;
  let lastViolationMs = -1;
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i] as number;
    let count = 0;
    for (let j = 0; j <= i; j++) {
      const u = timeline[j] as number;
      if (u > t - windowMs && u <= t) count++;
    }
    if (count > peak) peak = count;
    if (count > maxRequests) {
      excess++;
      lastViolationMs = t;
      if (firstViolationMs < 0) firstViolationMs = t;
    }
  }
  return { peak, excess, firstViolationMs, lastViolationMs };
}

describe('evaluateRule', () => {
  it('flags nothing at or under the limit', () => {
    expect(evaluateRule(f64([0, 2000, 4000, 6000, 8000]), 5, 10_000).excess).toBe(0);
    expect(evaluateRule(f64([]), 5, 10_000).excess).toBe(0);
  });

  it('flags the sample-input burst: 6 requests in 8 seconds', () => {
    const stats = evaluateRule(f64([0, 2000, 4000, 5000, 6000, 8000]), 5, 10_000);
    expect(stats).toEqual({ peak: 6, excess: 1, firstViolationMs: 8000, lastViolationMs: 8000 });
  });

  it('treats the window as half-open: requests exactly W apart do not share it', () => {
    const stats = evaluateRule(f64([0, 10_000]), 1, 10_000);
    expect(stats.excess).toBe(0);
    expect(stats.peak).toBe(1);
    // 1ms closer and they do share the window.
    expect(evaluateRule(f64([0, 9_999]), 1, 10_000).excess).toBe(1);
  });

  it('counts identical timestamps in arrival order', () => {
    const stats = evaluateRule(f64([5000, 5000, 5000]), 2, 10_000);
    expect(stats.excess).toBe(1);
    expect(stats.peak).toBe(3);
  });

  it('counts every violating request, not just violating windows', () => {
    // 10 requests in one second against 5/10s: requests 6..10 each violate.
    const stats = evaluateRule(f64(Array.from({ length: 10 }, (_, i) => i * 100)), 5, 10_000);
    expect(stats.excess).toBe(5);
    expect(stats.peak).toBe(10);
  });

  it('matches an O(n^2) reference on randomized timelines', () => {
    const rand = mulberry32(99);
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rand() * 300);
      const timeline = Float64Array.from(
        Array.from({ length: n }, () => Math.floor(rand() * 30_000)),
      ).sort();
      const maxRequests = 1 + Math.floor(rand() * 8);
      const windowMs = 500 + Math.floor(rand() * 10_000);
      expect(evaluateRule(timeline, maxRequests, windowMs)).toEqual(
        naive(timeline, maxRequests, windowMs),
      );
    }
  });
});
