// SPDX-License-Identifier: AGPL-3.0-only
// Read queries and cryptographic envelope verification for eSign Slice 1a (#3323).
// All reads execute inside QueryContext with org_id isolation and never expose signing_token or signing_otp secrets.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_ENVELOPE_STATUSES,
  SIGN_SOURCE_KINDS,
  type MemberRole,
  type SignEnvelopeStatus,
  type SignSealStatus,
} from '@ludy/db';
import {
  SIGN_BY_SOURCE_MAX,
  zId,
  zSignDrafterRenderPdfInput,
  type SignDrafterRenderPdfResult,
  type SignEnvelopeBySourceItem,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { isSignAiStoppedOnTrx } from './ai.ts';
import { signApiKeyQueries } from './api-keys.ts';
import { renderStarterContractPdf } from './contract-drafter.ts';
import { signDocxConvertQueries } from './docx-convert.ts';
import { signEnvelopeDocumentQueries } from './envelope-documents.ts';
import { signMcpQueries } from './mcp.ts';
import type { SigningEventChainRow } from './events.ts';
import { parseEventPayload, verifyEventChain } from './events.ts';
import {
  applyEnvelopeVisibilityFilter,
  assertCanAccessEnvelopeRow,
  canAccessEnvelopeRow,
  isHrPrivilegedRole,
} from './hr-visibility.ts';
import {
  applyMeetingMinutesVisibilityFilter,
  assertCanAccessMeetingMinutesEnvelopeRow,
  currentMeetingMinutesRevision,
  isMinutesEnvelopeStale,
} from './meeting-visibility.ts';
import type { SignFieldForSeal, SignSignerForSeal } from './sealing.ts';
import { SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE } from './sign-mail.ts';
import { SIGN_WRITERS, parseDetectedTags, parseFieldOptions, parseSharedSummary } from './shared.ts';
import { signVaultQueries } from './vault.ts';

const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

function assertUser(ctx: QueryContext): void {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this query');
  }
}

function assertSystem(ctx: QueryContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only system workers can run this query');
  }
}

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export const envelopeList = defineQuery({
  name: 'sign.envelope.list',
  input: z.strictObject({
    status: z.enum(SIGN_ENVELOPE_STATUSES).optional(),
    sourceKind: z.enum(SIGN_SOURCE_KINDS).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  access: READERS,
  handler: async (ctx, input) => {
    assertUser(ctx);
    let q = ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'routing_mode',
        'source_kind',
        'source_id',
        'source_file_id',
        'inspect_status',
        'seal_status',
        'certificate_code',
        'page_count',
        'expires_at',
        'auto_remind_before_expiry',
        'sent_at',
        'completed_at',
        'decline_acknowledged_at',
        'voided_at',
        'expired_at',
        'version',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId);
    if (input.status !== undefined) q = q.where('status', '=', input.status);
    if (input.sourceKind !== undefined) q = q.where('source_kind', '=', input.sourceKind);
    q = applyEnvelopeVisibilityFilter(q, ctx);
    q = applyMeetingMinutesVisibilityFilter(q, ctx);
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit).execute();
    if (rows.length === 0) {
      return { items: [] };
    }

    const actorUserId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    let actorEmail: string | null = null;
    if (actorUserId !== null) {
      const { rows: profileRows } = await sql<{ email: string | null }>`
        SELECT email FROM ludy_kernel.member_profiles(${[actorUserId]}::uuid[])
      `.execute(ctx.trx);
      actorEmail = profileRows[0]?.email?.trim().toLowerCase() ?? null;
    }

    const signerRows = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['envelope_id', 'status', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'envelope_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('signer_role', '!=', 'cc')
      .execute();

    const summaryByEnvelope = new Map<string, { total: number; signed: number; awaitingMe: boolean }>();
    for (const signer of signerRows) {
      let entry = summaryByEnvelope.get(signer.envelope_id);
      if (!entry) {
        entry = { total: 0, signed: 0, awaitingMe: false };
        summaryByEnvelope.set(signer.envelope_id, entry);
      }
      entry.total += 1;
      if (signer.status === 'signed') {
        entry.signed += 1;
      }
      if (
        actorEmail !== null &&
        (signer.status === 'pending' || signer.status === 'viewed') &&
        signer.email !== null &&
        signer.email.trim().toLowerCase() === actorEmail
      ) {
        entry.awaitingMe = true;
      }
    }

    return {
      items: rows.map((r) => {
        const counts = summaryByEnvelope.get(r.id);
        const envelopeActive = r.status === 'sent' || r.status === 'in_progress';
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          routingMode: r.routing_mode,
          sourceKind: r.source_kind,
          sourceId: r.source_id,
          sourceFileId: r.source_file_id,
          inspectStatus: r.inspect_status,
          sealStatus: r.seal_status,
          certificateCode: r.certificate_code,
          pageCount: r.page_count,
          expiresAt: isoOrNull(r.expires_at),
          autoRemindBeforeExpiry: r.auto_remind_before_expiry,
          sentAt: isoOrNull(r.sent_at),
          completedAt: isoOrNull(r.completed_at),
          declineAcknowledgedAt: isoOrNull(r.decline_acknowledged_at),
          voidedAt: isoOrNull(r.voided_at),
          expiredAt: isoOrNull(r.expired_at),
          version: r.version,
          createdBy: r.created_by,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
          signerSummary: {
            total: counts?.total ?? 0,
            signed: counts?.signed ?? 0,
            waitingForMe: Boolean(envelopeActive && counts?.awaitingMe),
          },
        };
      }),
    };
  },
});

