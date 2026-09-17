import {
  COMBO_ENDPOINT_RADIX,
  EXAMPLE_CAP,
  MAX_CLIENTS,
  type MalformedExample,
  type MalformedReason,
  type ParsedLine,
  packCombo,
  type ShardResult,
} from '../types.js';
import { hash64 } from './hash64.js';

/** Growable Float64Array, used for per-client timestamp timelines. */
export class GrowF64 {
  private buf = new Float64Array(16);
  private n = 0;

  push(v: number): void {
    if (this.n === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
  }

  /** Exact-length copy of the contents. */
  finish(): Float64Array {
    return this.buf.slice(0, this.n);
  }
}

/**
 * Accumulates one shard's lines into columnar arrays. Valid records become
 * parallel typed arrays (hash, timestamp, interned client/endpoint index,
 * status); strings are interned once per shard so the cross-thread payload is
 * a few small tables plus flat buffers.
 */
export class ShardBuilder {
  private cap = 4096;
  private n = 0;
  private idHashes = new BigUint64Array(this.cap);
  private timestamps = new Float64Array(this.cap);
  private clientIdx = new Uint32Array(this.cap);
  private endpointIdx = new Uint32Array(this.cap);
  private statusCodes = new Uint16Array(this.cap);

  private clientTable = new Map<string, number>();
  private clients: string[] = [];
  private endpointTable = new Map<string, number>();
  private endpoints: string[] = [];

  private linesRead = 0;
  private blankLines = 0;
  private malformedCount = 0;
  private malformedByReason = new Map<MalformedReason, number>();
  private malformedExamples: MalformedExample[] = [];
  private comboCounts = new Map<number, number>();

  /** Record a line rejected before decoding (size cap, invalid UTF-8). */
  addMalformedLine(reason: MalformedReason): void {
    this.linesRead++;
    this.recordMalformed(reason);
  }

  addParsed(p: ParsedLine): void {
    this.linesRead++;
    if (p.kind === 'blank') {
      this.blankLines++;
      return;
    }
    if (p.kind === 'malformed') {
      this.recordMalformed(p.reason);
      return;
    }
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    const client = intern(this.clientTable, this.clients, p.client);
    const endpoint = intern(this.endpointTable, this.endpoints, p.endpoint);
    if (client >= MAX_CLIENTS || endpoint >= COMBO_ENDPOINT_RADIX) {
      throw new Error(
        `cardinality limit exceeded: ${this.clients.length} clients / ${this.endpoints.length} endpoints in one shard`,
      );
    }
    this.idHashes[i] = hash64(p.id);
    this.timestamps[i] = p.tsMs;
    this.clientIdx[i] = client;
    this.endpointIdx[i] = endpoint;
    this.statusCodes[i] = p.status;
    const combo = packCombo(client, endpoint, p.status);
    this.comboCounts.set(combo, (this.comboCounts.get(combo) ?? 0) + 1);
  }

  finish(): ShardResult {
    return {
      linesRead: this.linesRead,
      blankLines: this.blankLines,
      malformedCount: this.malformedCount,
      malformedByReason: Object.fromEntries(this.malformedByReason),
      malformedExamples: this.malformedExamples,
      idHashes: this.idHashes.slice(0, this.n),
      timestamps: this.timestamps.slice(0, this.n),
      clientIdx: this.clientIdx.slice(0, this.n),
      endpointIdx: this.endpointIdx.slice(0, this.n),
      statusCodes: this.statusCodes.slice(0, this.n),
      clients: this.clients,
      endpoints: this.endpoints,
      comboCounts: this.comboCounts,
    };
  }

  private recordMalformed(reason: MalformedReason): void {
    this.malformedCount++;
    this.malformedByReason.set(reason, (this.malformedByReason.get(reason) ?? 0) + 1);
    if (this.malformedExamples.length < EXAMPLE_CAP) {
      this.malformedExamples.push({ line: this.linesRead, reason });
    }
  }

  private grow(): void {
    this.cap *= 2;
    const idHashes = new BigUint64Array(this.cap);
    idHashes.set(this.idHashes);
    this.idHashes = idHashes;
    const timestamps = new Float64Array(this.cap);
    timestamps.set(this.timestamps);
    this.timestamps = timestamps;
    const clientIdx = new Uint32Array(this.cap);
    clientIdx.set(this.clientIdx);
    this.clientIdx = clientIdx;
    const endpointIdx = new Uint32Array(this.cap);
    endpointIdx.set(this.endpointIdx);
    this.endpointIdx = endpointIdx;
    const statusCodes = new Uint16Array(this.cap);
    statusCodes.set(this.statusCodes);
    this.statusCodes = statusCodes;
  }
}

function intern(table: Map<string, number>, names: string[], name: string): number {
  const existing = table.get(name);
  if (existing !== undefined) return existing;
  const idx = names.length;
  table.set(name, idx);
  names.push(name);
  return idx;
}
