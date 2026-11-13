// SPDX-License-Identifier: AGPL-3.0-only
// The header of a live recording (#3110): a piece after the first is the middle of a stream, so it is read behind the header of the first.
import { describe, expect, it } from 'vitest';
import { liveContainerHeader, livePieceFile } from '../src/live-header.ts';

const bytes = (...parts: Array<number[] | Uint8Array>) => Uint8Array.from(parts.flatMap((p) => [...p]));
// EBML element: its id, a one byte data size, its data.
const element = (id: number[], data: number[]) => [...id, 0x80 | data.length, ...data];
const EBML_HEADER = element([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
// A Segment of unknown size (all ones in eight bytes), as a live MediaRecorder writes it, with an info and a tracks element before the first Cluster.
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO = element([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
const TRACKS = element([0x16, 0x54, 0xae, 0x6b], [0xae, 0x85, 0xd7, 0x81, 0x01, 0x83, 0x81]);
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const cluster = (fill: number, n = 20) => [...CLUSTER_ID, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...Array.from({ length: n }, () => fill)];

describe('liveContainerHeader', () => {
  it('cuts a WebM stream at its first Cluster: the EBML header and the Segment elements before it', () => {
    const header = bytes(EBML_HEADER, SEGMENT_UNKNOWN, INFO, TRACKS);
    const first = bytes(header, cluster(1));
    expect([...(liveContainerHeader(first) ?? [])]).toEqual([...header]);
  });

  it('does not stop at the bytes of a Cluster id that sit inside another element', () => {
    // The info element holds the four bytes of a Cluster id as data: the walk skips the element by its size, so it does not cut there.
    const trap = element([0x15, 0x49, 0xa9, 0x66], [...CLUSTER_ID, 0x00]);
    const header = bytes(EBML_HEADER, SEGMENT_UNKNOWN, trap, TRACKS);
    expect([...(liveContainerHeader(bytes(header, cluster(2))) ?? [])]).toEqual([...header]);
  });

  it('cuts a fragmented MP4 before its first moof: ftyp and moov', () => {
    const box = (type: string, size: number) => [0, 0, 0, size, ...[...type].map((c) => c.charCodeAt(0)), ...Array.from({ length: size - 8 }, () => 0)];
    const header = bytes(box('ftyp', 16), box('moov', 24));
    expect([...(liveContainerHeader(bytes(header, box('moof', 16), box('mdat', 20))) ?? [])]).toEqual([...header]);
  });

  it('answers null for a container it does not know, a stream cut short and a header with no Cluster', () => {
    expect(liveContainerHeader(bytes([0x4f, 0x67, 0x67, 0x53], Array.from({ length: 40 }, () => 0)))).toBeNull();
    expect(liveContainerHeader(bytes(EBML_HEADER.slice(0, 5)))).toBeNull();
    expect(liveContainerHeader(bytes(EBML_HEADER, SEGMENT_UNKNOWN, INFO, TRACKS))).toBeNull();
    expect(liveContainerHeader(new Uint8Array(0))).toBeNull();
    // An element whose size runs past the bytes: not a header.
    expect(liveContainerHeader(bytes(EBML_HEADER, SEGMENT_UNKNOWN, [0x15, 0x49, 0xa9, 0x66, 0xff]))).toBeNull();
  });
});

describe('livePieceFile', () => {
  const header = Uint8Array.from([1, 2, 3]);
  it('leaves the first piece as it is and puts the header in front of a later one', () => {
    const piece = Uint8Array.from([9, 9]);
    expect(livePieceFile(0, piece, header)).toBe(piece);
    expect([...livePieceFile(3, piece, header)]).toEqual([1, 2, 3, 9, 9]);
  });

  it('sends a later piece bare when there is no header to put in front of it', () => {
    const piece = Uint8Array.from([9, 9]);
    expect(livePieceFile(3, piece, null)).toBe(piece);
  });
});
