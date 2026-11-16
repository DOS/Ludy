// SPDX-License-Identifier: AGPL-3.0-only
// Strict PNG signature validator for public signing submissions (#3324, docs/plan/esign.md).
// Strips only an exact data:image/png;base64, prefix, enforces canonical base64, size and pixel bounds,
// full chunk + CRC32 structure, and rejects trailing polyglot bytes or embedded SVG/HTML markup.
import { inflateSync } from 'node:zlib';
import {
  SIGN_SIGNATURE_PNG_BASE64_MAX,
  SIGN_SIGNATURE_PNG_MAX_BYTES,
  SIGN_SIGNATURE_PNG_MAX_HEIGHT,
  SIGN_SIGNATURE_PNG_MAX_WIDTH,
} from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_PNG_PREFIX = 'data:image/png;base64,';
const POLYGLOT_MARKUP_RE = /<\s*(?:svg|script|html|iframe|object|embed|!doctype)\b|on(?:load|error)\s*=/i;
const PNG_TEXT_MAX_DECOMPRESSED = 64 * 1024;

// IEEE 802.3 CRC-32 lookup table used by every PNG chunk trailer.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function invalidPng(detail: string): never {
  throw new DomainError('SIGN_INVALID_SIGNATURE_PNG', 422, detail);
}

function validPngColorAndDepth(colorType: number, bitDepth: number): boolean {
  switch (colorType) {
    case 0:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
    default:
      return false;
  }
}

function pngSamplesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 0;
  }
}

const ADAM7_X0 = [0, 4, 0, 2, 0, 1, 0];
const ADAM7_STEP_X = [8, 8, 4, 4, 2, 2, 1];
const ADAM7_Y0 = [0, 0, 4, 0, 2, 0, 1];
const ADAM7_STEP_Y = [8, 8, 8, 4, 4, 2, 2];

function pngPassRows(
  width: number,
  height: number,
  bppBits: number,
  interlace: number,
): Array<{ rows: number; rowStride: number }> {
  if (interlace === 0) {
    return [{ rows: height, rowStride: 1 + Math.ceil((width * bppBits) / 8) }];
  }
  const passes: Array<{ rows: number; rowStride: number }> = [];
  for (let p = 0; p < 7; p += 1) {
    const x0 = ADAM7_X0[p]!;
    const sx = ADAM7_STEP_X[p]!;
    const y0 = ADAM7_Y0[p]!;
    const sy = ADAM7_STEP_Y[p]!;
    if (width <= x0 || height <= y0) continue;
    const cols = Math.ceil((width - x0) / sx);
    const rows = Math.ceil((height - y0) / sy);
    passes.push({ rows, rowStride: 1 + Math.ceil((cols * bppBits) / 8) });
  }
  return passes;
}

function expectedPngIdatByteLength(width: number, height: number, colorType: number, bitDepth: number, interlace: number): number {
  const bppBits = pngSamplesPerPixel(colorType) * bitDepth;
  if (bppBits <= 0) return 0;
  let total = 0;
  for (const pass of pngPassRows(width, height, bppBits, interlace)) {
    total += pass.rows * pass.rowStride;
  }
  return total;
}

function validatePngScanlines(
  inflated: Buffer,
  width: number,
  height: number,
  colorType: number,
  bitDepth: number,
  interlace: number,
): boolean {
  const bppBits = pngSamplesPerPixel(colorType) * bitDepth;
  if (bppBits <= 0) return false;
  let offset = 0;
  for (const pass of pngPassRows(width, height, bppBits, interlace)) {
    for (let row = 0; row < pass.rows; row += 1) {
      // PNG specification allows only scanline filter types 0..4 (None, Sub, Up, Average, Paeth).
      if (offset >= inflated.byteLength || (inflated[offset] ?? 255) > 4) {
        return false;
      }
      offset += pass.rowStride;
    }
  }
  return offset === inflated.byteLength;
}

const PNG_IDAT_MAX_DECOMPRESSED = 18 * 1024 * 1024;

