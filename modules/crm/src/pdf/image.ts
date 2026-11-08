// SPDX-License-Identifier: AGPL-3.0-only
// The logo of a quote's letterhead as the PDF writer takes it (issue #2814, plan docs/plan/crm-quotes.md section 4.6). This is the one place the writer meets a file a member supplied, so it is
// kept small and strict: it reads only the header it needs of a JPEG (the file goes into the PDF as it is, never decoded or re-encoded) and decodes a PNG into plain pixels, and it gives
// up quietly (null: the document is made without a logo) on anything it does not take. It never throws, never reads beyond the bytes it is given, and bounds what it allocates by the
// image's own size, which is capped before anything is inflated, so a small file that claims a huge picture costs nothing.
//
// Taken: a baseline, extended or progressive JPEG of one or three 8-bit components; a PNG of 8 bits per sample, not interlaced, as gray, gray and alpha, RGB, RGBA or palette (with
// its transparency). Not taken, so no logo on the PDF (the page and the screen are not affected): a 16-bit or interlaced PNG, a CMYK or lossless or arithmetic-coded JPEG, a picture over
// MAX_SIDE on a side or MAX_PIXELS in all.
import { inflateSync } from 'node:zlib';

export const MAX_SIDE = 4096;
export const MAX_PIXELS = 4 * 1024 * 1024;

// What the writer embeds: the picture's size, and its colour as either a JPEG file (written as is, DCTDecode) or plain 8-bit samples (written deflated), with an optional 8-bit alpha plane.
export interface PdfImage {
  readonly width: number;
  readonly height: number;
  readonly space: 'DeviceGray' | 'DeviceRGB';
  readonly colour: { readonly kind: 'jpeg'; readonly data: Uint8Array } | { readonly kind: 'raw'; readonly data: Uint8Array };
  readonly alpha: Uint8Array | null;
}

const fits = (width: number, height: number): boolean => width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;

// A JPEG: only its markers are read, up to the frame header.
function readJpeg(bytes: Uint8Array): PdfImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const u16 = (at: number) => ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1] as number;
    // Fill bytes before a marker.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1] as number;
    }
    // Markers with no length: a standalone one.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = u16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    // The frame header: baseline (C0), extended sequential (C1), progressive (C2). Every other frame type is not taken.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return null;
      const precision = bytes[at + 4] as number;
      const height = u16(at + 5);
      const width = u16(at + 7);
      const components = bytes[at + 9] as number;
      if (precision !== 8 || (components !== 1 && components !== 3) || !fits(width, height)) return null;
      return { width, height, space: components === 1 ? 'DeviceGray' : 'DeviceRGB', colour: { kind: 'jpeg', data: bytes }, alpha: null };
    }
    if ((marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) || marker === 0xda || marker === 0xd9) return null;
    at += 2 + length;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Undoes the PNG filters of every row, in place: `data` is height rows of one filter byte and `rowBytes` samples; the result is height rows of samples.
function unfilter(data: Uint8Array, rowBytes: number, height: number, bytesPerPixel: number): Uint8Array | null {
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)] as number;
    const from = y * (rowBytes + 1) + 1;
    const to = y * rowBytes;
    const above = to - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[from + x] as number;
      const left = x >= bytesPerPixel ? (out[to + x - bytesPerPixel] as number) : 0;
      const up = y > 0 ? (out[above + x] as number) : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? (out[above + x - bytesPerPixel] as number) : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          return null;
      }
      out[to + x] = (raw + predictor) & 0xff;
    }
  }
  return out;
}

function readPng(bytes: Uint8Array): PdfImage | null {
  if (bytes.length < 33 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: { width: number; height: number; colorType: number } | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let at = 8;
  let ended = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const start = at + 8;
    if (length > bytes.length || start + length + 4 > bytes.length) return null;
    const type = String.fromCharCode(bytes[at + 4] as number, bytes[at + 5] as number, bytes[at + 6] as number, bytes[at + 7] as number);
    const body = bytes.subarray(start, start + length);
    if (type === 'IHDR') {
      if (length !== 13 || header) return null;
      const width = view.getUint32(start);
      const height = view.getUint32(start + 4);
      const [depth, colorType, compression, filter, interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0 || colorType === undefined || CHANNELS[colorType] === undefined || !fits(width, height)) return null;
      header = { width, height, colorType };
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idatBytes += length;
      if (idatBytes > bytes.length) return null;
      idat.push(body);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    at = start + length + 4;
  }
  if (!header || !ended || idat.length === 0) return null;
  const { width, height, colorType } = header;
  const channels = CHANNELS[colorType] as number;
  const rowBytes = width * channels;
  const expected = (rowBytes + 1) * height;
  let inflated: Uint8Array;
  try {
    // The size the header promises is the most that is allowed out: a stream that would grow beyond it is a bomb, and throws.
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return null;
  }
  if (inflated.length !== expected) return null;
  const pixels = unfilter(inflated, rowBytes, height, channels);
  if (!pixels) return null;
  const count = width * height;
  const alphaOf = (plane: Uint8Array): Uint8Array | null => (plane.every((v) => v === 255) ? null : plane);
  if (colorType === 0) return { width, height, space: 'DeviceGray', colour: { kind: 'raw', data: pixels }, alpha: null };
  if (colorType === 2) return { width, height, space: 'DeviceRGB', colour: { kind: 'raw', data: pixels }, alpha: null };
  if (colorType === 4 || colorType === 6) {
    const colourChannels = channels - 1;
    const colour = new Uint8Array(count * colourChannels);
    const alpha = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < colourChannels; c++) colour[i * colourChannels + c] = pixels[i * channels + c] as number;
      alpha[i] = pixels[i * channels + colourChannels] as number;
    }
    return { width, height, space: colourChannels === 1 ? 'DeviceGray' : 'DeviceRGB', colour: { kind: 'raw', data: colour }, alpha: alphaOf(alpha) };
  }
  // A palette: every index must name an entry.
  if (!palette || palette.length === 0 || palette.length % 3 !== 0) return null;
  const entries = palette.length / 3;
  const colour = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const index = pixels[i] as number;
    if (index >= entries) return null;
    colour[i * 3] = palette[index * 3] as number;
    colour[i * 3 + 1] = palette[index * 3 + 1] as number;
    colour[i * 3 + 2] = palette[index * 3 + 2] as number;
    alpha[i] = transparency && index < transparency.length ? (transparency[index] as number) : 255;
  }
  return { width, height, space: 'DeviceRGB', colour: { kind: 'raw', data: colour }, alpha: alphaOf(alpha) };
}

// The image of a logo file, by the type the file row says; null for anything not taken (and for bytes that are not that type).
export function readLogoImage(bytes: Uint8Array, contentType: string): PdfImage | null {
  try {
    if (contentType === 'image/jpeg') return readJpeg(bytes);
    if (contentType === 'image/png') return readPng(bytes);
    return null;
  } catch {
    return null;
  }
}
