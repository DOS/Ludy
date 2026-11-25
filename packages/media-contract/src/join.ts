// SPDX-License-Identifier: AGPL-3.0-only
// The framing of /join-audio (#3175): the parts of one recording travel in ONE request body, so the sandbox needs no second call and keeps no state between calls. The body is a count (4 bytes,
// big-endian), then each part as its length (8 bytes, big-endian) and its bytes, and nothing after the last part. The sandbox reads the length of a part from the frame, never from a part's own
// container, and refuses a body whose frames do not add up exactly. No ffmpeg and no network here.
import { MEDIA_JOIN_FRAME, MEDIA_LIMITS } from './types.ts';

const JOIN_COUNT_BYTES = MEDIA_JOIN_FRAME.countBytes;
const JOIN_LENGTH_BYTES = MEDIA_JOIN_FRAME.lengthBytes;

export interface JoinPartSource {
  // The exact number of bytes `source` will produce: the frame says it before the bytes, and a source that produces another number aborts the call.
  length: number;
  source: AsyncIterable<Uint8Array>;
}

const countHeader = (count: number): Uint8Array => {
  const out = new Uint8Array(JOIN_COUNT_BYTES);
  new DataView(out.buffer).setUint32(0, count);
  return out;
};
const lengthHeader = (length: number): Uint8Array => {
  const out = new Uint8Array(JOIN_LENGTH_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(length));
  return out;
};

/**
 * The framed body of a join: the count, then each part's length and bytes, in the order given. A part that produces more or fewer bytes than it declared throws before the next frame, so the sandbox never sees
 * a body that is not exactly framed.
 */
export async function* framedParts(parts: readonly JoinPartSource[]): AsyncGenerator<Uint8Array> {
  if (parts.length < 1 || parts.length > MEDIA_LIMITS.maxJoinParts) throw new RangeError(`A join takes 1 to ${MEDIA_LIMITS.maxJoinParts} parts`);
  let reached = 0;
  try {
    yield countHeader(parts.length);
    for (const part of parts) {
      reached += 1;
      if (!Number.isSafeInteger(part.length) || part.length < 1) throw new RangeError('A part has at least one byte');
      yield lengthHeader(part.length);
      let sent = 0;
      for await (const chunk of part.source) {
        sent += chunk.byteLength;
        if (sent > part.length) throw new RangeError('A part produced more bytes than it declared');
        yield chunk;
      }
      if (sent !== part.length) throw new RangeError('A part produced fewer bytes than it declared');
    }
  } finally {
    // The parts after the one being read when this ended (an error, or the request cancelled) are never read: their sources are closed here, so nothing keeps a connection or a file open.
    for (const part of parts.slice(reached)) await part.source[Symbol.asyncIterator]().return?.().catch(() => undefined);
  }
}