export interface SourceEnvelopeCandidate {
  id: string;
  title: string;
  status: SignEnvelopeStatus;
  source_id: string | null;
  seal_status: SignSealStatus | null;
  certificate_code: string | null;
  completed_at: Date | string | null;
  // Only a meeting-minutes envelope has one (#4532).
  source_revision?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// For a meeting-minutes envelope (#4532): the revision of the published minutes now, per meeting (null where the caller cannot read them).
export interface MinutesRanking {
  currentRevisions: ReadonlyMap<string, string | null>;
}

// Stale as shown to the member: made for other minutes than the published ones. A signed envelope from before the server kept a revision ('legacy') is a legal record whose minutes were never
// compared, so it is not called stale (its download stays on the meeting screen); an unsigned legacy one is, and is made again.
function envelopeStale(row: Pick<SourceEnvelopeCandidate, 'status' | 'source_revision'>, current: string | null): boolean {
  if (row.status === 'completed' && row.source_revision === 'legacy') return false;
  return isMinutesEnvelopeStale(row.source_revision, current);
}

// Lower is shown first. An envelope for the current minutes comes before one for older minutes; among those, a signed (completed) one before one in flight before a draft, so a
// newer draft never pushes a signed envelope of the current minutes off the meeting screen. An envelope for older minutes that a newer one replaced does not hide it (otherwise the
// recorder, shown a stale signed envelope, would start another draft every time the meeting screen offered it).
function minutesRank(row: SourceEnvelopeCandidate, ranking: MinutesRanking): number {
  const stale = envelopeStale(row, row.source_id ? (ranking.currentRevisions.get(row.source_id) ?? null) : null);
  const settled = row.status === 'completed' ? 0 : row.status === 'sent' || row.status === 'in_progress' ? 1 : 2;
  return (stale ? 3 : 0) + settled;
}

function envelopePriorityCompare(a: SourceEnvelopeCandidate, b: SourceEnvelopeCandidate, minutes?: MinutesRanking): number {
  const aVoided = a.status === 'voided' ? 1 : 0;
  const bVoided = b.status === 'voided' ? 1 : 0;
  if (aVoided !== bVoided) return aVoided - bVoided;
  if (minutes) {
    const rankDiff = minutesRank(a, minutes) - minutesRank(b, minutes);
    if (rankDiff !== 0) return rankDiff;
  }
  const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  if (createdDiff !== 0) return createdDiff;
  const updatedDiff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  if (updatedDiff !== 0) return updatedDiff;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

// Selects the latest non-voided envelope (or latest overall if only voided exist) per requested sourceId. For meeting minutes, `minutes` ranks them first as described at minutesRank.
export function selectLatestEnvelopesBySource<T extends SourceEnvelopeCandidate>(
  rows: readonly T[],
  orderedSourceIds: readonly string[],
  minutes?: MinutesRanking,
): T[] {
  const bestBySource = new Map<string, T>();
  for (const row of rows) {
    if (!row.source_id) continue;
    const current = bestBySource.get(row.source_id);
    if (!current || envelopePriorityCompare(row, current, minutes) < 0) {
      bestBySource.set(row.source_id, row);
    }
  }
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const sourceId of orderedSourceIds) {
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const match = bestBySource.get(sourceId);
    if (match) selected.push(match);
  }
  return selected;
}

export const envelopeBySource = defineQuery({
  name: 'sign.envelope.by_source',
  input: z.strictObject({
    sourceKind: z.enum(SIGN_SOURCE_KINDS),
    sourceIds: z.array(zId).min(1).max(SIGN_BY_SOURCE_MAX),
  }),
  access: READERS,
  handler: async (ctx, input): Promise<{ items: SignEnvelopeBySourceItem[] }> => {
    assertUser(ctx);
    if (input.sourceKind === 'standalone') {
      return { items: [] };
    }
    const uniqueSourceIds = [...new Set(input.sourceIds)];
    let q = ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'source_kind',
        'source_id',
        'seal_status',
        'sealed_file_id',
        'certificate_code',
        'completed_at',
        'created_by',
        'created_at',
        'updated_at',
        'source_revision',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('source_kind', '=', input.sourceKind)
      .where('source_id', 'is not', null)
      .where('source_id', 'in', uniqueSourceIds);
    if (input.sourceKind === 'hr_contract' && !isHrPrivilegedRole(ctx.role)) {
      const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
      if (!userId) return { items: [] };
      q = q.where('created_by', '=', userId);
    }
    if (input.sourceKind === 'meeting_minutes') {
      q = applyMeetingMinutesVisibilityFilter(q, ctx);
    }
    const rawRows = await q.execute();
    const rows = rawRows.filter((r) =>
      canAccessEnvelopeRow(ctx, {
        source_kind: r.source_kind ?? input.sourceKind,
        created_by: r.created_by ?? '',
      }),
    );

    // Meeting minutes: the database's revision of the published minutes now, per meeting, to tell which envelopes were made for older minutes (#4532).
    const currentRevisions = new Map<string, string | null>();
    if (input.sourceKind === 'meeting_minutes') {
      for (const sourceId of new Set(rows.map((r) => r.source_id).filter((id): id is string => id !== null))) {
        currentRevisions.set(sourceId, await currentMeetingMinutesRevision(ctx, sourceId));
      }
    }
    const selected = selectLatestEnvelopesBySource(rows, uniqueSourceIds, input.sourceKind === 'meeting_minutes' ? { currentRevisions } : undefined);
    if (selected.length === 0) {
      return { items: [] };
    }

    const signerRows = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['envelope_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'envelope_id',
        'in',
        selected.map((r) => r.id),
      )
      .where('signer_role', '!=', 'cc')
      .execute();

    const countsByEnvelope = new Map<string, { total: number; signed: number }>();
    for (const signer of signerRows) {
      let entry = countsByEnvelope.get(signer.envelope_id);
      if (!entry) {
        entry = { total: 0, signed: 0 };
        countsByEnvelope.set(signer.envelope_id, entry);
      }
      entry.total += 1;
      if (signer.status === 'signed') {
        entry.signed += 1;
      }
    }

    return {
      items: selected.map((r) => {
        const counts = countsByEnvelope.get(r.id);
        return {
          sourceId: r.source_id as string,
          envelopeId: r.id,
          title: r.title,
          status: r.status,
          sealStatus: r.seal_status,
          sealedFileId: r.sealed_file_id ?? null,
          certificateCode: r.certificate_code,
          completedAt: isoOrNull(r.completed_at),
          signerCount: counts?.total ?? 0,
          signedCount: counts?.signed ?? 0,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
          // Made for other minutes than the published ones: decided here from the revision the database stored, never from the title.
          ...(input.sourceKind === 'meeting_minutes'
            ? { stale: envelopeStale(r, currentRevisions.get(r.source_id as string) ?? null) }
            : {}),
        };
      }),
    };
  },
});

export const envelopeGet = defineQuery({
  name: 'sign.envelope.get',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input) => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);

