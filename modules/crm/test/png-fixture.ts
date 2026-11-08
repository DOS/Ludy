// SPDX-License-Identifier: AGPL-3.0-only
// Test fixtures for the letterhead's logo (#2814): PNG files built here from plain samples, with every row filtered by one of the five PNG filters in turn so the reader's
// unfiltering is exercised, and JPEG headers (only the markers a reader of the frame header looks at; no picture). Not a product encoder.
import { deflateSync } from 'node:zlib';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, Buffer.from(body), crc]);
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export interface PngOptions {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  // Samples per pixel of the colour type, row after row (no filter bytes).
  samples: Uint8Array;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  depth?: number;
  interlace?: number;
  // The filter of row y is filters[y % filters.length]; default none.
  filters?: number[];
}

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function png(o: PngOptions): Buffer {
  const channels = CHANNELS[o.colorType] as number;
  const rowBytes = o.width * channels;
  const rows: Buffer[] = [];
  const filters = o.filters ?? [0];
  for (let y = 0; y < o.height; y++) {
    const filter = filters[y % filters.length] as number;
    const row = Buffer.alloc(rowBytes + 1);
    row[0] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const raw = o.samples[y * rowBytes + x] as number;
      const left = x >= channels ? (o.samples[y * rowBytes + x - channels] as number) : 0;
      const up = y > 0 ? (o.samples[(y - 1) * rowBytes + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (o.samples[(y - 1) * rowBytes + x - channels] as number) : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      row[x + 1] = (raw - predictor) & 0xff;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(o.width, 0);
  header.writeUInt32BE(o.height, 4);
  header[8] = o.depth ?? 8;
  header[9] = o.colorType;
  header[12] = o.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(o.palette ? [chunk('PLTE', o.palette)] : []),
    ...(o.transparency ? [chunk('tRNS', o.transparency)] : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The same file with the IDAT replaced by whatever bytes are given (compressed or not), for the malformed cases.
export function pngWithIdat(o: Omit<PngOptions, 'samples'>, idat: Uint8Array): Buffer {
  const base = png({ ...o, samples: new Uint8Array(o.width * o.height * (CHANNELS[o.colorType] as number)) });
  const at = base.indexOf('IDAT', 8, 'latin1') - 4;
  const length = base.readUInt32BE(at);
  return Buffer.concat([base.subarray(0, at), chunk('IDAT', idat), base.subarray(at + 12 + length)]);
}

// A JPEG that is only its markers: SOI, an APP0, the frame header of the given kind, an SOS and EOI. Readers of the frame header see what a picture would show; there is no picture.
export function jpeg(o: { marker?: number; width: number; height: number; components?: number; precision?: number }): Buffer {
  const components = o.components ?? 3;
  const frame = Buffer.alloc(8 + components * 3);
  frame.writeUInt16BE(frame.length, 0);
  frame[2] = o.precision ?? 8;
  frame.writeUInt16BE(o.height, 3);
  frame.writeUInt16BE(o.width, 5);
  frame[7] = components;
  for (let i = 0; i < components; i++) frame.set([i + 1, 0x11, 0], 8 + i * 3);
  const app0 = Buffer.from([0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), app0, Buffer.from([0xff, o.marker ?? 0xc0]), frame, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

// A colour that is easy to tell apart per pixel: a gradient over x and y, in `channels` samples.
export function gradient(width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) out[(y * width + x) * channels + c] = (x * 37 + y * 53 + c * 91 + ((x * y) % 7)) & 0xff;
  return out;
}
