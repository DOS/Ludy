// SPDX-License-Identifier: AGPL-3.0-only
// Dependency-free ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1..10)
// for rendering offline printable office attendance QR posters without external services or new packages.

interface QrVersionSpec {
  version: number;
  size: number;
  totalCodewords: number;
  dataCodewords: number;
  ecPerBlock: number;
  blocksGroup1: number;
  dataPerGroup1: number;
  blocksGroup2: number;
  dataPerGroup2: number;
  alignments: readonly number[];
}

// Level L specs for Byte mode versions 1..10 (holds up to 271 UTF-8 bytes cleanly).
const VERSION_SPECS: readonly QrVersionSpec[] = [
  { version: 1, size: 21, totalCodewords: 26, dataCodewords: 19, ecPerBlock: 7, blocksGroup1: 1, dataPerGroup1: 19, blocksGroup2: 0, dataPerGroup2: 0, alignments: [] },
  { version: 2, size: 25, totalCodewords: 44, dataCodewords: 34, ecPerBlock: 10, blocksGroup1: 1, dataPerGroup1: 34, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, dataCodewords: 55, ecPerBlock: 15, blocksGroup1: 1, dataPerGroup1: 55, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, dataCodewords: 80, ecPerBlock: 20, blocksGroup1: 1, dataPerGroup1: 80, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, dataCodewords: 108, ecPerBlock: 26, blocksGroup1: 1, dataPerGroup1: 108, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, dataCodewords: 136, ecPerBlock: 18, blocksGroup1: 2, dataPerGroup1: 68, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 34] },
  { version: 7, size: 45, totalCodewords: 196, dataCodewords: 156, ecPerBlock: 20, blocksGroup1: 2, dataPerGroup1: 78, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 22, 38] },
  { version: 8, size: 49, totalCodewords: 242, dataCodewords: 194, ecPerBlock: 24, blocksGroup1: 2, dataPerGroup1: 97, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 24, 42] },
  { version: 9, size: 53, totalCodewords: 292, dataCodewords: 232, ecPerBlock: 30, blocksGroup1: 2, dataPerGroup1: 116, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 26, 46] },
  { version: 10, size: 57, totalCodewords: 346, dataCodewords: 274, ecPerBlock: 18, blocksGroup1: 2, dataPerGroup1: 68, blocksGroup2: 2, dataPerGroup2: 69, alignments: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: readonly number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const coeff = res[i]!;
    if (coeff !== 0) {
      for (let j = 0; j < gen.length; j += 1) {
        res[i + j] = (res[i + j] ?? 0) ^ gfMul(gen[j]!, coeff);
      }
    }
  }
  return Array.from(res.slice(data.length));
}

function pushBits(bits: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function pickVersion(byteLength: number): QrVersionSpec {
  for (const spec of VERSION_SPECS) {
    const headerBits = 4 + (spec.version <= 9 ? 8 : 16);
    const capacityBytes = Math.floor((spec.dataCodewords * 8 - headerBits) / 8);
    if (byteLength <= capacityBytes) return spec;
  }
  throw new Error(`QR payload too long (${byteLength} bytes, max 271)`);
}

function encodeCodewords(bytes: Uint8Array, spec: QrVersionSpec): number[] {
  const bits: number[] = [];
  // Byte mode indicator (0100) + character count
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);

  const totalDataBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b]!;
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.dataCodewords) {
    codewords.push(padBytes[padIdx % 2]!);
    padIdx += 1;
  }

  // Split into RS blocks & interleave
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.blocksGroup1; i += 1) {
    const slice = codewords.slice(offset, offset + spec.dataPerGroup1);
    offset += spec.dataPerGroup1;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.blocksGroup2; i += 1) {
    const slice = codewords.slice(offset, offset + spec.dataPerGroup2);
    offset += spec.dataPerGroup2;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
  }

  const out: number[] = [];
  const maxDataLen = Math.max(spec.dataPerGroup1, spec.dataPerGroup2);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i]!);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const blk of ecBlocks) out.push(blk[i]!);
  }
  return out;
}

function createMatrix(size: number): { modules: (boolean | null)[][]; reserved: boolean[][] } {
  const modules = Array.from({ length: size }, () => Array<boolean | null>(size).fill(null));
  const reserved = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  return { modules, reserved };
}

function setFunction(
  modules: (boolean | null)[][],
  reserved: boolean[][],
  row: number,
  col: number,
  dark: boolean,
): void {
  if (row < 0 || col < 0 || row >= modules.length || col >= modules.length) return;
  modules[row]![col] = dark;
  reserved[row]![col] = true;
}

function placeFinder(modules: (boolean | null)[][], reserved: boolean[][], top: number, left: number): void {
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = top + dr;
      const c = left + dc;
      if (r < 0 || c < 0 || r >= modules.length || c >= modules.length) continue;
      const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark =
        inOuter &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      setFunction(modules, reserved, r, c, dark);
    }
  }
}

function placeAlignment(modules: (boolean | null)[][], reserved: boolean[][], centerR: number, centerC: number): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
      setFunction(modules, reserved, centerR + dr, centerC + dc, dark);
    }
  }
}

