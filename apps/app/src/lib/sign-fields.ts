// SPDX-License-Identifier: AGPL-3.0-only
// Normalized [0..1] PDF field geometry, signer color tokens, and keyboard/drag bounds (#3325).

export const SIGN_ENVELOPE_STATUSES = ['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired'] as const;
export type SignEnvelopeStatus = (typeof SIGN_ENVELOPE_STATUSES)[number];

export const SIGN_ROUTING_MODES = ['parallel', 'sequential'] as const;
export type SignRoutingMode = (typeof SIGN_ROUTING_MODES)[number];

export const SIGN_INSPECT_STATUSES = ['pending', 'passed', 'failed'] as const;
export type SignInspectStatus = (typeof SIGN_INSPECT_STATUSES)[number];

export const SIGN_SEAL_STATUSES = ['pending', 'sealed', 'failed'] as const;
export type SignSealStatus = (typeof SIGN_SEAL_STATUSES)[number];

export const SIGN_SIGNER_ROLES = ['signer', 'approver', 'cc'] as const;
export type SignSignerRole = (typeof SIGN_SIGNER_ROLES)[number];

export const SIGN_DELIVERY_MODES = ['link', 'email'] as const;
export type SignDeliveryMode = (typeof SIGN_DELIVERY_MODES)[number];

export const SIGN_SIGNER_STATUSES = ['waiting', 'pending', 'viewed', 'signed', 'declined', 'voided', 'expired'] as const;
export type SignSignerStatus = (typeof SIGN_SIGNER_STATUSES)[number];

export const SIGN_FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'] as const;
export type SignFieldType = (typeof SIGN_FIELD_TYPES)[number];

export const MIN_FIELD_W = 0.02;
export const MIN_FIELD_H = 0.015;

export interface NormalizedBox {
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
}

export interface DraftFieldPlacement extends NormalizedBox {
  localId: string;
  signerId: string;
  fieldType: SignFieldType;
  pageNumber: number;
  label: string | null;
  required: boolean;
  proposedByAi: boolean;
  fontSizePt?: number | null;
}

export interface SignDetectedTag extends NormalizedBox {
  pageNumber: number;
  fieldType: SignFieldType;
  roleOrder: number;
  roleKey: string;
  required: boolean;
  label: string | null;
}

export const DEFAULT_FIELD_SIZE: Record<SignFieldType, { readonly wNorm: number; readonly hNorm: number }> = {
  signature: { wNorm: 0.24, hNorm: 0.08 },
  initials: { wNorm: 0.14, hNorm: 0.065 },
  date: { wNorm: 0.18, hNorm: 0.048 },
  text: { wNorm: 0.24, hNorm: 0.052 },
  checkbox: { wNorm: 0.04, hNorm: 0.032 },
};

// Strictly semantic OKLCH label tokens from DESIGN.md (zero palette color literals).
export const SIGNER_CHIP_CLASSES = [
  { border: 'border-label-blue', fill: 'bg-label-blue/15', text: 'text-label-blue', dot: 'bg-label-blue' },
  { border: 'border-label-purple', fill: 'bg-label-purple/15', text: 'text-label-purple', dot: 'bg-label-purple' },
  { border: 'border-label-teal', fill: 'bg-label-teal/15', text: 'text-label-teal', dot: 'bg-label-teal' },
  { border: 'border-label-orange', fill: 'bg-label-orange/15', text: 'text-label-orange', dot: 'bg-label-orange' },
  { border: 'border-label-pink', fill: 'bg-label-pink/15', text: 'text-label-pink', dot: 'bg-label-pink' },
  { border: 'border-label-green', fill: 'bg-label-green/15', text: 'text-label-green', dot: 'bg-label-green' },
  { border: 'border-label-yellow', fill: 'bg-label-yellow/15', text: 'text-label-yellow', dot: 'bg-label-yellow' },
  { border: 'border-label-red', fill: 'bg-label-red/15', text: 'text-label-red', dot: 'bg-label-red' },
] as const;

export function signerChipStyle(index: number) {
  const safeIndex = Math.abs(index) % SIGNER_CHIP_CLASSES.length;
  return SIGNER_CHIP_CLASSES[safeIndex]!;
}

