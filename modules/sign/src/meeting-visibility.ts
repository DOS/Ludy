// SPDX-License-Identifier: AGPL-3.0-only
// Strict meeting-minutes envelope confidentiality helpers for @ludy/mod-sign (#3811, docs/plan/esign.md Slice 3a, ADR-0047).
// Envelopes with source_kind = 'meeting_minutes' may be created only for meetings in the caller's org whose minutes have
// been explicitly shared and that the caller is permitted to read. Only permitted meeting readers, the envelope creator
// (while still an active member of the org), or system workers may read, list, or mutate them.
// Unauthorized workspace members (including owners and admins on attendees-only meetings where they were not shared)
// receive identical NOT_FOUND (404) responses on ID lookups so no existence oracle leaks.
import { sql, type SelectQueryBuilder } from 'kysely';
import type { Database, SignSourceKind } from '@ludy/db';
import { DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

export type MeetingEnvelopeVisibilityCtx = Pick<QueryContext, 'trx' | 'orgId' | 'actor'>;

export interface MeetingEnvelopeVisibilityRow {
  readonly source_kind: SignSourceKind | string;
  readonly source_id?: string | null;
  readonly created_by: string;
}

// Who may act on a meeting-minutes envelope is narrower than who may read it (#4530): every reader of the meeting reads it, but only its creator, an owner or an admin edits its draft, sends it,
// reminds its signers, or issues a signing link or an in-person signing session. Run it right after the visibility check (lockEnvelope, or the in-person command's own read), so a caller who cannot
// read the envelope still gets the 404 and learns nothing of its existence; one who can read it but not act gets a 403. An hr_contract envelope needs no second check: only an owner, an admin or its
// creator reads it at all (hr-visibility.ts).
export function assertCanActOnMeetingMinutesEnvelope(
  ctx: Pick<CommandContext, 'role'>,
  row: { source_kind: string; created_by: string | null },
  userId: string,
): void {
  if (row.source_kind !== 'meeting_minutes') return;
  if (row.created_by === userId || ctx.role === 'owner' || ctx.role === 'admin') return;
  throw new DomainError('SIGN_FORBIDDEN', 403, 'Only the envelope creator, owner, or admin can act on a meeting-minutes envelope');
}

export async function assertCanCreateMeetingMinutesEnvelope(
  ctx: Pick<CommandContext, 'trx' | 'orgId' | 'actor'> & Partial<Pick<CommandContext, 'installed'>>,
  sourceKind: SignSourceKind | string,
  sourceId: string | null,
): Promise<void> {
  if (sourceKind !== 'meeting_minutes') return;
  if (ctx.actor.type === 'system') return;
  if (ctx.actor.type !== 'user') {
    throw new DomainError('SIGN_FORBIDDEN', 403, 'Only authenticated members can create meeting minutes envelopes');
  }
  if (!sourceId) {
    throw new DomainError('SIGN_INVALID_SOURCE', 422, 'Meeting minutes envelopes require sourceId');
  }
  if (typeof ctx.installed === 'function' && !ctx.installed('meetings')) {
    throw new DomainError('SIGN_SOURCE_NOT_FOUND', 404, 'Meeting not found');
  }

  const { rows } = await sql<{ state: number }>`
    SELECT ludy_sign.check_meeting_minutes_source(${sourceId}::uuid) AS state
  `.execute(ctx.trx);
  const state = Number(rows[0]?.state ?? 0);
  if (state === 0) {
    throw new DomainError('SIGN_SOURCE_NOT_FOUND', 404, 'Meeting not found');
  }
  if (state === 1) {
    throw new DomainError(
      'SIGN_MINUTES_NOT_SHARED',
      409,
      'Meeting minutes must be shared before creating a signing envelope',
    );
  }
}

export async function canAccessMeetingMinutesEnvelopeRow(
  ctx: MeetingEnvelopeVisibilityCtx,
  row: MeetingEnvelopeVisibilityRow,
): Promise<boolean> {
  if (row.source_kind !== 'meeting_minutes') return true;
  if (ctx.actor.type === 'system') return true;
  if (ctx.actor.type !== 'user') return false;
  if (ctx.actor.userId === row.created_by) return true;
  if (!row.source_id) return false;

  const { rows } = await sql<{ allowed: boolean }>`
    SELECT ludy_sign.can_access_meeting_minutes_envelope(
      ${ctx.orgId}::uuid,
      ${row.source_id}::uuid,
      ${row.created_by}::uuid
    ) AS allowed
  `.execute(ctx.trx);
  return Boolean(rows[0]?.allowed);
}

export async function assertCanAccessMeetingMinutesEnvelopeRow(
  ctx: MeetingEnvelopeVisibilityCtx,
  row: MeetingEnvelopeVisibilityRow,
  notFoundMessage = 'Envelope not found',
): Promise<void> {
  if (!(await canAccessMeetingMinutesEnvelopeRow(ctx, row))) {
    throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, notFoundMessage);
  }
}

export function applyMeetingMinutesVisibilityFilter<O>(
  query: SelectQueryBuilder<Database, 'ludy_sign.envelope', O>,
  ctx: Pick<QueryContext, 'actor'>,
): SelectQueryBuilder<Database, 'ludy_sign.envelope', O> {
  if (ctx.actor.type === 'system') return query;
  if (ctx.actor.type !== 'user') {
    return query.where('source_kind', '!=', 'meeting_minutes');
  }
  return query.where((eb) =>
    eb.or([
      eb('source_kind', '!=', 'meeting_minutes'),
      sql<boolean>`ludy_sign.can_access_meeting_minutes_envelope(${eb.ref('org_id')}, ${eb.ref('source_id')}, ${eb.ref('created_by')})`,
    ]),
  );
}
