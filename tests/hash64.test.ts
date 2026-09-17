import { describe, expect, it } from 'vitest';
import { HashSet64, hash64 } from '../src/pipeline/hash64.js';
import { mulberry32 } from './helpers.js';

/** Straightforward BigInt FNV-1a 64 over UTF-16 code units, as a reference. */
function referenceHash(s: string): bigint {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h;
}

describe('hash64', () => {
  it('matches the FNV-1a offset basis for the empty string', () => {
    expect(hash64('')).toBe(0xcbf29ce484222325n);
  });

  it('matches a plain BigInt implementation across random strings', () => {
    const rand = mulberry32(1);
    for (let n = 0; n < 500; n++) {
      const len = Math.floor(rand() * 40);
      let s = '';
      for (let i = 0; i < len; i++) {
        s += String.fromCharCode(Math.floor(rand() * 0xffff) + 1);
      }
      expect(hash64(s)).toBe(referenceHash(s));
    }
  });

  it('distinguishes realistic request ids', () => {
    const ids = ['a1_1', 'a1_2', 'a2_1', 'req_0', 'req_1', 'REQ_1', '550e8400-e29b-41d4'];
    const hashes = new Set(ids.map(hash64));
    expect(hashes.size).toBe(ids.length);
  });
});

/** Add a 64-bit value to the pair-interface set. */
function addBig(set: HashSet64, v: bigint): boolean {
  return set.add(Number(v & 0xffffffffn), Number(v >> 32n));
}

describe('HashSet64', () => {
  it('adds values once', () => {
    const set = new HashSet64(16);
    expect(addBig(set, 42n)).toBe(true);
    expect(addBig(set, 42n)).toBe(false);
    expect(addBig(set, 43n)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('handles the zero value', () => {
    const set = new HashSet64(16);
    expect(addBig(set, 0n)).toBe(true);
    expect(addBig(set, 0n)).toBe(false);
  });

  it('separates values that collide on table index', () => {
    const set = new HashSet64(16);
    // Same low word, different high words -> may share the initial slot.
    expect(addBig(set, 1n)).toBe(true);
    expect(addBig(set, 1n | (1n << 40n))).toBe(true);
    expect(addBig(set, 1n | (2n << 40n))).toBe(true);
    expect(addBig(set, 1n | (1n << 40n))).toBe(false);
    expect(set.size).toBe(3);
  });

  it('grows correctly under load', () => {
    const set = new HashSet64(16);
    const rand = mulberry32(7);
    const values: bigint[] = [];
    for (let i = 0; i < 100_000; i++) {
      values.push(
        (BigInt(Math.floor(rand() * 0xffffffff)) << 32n) | BigInt(Math.floor(rand() * 0xffffffff)),
      );
    }
    const unique = new Set(values.map((v) => v.toString()));
    for (const v of values) addBig(set, v);
    expect(set.size).toBe(unique.size);
    for (const v of values) expect(addBig(set, v)).toBe(false);
  });
});