export function roundNorm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function clampFieldBox(box: NormalizedBox): NormalizedBox {
  const wNorm = roundNorm(Math.min(1, Math.max(MIN_FIELD_W, Number.isFinite(box.wNorm) ? box.wNorm : MIN_FIELD_W)));
  const hNorm = roundNorm(Math.min(1, Math.max(MIN_FIELD_H, Number.isFinite(box.hNorm) ? box.hNorm : MIN_FIELD_H)));
  const maxX = Math.max(0, roundNorm(1 - wNorm));
  const maxY = Math.max(0, roundNorm(1 - hNorm));
  const xNorm = roundNorm(Math.min(maxX, Math.max(0, Number.isFinite(box.xNorm) ? box.xNorm : 0)));
  const yNorm = roundNorm(Math.min(maxY, Math.max(0, Number.isFinite(box.yNorm) ? box.yNorm : 0)));
  return { xNorm, yNorm, wNorm, hNorm };
}

export function nudgeFieldBox(box: NormalizedBox, dx: number, dy: number): NormalizedBox {
  return clampFieldBox({
    xNorm: box.xNorm + dx,
    yNorm: box.yNorm + dy,
    wNorm: box.wNorm,
    hNorm: box.hNorm,
  });
}

export function resizeFieldBox(box: NormalizedBox, dw: number, dh: number): NormalizedBox {
  const nextW = Math.min(roundNorm(1 - box.xNorm), Math.max(MIN_FIELD_W, box.wNorm + dw));
  const nextH = Math.min(roundNorm(1 - box.yNorm), Math.max(MIN_FIELD_H, box.hNorm + dh));
  return clampFieldBox({
    xNorm: box.xNorm,
    yNorm: box.yNorm,
    wNorm: nextW,
    hNorm: nextH,
  });
}

export function createPlacedFieldBox(input: {
  fieldType: SignFieldType;
  xCenterNorm?: number;
  yCenterNorm?: number;
  existingOnPageCount?: number;
}): NormalizedBox {
  const defaults = DEFAULT_FIELD_SIZE[input.fieldType];
  if (input.xCenterNorm !== undefined && input.yCenterNorm !== undefined) {
    return clampFieldBox({
      xNorm: input.xCenterNorm - defaults.wNorm / 2,
      yNorm: input.yCenterNorm - defaults.hNorm / 2,
      wNorm: defaults.wNorm,
      hNorm: defaults.hNorm,
    });
  }
  const step = (input.existingOnPageCount ?? 0) % 6;
  return clampFieldBox({
    xNorm: 0.58 - step * 0.03,
    yNorm: 0.72 - step * 0.07,
    wNorm: defaults.wNorm,
    hNorm: defaults.hNorm,
  });
}

export type SendReadinessIssue = 'NOT_INSPECTED' | 'INSPECT_FAILED' | 'NO_SIGNERS' | 'MISSING_SIGNATURE_FIELD';

// Mirrors server-side sign.envelope.send preconditions (#3323) so the UI informs before submission.
export function checkSendReadiness(input: {
  inspectStatus: string;
  signers: readonly { id: string; signerRole: string }[];
  fields: readonly { signerId: string; fieldType: string }[];
}): SendReadinessIssue | null {
  if (input.inspectStatus === 'failed') return 'INSPECT_FAILED';
  if (input.inspectStatus !== 'passed') return 'NOT_INSPECTED';
  const activeSigners = input.signers.filter((s) => s.signerRole !== 'cc');
  if (activeSigners.length === 0) return 'NO_SIGNERS';
  const sigCountBySigner = new Map<string, number>();
  for (const field of input.fields) {
    if (field.fieldType === 'signature') {
      sigCountBySigner.set(field.signerId, (sigCountBySigner.get(field.signerId) ?? 0) + 1);
    }
  }
  for (const signer of activeSigners) {
    if (signer.signerRole === 'signer' && (sigCountBySigner.get(signer.id) ?? 0) < 1) {
      return 'MISSING_SIGNATURE_FIELD';
    }
  }
  return null;
}

export interface PlannedTagPlacement extends NormalizedBox {
  signerId: string;
  fieldType: SignFieldType;
  pageNumber: number;
  label: string | null;
  required: boolean;
}

function isDuplicateTagPlacement(
  existing: readonly Pick<DraftFieldPlacement, 'signerId' | 'fieldType' | 'pageNumber' | 'xNorm' | 'yNorm'>[],
  candidate: PlannedTagPlacement,
): boolean {
  return existing.some(
    (f) =>
      f.signerId === candidate.signerId &&
      f.fieldType === candidate.fieldType &&
      f.pageNumber === candidate.pageNumber &&
      Math.abs(f.xNorm - candidate.xNorm) <= 0.002 &&
      Math.abs(f.yNorm - candidate.yNorm) <= 0.002,
  );
}

