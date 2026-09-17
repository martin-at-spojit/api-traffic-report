/**
 * 64-bit FNV-1a over a string's UTF-16 code units, computed in 16-bit limbs so
 * the hot loop stays in small-integer arithmetic (BigInt is only touched once,
 * to assemble the final value).
 *
 * Used to deduplicate request ids without retaining the id strings themselves,
 * which keeps memory per request constant. Collision probability for n ids is
 * ~n^2 / 2^65 (about 3e-6 at 10M requests) — documented as an accepted
 * tradeoff in the README.
 */
export function hash64(s: string): bigint {
  // FNV-1a 64 offset basis 0xcbf29ce484222325, low limb first.
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;
  for (let i = 0; i < s.length; i++) {
    v0 ^= s.charCodeAt(i);
    // Multiply by the FNV prime 2^40 + 2^8 + 0xb3: limbs (0x01b3, 0, 0x0100, 0).
    const t0 = v0 * 0x01b3;
    let t1 = v1 * 0x01b3;
    let t2 = v2 * 0x01b3 + v0 * 0x0100;
    let t3 = v3 * 0x01b3 + v1 * 0x0100;
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    v0 = t0 & 0xffff;
    v1 = t1 & 0xffff;
    v2 = t2 & 0xffff;
    v3 = t3 & 0xffff;
  }
  return (BigInt(v3) << 48n) | (BigInt(v2) << 32n) | (BigInt(v1) << 16n) | BigInt(v0);
}

/** Stand-in for a genuine hash of (0, 0), which marks empty slots. */
const ZERO_LO = 0x9e3779b9;
const ZERO_HI = 0x7f4a7c15;

/**
 * Open-addressing hash set for 64-bit values presented as (lo, hi) 32-bit
 * pairs over one interleaved Uint32Array. The pair interface lets the merge
 * loop read hash columns through a Uint32Array view, avoiding the BigInt
 * allocation that every BigUint64Array element access incurs — this set sits
 * on the serial path that limits parallel speedup. 8 bytes per slot.
 */
export class HashSet64 {
  private table: Uint32Array;
  private mask: number;
  size = 0;

  constructor(initialCapacity = 1 << 16) {
    let cap = 16;
    while (cap < initialCapacity) cap *= 2;
    this.table = new Uint32Array(cap * 2);
    this.mask = cap - 1;
  }

  /** Insert; returns true if the value was not present before. */
  add(lo: number, hi: number): boolean {
    if (lo === 0 && hi === 0) {
      lo = ZERO_LO;
      hi = ZERO_HI;
    }
    if ((this.size + 1) * 4 > (this.mask + 1) * 3) this.grow();
    const table = this.table;
    const mask = this.mask;
    let i = (lo ^ hi) & mask;
    for (;;) {
      const slotLo = table[i * 2] as number;
      const slotHi = table[i * 2 + 1] as number;
      if (slotLo === 0 && slotHi === 0) {
        table[i * 2] = lo;
        table[i * 2 + 1] = hi;
        this.size++;
        return true;
      }
      if (slotLo === lo && slotHi === hi) return false;
      i = (i + 1) & mask;
    }
  }

  private grow(): void {
    const old = this.table;
    const cap = (this.mask + 1) * 2;
    this.table = new Uint32Array(cap * 2);
    this.mask = cap - 1;
    for (let i = 0; i < old.length; i += 2) {
      const lo = old[i] as number;
      const hi = old[i + 1] as number;
      if (lo === 0 && hi === 0) continue;
      let j = (lo ^ hi) & this.mask;
      while ((this.table[j * 2] as number) !== 0 || (this.table[j * 2 + 1] as number) !== 0) {
        j = (j + 1) & this.mask;
      }
      this.table[j * 2] = lo;
      this.table[j * 2 + 1] = hi;
    }
  }
}
