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
  planDetectedTagsForSigners,
  planDetectedTagsForTemplateRoles,
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

describe('deterministic PDF tag mapping (#3552)', () => {
  const sampleTags = [
    {
      pageNumber: 1,
      fieldType: 'signature' as const,
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
      xNorm: 0.12,
      yNorm: 0.72,
      wNorm: 0.22,
      hNorm: 0.06,
    },
    {
      pageNumber: 1,
      fieldType: 'date' as const,
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
      xNorm: 0.44,
      yNorm: 0.73,
      wNorm: 0.16,
      hNorm: 0.03,
    },
    {
      pageNumber: 2,
      fieldType: 'text' as const,
      roleOrder: 2,
      roleKey: 'r2',
      required: false,
      label: 'Chức danh',
      xNorm: 0.18,
      yNorm: 0.4,
      wNorm: 0.24,
      hNorm: 0.03,
    },
  ];

  it('maps r1/r2 to non-CC signers by routingOrder, tracks unmatched orders, and skips already applied boxes', () => {
    const partialPlan = planDetectedTagsForSigners({
      detectedTags: sampleTags,
      signers: [
        { id: 's-1', routingOrder: 1, signerRole: 'signer' },
        { id: 'cc-2', routingOrder: 2, signerRole: 'cc' },
      ],
      existingFields: [],
      pageCount: 2,
    });
    expect(partialPlan.totalTags).toBe(3);
    expect(partialPlan.applicable).toHaveLength(2);
    expect(partialPlan.unmatchedRoleOrders).toEqual([2]);

    const fullPlan = planDetectedTagsForSigners({
      detectedTags: sampleTags,
      signers: [
        { id: 's-1', routingOrder: 1, signerRole: 'signer' },
        { id: 's-2', routingOrder: 2, signerRole: 'approver' },
      ],
      existingFields: [],
      pageCount: 2,
    });
    expect(fullPlan.applicable).toHaveLength(3);
    expect(fullPlan.unmatchedRoleOrders).toEqual([]);
    expect(fullPlan.applicable[0]).toMatchObject({ signerId: 's-1', fieldType: 'signature', pageNumber: 1 });
    expect(fullPlan.applicable[2]).toMatchObject({
      signerId: 's-2',
      fieldType: 'text',
      pageNumber: 2,
      required: false,
      label: 'Chức danh',
    });

    const afterApply = planDetectedTagsForSigners({
      detectedTags: sampleTags,
      signers: [
        { id: 's-1', routingOrder: 1, signerRole: 'signer' },
        { id: 's-2', routingOrder: 2, signerRole: 'approver' },
      ],
      existingFields: fullPlan.applicable,
      pageCount: 2,
    });
    expect(afterApply.applicable).toHaveLength(0);
    expect(afterApply.alreadyAppliedCount).toBe(3);
  });

  it('maps template tags by roleKey first and routingOrder second while skipping CC roles', () => {
    const tplPlan = planDetectedTagsForTemplateRoles({
      detectedTags: sampleTags,
      roles: [
        { id: 'role-a', roleKey: 'r1', routingOrder: 1, signerRole: 'signer' },
        { id: 'role-cc', roleKey: 'r2', routingOrder: 2, signerRole: 'cc' },
      ],
      existingFields: [],
      pageCount: 2,
    });
    expect(tplPlan.applicable).toHaveLength(2);
    expect(tplPlan.unmatchedRoleKeys).toEqual(['r2']);

    const fullTplPlan = planDetectedTagsForTemplateRoles({
      detectedTags: sampleTags,
      roles: [
        { id: 'role-a', roleKey: 'party_a', routingOrder: 1, signerRole: 'signer' },
        { id: 'role-b', roleKey: 'r2', routingOrder: 3, signerRole: 'signer' },
      ],
      existingFields: [],
      pageCount: 2,
    });
    expect(fullTplPlan.applicable).toHaveLength(3);
    expect(fullTplPlan.unmatchedRoleKeys).toEqual([]);
    expect(fullTplPlan.applicable[0]?.signerId).toBe('role-a');
    expect(fullTplPlan.applicable[2]?.signerId).toBe('role-b');
  });

  it('preserves roleKey mapping when template roles use reversed routing orders (r1 at order 2, r2 at order 1)', () => {
    const reversedSigners = [
      { id: 'signer-from-r2', roleKey: 'r2', routingOrder: 1, signerRole: 'signer' },
      { id: 'signer-from-r1', roleKey: 'r1', routingOrder: 2, signerRole: 'signer' },
    ];
    const plan = planDetectedTagsForSigners({
      detectedTags: sampleTags,
      signers: reversedSigners,
      existingFields: [],
      pageCount: 2,
    });
    expect(plan.applicable).toHaveLength(3);
    expect(plan.applicable[0]?.signerId).toBe('signer-from-r1');
    expect(plan.applicable[1]?.signerId).toBe('signer-from-r1');
    expect(plan.applicable[2]?.signerId).toBe('signer-from-r2');

    // Inherited fields already placed on those signers are recognized as duplicates and never re-applied to the other signer.
    const deduped = planDetectedTagsForSigners({
      detectedTags: sampleTags,
      signers: reversedSigners,
      existingFields: plan.applicable,
      pageCount: 2,
    });
    expect(deduped.applicable).toHaveLength(0);
    expect(deduped.alreadyAppliedCount).toBe(3);

    // If a template only defines r2 at routingOrder 1 (no r1), r1 tags stay unmatched rather than binding to r2.
    const onlyR2Role = planDetectedTagsForTemplateRoles({
      detectedTags: sampleTags,
      roles: [{ id: 'only-r2', roleKey: 'r2', routingOrder: 1, signerRole: 'signer' }],
      existingFields: [],
      pageCount: 2,
    });
    expect(onlyR2Role.applicable).toHaveLength(1);
    expect(onlyR2Role.applicable[0]?.signerId).toBe('only-r2');
    expect(onlyR2Role.unmatchedRoleKeys).toEqual(['r1']);
  });
});
