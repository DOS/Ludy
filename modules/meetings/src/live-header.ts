// SPDX-License-Identifier: AGPL-3.0-only
// The container header of a live recording (issue #3110, ADR-0052 L4a-2). The pieces of #3109 are consecutive slices of ONE MediaRecorder stream, so only the first
// one carries the header (the codec, the track, the timescale) and every later one starts in the middle of the stream: alone it is bytes no provider and no probe can
// read. To transcribe piece N the worker puts the header of piece 0 in front of it; this file finds that header. Pure bytes in, bytes out: no decoding, nothing logged.
//
//   WebM (Chrome, Edge, Firefox): the EBML header and the Segment's own elements (info, tracks), up to the first Cluster. The Segment of a live stream has an unknown
//                                 size, so the walk reads element headers and stops at the Cluster id.
//   MP4 (Safari, fragmented): the boxes before the first `moof` (ftyp and moov).
// Anything else is `null`, and the piece is then sent as it is (the provider answers for it; a window that fails keeps a fixed code).

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;

// An EBML element id: its length is the leading zero bits of the first byte plus one (1 to 4 bytes), and it keeps its length marker.
function readId(bytes: Uint8Array, at: number): { id: number; length: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 4 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 4 || at + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + (bytes[at + i] as number);
  return { id, length };
}

// An EBML data size (1 to 8 bytes, the marker removed); the all-ones value is "unknown" and comes back as null.
function readSize(bytes: Uint8Array, at: number): { size: number | null; length: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[at + i] as number;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : value, length };
}

function webmHeader(bytes: Uint8Array): Uint8Array | null {
  let at = 0;
  // The EBML header element, whole.
  const ebml = readId(bytes, at);
  if (!ebml || ebml.id !== EBML) return null;
  at += ebml.length;
  const ebmlSize = readSize(bytes, at);
  if (!ebmlSize || ebmlSize.size === null) return null;
  at += ebmlSize.length + ebmlSize.size;
  // The Segment: its header, then its children until the first Cluster.
  const segment = readId(bytes, at);
  if (!segment || segment.id !== SEGMENT) return null;
  at += segment.length;
  const segmentSize = readSize(bytes, at);
  if (!segmentSize) return null;
  at += segmentSize.length;
  while (at < bytes.length) {
    const child = readId(bytes, at);
    if (!child) return null;
    if (child.id === CLUSTER) return at > 0 ? bytes.slice(0, at) : null;
    const size = readSize(bytes, at + child.length);
    // A child of unknown size before the first Cluster is not a header this walk understands.
    if (!size || size.size === null) return null;
    at += child.length + size.length + size.size;
  }
  return null;
}

function mp4Header(bytes: Uint8Array): Uint8Array | null {
  let at = 0;
  let sawMoov = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4] as number, bytes[at + 5] as number, bytes[at + 6] as number, bytes[at + 7] as number);
    if (type === 'moof') return sawMoov ? bytes.slice(0, at) : null;
    if (type === 'moov') sawMoov = true;
    // 0 means "to the end" and 1 a 64 bit size: neither is a box of an init segment.
    if (size < 8) return null;
    at += size;
  }
  return null;
}

/** The header to put in front of a later piece, from the first piece's bytes, or null when the container is not one this knows. */
export function liveContainerHeader(first: Uint8Array): Uint8Array | null {
  if (first.length < 16) return null;
  if (first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3) return webmHeader(first);
  if (first[4] === 0x66 && first[5] === 0x74 && first[6] === 0x79 && first[7] === 0x70) return mp4Header(first);
  return null;
}

/** A file a provider can read for piece `seq`: the first piece as it is, any later one behind the header (or bare when there is none). */
export function livePieceFile(seq: number, piece: Uint8Array, header: Uint8Array | null): Uint8Array {
  if (seq === 0 || header === null) return piece;
  const out = new Uint8Array(header.length + piece.length);
  out.set(header, 0);
  out.set(piece, header.length);
  return out;
}
