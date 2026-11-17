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
} from '@crove/db';
import { SIGN_BY_SOURCE_MAX, zId, type SignEnvelopeBySourceItem } from '@crove/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import type { SigningEventChainRow } from './events.ts';
import { parseEventPayload, verifyEventChain } from './events.ts';
import type { SignFieldForSeal, SignSignerForSeal } from './sealing.ts';

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
      .selectFrom('crove_sign.envelope')
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
        'sent_at',
        'completed_at',
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
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit).execute();
    if (rows.length === 0) {
      return { items: [] };
    }

    const actorUserId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    let actorEmail: string | null = null;
    if (actorUserId !== null) {
      const { rows: profileRows } = await sql<{ email: string | null }>`
        SELECT email FROM crove_kernel.member_profiles(${[actorUserId]}::uuid[])
      `.execute(ctx.trx);
      actorEmail = profileRows[0]?.email?.trim().toLowerCase() ?? null;
    }

    const signerRows = await ctx.trx
      .selectFrom('crove_sign.signer')
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
          sentAt: isoOrNull(r.sent_at),
          completedAt: isoOrNull(r.completed_at),
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
  created_at: Date | string;
  updated_at: Date | string;
}

function envelopePriorityCompare(a: SourceEnvelopeCandidate, b: SourceEnvelopeCandidate): number {
  const aVoided = a.status === 'voided' ? 1 : 0;
  const bVoided = b.status === 'voided' ? 1 : 0;
  if (aVoided !== bVoided) return aVoided - bVoided;
  const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  if (createdDiff !== 0) return createdDiff;
  const updatedDiff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  if (updatedDiff !== 0) return updatedDiff;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

// Selects the latest non-voided envelope (or latest overall if only voided exist) per requested sourceId.
export function selectLatestEnvelopesBySource<T extends SourceEnvelopeCandidate>(
  rows: readonly T[],
  orderedSourceIds: readonly string[],
): T[] {
  const bestBySource = new Map<string, T>();
  for (const row of rows) {
    if (!row.source_id) continue;
    const current = bestBySource.get(row.source_id);
    if (!current || envelopePriorityCompare(row, current) < 0) {
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
    const rows = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'source_id',
        'seal_status',
        'certificate_code',
        'completed_at',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('source_kind', '=', input.sourceKind)
      .where('source_id', 'is not', null)
      .where('source_id', 'in', uniqueSourceIds)
      .execute();

    const selected = selectLatestEnvelopesBySource(rows, uniqueSourceIds);
    if (selected.length === 0) {
      return { items: [] };
    }

    const signerRows = await ctx.trx
      .selectFrom('crove_sign.signer')
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
          certificateCode: r.certificate_code,
          completedAt: isoOrNull(r.completed_at),
          signerCount: counts?.total ?? 0,
          signedCount: counts?.signed ?? 0,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
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
      .selectFrom('crove_sign.envelope')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');

    const signers = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select([
        'id',
        'envelope_id',
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
        'viewed_at',
        'signed_at',
        'declined_at',
        'decline_reason',
        'otp_verified_at',
        'signature_kind',
        'consent_accepted_at',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const fields = await ctx.trx
      .selectFrom('crove_sign.field')
      .select([
        'id',
        'envelope_id',
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
        'value_text',
        'value_checked',
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

    return {
      envelope: {
        id: env.id,
        title: env.title,
        subject: env.subject,
        message: env.message,
        status: env.status,
        routingMode: env.routing_mode,
        sourceKind: env.source_kind,
        sourceId: env.source_id,
        sourceFileId: env.source_file_id,
        sourceSha256: env.source_sha256,
        inspectStatus: env.inspect_status,
        inspectError: env.inspect_error,
        pageCount: env.page_count,
        pageDimensions: parseEventPayload(env.page_dimensions_json),
        sealedFileId: env.sealed_file_id,
        sealedSha256: env.sealed_sha256,
        sealStatus: env.seal_status,
        certificateFileId: env.certificate_file_id,
        certificateSha256: env.certificate_sha256,
        certificateCode: env.certificate_code,
        expiresAt: isoOrNull(env.expires_at),
        sentAt: isoOrNull(env.sent_at),
        completedAt: isoOrNull(env.completed_at),
        declinedAt: isoOrNull(env.declined_at),
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
        viewedAt: isoOrNull(s.viewed_at),
        signedAt: isoOrNull(s.signed_at),
        declinedAt: isoOrNull(s.declined_at),
        declineReason: s.decline_reason,
        otpVerifiedAt: isoOrNull(s.otp_verified_at),
        signatureKind: s.signature_kind,
        consentAcceptedAt: isoOrNull(s.consent_accepted_at),
        createdAt: new Date(s.created_at).toISOString(),
        updatedAt: new Date(s.updated_at).toISOString(),
      })),
      fields: fields.map((f) => ({
        id: f.id,
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
        valueText: f.value_text,
        valueChecked: f.value_checked,
        filledAt: isoOrNull(f.filled_at),
        createdAt: new Date(f.created_at).toISOString(),
        updatedAt: new Date(f.updated_at).toISOString(),
      })),
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
      .selectFrom('crove_sign.envelope')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');

    const rows = await ctx.trx
      .selectFrom('crove_sign.signing_event')
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
      .selectFrom('crove_sign.envelope')
      .select([
        'id',
        'status',
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

    const events = await ctx.trx
      .selectFrom('crove_sign.signing_event')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('seq', 'asc')
      .execute();

    const chain =
      events.length === 0
        ? { valid: false, count: 0, tipHash: null, brokenSeq: null, reason: 'No signing events recorded' }
        : verifyEventChain(events);

    const fileIds = [env.source_file_id, env.sealed_file_id, env.certificate_file_id].filter(
      (id): id is string => id !== null,
    );
    const fileRows = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'source', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', fileIds)
      .execute();
    const byId = new Map(fileRows.map((f) => [f.id, f]));

    const srcFile = byId.get(env.source_file_id);
    const sourceConsistent =
      srcFile !== undefined &&
      srcFile.source === 'sign_document' &&
      srcFile.storage_key === env.source_storage_key &&
      srcFile.generation === env.source_generation &&
      srcFile.sha256 === env.source_sha256;

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

    const pointersConsistent = sourceConsistent && sealedConsistent && certConsistent;
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

export interface SignInspectJobData {
  id: string;
  status: string;
  inspectStatus: string;
  sourceStorageKey: string;
  sourceGeneration: string;
  sourceSha256: string;
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
  signers: SignSignerForSeal[];
  fields: SignFieldForSeal[];
  events: SigningEventChainRow[];
}

export const envelopeInspectJobData = defineQuery({
  name: 'sign.envelope.inspect_job_data',
  input: z.strictObject({ envelopeId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SignInspectJobData | null> => {
    assertSystem(ctx);
    const row = await ctx.trx
      .selectFrom('crove_sign.envelope')
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
    return {
      id: row.id,
      status: row.status,
      inspectStatus: row.inspect_status,
      sourceStorageKey: row.source_storage_key,
      sourceGeneration: row.source_generation,
      sourceSha256: row.source_sha256,
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
      .selectFrom('crove_sign.envelope')
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
      .selectFrom('crove_sign.signer')
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
        'created_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const fields = await ctx.trx
      .selectFrom('crove_sign.field')
      .select([
        'id',
        'field_type',
        'page_number',
        'x_norm',
        'y_norm',
        'w_norm',
        'h_norm',
        'required',
        'font_size_pt',
        'value_text',
        'value_checked',
        'signature_png_base64',
        'filled_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('page_number', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const events = await ctx.trx
      .selectFrom('crove_sign.signing_event')
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
      signers,
      fields,
      events,
    };
  },
});

import { signTemplateQueries } from './templates.ts';

export const signQueries = [
  envelopeList,
  envelopeBySource,
  envelopeGet,
  envelopeEvents,
  envelopeVerify,
  envelopeInspectJobData,
  envelopeSealJobData,
  ...signTemplateQueries,
];
