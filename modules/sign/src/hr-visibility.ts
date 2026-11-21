// SPDX-License-Identifier: AGPL-3.0-only
// Strict HR contract envelope confidentiality helpers for @ludy/mod-sign (#3553, docs/plan/esign.md Slice 2b A4).
// Envelopes with source_kind = 'hr_contract' carry employee compensation and contract terms (owner decision 2026-11-08):
// only organization owners, admins, the envelope creator, or system workers may read, list, or mutate them.
// Unauthorized workspace members receive identical NOT_FOUND (404) responses on ID lookups so no existence oracle leaks.
import type { SelectQueryBuilder } from 'kysely';
import type { Database, MemberRole, SignSourceKind } from '@ludy/db';
import { DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

export interface HrEnvelopeVisibilityCtx {
  readonly actor: QueryContext['actor'] | CommandContext['actor'];
  readonly role: MemberRole | null;
}

export interface HrEnvelopeVisibilityRow {
  readonly source_kind: SignSourceKind | string;
  readonly created_by: string;
}

export function isHrPrivilegedRole(role: MemberRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

export function assertCanCreateEnvelopeForSource(
  ctx: HrEnvelopeVisibilityCtx,
  sourceKind: SignSourceKind | string,
): void {
  if (sourceKind !== 'hr_contract') return;
  if (ctx.actor.type === 'system') return;
  if (ctx.actor.type === 'user' && isHrPrivilegedRole(ctx.role)) return;
  throw new DomainError(
    'SIGN_FORBIDDEN',
    403,
    'Only organization owners and admins can create HR contract envelopes',
  );
}

export function canAccessEnvelopeRow(
  ctx: HrEnvelopeVisibilityCtx,
  row: HrEnvelopeVisibilityRow,
): boolean {
  if (ctx.actor.type === 'system') return true;
  if (ctx.actor.type !== 'user') {
    return row.source_kind !== 'hr_contract';
  }
  if (row.source_kind !== 'hr_contract') return true;
  if (isHrPrivilegedRole(ctx.role)) return true;
  return ctx.actor.userId === row.created_by;
}

export function assertCanAccessEnvelopeRow(
  ctx: HrEnvelopeVisibilityCtx,
  row: HrEnvelopeVisibilityRow,
  notFoundMessage = 'Envelope not found',
): void {
  if (!canAccessEnvelopeRow(ctx, row)) {
    throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, notFoundMessage);
  }
}

export function applyEnvelopeVisibilityFilter<O>(
  query: SelectQueryBuilder<Database, 'crove_sign.envelope', O>,
  ctx: HrEnvelopeVisibilityCtx,
): SelectQueryBuilder<Database, 'crove_sign.envelope', O> {
  if (ctx.actor.type === 'system') return query;
  if (ctx.actor.type !== 'user') {
    return query.where('source_kind', '!=', 'hr_contract');
  }
  if (isHrPrivilegedRole(ctx.role)) return query;
  const userId = ctx.actor.userId;
  return query.where((eb) =>
    eb.or([eb('source_kind', '!=', 'hr_contract'), eb('created_by', '=', userId)]),
  );
}
