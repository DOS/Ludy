// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { encodeQrMatrix, qrSvgPath } from '../src/lib/qr-svg.ts';

function readFormatWords(matrix: readonly (readonly boolean[])[]): { copy1: number; copy2: number } {
  const n = matrix.length;
  let copy1 = 0;
  let copy2 = 0;
  for (let k = 0; k < 15; k += 1) {
    const b1 =
      k < 6
        ? matrix[k]![8]!
        : k < 8
          ? matrix[k + 1]![8]!
          : k === 8
            ? matrix[8]![7]!
            : matrix[8]![14 - k]!;
    const b2 = k < 8 ? matrix[8]![n - 1 - k]! : matrix[n - 15 + k]![8]!;
    if (b1) copy1 |= 1 << k;
    if (b2) copy2 |= 1 << k;
  }
  return { copy1, copy2 };
}

function bchFormatSyndrome(unmasked: number): number {
  let d = unmasked;
  for (let i = 4; i >= 0; i -= 1) {
    if ((d >>> (i + 10)) & 1) d ^= 0x537 << i;
  }
  return d;
}

describe('encodeQrMatrix and qrSvgPath', () => {
  it('produces ISO/IEC 18004 compliant finder, timing, dark module, and matching format info across versions', () => {
    const samples = [
      'qr=short-1', // Version 1 (21x21)
      'https://app.ludy.vn/o/demo-org/hr/my?qr=secret-office-token-123', // Version 4 (33x33)
      `https://app.ludy.vn/o/cong-ty-tnhh-thuong-mai-crove/hr/my?qr=${'a'.repeat(110)}`, // Version 7+ (>= 45x45 with version info)
    ];

    for (const payload of samples) {
      const matrix = encodeQrMatrix(payload);
      const n = matrix.length;
      const version = (n - 17) / 4;
      expect(Number.isInteger(version)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(21);

      // Top-left, top-right, bottom-left 7x7 finder outer corners + center
      for (let i = 0; i < 7; i += 1) {
        expect(matrix[0]![i]).toBe(true);
        expect(matrix[6]![i]).toBe(true);
        expect(matrix[i]![0]).toBe(true);
        expect(matrix[i]![6]).toBe(true);
      }
      expect(matrix[3]![3]).toBe(true);
      expect(matrix[0]![n - 1]).toBe(true);
      expect(matrix[n - 1]![0]).toBe(true);

      // Mandatory ISO Dark Module at (4*V + 9, 8) = (n - 8, 8)
      expect(matrix[n - 8]![8]).toBe(true);

      // Timing pattern alternates cleanly at row 6 and col 6
      for (let i = 8; i < n - 8; i += 1) {
        expect(matrix[6]![i]).toBe(i % 2 === 0);
        expect(matrix[i]![6]).toBe(i % 2 === 0);
      }

      // Format info Copy 1 & Copy 2 match, pass BCH(15,5) syndrome = 0, and carry ECC Level L (0b01)
      const { copy1, copy2 } = readFormatWords(matrix);
      expect(copy1).toBe(copy2);
      const unmasked = copy1 ^ 0x5412;
      expect(bchFormatSyndrome(unmasked)).toBe(0);
      expect((unmasked >>> 13) & 0b11).toBe(0b01);

      const svg = qrSvgPath(matrix, 2);
      expect(svg.viewBox).toBe(`0 0 ${n + 4} ${n + 4}`);
      expect(svg.d.startsWith('M')).toBe(true);
    }
  });

  it('rejects payloads exceeding 271 UTF-8 bytes cleanly', () => {
    expect(() => encodeQrMatrix('x'.repeat(272))).toThrow(/too long/i);
  });
});