export interface ValidatedSignaturePng {
  base64: string;
  byteLength: number;
  width: number;
  height: number;
}

export function validateSignaturePngBase64(rawInput: string): ValidatedSignaturePng {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    invalidPng('Signature image payload is required');
  }
  let rawBase64 = rawInput;
  if (rawInput.startsWith('data:')) {
    if (!rawInput.startsWith(DATA_PNG_PREFIX)) {
      invalidPng('Signature image must be a PNG binary or data:image/png;base64 payload');
    }
    rawBase64 = rawInput.slice(DATA_PNG_PREFIX.length);
  }
  if (rawBase64.length === 0 || rawBase64.length > SIGN_SIGNATURE_PNG_BASE64_MAX || rawBase64.length % 4 !== 0 || !BASE64_RE.test(rawBase64)) {
    invalidPng('Signature image is not valid canonical base64 PNG data');
  }
  const bytes = Buffer.from(rawBase64, 'base64');
  if (bytes.toString('base64') !== rawBase64) {
    invalidPng('Signature image base64 encoding is malformed');
  }
  if (bytes.length < 45 || bytes.length > SIGN_SIGNATURE_PNG_MAX_BYTES) {
    invalidPng(`Signature PNG must be between 45 bytes and ${SIGN_SIGNATURE_PNG_MAX_BYTES} bytes`);
  }
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC[i]) {
      invalidPng('Signature image does not start with a valid PNG header');
    }
  }

  let offset = PNG_MAGIC.length;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawPlte = false;
  let plteEntries = 0;
  let sawTrns = false;
  let sawBkgd = false;
  let sawGama = false;
  let sawChrm = false;
  let sawSrgb = false;
  let sawIccp = false;
  let sawSbit = false;
  let sawPhys = false;
  let sawTime = false;
  let lastChunkType = '';
  const idatChunks: Buffer[] = [];
  let sawIend = false;

  while (offset < bytes.length) {
    if (sawIend) {
      invalidPng('Signature PNG contains trailing bytes after IEND');
    }
    if (offset + 12 > bytes.length) {
      invalidPng('Signature PNG chunk header is truncated');
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (length > bytes.length || crcOffset + 4 > bytes.length) {
      invalidPng('Signature PNG chunk length exceeds buffer bounds');
    }
    for (let i = typeStart; i < dataStart; i += 1) {
      const byte = bytes[i]!;
      if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) {
        invalidPng('Signature PNG contains an invalid chunk type');
      }
    }
    const chunkType = bytes.subarray(typeStart, dataStart).toString('latin1');
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = crc32(bytes, typeStart, dataEnd);
    if (expectedCrc !== actualCrc) {
      invalidPng(`Signature PNG chunk ${chunkType} failed CRC32 verification`);
    }

    if (chunkIndex === 0) {
      if (chunkType !== 'IHDR' || length !== 13) {
        invalidPng('Signature PNG must start with a valid 13-byte IHDR chunk');
      }
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      interlace = bytes[dataStart + 12]!;
      if (
        width < 1 ||
        width > SIGN_SIGNATURE_PNG_MAX_WIDTH ||
        height < 1 ||
        height > SIGN_SIGNATURE_PNG_MAX_HEIGHT ||
        !validPngColorAndDepth(colorType, bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        invalidPng('Signature PNG IHDR dimensions or color mode exceed allowed limits');
      }
    } else if (chunkType === 'IHDR') {
      invalidPng('Signature PNG contains duplicate IHDR chunks');
    } else if (chunkType === 'acTL' || chunkType === 'fcTL' || chunkType === 'fdAT') {
      invalidPng('Signature PNG must not be animated (APNG)');
    } else if (chunkType === 'PLTE') {
      if (
        colorType === 0 ||
        colorType === 4 ||
        idatChunks.length > 0 ||
        sawPlte ||
        sawTrns ||
        sawBkgd ||
        length < 3 ||
        length > 256 * 3 ||
        length % 3 !== 0
      ) {
        invalidPng('Signature PNG PLTE chunk is malformed or out of order');
      }
      sawPlte = true;
      plteEntries = length / 3;
    } else if (chunkType === 'IDAT') {
      if (idatChunks.length > 0 && lastChunkType !== 'IDAT') {
        invalidPng('Signature PNG contains non-contiguous IDAT chunks');
      }
      if (length > 0) {
        idatChunks.push(bytes.subarray(dataStart, dataEnd));
      }
    } else if (chunkType === 'tRNS') {
      if (idatChunks.length > 0 || sawTrns || colorType === 4 || colorType === 6) {
        invalidPng('Signature PNG tRNS chunk is invalid or out of order');
      }
      if (colorType === 3 && (!sawPlte || length < 1 || length > plteEntries)) {
        invalidPng('Signature PNG indexed tRNS chunk is missing PLTE or exceeds palette size');
      }
      if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6)) {
        invalidPng('Signature PNG tRNS chunk length is invalid for color mode');
      }
      sawTrns = true;
    } else if (chunkType === 'bKGD') {
      if (idatChunks.length > 0 || sawBkgd) {
        invalidPng('Signature PNG bKGD chunk is duplicated or out of order');
      }
      if ((colorType === 0 || colorType === 4) && length !== 2) {
        invalidPng('Signature PNG bKGD chunk length is invalid');
      }
      if ((colorType === 2 || colorType === 6) && length !== 6) {
        invalidPng('Signature PNG bKGD chunk length is invalid');
      }
      if (colorType === 3 && (!sawPlte || length !== 1 || bytes[dataStart]! >= plteEntries)) {
        invalidPng('Signature PNG indexed bKGD chunk is missing PLTE or out of range');
      }
      sawBkgd = true;
    } else if (chunkType === 'gAMA') {
      if (idatChunks.length > 0 || sawGama || length !== 4) {
        invalidPng('Signature PNG gAMA chunk is invalid or out of order');
      }
      sawGama = true;
    } else if (chunkType === 'cHRM') {
      if (idatChunks.length > 0 || sawChrm || length !== 32) {
        invalidPng('Signature PNG cHRM chunk is invalid or out of order');
      }
      sawChrm = true;
    } else if (chunkType === 'sRGB') {
      if (idatChunks.length > 0 || sawSrgb || sawIccp || length !== 1 || bytes[dataStart]! > 3) {
        invalidPng('Signature PNG sRGB chunk is invalid or out of order');
      }
      sawSrgb = true;
    } else if (chunkType === 'iCCP') {
      if (sawPlte || idatChunks.length > 0 || sawIccp || sawSrgb) {
        invalidPng('Signature PNG iCCP chunk is invalid or out of order');
      }
      sawIccp = true;
    } else if (chunkType === 'sBIT') {
      const expectedSbit = colorType === 3 ? 3 : pngSamplesPerPixel(colorType);
      if (sawPlte || idatChunks.length > 0 || sawSbit || length !== expectedSbit) {
        invalidPng('Signature PNG sBIT chunk is invalid or out of order');
      }
      sawSbit = true;
    } else if (chunkType === 'pHYs') {
      if (idatChunks.length > 0 || sawPhys || length !== 9) {
        invalidPng('Signature PNG pHYs chunk is invalid or out of order');
      }
      sawPhys = true;
    } else if (chunkType === 'tIME') {
      if (sawTime || length !== 7) {
        invalidPng('Signature PNG tIME chunk is invalid or duplicated');
      }
      sawTime = true;
    } else if (chunkType === 'tEXt' || chunkType === 'zTXt' || chunkType === 'iTXt') {
      const chunkBytes = bytes.subarray(dataStart, dataEnd);
      const rawText = chunkBytes.toString('utf8');
      if (POLYGLOT_MARKUP_RE.test(rawText)) {
        invalidPng('Signature PNG contains disallowed embedded markup');
      }
      if (chunkType === 'tEXt') {
        const nullIdx = chunkBytes.indexOf(0);
        if (nullIdx < 1 || nullIdx > 79) {
          invalidPng('Signature PNG tEXt chunk is malformed');
        }
      } else if (chunkType === 'zTXt') {
        const nullIdx = chunkBytes.indexOf(0);
        if (nullIdx <= 0 || nullIdx + 2 >= chunkBytes.length || chunkBytes[nullIdx + 1] !== 0) {
          invalidPng('Signature PNG zTXt chunk is malformed');
        }
        let inflated: Buffer;
        try {
          inflated = inflateSync(chunkBytes.subarray(nullIdx + 2), { maxOutputLength: PNG_TEXT_MAX_DECOMPRESSED });
        } catch {
          invalidPng('Signature PNG zTXt chunk failed decompression');
        }
        if (POLYGLOT_MARKUP_RE.test(inflated.toString('utf8'))) {
          invalidPng('Signature PNG contains disallowed embedded markup');
        }
      } else if (chunkType === 'iTXt') {
        const firstNull = chunkBytes.indexOf(0);
        if (firstNull <= 0 || firstNull + 3 >= chunkBytes.length) {
          invalidPng('Signature PNG iTXt chunk is malformed');
        }
        const compFlag = chunkBytes[firstNull + 1]!;
        const compMethod = chunkBytes[firstNull + 2]!;
        const langEnd = chunkBytes.indexOf(0, firstNull + 3);
        const transEnd = langEnd >= 0 ? chunkBytes.indexOf(0, langEnd + 1) : -1;
        if (langEnd < 0 || transEnd < 0) {
          invalidPng('Signature PNG iTXt header is malformed');
        }
        const body = chunkBytes.subarray(transEnd + 1);
        if (compFlag === 1) {
          if (compMethod !== 0) {
            invalidPng('Signature PNG iTXt compression method is unsupported');
          }
          let inflated: Buffer;
          try {
            inflated = inflateSync(body, { maxOutputLength: PNG_TEXT_MAX_DECOMPRESSED });
          } catch {
            invalidPng('Signature PNG iTXt chunk failed decompression');
          }
          if (POLYGLOT_MARKUP_RE.test(inflated.toString('utf8'))) {
            invalidPng('Signature PNG contains disallowed embedded markup');
          }
        } else if (compFlag === 0) {
          if (POLYGLOT_MARKUP_RE.test(body.toString('utf8'))) {
            invalidPng('Signature PNG contains disallowed embedded markup');
          }
        } else {
          invalidPng('Signature PNG iTXt compression flag is invalid');
        }
      }
    } else if (chunkType === 'IEND') {
      if (length !== 0) {
        invalidPng('Signature PNG IEND chunk must be empty');
      }
      sawIend = true;
    } else {
      invalidPng(`Signature PNG contains unsupported chunk ${chunkType}`);
    }

    lastChunkType = chunkType;
    offset = crcOffset + 4;
    chunkIndex += 1;
  }

  if (!sawIend || idatChunks.length === 0 || offset !== bytes.length) {
    invalidPng('Signature PNG is missing required IDAT or IEND chunks');
  }
  if (colorType === 3 && (!sawPlte || plteEntries > 2 ** bitDepth)) {
    invalidPng('Signature PNG indexed-color image is missing a valid PLTE palette');
  }

  const expectedIdatBytes = expectedPngIdatByteLength(width, height, colorType, bitDepth, interlace);
  if (expectedIdatBytes <= 0 || expectedIdatBytes > PNG_IDAT_MAX_DECOMPRESSED) {
    invalidPng('Signature PNG decoded image size exceeds allowed limits');
  }
  let inflatedIdat: Buffer;
  try {
    inflatedIdat = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedIdatBytes });
  } catch {
    invalidPng('Signature PNG image data stream is malformed');
  }
  if (inflatedIdat.byteLength !== expectedIdatBytes) {
    invalidPng('Signature PNG image data dimensions do not match IHDR');
  }
  if (!validatePngScanlines(inflatedIdat, width, height, colorType, bitDepth, interlace)) {
    invalidPng('Signature PNG contains an invalid scanline filter method');
  }

  return {
    base64: rawBase64,
    byteLength: bytes.length,
    width,
    height,
  };
}