export function planDetectedTagsForSigners(input: {
  detectedTags: readonly SignDetectedTag[];
  signers: readonly { id: string; routingOrder: number; signerRole: string; roleKey?: string | null | undefined }[];
  existingFields: readonly Pick<DraftFieldPlacement, 'signerId' | 'fieldType' | 'pageNumber' | 'xNorm' | 'yNorm'>[];
  pageCount: number;
}): {
  totalTags: number;
  applicable: PlannedTagPlacement[];
  unmatchedRoleOrders: number[];
  alreadyAppliedCount: number;
} {
  const maxPage = Math.max(1, input.pageCount);
  const applicable: PlannedTagPlacement[] = [];
  const unmatchedSet = new Set<number>();
  let alreadyAppliedCount = 0;

  for (const tag of input.detectedTags) {
    const explicitByKey = input.signers.find((s) => s.roleKey === tag.roleKey);
    const matchedSigner = explicitByKey
      ? explicitByKey.signerRole !== 'cc'
        ? explicitByKey
        : undefined
      : input.signers.find((s) => !s.roleKey && s.signerRole !== 'cc' && s.routingOrder === tag.roleOrder);
    if (!matchedSigner) {
      unmatchedSet.add(tag.roleOrder);
      continue;
    }
    const box = clampFieldBox(tag);
    const candidate: PlannedTagPlacement = {
      signerId: matchedSigner.id,
      fieldType: tag.fieldType,
      pageNumber: Math.min(maxPage, Math.max(1, tag.pageNumber)),
      ...box,
      label: tag.label,
      required: tag.required,
    };
    if (isDuplicateTagPlacement(input.existingFields, candidate) || isDuplicateTagPlacement(applicable, candidate)) {
      alreadyAppliedCount += 1;
      continue;
    }
    applicable.push(candidate);
  }

  return {
    totalTags: input.detectedTags.length,
    applicable,
    unmatchedRoleOrders: [...unmatchedSet].sort((a, b) => a - b),
    alreadyAppliedCount,
  };
}

export function planDetectedTagsForTemplateRoles(input: {
  detectedTags: readonly SignDetectedTag[];
  roles: readonly { id: string; roleKey: string; routingOrder: number; signerRole: string }[];
  existingFields: readonly Pick<DraftFieldPlacement, 'signerId' | 'fieldType' | 'pageNumber' | 'xNorm' | 'yNorm'>[];
  pageCount: number;
}): {
  totalTags: number;
  applicable: PlannedTagPlacement[];
  unmatchedRoleKeys: string[];
  alreadyAppliedCount: number;
} {
  const maxPage = Math.max(1, input.pageCount);
  const applicable: PlannedTagPlacement[] = [];
  const unmatchedMap = new Map<number, string>();
  let alreadyAppliedCount = 0;

  for (const tag of input.detectedTags) {
    const explicitByKey = input.roles.find((r) => r.roleKey === tag.roleKey);
    const matchedRole = explicitByKey
      ? explicitByKey.signerRole !== 'cc'
        ? explicitByKey
        : undefined
      : input.roles.find(
          (r) => r.signerRole !== 'cc' && !/^r[1-9]\d*$/.test(r.roleKey) && r.routingOrder === tag.roleOrder,
        );
    if (!matchedRole) {
      unmatchedMap.set(tag.roleOrder, tag.roleKey);
      continue;
    }
    const box = clampFieldBox(tag);
    const candidate: PlannedTagPlacement = {
      signerId: matchedRole.id,
      fieldType: tag.fieldType,
      pageNumber: Math.min(maxPage, Math.max(1, tag.pageNumber)),
      ...box,
      label: tag.label,
      required: tag.required,
    };
    if (isDuplicateTagPlacement(input.existingFields, candidate) || isDuplicateTagPlacement(applicable, candidate)) {
      alreadyAppliedCount += 1;
      continue;
    }
    applicable.push(candidate);
  }

  const unmatchedRoleKeys = [...unmatchedMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, key]) => key);

  return {
    totalTags: input.detectedTags.length,
    applicable,
    unmatchedRoleKeys,
    alreadyAppliedCount,
  };
}