function computeBchFormatInfo(mask: number): number {
  // ECC Level L = 01 (2 bits) + mask (3 bits)
  const data = (0b01 << 3) | mask;
  let d = data << 10;
  const gen = 0x537;
  for (let i = 4; i >= 0; i -= 1) {
    if ((d >>> (i + 10)) & 1) d ^= gen << i;
  }
  return ((data << 10) | d) ^ 0x5412;
}

function computeBchVersionInfo(version: number): number {
  let d = version << 12;
  const gen = 0x1f25;
  for (let i = 5; i >= 0; i -= 1) {
    if ((d >>> (i + 12)) & 1) d ^= gen << i;
  }
  return (version << 12) | d;
}

function applyMaskPattern(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;

  // Rule 1: 5+ adjacent same-color modules in row/col
  for (let r = 0; r < n; r += 1) {
    let runColor = grid[r]![0]!;
    let runLen = 1;
    for (let c = 1; c < n; c += 1) {
      if (grid[r]![c]! === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = grid[r]![c]!;
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < n; c += 1) {
    let runColor = grid[0]![c]!;
    let runLen = 1;
    for (let r = 1; r < n; r += 1) {
      if (grid[r]![c]! === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = grid[r]![c]!;
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = grid[r]![c]!;
      if (grid[r]![c + 1] === v && grid[r + 1]![c] === v && grid[r + 1]![c + 1] === v) {
        score += 3;
      }
    }
  }

  // Rule 4: dark ratio balance
  let darkCount = 0;
  for (const row of grid) for (const cell of row) if (cell) darkCount += 1;
  const pct = (darkCount * 100) / (n * n);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  score += k * 10;
  return score;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const spec = pickVersion(bytes.length);
  const codewords = encodeCodewords(bytes, spec);
  const size = spec.size;
  const { modules, reserved } = createMatrix(size);

  // Finder patterns
  placeFinder(modules, reserved, 0, 0);
  placeFinder(modules, reserved, 0, size - 7);
  placeFinder(modules, reserved, size - 7, 0);

  // Alignment patterns (skip corners where finders live)
  for (const r of spec.alignments) {
    for (const c of spec.alignments) {
      if (reserved[r]![c]) continue;
      placeAlignment(modules, reserved, r, c);
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    if (!reserved[6]![i]) setFunction(modules, reserved, 6, i, i % 2 === 0);
    if (!reserved[i]![6]) setFunction(modules, reserved, i, 6, i % 2 === 0);
  }

  // Dark module
  setFunction(modules, reserved, 4 * spec.version + 9, 8, true);

  // Reserve format info cells (populated per mask candidate)
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8]![i]) reserved[8]![i] = true;
    if (!reserved[i]![8]) reserved[i]![8] = true;
  }
  for (let i = size - 8; i < size; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }

  // Version info for >= 7
  if (spec.version >= 7) {
    const vInfo = computeBchVersionInfo(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vInfo >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFunction(modules, reserved, r, c, bit);
      setFunction(modules, reserved, c, r, bit);
    }
  }

  // Place data bits in standard zigzag columns right-to-left skipping col 6
  const bitStream: number[] = [];
  for (const cw of codewords) pushBits(bitStream, cw, 8);
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const r = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!reserved[r]![c]) {
          const bit = bitIdx < bitStream.length ? bitStream[bitIdx]! === 1 : false;
          modules[r]![c] = bit;
          bitIdx += 1;
        }
      }
    }
    upward = !upward;
  }

  // Pick optimal mask
  let bestGrid: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row, r) =>
      row.map((val, c) => (reserved[r]![c] ? Boolean(val) : Boolean(val) !== applyMaskPattern(mask, r, c))),
    );
    const fmt = computeBchFormatInfo(mask);
    for (let k = 0; k < 15; k += 1) {
      const bit = ((fmt >>> k) & 1) === 1;
      // Copy 1 (ISO/IEC 18004 Fig. 25): LSB k=0..5 at (0..5,8), k=6..7 at (7..8,8), k=8 at (8,7), k=9..14 at (8,5..0)
      if (k < 6) candidate[k]![8] = bit;
      else if (k < 8) candidate[k + 1]![8] = bit;
      else if (k === 8) candidate[8]![7] = bit;
      else candidate[8]![14 - k] = bit;

      // Copy 2: LSB k=0..7 at (8,size-1..size-8), MSB k=8..14 at (size-7..size-1,8); leaves Dark Module (size-8,8) intact
      if (k < 8) candidate[8]![size - 1 - k] = bit;
      else candidate[size - 15 + k]![8] = bit;
    }
    const s = penaltyScore(candidate);
    if (s < bestScore) {
      bestScore = s;
      bestGrid = candidate;
    }
  }
  return bestGrid!;
}

/** Converts QR boolean matrix to compact SVG `<path>` `d` attribute at 1-module unit grid. */
export function qrSvgPath(matrix: readonly (readonly boolean[])[], quietZone = 2): {
  viewBox: string;
  d: string;
  size: number;
} {
  const n = matrix.length;
  const full = n + quietZone * 2;
  const parts: string[] = [];
  for (let r = 0; r < n; r += 1) {
    const row = matrix[r]!;
    for (let c = 0; c < n; c += 1) {
      if (row[c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return { viewBox: `0 0 ${full} ${full}`, d: parts.join(''), size: full };
}
