import { GrowF64 } from '../pipeline/columnar.js';
import { HashSet64 } from '../pipeline/hash64.js';
import {
  COMBO_ENDPOINT_RADIX,
  EXAMPLE_CAP,
  MAX_CLIENTS,
  type MalformedExample,
  packCombo,
  type ShardResult,
  unpackCombo,
} from '../types.js';

/**
 * Merges shard results into global aggregates. Shards MUST be added in file
 * order: that is what makes first-wins deduplication and malformed-example
 * line numbers identical to a sequential run, and therefore makes output
 * independent of the worker count.
 *
 * The per-record merge loop does only deduplication, timeline building and
 * min/max tracking, reading hashes through a Uint32Array view (no BigInt
 * allocation). Counting is merged from the shards' pre-aggregated combo maps;
 * when a record turns out to be a cross- or intra-shard duplicate, its single
 * contribution is subtracted from its own shard's combo map before that map
 * is merged, so counts match a sequential dedup-then-count exactly.
 */
export class Aggregator {
  private dedup: HashSet64;

  private clientTable = new Map<string, number>();
  readonly clients: string[] = [];
  private endpointTable = new Map<string, number>();
  readonly endpoints: string[] = [];

  /** Global packCombo(client, endpoint, status) -> count. */
  private combos = new Map<number, number>();
  private readonly clientTs: GrowF64[] = [];

  linesRead = 0;
  blankLines = 0;
  duplicateLines = 0;
  validRequests = 0;
  malformedCount = 0;
  readonly malformedByReason = new Map<string, number>();
  readonly malformedExamples: MalformedExample[] = [];
  minTs = Infinity;
  maxTs = -Infinity;

  // Derived by finalize().
  readonly clientRequests: number[] = [];
  readonly clientStatus: Map<number, number>[] = [];
  readonly endpointRequests: number[] = [];
  readonly endpointClients: Set<number>[] = [];
  readonly endpointStatus: Map<number, number>[] = [];
  readonly statusTotals = new Map<number, number>();
  private finalized = false;

  /** expectedRecords pre-sizes the dedup table, avoiding rehashes on the
   * serial merge path when the caller already knows the total. */
  constructor(expectedRecords = 0) {
    this.dedup = new HashSet64(Math.max(1 << 16, Math.ceil((expectedRecords * 4) / 3)));
  }

  addShard(r: ShardResult): void {
    const lineOffset = this.linesRead;

    for (const [reason, count] of Object.entries(r.malformedByReason)) {
      this.malformedByReason.set(reason, (this.malformedByReason.get(reason) ?? 0) + count);
    }
    for (const ex of r.malformedExamples) {
      if (this.malformedExamples.length === EXAMPLE_CAP) break;
      this.malformedExamples.push({ line: lineOffset + ex.line, reason: ex.reason });
    }
    this.malformedCount += r.malformedCount;

    const records = r.timestamps.length;

    // Zero-allocation view over the id-hash column: element i occupies words
    // (2i, 2i+1). Word order is platform endianness, which is consistent
    // because hashes are written and read within the same process.
    const hashPairs = new Uint32Array(r.idHashes.buffer, 0, records * 2);
    const clientMap = new Int32Array(r.clients.length).fill(-1);

    for (let i = 0; i < records; i++) {
      if (!this.dedup.add(hashPairs[i * 2] as number, hashPairs[i * 2 + 1] as number)) {
        this.duplicateLines++;
        // Remove this record's single contribution from its shard's counts.
        const combo = packCombo(
          r.clientIdx[i] as number,
          r.endpointIdx[i] as number,
          r.statusCodes[i] as number,
        );
        r.comboCounts.set(combo, (r.comboCounts.get(combo) as number) - 1);
        continue;
      }
      const ts = r.timestamps[i] as number;
      this.validRequests++;
      if (ts < this.minTs) this.minTs = ts;
      if (ts > this.maxTs) this.maxTs = ts;

      const localClient = r.clientIdx[i] as number;
      let client = clientMap[localClient] as number;
      if (client === -1) {
        client = this.internClient(r.clients[localClient] as string);
        clientMap[localClient] = client;
      }
      (this.clientTs[client] as GrowF64).push(ts);
    }

    // Merge this shard's (already dup-corrected) counts.
    for (const [combo, count] of r.comboCounts) {
      if (count === 0) continue;
      const local = unpackCombo(combo);
      const client = clientMap[local.client] as number; // interned above: count>0 => kept record
      const endpoint = this.internEndpoint(r.endpoints[local.endpoint] as string);
      const global = packCombo(client, endpoint, local.status);
      this.combos.set(global, (this.combos.get(global) ?? 0) + count);
    }

    this.linesRead += r.linesRead;
    this.blankLines += r.blankLines;
  }

  /** Expand the global combo map into the per-client/per-endpoint tables. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    for (const [combo, count] of this.combos) {
      const { client, endpoint, status } = unpackCombo(combo);
      this.clientRequests[client] = (this.clientRequests[client] as number) + count;
      bump(this.clientStatus[client] as Map<number, number>, status, count);
      this.endpointRequests[endpoint] = (this.endpointRequests[endpoint] as number) + count;
      (this.endpointClients[endpoint] as Set<number>).add(client);
      bump(this.endpointStatus[endpoint] as Map<number, number>, status, count);
      bump(this.statusTotals, status, count);
    }
  }

  /** Sorted timestamp timeline for one client (by global index). */
  timeline(client: number): Float64Array {
    const ts = (this.clientTs[client] as GrowF64).finish();
    ts.sort();
    return ts;
  }

  private internClient(name: string): number {
    const existing = this.clientTable.get(name);
    if (existing !== undefined) return existing;
    const idx = this.clients.length;
    if (idx >= MAX_CLIENTS) throw new Error(`cardinality limit exceeded: ${idx} clients`);
    this.clientTable.set(name, idx);
    this.clients.push(name);
    this.clientTs.push(new GrowF64());
    this.clientRequests.push(0);
    this.clientStatus.push(new Map());
    return idx;
  }

  private internEndpoint(name: string): number {
    const existing = this.endpointTable.get(name);
    if (existing !== undefined) return existing;
    const idx = this.endpoints.length;
    if (idx >= COMBO_ENDPOINT_RADIX) {
      throw new Error(`cardinality limit exceeded: ${idx} endpoints`);
    }
    this.endpointTable.set(name, idx);
    this.endpoints.push(name);
    this.endpointRequests.push(0);
    this.endpointClients.push(new Set());
    this.endpointStatus.push(new Map());
    return idx;
  }
}

function bump(map: Map<number, number>, key: number, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
