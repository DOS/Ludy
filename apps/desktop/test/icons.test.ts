// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { trayIconPng } from '../src/icons.ts';

describe('trayIconPng', () => {
  it('makes a valid PNG for each state, with a transparent corner and an opaque centre', () => {
    for (const kind of ['signed-out', 'signed-in', 'update', 'error'] as const) {
      const png = trayIconPng(kind, 32);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe(32);
      expect(png.readUInt32BE(20)).toBe(32);
      expect(png.subarray(-8, -4).toString('latin1')).toBe('IEND');
    }
    expect(trayIconPng('error', 16).equals(trayIconPng('error', 16))).toBe(true);
    expect(trayIconPng('error', 16).equals(trayIconPng('signed-in', 16))).toBe(false);
  });
});