    const signers = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select([
        'id',
        'envelope_id',
        'role_key',
        'routing_order',
        'signer_role',
        'role_label',
        'name',
        'email',
        'phone',
        'delivery_mode',
        'require_email_otp',
        'status',
        'token_last_reminded_at',
        'pre_expiry_reminded_at',
        'viewed_at',
        'signed_at',
        'declined_at',
        'decline_reason',
        'otp_verified_at',
        'signature_kind',
        'consent_accepted_at',
        'delegated_from_name',
        'delegated_from_email',
        'delegation_reason',
        'delegation_count',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const remindedSignerIds = signers
      .filter((s) => s.pre_expiry_reminded_at !== null)
      .map((s) => s.id);
    const preExpiryMailStatusBySigner = new Map<string, string>();
    if (remindedSignerIds.length > 0) {
      const mailRows = await ctx.trx
        .selectFrom('ludy_kernel.mail_message')
        .select(['source_id', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('source', '=', SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE)
        .where('source_id', 'in', remindedSignerIds)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      for (const m of mailRows) {
        if (m.source_id && !preExpiryMailStatusBySigner.has(m.source_id)) {
          preExpiryMailStatusBySigner.set(m.source_id, m.status);
        }
      }
    }

    const fields = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select([
        'id',
        'envelope_id',
        'document_id',
        'signer_id',
        'field_type',
        'page_number',
        'x_norm',
        'y_norm',
        'w_norm',
        'h_norm',
        'label',
        'required',
        'proposed_by_ai',
        'font_size_pt',
        'options_json',
        'value_text',
        'value_checked',
        'attachment_file_id',
        'attachment_filename',
        'attachment_content_type',
        'attachment_size_bytes',
        'attachment_sha256',
        'filled_at',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('page_number', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const docRows = await ctx.trx
      .selectFrom('ludy_sign.envelope_document as ed')
      .innerJoin('ludy_kernel.file as f', (join) =>
        join.onRef('f.org_id', '=', 'ed.org_id').onRef('f.id', '=', 'ed.file_id'),
      )
      .select([
        'ed.id',
        'ed.doc_index',
        'ed.title',
        'ed.file_id',
        'ed.source_sha256',
        'ed.inspect_status',
        'ed.inspect_error',
        'ed.page_count',
        'ed.page_dimensions_json',
        'ed.detected_tags_json',
        'ed.created_at',
        'ed.updated_at',
        'f.size_bytes',
      ])
      .where('ed.org_id', '=', ctx.orgId)
      .where('ed.envelope_id', '=', env.id)
      .orderBy('ed.doc_index', 'asc')
      .orderBy('ed.id', 'asc')
      .execute();

    const documents =
      docRows.length > 0
        ? docRows.map((d) => ({
            id: d.id,
            docIndex: d.doc_index,
            title: d.title,
            fileId: d.file_id,
            sourceSha256: d.source_sha256,
            inspectStatus: d.inspect_status,
            inspectError: d.inspect_error,
            pageCount: d.page_count,
            pageDimensions: parseEventPayload(d.page_dimensions_json),
            detectedTags: parseDetectedTags(d.detected_tags_json, d.page_count),
            sizeBytes: Number.isFinite(Number(d.size_bytes)) ? Number(d.size_bytes) : null,
            createdAt: new Date(d.created_at).toISOString(),
            updatedAt: new Date(d.updated_at).toISOString(),
          }))
        : await (async () => {
            const baseFile = await ctx.trx
              .selectFrom('ludy_kernel.file')
              .select(['size_bytes'])
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', env.source_file_id)
              .executeTakeFirst();
            return [
              {
                id: null,
                docIndex: 1,
                title: env.title,
                fileId: env.source_file_id,
                sourceSha256: env.source_sha256,
                inspectStatus: env.inspect_status,
                inspectError: env.inspect_error,
                pageCount: env.page_count,
                pageDimensions: parseEventPayload(env.page_dimensions_json),
                detectedTags: parseDetectedTags(env.detected_tags_json, env.page_count),
                sizeBytes: baseFile && Number.isFinite(Number(baseFile.size_bytes)) ? Number(baseFile.size_bytes) : null,
                createdAt: new Date(env.created_at).toISOString(),
                updatedAt: new Date(env.updated_at).toISOString(),
              },
            ];
          })();

    return {
      envelope: {
        id: env.id,
        title: env.title,
        subject: env.subject,
        message: env.message,
        status: env.status,
        routingMode: env.routing_mode,
        allowDelegation: env.allow_delegation,
        sourceKind: env.source_kind,
        sourceId: env.source_id,
        sourceFileId: env.source_file_id,
        sourceSha256: env.source_sha256,
        inspectStatus: env.inspect_status,
        inspectError: env.inspect_error,
        pageCount: env.page_count,
        pageDimensions: parseEventPayload(env.page_dimensions_json),
        detectedTags: parseDetectedTags(env.detected_tags_json, env.page_count),
        shareSummaryWithSigners: Boolean(env.share_summary_with_signers),
        sharedSummary: parseSharedSummary(env.shared_summary_json, env.page_count),
        sealedFileId: env.sealed_file_id,
        sealedSha256: env.sealed_sha256,
        sealStatus: env.seal_status,
        certificateFileId: env.certificate_file_id,
        certificateSha256: env.certificate_sha256,
        certificateCode: env.certificate_code,
        expiresAt: isoOrNull(env.expires_at),
        autoRemindBeforeExpiry: env.auto_remind_before_expiry,
        sentAt: isoOrNull(env.sent_at),
        completedAt: isoOrNull(env.completed_at),
        declinedAt: isoOrNull(env.declined_at),
        declineAcknowledgedAt: isoOrNull(env.decline_acknowledged_at),
        voidedAt: isoOrNull(env.voided_at),
        voidedBy: env.voided_by,
        voidReason: env.void_reason,
        expiredAt: isoOrNull(env.expired_at),
        version: env.version,
        createdBy: env.created_by,
        createdAt: new Date(env.created_at).toISOString(),
        updatedAt: new Date(env.updated_at).toISOString(),
      },
      signers: signers.map((s) => ({
        id: s.id,
        roleKey: s.role_key ?? null,
        routingOrder: s.routing_order,
        signerRole: s.signer_role,
        roleLabel: s.role_label,
        name: s.name,
        email: s.email,
        phone: s.phone,
        deliveryMode: s.delivery_mode,
        requireEmailOtp: s.require_email_otp,
        status: s.status,
        tokenLastRemindedAt: isoOrNull(s.token_last_reminded_at),
        preExpiryRemindedAt: isoOrNull(s.pre_expiry_reminded_at),
        preExpiryRemindStatus:
          (preExpiryMailStatusBySigner.get(s.id) as
            | 'queued'
            | 'sending'
            | 'sent'
            | 'delivered'
            | 'bounced'
            | 'complained'
            | 'suppressed'
            | 'failed'
            | 'ambiguous'
            | undefined) ?? null,
        viewedAt: isoOrNull(s.viewed_at),
        signedAt: isoOrNull(s.signed_at),
        declinedAt: isoOrNull(s.declined_at),
        declineReason: s.decline_reason,
        otpVerifiedAt: isoOrNull(s.otp_verified_at),
        signatureKind: s.signature_kind,
        consentAcceptedAt: isoOrNull(s.consent_accepted_at),
        delegatedFromName: s.delegated_from_name,
        delegatedFromEmail: s.delegated_from_email,
        delegationReason: s.delegation_reason,
        delegationCount: s.delegation_count,
        createdAt: new Date(s.created_at).toISOString(),
        updatedAt: new Date(s.updated_at).toISOString(),
      })),
      fields: fields.map((f) => ({
        id: f.id,
        documentId: f.document_id ?? null,
        signerId: f.signer_id,
        fieldType: f.field_type,
        pageNumber: f.page_number,
        xNorm: Number(f.x_norm),
        yNorm: Number(f.y_norm),
        wNorm: Number(f.w_norm),
        hNorm: Number(f.h_norm),
        label: f.label,
        required: f.required,
        proposedByAi: f.proposed_by_ai,
        fontSizePt: f.font_size_pt,
        options: parseFieldOptions(f.options_json),
        valueText: f.value_text,
        valueChecked: f.value_checked,
        attachmentFileId: f.attachment_file_id,
        attachmentFilename: f.attachment_filename,
        attachmentContentType: f.attachment_content_type,
        attachmentSizeBytes: f.attachment_size_bytes,
        attachmentSha256: f.attachment_sha256,
        filledAt: isoOrNull(f.filled_at),
        createdAt: new Date(f.created_at).toISOString(),
        updatedAt: new Date(f.updated_at).toISOString(),
      })),
      documents,
    };
  },
});

export const envelopeEvents = defineQuery({
  name: 'sign.envelope.events',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input) => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);

    const rows = await ctx.trx
      .selectFrom('ludy_sign.signing_event')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('seq', 'asc')
      .execute();

    return {
      envelopeId: env.id,
      events: rows.map((e) => ({
        id: e.id,
        signerId: e.signer_id,
        hostUserId: e.host_user_id ?? null,
        seq: e.seq,
        eventType: e.event_type,
        actorType: e.actor_type,
        actorId: e.actor_id,
        actorLabel: e.actor_label,
        documentSha256: e.document_sha256,
        prevEventHash: e.prev_event_hash,
        eventHash: e.event_hash,
        payload: parseEventPayload(e.payload_json),
        occurredAt: new Date(e.occurred_at).toISOString(),
      })),
    };
  },
});

export const envelopeVerify = defineQuery({
  name: 'sign.envelope.verify',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input) => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'status',
        'source_kind',
        'source_id',
        'created_by',
        'retained_org_visible',
        'retained_reader_ids',
        'seal_status',
        'source_file_id',
        'source_storage_key',
        'source_generation',
        'source_sha256',
        'sealed_file_id',
        'sealed_storage_key',
        'sealed_generation',
        'sealed_sha256',
        'certificate_file_id',
        'certificate_storage_key',
        'certificate_generation',
        'certificate_sha256',
        'certificate_code',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);

    const events = await ctx.trx
      .selectFrom('ludy_sign.signing_event')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('seq', 'asc')
      .execute();

    const chain =
      events.length === 0
        ? { valid: false, count: 0, tipHash: null, brokenSeq: null, reason: 'No signing events recorded' }
        : verifyEventChain(events);

    const attachmentFields = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select(['attachment_file_id', 'attachment_content_type', 'attachment_size_bytes', 'attachment_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('attachment_file_id', 'is not', null)
      .execute();

    const packetDocs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['file_id', 'storage_key', 'generation', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .execute();

    const fileIds = [
      env.source_file_id,
      env.sealed_file_id,
      env.certificate_file_id,
      ...packetDocs.map((d) => d.file_id),
      ...attachmentFields.map((f) => f.attachment_file_id),
    ].filter((id): id is string => id !== null);
    const fileRows = await ctx.trx
      .selectFrom('ludy_kernel.file')
      .select(['id', 'source', 'content_type', 'size_bytes', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', fileIds)
      .execute();
    const byId = new Map(fileRows.map((f) => [f.id, f]));

    const srcFile = byId.get(env.source_file_id);
    const rootSourceConsistent =
      srcFile !== undefined &&
      srcFile.source === 'sign_document' &&
      srcFile.storage_key === env.source_storage_key &&
      srcFile.generation === env.source_generation &&
      srcFile.sha256 === env.source_sha256;
    const docsConsistent = packetDocs.every((d) => {
      const f = byId.get(d.file_id);
      return (
        f !== undefined &&
        f.source === 'sign_document' &&
        f.storage_key === d.storage_key &&
        f.generation === d.generation &&
        f.sha256 === d.source_sha256
      );
    });
    const sourceConsistent = rootSourceConsistent && docsConsistent;

    const sealedConsistent =
      env.sealed_file_id === null
        ? env.seal_status !== 'sealed'
        : (() => {
            const f = byId.get(env.sealed_file_id);
            return (
              f !== undefined &&
              f.source === 'sign_sealed' &&
              f.storage_key === env.sealed_storage_key &&
              f.generation === env.sealed_generation &&
              f.sha256 === env.sealed_sha256
            );
          })();

    const certConsistent =
      env.certificate_file_id === null
        ? env.seal_status !== 'sealed'
        : (() => {
            const f = byId.get(env.certificate_file_id);
            return (
              f !== undefined &&
              f.source === 'sign_certificate' &&
              f.storage_key === env.certificate_storage_key &&
              f.generation === env.certificate_generation &&
              f.sha256 === env.certificate_sha256
            );
          })();

    const attachmentsConsistent = attachmentFields.every((af) => {
      if (!af.attachment_file_id) return true;
      const f = byId.get(af.attachment_file_id);
      return (
        f !== undefined &&
        f.source === 'sign_attachment' &&
        f.content_type === af.attachment_content_type &&
        Number(f.size_bytes) === af.attachment_size_bytes &&
        f.sha256 === af.attachment_sha256
      );
    });

    const pointersConsistent = sourceConsistent && sealedConsistent && certConsistent && attachmentsConsistent;
    return {
      envelopeId: env.id,
      status: env.status,
      sealStatus: env.seal_status,
      valid: chain.valid && pointersConsistent,
      eventChain: chain,
      files: {
        sourceSha256: env.source_sha256,
        sealedSha256: env.sealed_sha256,
        certificateSha256: env.certificate_sha256,
        certificateCode: env.certificate_code,
        pointersConsistent,
      },
    };
  },
});

export interface SignInspectJobDocumentData {
  id: string;
  docIndex: number;
  inspectStatus: string;
  sourceStorageKey: string;
  sourceGeneration: string;
  sourceSha256: string;
}

export interface SignInspectJobData {
  id: string;
  documentId?: string;
  status: string;
  inspectStatus: string;
  sourceStorageKey: string;
  sourceGeneration: string;
  sourceSha256: string;
  pendingDocuments?: SignInspectJobDocumentData[];
}

export interface SignSealJobDocument {
  id: string;
  docIndex: number;
  title: string;
  storageKey: string;
  generation: string;
  sourceSha256: string;
  pageCount: number | null;
}

export interface SignSealJobData {
  envelope: {
    id: string;
    title: string;
    status: string;
    sourceStorageKey: string;
    sourceGeneration: string;
    sourceSha256: string;
    pageCount: number | null;
    sealStatus: string | null;
    completedAtIso: string | null;
  };
  documents: SignSealJobDocument[];
  signers: SignSignerForSeal[];
  fields: SignFieldForSeal[];
  events: SigningEventChainRow[];
}

export const envelopeInspectJobData = defineQuery({
  name: 'sign.envelope.inspect_job_data',
  input: z.strictObject({ envelopeId: zId, documentId: zId.optional() }),
  access: 'system',
  handler: async (ctx, input): Promise<SignInspectJobData | null> => {
    assertSystem(ctx);
    const row = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'status',
        'inspect_status',
        'source_storage_key',
        'source_generation',
        'source_sha256',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!row) return null;
    if (input.documentId) {
      const doc = await ctx.trx
        .selectFrom('ludy_sign.envelope_document')
        .select(['id', 'inspect_status', 'storage_key', 'generation', 'source_sha256'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', row.id)
        .where('id', '=', input.documentId)
        .executeTakeFirst();
      if (!doc) return null;
      return {
        id: row.id,
        documentId: doc.id,
        status: row.status,
        inspectStatus: doc.inspect_status,
        sourceStorageKey: doc.storage_key,
        sourceGeneration: doc.generation,
        sourceSha256: doc.source_sha256,
      };
    }
    const pendingDocs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['id', 'doc_index', 'inspect_status', 'storage_key', 'generation', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('inspect_status', '=', 'pending')
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return {
      id: row.id,
      status: row.status,
      inspectStatus: row.inspect_status,
      sourceStorageKey: row.source_storage_key,
      sourceGeneration: row.source_generation,
      sourceSha256: row.source_sha256,
      ...(pendingDocs.length > 0
        ? {
            pendingDocuments: pendingDocs.map((d) => ({
              id: d.id,
              docIndex: d.doc_index,
              inspectStatus: d.inspect_status,
              sourceStorageKey: d.storage_key,
              sourceGeneration: d.generation,
              sourceSha256: d.source_sha256,
            })),
          }
        : {}),
    };
  },
});

export const envelopeSealJobData = defineQuery({
  name: 'sign.envelope.seal_job_data',
  input: z.strictObject({ envelopeId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SignSealJobData | null> => {
    assertSystem(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'source_storage_key',
        'source_generation',
        'source_sha256',
        'page_count',
        'seal_status',
        'completed_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) return null;

    const signers = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select([
        'id',
        'routing_order',
        'signer_role',
        'role_label',
        'name',
        'email',
        'delivery_mode',
        'require_email_otp',
        'status',
        'signed_at',
        'otp_verified_at',
        'signature_kind',
        'signer_ip_hash',
        'delegated_from_name',
        'delegated_from_email',
        'delegation_count',
        'created_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const documents = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['id', 'doc_index', 'title', 'storage_key', 'generation', 'source_sha256', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const fields = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select([
        'id',
        'document_id',
        'signer_id',
        'field_type',
        'page_number',
        'x_norm',
        'y_norm',
        'w_norm',
        'h_norm',
        'label',
        'required',
        'font_size_pt',
        'value_text',
        'value_checked',
        'signature_png_base64',
        'attachment_file_id',
        'attachment_filename',
        'attachment_sha256',
        'filled_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('page_number', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const events = await ctx.trx
      .selectFrom('ludy_sign.signing_event')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('seq', 'asc')
      .execute();

    return {
      envelope: {
        id: env.id,
        title: env.title,
        status: env.status,
        sourceStorageKey: env.source_storage_key,
        sourceGeneration: env.source_generation,
        sourceSha256: env.source_sha256,
        pageCount: env.page_count,
        sealStatus: env.seal_status,
        completedAtIso: isoOrNull(env.completed_at),
      },
      documents: documents.map((d) => ({
        id: d.id,
        docIndex: d.doc_index,
        title: d.title,
        storageKey: d.storage_key,
        generation: d.generation,
        sourceSha256: d.source_sha256,
        pageCount: d.page_count,
      })),
      signers,
      fields,
      events,
    };
  },
});

import { signAcceptanceQueries } from './acceptance.ts';
import { signCaQueries } from './ca.ts';
import { signKycQueries } from './kyc.ts';
import { signObligationQueries } from './obligations.ts';
import { signPlaybookQueries } from './playbook.ts';
import { signProfileQueries } from './profiles.ts';
import { signTemplateQueries } from './templates.ts';
import { signToday } from './today-and-reminders.ts';
import { signWebhookQueries } from './webhooks.ts';

export interface SignDiffSourceResult {
  aiStopped: boolean;
}

async function verifySignReadablePdfFile(ctx: QueryContext, fileId: string): Promise<void> {
  const file = await ctx.trx
    .selectFrom('ludy_kernel.file')
    .select(['id', 'source', 'content_type'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!file) {
    throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
  }
  const { rows } = await sql<{ allowed: boolean }>`
    SELECT ludy_sign.can_read_sign_file(${file.id}::uuid) AS allowed
  `.execute(ctx.trx);
  if (!rows[0]?.allowed) {
    throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
  }
  if (file.source !== 'sign_document') {
    throw new DomainError('SIGN_INVALID_SOURCE_FILE', 422, 'Compared file must have source sign_document');
  }
  if (file.content_type !== 'application/pdf') {
    throw new DomainError('SIGN_INVALID_FILE_TYPE', 422, 'Compared file must be application/pdf');
  }
}

export const signDiffSource = defineQuery({
  name: 'sign.diff.source',
  input: z.strictObject({
    fileIdV1: zId.optional(),
    fileIdV2: zId.optional(),
  }),
  access: READERS,
  handler: async (ctx, input): Promise<SignDiffSourceResult> => {
    assertUser(ctx);
    if (input.fileIdV1) {
      await verifySignReadablePdfFile(ctx, input.fileIdV1);
    }
    if (input.fileIdV2) {
      await verifySignReadablePdfFile(ctx, input.fileIdV2);
    }
    return {
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
    };
  },
});

export const signDrafterAiSource = defineQuery({
  name: 'sign.drafter.ai_source',
  input: z.strictObject({}),
  access: SIGN_WRITERS,
  handler: async (ctx): Promise<{ aiStopped: boolean }> => {
    assertUser(ctx);
    return {
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
    };
  },
});

export const signDrafterRenderPdf = defineQuery({
  name: 'sign.drafter.render_pdf',
  input: zSignDrafterRenderPdfInput,
  access: SIGN_WRITERS,
  handler: async (ctx, input): Promise<SignDrafterRenderPdfResult> => {
    assertUser(ctx);
    const rendered = renderStarterContractPdf(input);
    return {
      title: rendered.title,
      filename: rendered.filename,
      pdfBase64: Buffer.from(rendered.bytes).toString('base64'),
      sha256: rendered.sha256,
      pageCount: rendered.pageCount,
    };
  },
});

export const signQueries = [
  envelopeList,
  envelopeBySource,
  envelopeGet,
  envelopeEvents,
  envelopeVerify,
  envelopeInspectJobData,
  envelopeSealJobData,
  signToday,
  signDiffSource,
  signDrafterAiSource,
  signDrafterRenderPdf,
  ...signTemplateQueries,
  ...signAcceptanceQueries,
  ...signCaQueries,
  ...signKycQueries,
  ...signObligationQueries,
  ...signProfileQueries,
  ...signVaultQueries,
  ...signWebhookQueries,
  ...signPlaybookQueries,
  ...signApiKeyQueries,
  ...signMcpQueries,
  ...signDocxConvertQueries,
  ...signEnvelopeDocumentQueries,
];
