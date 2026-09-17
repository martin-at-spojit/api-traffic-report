import type { ShardBuilder } from './columnar.js';
import { parseLine } from './parse.js';

/** Lines above this size are counted as malformed without being decoded. */
export const MAX_LINE_BYTES = 1 << 20;

/** Read-buffer size for every input stream, file shards and stdin alike. */
export const READ_CHUNK = 1 << 20;

const NL = 0x0a;
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode one line's bytes, or return null on invalid UTF-8.
 *
 * Fast path: Buffer.toString, which never throws but substitutes U+FFFD for
 * invalid sequences. Only when a U+FFFD is present (rare) do we re-decode
 * strictly to distinguish genuinely broken bytes from a legitimate U+FFFD
 * character in the input.
 */
function decodeLine(buf: Buffer): string | null {
  const s = buf.toString('utf8');
  if (s.includes('�')) {
    try {
      return fatalDecoder.decode(buf);
    } catch {
      return null;
    }
  }
  return s;
}

export interface ShardIO {
  chunks: AsyncIterable<Buffer>;
  /** Absolute byte offset of the first byte `chunks` yields. */
  streamStart: number;
  /** Only lines that START at offsets below this are processed. */
  endOffset: number;
  /**
   * Discard bytes up to and including the first newline. Shards with
   * start > 0 open their stream at start-1: if the byte at start-1 is a
   * newline, a line begins exactly at our boundary and only that newline is
   * skipped; otherwise the tail of a line owned by the previous shard is
   * skipped. Either way every line is processed by exactly one shard.
   */
  skipFirstLine: boolean;
  /** Strip a UTF-8 BOM from the first line (only at file offset 0). */
  stripBom: boolean;
}

/**
 * Split a byte stream into lines and feed them to the builder. A line belongs
 * to the shard containing its first byte; the final line of a shard is
 * followed to completion even when it extends past endOffset.
 */
export async function processShard(io: ShardIO, builder: ShardBuilder): Promise<void> {
  let discarding = io.skipFirstLine;
  let firstLine = true;
  let chunkStart = io.streamStart;
  let stop = false;

  /** Stored bytes of the in-progress line (dropped once over the size cap). */
  let segments: Buffer[] = [];
  /** True byte length of the in-progress line, including unstored bytes. */
  let pendingBytes = 0;

  const emit = (tail: Buffer): void => {
    const total = pendingBytes + tail.length;
    // The size cap applies to the logical line: a trailing CR left by a CRLF
    // terminator is not counted, so the same content is classified the same
    // way whichever line-ending style produced it.
    let lastByte = -1;
    if (tail.length > 0) {
      lastByte = tail[tail.length - 1] as number;
    } else if (segments.length > 0) {
      const seg = segments[segments.length - 1] as Buffer;
      lastByte = seg[seg.length - 1] as number;
    }
    const effective = lastByte === 0x0d ? total - 1 : total;
    if (effective > MAX_LINE_BYTES) {
      builder.addMalformedLine('line_too_long');
    } else {
      const buf = segments.length === 0 ? tail : Buffer.concat([...segments, tail], total);
      let text = decodeLine(buf);
      if (text === null) {
        builder.addMalformedLine('invalid_utf8');
      } else {
        if (firstLine && io.stripBom && text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
        if (text.endsWith('\r')) text = text.slice(0, -1);
        builder.addParsed(parseLine(text));
      }
    }
    firstLine = false;
    segments = [];
    pendingBytes = 0;
  };

  const accumulate = (part: Buffer): void => {
    if (part.length === 0) return;
    pendingBytes += part.length;
    // One byte of slack keeps a possible trailing CR decodable at the cap.
    if (pendingBytes <= MAX_LINE_BYTES + 1) {
      segments.push(part);
    } else {
      segments = [];
    }
  };

  for await (const chunk of io.chunks) {
    let idx = 0;
    while (idx < chunk.length) {
      const nl = chunk.indexOf(NL, idx);
      if (nl === -1) {
        if (!discarding) accumulate(chunk.subarray(idx));
        break;
      }
      if (discarding) {
        discarding = false;
      } else {
        emit(chunk.subarray(idx, nl));
      }
      idx = nl + 1;
      if (chunkStart + idx >= io.endOffset) {
        stop = true;
        break;
      }
    }
    chunkStart += chunk.length;
    if (stop) break;
  }

  if (!stop && !discarding && pendingBytes > 0) {
    emit(Buffer.alloc(0));
  }
}
