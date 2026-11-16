// SPDX-License-Identifier: AGPL-3.0-only
// Tests for normalized [0..1] PDF field bounds, keyboard nudging/resizing, and send readiness preconditions (#3325).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIELD_SIZE,
  MIN_FIELD_H,
  MIN_FIELD_W,
  checkSendReadiness,
  clampFieldBox,
  createPlacedFieldBox,
  nudgeFieldBox,
  resizeFieldBox,
} from '../src/lib/sign-fields.ts';

describe('normalized [0..1] PDF field box geometry', () => {
  it('clamps coordinates and dimensions inside [0..1] and enforces minimum sizes', () => {
    const clamped = clampFieldBox({ xNorm: -0.2, yNorm: 0.95, wNorm: 0.3, hNorm: 0.1 });
    expect(clamped.xNorm).toBe(0);
    expect(clamped.yNorm).toBe(0.9);
    expect(clamped.wNorm).toBe(0.3);
    expect(clamped.hNorm).toBe(0.1);

    const tiny = clampFieldBox({ xNorm: 0.5, yNorm: 0.5, wNorm: 0.001, hNorm: 0.001 });
    expect(tiny.wNorm).toBe(MIN_FIELD_W);
    expect(tiny.hNorm).toBe(MIN_FIELD_H);

    const nonFinite = clampFieldBox({ xNorm: Number.NaN, yNorm: Infinity, wNorm: 2, hNorm: 2 });
    expect(nonFinite).toEqual({ xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 });
  });

  it('nudges fields via keyboard steps while keeping them inside page edges', () => {
    const start = { xNorm: 0.74, yNorm: 0.9, wNorm: 0.24, hNorm: 0.08 };
    const nudgedOut = nudgeFieldBox(start, 0.1, 0.05);
    expect(nudgedOut.xNorm).toBe(0.76);
    expect(nudgedOut.yNorm).toBe(0.92);

    const nudgedBack = nudgeFieldBox(start, -0.8, -0.95);
    expect(nudgedBack.xNorm).toBe(0);
    expect(nudgedBack.yNorm).toBe(0);
  });

  it('resizes fields within remaining page space and minimum dimensions', () => {
    const start = { xNorm: 0.7, yNorm: 0.85, wNorm: 0.2, hNorm: 0.08 };
    const grown = resizeFieldBox(start, 0.25, 0.25);
    expect(grown.wNorm).toBe(0.3);
    expect(grown.hNorm).toBe(0.15);

    const shrunk = resizeFieldBox(start, -0.5, -0.5);
    expect(shrunk.wNorm).toBe(MIN_FIELD_W);
    expect(shrunk.hNorm).toBe(MIN_FIELD_H);
  });

  it('places centered clicks and staggered toolbar additions inside [0..1]', () => {
    const centered = createPlacedFieldBox({ fieldType: 'signature', xCenterNorm: 0.98, yCenterNorm: 0.01 });
    expect(centered.wNorm).toBe(DEFAULT_FIELD_SIZE.signature.wNorm);
    expect(centered.xNorm).toBeCloseTo(1 - DEFAULT_FIELD_SIZE.signature.wNorm, 5);
    expect(centered.yNorm).toBe(0);

    const first = createPlacedFieldBox({ fieldType: 'date', existingOnPageCount: 0 });
    const second = createPlacedFieldBox({ fieldType: 'date', existingOnPageCount: 1 });
    expect(second.xNorm).toBeLessThan(first.xNorm);
    expect(second.yNorm).toBeLessThan(first.yNorm);
  });
});

describe('checkSendReadiness', () => {
  it('blocks send when PDF inspection failed or is pending, or signers lack a signature field', () => {
    expect(checkSendReadiness({ inspectStatus: 'pending', signers: [], fields: [] })).toBe('NOT_INSPECTED');
    expect(checkSendReadiness({ inspectStatus: 'failed', signers: [], fields: [] })).toBe('INSPECT_FAILED');
    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        signers: [{ id: 'cc1', signerRole: 'cc' }],
        fields: [],
      }),
    ).toBe('NO_SIGNERS');

    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        signers: [{ id: 's1', signerRole: 'signer' }],
        fields: [{ signerId: 's1', fieldType: 'date' }],
      }),
    ).toBe('MISSING_SIGNATURE_FIELD');
  });

  it('passes when all signer roles have >= 1 signature field and allows approvers without one', () => {
    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        signers: [
          { id: 's1', signerRole: 'signer' },
          { id: 'a1', signerRole: 'approver' },
          { id: 'cc1', signerRole: 'cc' },
        ],
        fields: [{ signerId: 's1', fieldType: 'signature' }],
      }),
    ).toBeNull();
  });
});
