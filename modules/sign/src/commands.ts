// SPDX-License-Identifier: AGPL-3.0-only
// Runtime.execute() command handlers for eSign Slice 1a (#3323, docs/plan/esign.md).
// Every state change on crove_sign tables runs inside a command transaction here and appends to the hash-chained
// crove_sign.signing_event ledger. Raw signing tokens are returned once by send / create_link and never stored.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_DELIVERY_MODES,
  SIGN_FIELD_TYPES,
  SIGN_ROUTING_MODES,
  SIGN_SIGNER_ROLES,
  SIGN_SOURCE_KINDS,
  type MemberRole,
  type SignDeliveryMode,
  type SignSignerStatus,
} from '@ludy/db';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import {
  tableWrite,
  zId,
  zSignFieldOptions,
  zSignSharedSummary,
  zSignSignerCorrectRecipientInput,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CommandContext, type ErrorStatus } from '@ludy/kernel-runtime';
import { signDirectPublicCommands } from './direct-public.ts';
import { appendSigningEvent } from './events.ts';
import { assertCanAccessEnvelopeRow, assertCanCreateEnvelopeForSource } from './hr-visibility.ts';
import { signInPersonCommands } from './in-person.ts';
import {
  assertCanAccessMeetingMinutesEnvelopeRow,
  assertCanCreateMeetingMinutesEnvelope,
} from './meeting-visibility.ts';
import { signManifest } from './manifest.ts';
import { signPublicCommands } from './public-commands.ts';
import { generateRawSigningToken, hashSigningToken, maskEmail } from './sealing.ts';
import {
  SIGN_CORRECT_INVITE_MAIL_SOURCE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_REMIND_MAIL_SOURCE,
  SIGN_REMIND_MAIL_TEMPLATE,
  queueSignCompletedEmail,
  queueSignInviteEmail,
} from './sign-mail.ts';
import {
  ENVELOPE_VERSION_WRITE,
  MAIL_MESSAGE_WRITE,
  SIGNING_EVENT_WRITE,
  SIGNING_OTP_INVALIDATE_WRITE,
  SIGNING_TOKEN_WRITE,
  requireSignSourceFile,
  sanitizeSharedSummaryForWrite,
  sendDraftEnvelope,
  serializeFieldOptionsForType,
  zSignInspectDetectedTags,
  type IssuedSigningLink,
} from './shared.ts';
import { signCaCommands } from './ca.ts';
import { signTemplateCommands } from './templates.ts';
import { envelopePreExpiryRemindSweep } from './today-and-reminders.ts';

export type { IssuedSigningLink };

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const REMIND_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_LINK_TTL_HOURS = 30 * 24;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_OTP_RETENTION_HOURS = 24;
const EXPIRE_SWEEP_BATCH = 100;
const NORM_SCALE = 1_000_000;
const MAX_ROUTING_ORDER = 100;

const zNormMin0 = z.number().finite().min(0).lt(1);
const zNormSpan = z.number().finite().gt(0).lte(1);

function toMicroNorm(value: number): number {
  return Math.round(value * NORM_SCALE);
}

function formatMicroNorm(micro: number): string {
  return (micro / NORM_SCALE).toFixed(6);
}

function nextDefaultRoutingOrder(existing: ReadonlyArray<{ routing_order: number }>): number {
  const maxOrder = existing.reduce((max, item) => Math.max(max, item.routing_order), 0);
  if (maxOrder < MAX_ROUTING_ORDER) {
    return maxOrder + 1;
  }
  const used = new Set(existing.map((item) => item.routing_order));
  for (let order = 1; order <= MAX_ROUTING_ORDER; order += 1) {
    if (!used.has(order)) return order;
  }
  return MAX_ROUTING_ORDER;
}

const target = (input: { envelopeId: string }) => ({ type: 'sign.envelope', id: input.envelopeId });

function userOf(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this action');
  }
  return ctx.actor.userId;
}

function assertSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only system workers can run this action');
  }
}

function actorLabelOf(ctx: CommandContext): string {
  if (ctx.actor.type === 'user') return `user:${ctx.actor.userId}`;
  if (ctx.actor.type === 'system') return `system:${ctx.actor.component}`;
  return `actor:${ctx.actor.type}`;
}

async function lockEnvelope(ctx: CommandContext, envelopeId: string) {
  const row = await ctx.trx
    .selectFrom('crove_sign.envelope')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', envelopeId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
  assertCanAccessEnvelopeRow(ctx, row);
  await assertCanAccessMeetingMinutesEnvelopeRow(ctx, row);
  return row;
}

function assertDraft(status: string): void {
  if (status !== 'draft') {
    throw new DomainError('SIGN_ENVELOPE_NOT_DRAFT', 409, 'Envelope can no longer be edited once sent');
  }
}

const zEnvelopeCreate = z.strictObject({
  title: z.string().trim().min(1).max(300),
  subject: z.string().trim().min(1).max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  routingMode: z.enum(SIGN_ROUTING_MODES).default('parallel'),
  allowDelegation: z.boolean().optional(),
  sourceKind: z.enum(SIGN_SOURCE_KINDS).default('standalone'),
  sourceId: zId.nullable().optional(),
  sourceFileId: zId,
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  autoRemindBeforeExpiry: z.boolean().optional(),
});

export const envelopeCreate = defineCommand({
  name: 'sign.envelope.create',
  input: zEnvelopeCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'org_id',
      'title',
      'subject',
      'message',
      'status',
      'routing_mode',
      'allow_delegation',
      'source_kind',
      'source_id',
      'source_file_id',
      'source_storage_key',
      'source_generation',
      'source_sha256',
      'inspect_status',
      'expires_at',
      'auto_remind_before_expiry',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const sourceId = input.sourceId ?? null;
    if (input.sourceKind === 'standalone' && sourceId !== null) {
      throw new DomainError('SIGN_INVALID_SOURCE', 422, 'Standalone envelopes cannot specify sourceId');
    }
    if (input.sourceKind !== 'standalone' && sourceId === null) {
      throw new DomainError('SIGN_INVALID_SOURCE', 422, 'Linked envelopes require sourceId');
    }
    assertCanCreateEnvelopeForSource(ctx, input.sourceKind);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt !== null && expiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }
    await assertCanCreateMeetingMinutesEnvelope(ctx, input.sourceKind, sourceId);

    const file = await requireSignSourceFile(ctx, input.sourceFileId);
    if (input.sourceKind === 'hr_contract' || input.sourceKind === 'meeting_minutes') {
      const { rows: attachCheck } = await sql<{ allowed: boolean }>`
        SELECT crove_sign.can_attach_confidential_source_file(
          ${ctx.orgId}::uuid,
          ${file.id}::uuid,
          ${input.sourceKind},
          ${sourceId}::uuid,
          ${ctx.now}::timestamptz,
          false
        ) AS allowed
      `.execute(ctx.trx);
      if (!attachCheck[0]?.allowed) {
        throw new DomainError(
          'SIGN_FORBIDDEN',
          403,
          'Existing template or non-matching envelope source files cannot be reused on confidential envelopes',
        );
      }
    } else {
      const { rows: confidentialRefs } = await sql<{ restricted: boolean }>`
        SELECT (
          EXISTS (
            SELECT 1 FROM crove_sign.envelope e
            WHERE e.org_id = ${ctx.orgId}::uuid
              AND e.source_file_id = ${file.id}::uuid
              AND e.source_kind IN ('hr_contract', 'meeting_minutes')
          )
          AND NOT EXISTS (
            SELECT 1 FROM crove_sign.template t
            WHERE t.org_id = ${ctx.orgId}::uuid
              AND t.source_file_id = ${file.id}::uuid
          )
        ) AS restricted
      `.execute(ctx.trx);
      if (confidentialRefs[0]?.restricted) {
        throw new DomainError(
          'SIGN_FORBIDDEN',
          403,
          'Confidential HR contract or meeting minutes source files cannot be reused on non-confidential envelopes',
        );
      }
    }

    const row = await ctx.trx
      .insertInto('crove_sign.envelope')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        subject: input.subject ?? null,
        message: input.message ?? null,
        status: 'draft',
        routing_mode: input.routingMode,
        allow_delegation: input.allowDelegation ?? false,
        source_kind: input.sourceKind,
        source_id: sourceId,
        source_file_id: file.id,
        source_storage_key: file.storage_key,
        source_generation: file.generation,
        source_sha256: file.sha256,
        inspect_status: 'pending',
        expires_at: expiresAt,
        auto_remind_before_expiry: input.autoRemindBeforeExpiry ?? true,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'status', 'inspect_status', 'version'])
      .executeTakeFirstOrThrow();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_created',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: file.sha256,
      payloadJson: { routingMode: input.routingMode, sourceKind: input.sourceKind },
      occurredAt: ctx.now,
    });

    await ctx.emit('sign.envelope.inspect_queued', { envelopeId: row.id });
    ctx.audit({
      envelopeId: row.id,
      sourceFileId: file.id,
      routingMode: input.routingMode,
      sourceKind: input.sourceKind,
    });
    return {
      envelopeId: row.id,
      status: row.status,
      inspectStatus: row.inspect_status,
      version: row.version,
    };
  },
});

const zPageDimension = z.strictObject({
  page: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
  widthPt: z.number().finite().positive(),
  heightPt: z.number().finite().positive(),
  rotation: z.number().int(),
});

const zEnvelopeInspectComplete = z.discriminatedUnion('outcome', [
  z.strictObject({
    envelopeId: zId,
    outcome: z.literal('passed'),
    pageCount: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    pageDimensions: z.array(zPageDimension).min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    detectedTags: zSignInspectDetectedTags,
  }),
  z.strictObject({
    envelopeId: zId,
    outcome: z.literal('failed'),
    error: z.string().min(1).max(500),
  }),
]);

export const envelopeInspectComplete = defineCommand({
  name: 'sign.envelope.inspect_complete',
  input: zEnvelopeInspectComplete,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'inspect_status',
      'inspect_error',
      'page_count',
      'page_dimensions_json',
      'detected_tags_json',
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.status !== 'draft' || row.inspect_status !== 'pending') {
      ctx.audit({
        envelopeId: row.id,
        status: row.status,
        inspectStatus: row.inspect_status,
        alreadyHandled: true,
        idempotent: row.inspect_status !== 'pending',
      });
      return { envelopeId: row.id, inspectStatus: row.inspect_status, pageCount: row.page_count };
    }
    if (input.outcome === 'passed') {
      if (input.pageDimensions.length !== input.pageCount) {
        throw new DomainError('SIGN_INVALID_INSPECT', 422, 'pageDimensions length must equal pageCount');
      }
      for (const tag of input.detectedTags) {
        if (tag.pageNumber > input.pageCount) {
          throw new DomainError(
            'SIGN_INVALID_INSPECT',
            422,
            `Detected tag pageNumber ${tag.pageNumber} exceeds pageCount ${input.pageCount}`,
          );
        }
      }
      const nextVersion = row.version + 1;
      await ctx.trx
        .updateTable('crove_sign.envelope')
        .set({
          inspect_status: 'passed',
          inspect_error: null,
          page_count: input.pageCount,
          page_dimensions_json: JSON.stringify(input.pageDimensions),
          detected_tags_json: JSON.stringify(input.detectedTags),
          version: nextVersion,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      await appendSigningEvent(ctx.trx, {
        orgId: ctx.orgId,
        envelopeId: row.id,
        eventType: 'document_inspected',
        actorType: 'system',
        actorLabel: actorLabelOf(ctx),
        documentSha256: row.source_sha256,
        payloadJson: { pageCount: input.pageCount, detectedTagCount: input.detectedTags.length },
        occurredAt: ctx.now,
      });
      ctx.audit({
        envelopeId: row.id,
        inspectStatus: 'passed',
        pageCount: input.pageCount,
        detectedTagCount: input.detectedTags.length,
      });
      return { envelopeId: row.id, inspectStatus: 'passed' as const, pageCount: input.pageCount };
    }
    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        inspect_status: 'failed',
        inspect_error: input.error,
        detected_tags_json: null,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'document_inspect_failed',
      actorType: 'system',
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { error: input.error },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, inspectStatus: 'failed' });
    return { envelopeId: row.id, inspectStatus: 'failed' as const, pageCount: null };
  },
});

const zEnvelopeUpdate = z.strictObject({
  envelopeId: zId,
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  subject: z.string().trim().min(1).max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  routingMode: z.enum(SIGN_ROUTING_MODES).optional(),
  allowDelegation: z.boolean().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  autoRemindBeforeExpiry: z.boolean().optional(),
});

export const envelopeUpdate = defineCommand({
  name: 'sign.envelope.update',
  input: zEnvelopeUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'title',
      'subject',
      'message',
      'routing_mode',
      'allow_delegation',
      'expires_at',
      'auto_remind_before_expiry',
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw new DomainError('SIGN_VERSION_CONFLICT', 409, 'Envelope was modified concurrently', { version: row.version });
    }
    const nextExpiresAt =
      input.expiresAt === undefined ? row.expires_at : input.expiresAt === null ? null : new Date(input.expiresAt);
    if (nextExpiresAt !== null && input.expiresAt !== undefined && nextExpiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }
    const nextTitle = input.title ?? row.title;
    const nextSubject = input.subject === undefined ? row.subject : input.subject;
    const nextMessage = input.message === undefined ? row.message : input.message;
    const nextRoutingMode = input.routingMode ?? row.routing_mode;
    const nextAutoRemind = input.autoRemindBeforeExpiry ?? row.auto_remind_before_expiry;
    const nextAllowDelegation = input.allowDelegation ?? row.allow_delegation;
    const changed: string[] = [];
    if (nextTitle !== row.title) changed.push('title');
    if (nextSubject !== row.subject) changed.push('subject');
    if (nextMessage !== row.message) changed.push('message');
    if (nextRoutingMode !== row.routing_mode) changed.push('routing_mode');
    if (nextAllowDelegation !== row.allow_delegation) changed.push('allow_delegation');
    if (input.expiresAt !== undefined) {
      const oldIso = row.expires_at ? new Date(row.expires_at).toISOString() : null;
      const newIso = nextExpiresAt ? nextExpiresAt.toISOString() : null;
      if (oldIso !== newIso) changed.push('expires_at');
    }
    if (nextAutoRemind !== row.auto_remind_before_expiry) changed.push('auto_remind_before_expiry');
    if (changed.length === 0) {
      ctx.audit({ envelopeId: row.id, changed: [], version: row.version });
      return { envelopeId: row.id, version: row.version };
    }
    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        title: nextTitle,
        subject: nextSubject,
        message: nextMessage,
        routing_mode: nextRoutingMode,
        allow_delegation: nextAllowDelegation,
        expires_at: nextExpiresAt,
        auto_remind_before_expiry: nextAutoRemind,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_updated',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { changed, version: nextVersion },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, changed, version: nextVersion });
    return { envelopeId: row.id, version: nextVersion };
  },
});

const zSignerAdd = z.strictObject({
  envelopeId: zId,
  routingOrder: z.number().int().min(1).max(100).optional(),
  signerRole: z.enum(SIGN_SIGNER_ROLES).default('signer'),
  roleLabel: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().min(6).max(32).nullable().optional(),
  deliveryMode: z.enum(SIGN_DELIVERY_MODES).default('link'),
  requireEmailOtp: z.boolean().default(false),
});

export const signerAdd = defineCommand({
  name: 'sign.signer.add',
  input: zSignerAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signer', [
      'org_id',
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
      'created_at',
      'updated_at',
    ]),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);
    const normalizedEmail = input.email ? input.email.trim().toLowerCase() : null;
    if ((input.deliveryMode === 'email' || input.requireEmailOtp) && !normalizedEmail) {
      throw new DomainError('SIGN_EMAIL_REQUIRED', 422, 'Email address is required for email delivery or email OTP');
    }
    if (input.signerRole === 'cc' && input.requireEmailOtp) {
      throw new DomainError('SIGN_INVALID_SIGNER', 422, 'CC recipients cannot require email OTP');
    }
    const existing = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'routing_order'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .execute();
    if (existing.length >= EXTRACT_LIMITS.maxPdfSealSigners) {
      throw new DomainError(
        'SIGN_SIGNER_LIMIT',
        409,
        `An envelope can have at most ${EXTRACT_LIMITS.maxPdfSealSigners} signers`,
      );
    }
    const routingOrder = input.routingOrder ?? nextDefaultRoutingOrder(existing);
    const defaultRoleLabel =
      input.signerRole === 'approver' ? 'Approver' : input.signerRole === 'cc' ? 'CC' : 'Signer';
    const roleLabel = input.roleLabel ?? defaultRoleLabel;

    const signer = await ctx.trx
      .insertInto('crove_sign.signer')
      .values({
        org_id: ctx.orgId,
        envelope_id: row.id,
        routing_order: routingOrder,
        signer_role: input.signerRole,
        role_label: roleLabel,
        name: input.name,
        email: normalizedEmail,
        phone: input.phone ?? null,
        delivery_mode: input.deliveryMode,
        require_email_otp: input.requireEmailOtp,
        status: 'waiting',
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'routing_order', 'signer_role', 'status'])
      .executeTakeFirstOrThrow();

    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({ version: row.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      signerId: signer.id,
      eventType: 'signer_added',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: {
        routingOrder: signer.routing_order,
        signerRole: signer.signer_role,
        deliveryMode: input.deliveryMode,
        requireEmailOtp: input.requireEmailOtp,
      },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, signerId: signer.id, signerRole: signer.signer_role, routingOrder });
    return {
      envelopeId: row.id,
      signerId: signer.id,
      routingOrder: signer.routing_order,
      status: signer.status,
      version: row.version + 1,
    };
  },
});

export const signerRemove = defineCommand({
  name: 'sign.signer.remove',
  input: z.strictObject({ envelopeId: zId, signerId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'field', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['id']),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);
    const existing = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', '=', input.signerId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');

    await ctx.trx
      .deleteFrom('crove_sign.field')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('signer_id', '=', input.signerId)
      .execute();

    await ctx.trx
      .deleteFrom('crove_sign.signer')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', '=', input.signerId)
      .execute();

    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({ version: row.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      signerId: null,
      eventType: 'signer_removed',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { removedSignerId: input.signerId },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, signerId: input.signerId });
    return { envelopeId: row.id, removedSignerId: input.signerId, version: row.version + 1 };
  },
});

const zSignerReorder = z.strictObject({
  envelopeId: zId,
  orders: z
    .array(z.strictObject({ signerId: zId, routingOrder: z.number().int().min(1).max(100) }))
    .min(1)
    .max(EXTRACT_LIMITS.maxPdfSealSigners),
});

export const signerReorder = defineCommand({
  name: 'sign.signer.reorder',
  input: zSignerReorder,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['routing_order', 'updated_at']),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);

    const seenIds = new Set<string>();
    for (const item of input.orders) {
      if (seenIds.has(item.signerId)) {
        throw new DomainError('SIGN_DUPLICATE_SIGNER', 422, 'Duplicate signerId in reorder list');
      }
      seenIds.add(item.signerId);
    }
    const existing = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forUpdate()
      .execute();
    const validIds = new Set(existing.map((s) => s.id));
    for (const item of input.orders) {
      if (!validIds.has(item.signerId)) {
        throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, `Signer ${item.signerId} not found on envelope`);
      }
    }
    for (const item of input.orders) {
      await ctx.trx
        .updateTable('crove_sign.signer')
        .set({ routing_order: item.routingOrder, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', row.id)
        .where('id', '=', item.signerId)
        .execute();
    }
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({ version: row.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'signers_reordered',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { count: input.orders.length },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, updatedCount: input.orders.length });
    return { envelopeId: row.id, version: row.version + 1 };
  },
});

const zFieldItem = z
  .strictObject({
    signerId: zId,
    fieldType: z.enum(SIGN_FIELD_TYPES),
    pageNumber: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    xNorm: zNormMin0,
    yNorm: zNormMin0,
    wNorm: zNormSpan,
    hNorm: zNormSpan,
    label: z.string().trim().min(1).max(120).nullable().optional(),
    required: z.boolean().default(true),
    proposedByAi: z.boolean().default(false),
    fontSizePt: z.number().int().min(6).max(36).nullable().optional(),
    options: zSignFieldOptions.nullable().optional(),
  })
  .superRefine((item, issueCtx) => {
    const isChoice = item.fieldType === 'dropdown' || item.fieldType === 'radio';
    if (isChoice) {
      if (!item.options || item.options.length === 0) {
        issueCtx.addIssue({ code: 'custom', path: ['options'], message: 'dropdown and radio fields require at least one option' });
      }
    } else if (item.options !== undefined && item.options !== null) {
      issueCtx.addIssue({ code: 'custom', path: ['options'], message: 'options are only valid on dropdown and radio fields' });
    }
    const x = toMicroNorm(item.xNorm);
    const y = toMicroNorm(item.yNorm);
    const w = toMicroNorm(item.wNorm);
    const h = toMicroNorm(item.hNorm);
    if (x < 0 || x >= NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['xNorm'], message: 'xNorm rounds outside [0, 1)' });
    }
    if (y < 0 || y >= NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['yNorm'], message: 'yNorm rounds outside [0, 1)' });
    }
    if (w < 1 || w > NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['wNorm'], message: 'wNorm rounds outside (0, 1]' });
    }
    if (h < 1 || h > NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['hNorm'], message: 'hNorm rounds outside (0, 1]' });
    }
    if (x + w > NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['wNorm'], message: 'xNorm + wNorm must be <= 1' });
    }
    if (y + h > NORM_SCALE) {
      issueCtx.addIssue({ code: 'custom', path: ['hNorm'], message: 'yNorm + hNorm must be <= 1' });
    }
  });

const zFieldSet = z.strictObject({
  envelopeId: zId,
  fields: z.array(zFieldItem).max(EXTRACT_LIMITS.maxPdfSealFields),
});

export const fieldSet = defineCommand({
  name: 'sign.field.set',
  input: zFieldSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'field', [
      'org_id',
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
      'options_json',
      'created_at',
      'updated_at',
    ]),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);
    if (row.inspect_status === 'failed') {
      throw new DomainError('SIGN_INSPECT_FAILED', 409, 'Cannot place fields on a document whose PDF inspection failed');
    }

    const signers = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'signer_role'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forShare()
      .execute();
    const signerRoleById = new Map(signers.map((s) => [s.id, s.signer_role]));

    for (const f of input.fields) {
      const role = signerRoleById.get(f.signerId);
      if (!role) {
        throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, `Signer ${f.signerId} not found on envelope`);
      }
      if (role === 'cc') {
        throw new DomainError('SIGN_INVALID_FIELD', 422, 'Fields cannot be assigned to CC recipients');
      }
      if (row.page_count !== null && f.pageNumber > row.page_count) {
        throw new DomainError(
          'SIGN_FIELD_OUT_OF_BOUNDS',
          422,
          `Field pageNumber ${f.pageNumber} exceeds document page count ${row.page_count}`,
        );
      }
    }

    await ctx.trx
      .deleteFrom('crove_sign.field')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .execute();

    const fieldIds: string[] = [];
    if (input.fields.length > 0) {
      const inserted = await ctx.trx
        .insertInto('crove_sign.field')
        .values(
          input.fields.map((f) => ({
            org_id: ctx.orgId,
            envelope_id: row.id,
            signer_id: f.signerId,
            field_type: f.fieldType,
            page_number: f.pageNumber,
            x_norm: formatMicroNorm(toMicroNorm(f.xNorm)),
            y_norm: formatMicroNorm(toMicroNorm(f.yNorm)),
            w_norm: formatMicroNorm(toMicroNorm(f.wNorm)),
            h_norm: formatMicroNorm(toMicroNorm(f.hNorm)),
            label: f.label ?? null,
            required: f.required,
            proposed_by_ai: f.proposedByAi,
            font_size_pt: f.fontSizePt ?? null,
            options_json: serializeFieldOptionsForType(f.fieldType, f.options),
            created_at: ctx.now,
            updated_at: ctx.now,
          })),
        )
        .returning('id')
        .execute();
      for (const item of inserted) fieldIds.push(item.id);
    }

    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({ version: row.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'fields_set',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { count: fieldIds.length },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, count: fieldIds.length });
    return { envelopeId: row.id, fieldIds, version: row.version + 1 };
  },
});

export const envelopeSend = defineCommand({
  name: 'sign.envelope.send',
  input: z.strictObject({ envelopeId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  // Returns raw one-time signing tokens; disallow idempotency replay storage so plaintext tokens are never persisted.
  noIdempotency: true,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['status', 'sent_at', 'version', 'updated_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['status', 'updated_at']),
    SIGNING_TOKEN_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
    MAIL_MESSAGE_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);

    const signers = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'routing_order', 'signer_role', 'role_label', 'email', 'delivery_mode', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forUpdate()
      .execute();

    const fields = await ctx.trx
      .selectFrom('crove_sign.field')
      .select(['id', 'signer_id', 'field_type', 'page_number'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forShare()
      .execute();

    return sendDraftEnvelope(ctx, { envelope: row, signers, fields, userId });
  },
});

export const signerCreateLink = defineCommand({
  name: 'sign.signer.create_link',
  input: z.strictObject({
    envelopeId: zId,
    signerId: zId,
    expiresInHours: z.number().int().min(1).max(720).default(DEFAULT_LINK_TTL_HOURS),
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: WRITERS,
  // Returns raw one-time signing tokens; disallow idempotency replay storage so plaintext tokens are never persisted.
  noIdempotency: true,
  target,
  writes: [SIGNING_TOKEN_WRITE, SIGNING_OTP_INVALIDATE_WRITE, SIGNING_EVENT_WRITE],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.status !== 'sent' && row.status !== 'in_progress') {
      throw new DomainError('SIGN_ENVELOPE_NOT_ACTIVE', 409, 'Links can only be minted while envelope is sent or in progress');
    }
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope has expired');
    }

    const signer = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'signer_role', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', '=', input.signerId)
      .forUpdate()
      .executeTakeFirst();
    if (!signer) throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
    if (signer.signer_role === 'cc') {
      throw new DomainError('SIGN_INVALID_SIGNER', 422, 'Signing links cannot be minted for CC recipients');
    }
    if (signer.status !== 'pending' && signer.status !== 'viewed') {
      throw new DomainError('SIGN_SIGNER_NOT_DUE', 409, 'Signer is not currently awaiting signature');
    }

    const baseNowMs = ctx.now.getTime();
    const requestedExpiry = new Date(baseNowMs + input.expiresInHours * 3_600_000);
    const expiresAt =
      row.expires_at && new Date(row.expires_at).getTime() < requestedExpiry.getTime()
        ? new Date(row.expires_at)
        : requestedExpiry;

    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const { rows: minted } = await sql<{ id: string }>`
      SELECT crove_sign.mint_signing_token(
        ${row.id}::uuid,
        ${signer.id}::uuid,
        ${tokenHash},
        ${expiresAt}::timestamptz
      ) AS id
    `.execute(ctx.trx);
    const tokenId = minted[0]?.id;
    if (!tokenId) throw new Error('mint_signing_token returned no id');

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      signerId: signer.id,
      eventType: 'link_created',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { tokenId, expiresAt: expiresAt.toISOString() },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, signerId: signer.id, tokenId });
    return {
      envelopeId: row.id,
      signerId: signer.id,
      tokenId,
      token: rawToken,
      expiresAt: expiresAt.toISOString(),
    };
  },
});

function toCorrectionErrorStatus(status: number | undefined): ErrorStatus {
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422 || status === 429) {
    return status;
  }
  return 422;
}

type CorrectRecipientSqlRow =
  | { status: 'not_found'; target: 'envelope' | 'signer' }
  | { status: 'error'; code: string; httpStatus?: number; message?: string }
  | {
      status: 'ok';
      envelopeId: string;
      envelopeTitle: string;
      envelopeExpiresAt: string | null;
      sourceSha256: string;
      version: number;
      signerId: string;
      signerRole: 'signer' | 'approver' | 'cc';
      roleLabel: string;
      signerStatus: SignSignerStatus;
      name: string;
      email: string | null;
      phone: string | null;
      deliveryMode: SignDeliveryMode;
      requireEmailOtp: boolean;
      previousName: string;
      previousEmail: string | null;
      previousPhone: string | null;
      previousDeliveryMode: SignDeliveryMode;
      previousRequireEmailOtp: boolean;
      revokedTokens: number;
      invalidatedOtps: number;
    };

export const signerCorrectRecipient = defineCommand({
  name: 'sign.signer.correct_recipient',
  input: zSignSignerCorrectRecipientInput,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  // May mint and return a fresh one-time signing link when deliveryMode = 'link'; never store plaintext tokens.
  noIdempotency: true,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signer', [
      'name',
      'email',
      'phone',
      'delivery_mode',
      'require_email_otp',
      'status',
      'viewed_at',
      'otp_verified_at',
      'token_last_reminded_at',
      'updated_at',
    ]),
    ENVELOPE_VERSION_WRITE,
    SIGNING_TOKEN_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
    MAIL_MESSAGE_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    await lockEnvelope(ctx, input.envelopeId);
    const normalizedEmail = input.email ? input.email.trim().toLowerCase() : null;
    const normalizedPhone = input.phone ? input.phone.trim() : null;
    const { rows: sqlRows } = await sql<{ res: CorrectRecipientSqlRow }>`
      SELECT crove_sign.correct_signer_recipient(
        ${input.envelopeId}::uuid,
        ${input.signerId}::uuid,
        ${input.name},
        ${normalizedEmail},
        ${normalizedPhone},
        ${input.deliveryMode},
        ${input.requireEmailOtp ?? null}::boolean,
        ${ctx.now}::timestamptz
      ) AS res
    `.execute(ctx.trx);
    const res = sqlRows[0]?.res;
    if (!res || res.status === 'not_found') {
      if (res?.status === 'not_found' && res.target === 'signer') {
        throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
      }
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    if (res.status === 'error') {
      const status = toCorrectionErrorStatus(res.httpStatus);
      const message = res.message ?? 'Unable to correct recipient';
      if (res.code === 'SIGN_SIGNER_ALREADY_COMPLETED') {
        throw new DomainError('SIGN_SIGNER_ALREADY_COMPLETED', status, message);
      }
      throw new DomainError(res.code, status, message);
    }

    const revokedTokens = Number(res.revokedTokens ?? 0);
    const invalidatedOtps = Number(res.invalidatedOtps ?? 0);
    let mailStatus: 'sending' | 'queued' | 'suppressed' | null = null;
    let issuedLink: IssuedSigningLink | null = null;

    if (res.signerRole !== 'cc' && res.signerStatus === 'pending') {
      if (res.deliveryMode === 'email' && res.email) {
        const tenant = await ctx.trx
          .selectFrom('crove_kernel.tenant')
          .select('name')
          .where('org_id', '=', ctx.orgId)
          .executeTakeFirstOrThrow();
        const mail = await queueSignInviteEmail(ctx, {
          source: SIGN_CORRECT_INVITE_MAIL_SOURCE,
          templateKey: SIGN_INVITE_MAIL_TEMPLATE,
          orgName: tenant.name,
          envelopeId: res.envelopeId,
          signerId: res.signerId,
          signerRole: res.signerRole === 'approver' ? 'approver' : 'signer',
          to: res.email,
          docTitle: res.envelopeTitle,
          roleLabel: res.roleLabel,
          expiresAt: res.envelopeExpiresAt,
        });
        mailStatus = mail.status;
      } else {
        const defaultExpiry = new Date(ctx.now.getTime() + DEFAULT_LINK_TTL_HOURS * 3_600_000);
        const tokenExpiresAt = res.envelopeExpiresAt ? new Date(res.envelopeExpiresAt) : defaultExpiry;
        const rawToken = generateRawSigningToken();
        const tokenHash = hashSigningToken(rawToken);
        const { rows: minted } = await sql<{ id: string }>`
          SELECT crove_sign.mint_signing_token(
            ${res.envelopeId}::uuid,
            ${res.signerId}::uuid,
            ${tokenHash},
            ${tokenExpiresAt}::timestamptz
          ) AS id
        `.execute(ctx.trx);
        const tokenId = minted[0]?.id;
        if (!tokenId) throw new Error('mint_signing_token returned no id');
        issuedLink = {
          signerId: res.signerId,
          tokenId,
          token: rawToken,
          expiresAt: tokenExpiresAt.toISOString(),
        };
      }
    }

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: res.envelopeId,
      signerId: res.signerId,
      eventType: 'signer_corrected',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: res.sourceSha256,
      payloadJson: {
        previousName: res.previousName,
        previousMaskedEmail: maskEmail(res.previousEmail),
        previousDeliveryMode: res.previousDeliveryMode,
        name: res.name,
        maskedEmail: maskEmail(res.email),
        deliveryMode: res.deliveryMode,
        requireEmailOtp: res.requireEmailOtp,
        revokedTokens,
        mintedLink: issuedLink !== null,
        mailQueued: mailStatus !== null,
      },
      occurredAt: ctx.now,
    });

    ctx.audit({
      envelopeId: input.envelopeId,
      signerId: input.signerId,
      deliveryMode: input.deliveryMode,
      revokedTokens,
      invalidatedOtps,
      mintedLink: issuedLink !== null,
      mailQueued: mailStatus !== null,
    });

    return {
      envelopeId: res.envelopeId,
      signerId: res.signerId,
      status: res.signerStatus,
      deliveryMode: res.deliveryMode,
      version: Number(res.version),
      revokedTokens,
      mailStatus,
      link: issuedLink,
    };
  },
});

export const envelopeRemind = defineCommand({
  name: 'sign.envelope.remind',
  input: z.strictObject({
    envelopeId: zId,
    signerId: zId.optional(),
  }),
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target,
  writes: [tableWrite(signManifest.tables, 'crove_sign', 'signer', ['token_last_reminded_at', 'updated_at']), SIGNING_EVENT_WRITE, MAIL_MESSAGE_WRITE],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.status !== 'sent' && row.status !== 'in_progress') {
      throw new DomainError('SIGN_ENVELOPE_NOT_ACTIVE', 409, 'Reminders apply only to active envelopes');
    }
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope has expired');
    }

    let query = ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'status', 'signer_role', 'role_label', 'email', 'delivery_mode', 'token_last_reminded_at'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forUpdate();
    if (input.signerId !== undefined) query = query.where('id', '=', input.signerId);
    const candidates = await query.execute();

    if (input.signerId !== undefined && candidates.length === 0) {
      throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
    }
    const due = candidates.filter((s) => s.signer_role !== 'cc' && (s.status === 'pending' || s.status === 'viewed'));
    if (due.length === 0) {
      throw new DomainError('SIGN_NO_PENDING_SIGNERS', 409, 'No pending or viewed signers are eligible for a reminder');
    }

    const nowMs = ctx.now.getTime();
    const eligible = due.filter((s) => {
      if (s.token_last_reminded_at === null) return true;
      return nowMs - new Date(s.token_last_reminded_at).getTime() >= REMIND_COOLDOWN_MS;
    });
    if (eligible.length === 0) {
      throw new DomainError('SIGN_REMIND_RATE_LIMITED', 429, 'Signers were reminded recently; wait 5 minutes between reminders');
    }

    const remindedSignerIds = eligible.map((s) => s.id);
    await ctx.trx
      .updateTable('crove_sign.signer')
      .set({ token_last_reminded_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', 'in', remindedSignerIds)
      .execute();

    let remindOrgName: string | null = null;
    for (const s of eligible) {
      if (s.delivery_mode === 'email' && s.email) {
        if (remindOrgName === null) {
          const tenant = await ctx.trx
            .selectFrom('crove_kernel.tenant')
            .select('name')
            .where('org_id', '=', ctx.orgId)
            .executeTakeFirstOrThrow();
          remindOrgName = tenant.name;
        }
        await queueSignInviteEmail(ctx, {
          source: SIGN_REMIND_MAIL_SOURCE,
          templateKey: SIGN_REMIND_MAIL_TEMPLATE,
          orgName: remindOrgName,
          envelopeId: row.id,
          signerId: s.id,
          signerRole: s.signer_role === 'approver' ? 'approver' : 'signer',
          to: s.email,
          docTitle: row.title,
          roleLabel: s.role_label,
          expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        });
      }
    }

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      signerId: input.signerId ?? null,
      eventType: 'signer_reminded',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { signerIds: remindedSignerIds },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, remindedCount: remindedSignerIds.length, signerIds: remindedSignerIds });
    return { envelopeId: row.id, remindedSignerIds };
  },
});

const TERMINAL_STATUSES = new Set(['completed', 'declined', 'voided', 'expired']);

export const envelopeVoid = defineCommand({
  name: 'sign.envelope.void',
  input: z.strictObject({
    envelopeId: zId,
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'status',
      'voided_at',
      'voided_by',
      'void_reason',
      'version',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['status', 'updated_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_token', ['revoked_at', 'revoked_by']),
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.created_by !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') {
      throw new DomainError('SIGN_FORBIDDEN', 403, 'Only the envelope creator, owner, or admin can void this envelope');
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      throw new DomainError('SIGN_ENVELOPE_TERMINAL', 409, `Envelope in status ${row.status} cannot be voided`);
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        status: 'voided',
        voided_at: ctx.now,
        voided_by: userId,
        void_reason: input.reason ?? null,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await ctx.trx
      .updateTable('crove_sign.signer')
      .set({ status: 'voided', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('status', 'in', ['waiting', 'pending', 'viewed'])
      .execute();

    const { rows: revokedRows } = await sql<{ count: number }>`
      SELECT crove_sign.revoke_envelope_tokens(${row.id}::uuid) AS count
    `.execute(ctx.trx);
    const revokedTokens = Number(revokedRows[0]?.count ?? 0);

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_voided',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { reasonProvided: Boolean(input.reason), revokedTokens },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, status: 'voided', revokedTokens });
    return { envelopeId: row.id, status: 'voided' as const, revokedTokens, version: nextVersion };
  },
});

export const envelopeAcknowledgeDecline = defineCommand({
  name: 'sign.envelope.acknowledge_decline',
  input: z.strictObject({
    envelopeId: zId,
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'decline_acknowledged_at',
      'decline_acknowledged_by',
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.status !== 'declined') {
      throw new DomainError('SIGN_ENVELOPE_NOT_DECLINED', 409, 'Only declined envelopes can be acknowledged');
    }
    if (row.decline_acknowledged_at !== null) {
      const existingIso = new Date(row.decline_acknowledged_at).toISOString();
      ctx.audit({ envelopeId: row.id, alreadyAcknowledged: true, version: row.version });
      return {
        envelopeId: row.id,
        declineAcknowledgedAt: existingIso,
        version: row.version,
      };
    }
    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        decline_acknowledged_at: ctx.now,
        decline_acknowledged_by: userId,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_decline_acknowledged',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { version: nextVersion },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, version: nextVersion });
    return {
      envelopeId: row.id,
      declineAcknowledgedAt: ctx.now.toISOString(),
      version: nextVersion,
    };
  },
});

const zEnvelopeSealComplete = z.discriminatedUnion('outcome', [
  z.strictObject({
    envelopeId: zId,
    outcome: z.literal('sealed'),
    certificateCode: z.string().min(1).max(64),
    sealedFileId: zId,
    certificateFileId: zId,
  }),
  z.strictObject({
    envelopeId: zId,
    outcome: z.literal('failed'),
    error: z.string().min(1).max(500),
  }),
]);

export const envelopeSealComplete = defineCommand({
  name: 'sign.envelope.seal_complete',
  input: zEnvelopeSealComplete,
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'sealed_file_id',
      'sealed_storage_key',
      'sealed_generation',
      'sealed_sha256',
      'certificate_file_id',
      'certificate_storage_key',
      'certificate_generation',
      'certificate_sha256',
      'certificate_code',
      'seal_status',
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
    MAIL_MESSAGE_WRITE,
  ],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.status !== 'completed') {
      throw new DomainError('SIGN_ENVELOPE_NOT_COMPLETED', 409, 'Only completed envelopes can be sealed');
    }
    if (row.seal_status === 'sealed') {
      ctx.audit({
        envelopeId: row.id,
        sealStatus: 'sealed',
        idempotent: true,
        ...(input.outcome === 'failed' ? { ignoredOutcome: input.outcome } : {}),
      });
      return {
        envelopeId: row.id,
        sealStatus: 'sealed' as const,
        sealedFileId: row.sealed_file_id,
        certificateFileId: row.certificate_file_id,
        certificateCode: row.certificate_code,
        idempotent: true,
        ...(input.outcome === 'failed' ? { ignoredOutcome: input.outcome } : {}),
      };
    }

    if (input.outcome === 'failed') {
      const nextVersion = row.version + 1;
      await ctx.trx
        .updateTable('crove_sign.envelope')
        .set({ seal_status: 'failed', version: nextVersion, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      await appendSigningEvent(ctx.trx, {
        orgId: ctx.orgId,
        envelopeId: row.id,
        eventType: 'envelope_seal_failed',
        actorType: 'system',
        actorLabel: actorLabelOf(ctx),
        documentSha256: row.source_sha256,
        payloadJson: { error: input.error },
        occurredAt: ctx.now,
      });
      ctx.audit({ envelopeId: row.id, sealStatus: 'failed' });
      return {
        envelopeId: row.id,
        sealStatus: 'failed' as const,
        sealedFileId: null,
        certificateFileId: null,
        certificateCode: null,
      };
    }

    const [sealedFile, certFile] = await Promise.all([
      ctx.trx
        .selectFrom('crove_kernel.file')
        .select(['id', 'source', 'storage_key', 'generation', 'sha256'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.sealedFileId)
        .executeTakeFirst(),
      ctx.trx
        .selectFrom('crove_kernel.file')
        .select(['id', 'source', 'storage_key', 'generation', 'sha256'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.certificateFileId)
        .executeTakeFirst(),
    ]);
    if (!sealedFile || sealedFile.source !== 'sign_sealed') {
      throw new DomainError('SIGN_INVALID_SEALED_FILE', 422, 'Sealed PDF file reference is invalid');
    }
    if (!certFile || certFile.source !== 'sign_certificate') {
      throw new DomainError('SIGN_INVALID_CERTIFICATE_FILE', 422, 'Certificate file reference is invalid');
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        sealed_file_id: sealedFile.id,
        sealed_storage_key: sealedFile.storage_key,
        sealed_generation: sealedFile.generation,
        sealed_sha256: sealedFile.sha256,
        certificate_file_id: certFile.id,
        certificate_storage_key: certFile.storage_key,
        certificate_generation: certFile.generation,
        certificate_sha256: certFile.sha256,
        certificate_code: input.certificateCode,
        seal_status: 'sealed',
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_sealed',
      actorType: 'system',
      actorLabel: actorLabelOf(ctx),
      documentSha256: sealedFile.sha256,
      payloadJson: {
        certificateCode: input.certificateCode,
        sealedSha256: sealedFile.sha256,
        certificateSha256: certFile.sha256,
      },
      occurredAt: ctx.now,
    });

    const recipientRows = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['signer_role', 'email', 'delivery_mode'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .execute();
    let isDirectLinkEnvelope = row.direct_link_id != null;
    if (!isDirectLinkEnvelope) {
      // Defense in depth: if a revoked template_direct_link row was pruned after retention
      // (ON DELETE SET NULL on direct_link_id), the immutable genesis event still identifies it.
      const originEvent = await ctx.trx
        .selectFrom('crove_sign.signing_event')
        .select(['actor_label'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', row.id)
        .where('seq', '=', 1)
        .executeTakeFirst();
      if (originEvent?.actor_label === 'system:sign-direct-link') {
        isDirectLinkEnvelope = true;
      }
    }
    const eligibleRecipients = isDirectLinkEnvelope
      ? recipientRows.filter((r) => r.delivery_mode === 'email')
      : recipientRows;
    const { rows: senderProfiles } = await sql<{ email: string | null }>`
      SELECT email FROM crove_kernel.member_emails(${[row.created_by]}::uuid[])`.execute(ctx.trx);
    const signerCount = Math.max(1, recipientRows.filter((r) => r.signer_role !== 'cc').length);
    const seenEmails = new Set<string>();
    const emailRecipients = [
      ...senderProfiles.map((p) => p.email),
      ...eligibleRecipients.map((r) => r.email),
    ]
      .map((rawEmail) => rawEmail?.trim().toLowerCase() ?? '')
      .filter((addr) => {
        if (!addr || seenEmails.has(addr)) return false;
        seenEmails.add(addr);
        return true;
      });
    if (emailRecipients.length > 0) {
      const tenant = await ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select('name')
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      const completedAtIso = row.completed_at ? new Date(row.completed_at).toISOString() : ctx.now.toISOString();
      for (const addr of emailRecipients) {
        await queueSignCompletedEmail(ctx, {
          orgName: tenant.name,
          envelopeId: row.id,
          to: addr,
          docTitle: row.title,
          certificateCode: input.certificateCode,
          sealedSha256: sealedFile.sha256,
          completedAtIso,
          signerCount,
        });
      }
    }
    await ctx.emit('sign.envelope.completed', {
      envelopeId: row.id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sealedFileId: sealedFile.id,
      sealedSha256: sealedFile.sha256,
      certificateCode: input.certificateCode,
    });
    ctx.audit({
      envelopeId: row.id,
      sealStatus: 'sealed',
      sealedFileId: sealedFile.id,
      certificateFileId: certFile.id,
    });
    return {
      envelopeId: row.id,
      sealStatus: 'sealed' as const,
      sealedFileId: sealedFile.id,
      certificateFileId: certFile.id,
      certificateCode: input.certificateCode,
    };
  },
});

export const envelopeExpireSweep = defineCommand({
  name: 'sign.envelope.expire_sweep',
  runsWhenOff: 'expires overdue signing envelopes and revokes active tokens while the app is off',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['status', 'expired_at', 'version', 'updated_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['status', 'updated_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_token', ['revoked_at', 'revoked_by']),
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx) => {
    assertSystem(ctx);
    const due = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select(['id', 'source_sha256', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('status', 'in', ['sent', 'in_progress'])
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', ctx.now)
      .orderBy('expires_at', 'asc')
      .orderBy('id', 'asc')
      .limit(EXPIRE_SWEEP_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const env of due) {
      await ctx.trx
        .updateTable('crove_sign.envelope')
        .set({
          status: 'expired',
          expired_at: ctx.now,
          version: env.version + 1,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', env.id)
        .execute();

      await ctx.trx
        .updateTable('crove_sign.signer')
        .set({ status: 'expired', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .where('status', 'in', ['waiting', 'pending', 'viewed'])
        .execute();

      await sql`SELECT crove_sign.revoke_envelope_tokens(${env.id}::uuid)`.execute(ctx.trx);

      await appendSigningEvent(ctx.trx, {
        orgId: ctx.orgId,
        envelopeId: env.id,
        eventType: 'envelope_expired',
        actorType: 'system',
        actorLabel: actorLabelOf(ctx),
        documentSha256: env.source_sha256,
        payloadJson: {},
        occurredAt: ctx.now,
      });
    }

    ctx.audit({ expiredCount: due.length });
    return { expiredCount: due.length, expiredIds: due.map((e) => e.id) };
  },
});

export const orgCleanup = defineCommand({
  name: 'sign.org.cleanup',
  runsWhenOff: 'prunes expired sign tokens and OTPs under retention while the app is off',
  input: z.strictObject({
    tokenRetentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
    otpRetentionHours: z.number().int().min(1).max(8760).default(DEFAULT_OTP_RETENTION_HOURS),
  }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_token', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'template_direct_link', ['id']),
    // Pruning a revoked template_direct_link clears envelope.direct_link_id via ON DELETE SET NULL.
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['direct_link_id']),
  ],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    const otpCutoff = new Date(ctx.now.getTime() - input.otpRetentionHours * 3_600_000);
    const tokenCutoff = new Date(ctx.now.getTime() - input.tokenRetentionDays * 86_400_000);
    const { rows } = await sql<{
      counts: { otps: number; tokens: number; directLinks?: number; drafts: number; draftEvents: number };
    }>`
      SELECT crove_sign.cleanup_org_secrets(${otpCutoff}::timestamptz, ${tokenCutoff}::timestamptz) AS counts
    `.execute(ctx.trx);
    const counts = rows[0]?.counts ?? { otps: 0, tokens: 0, drafts: 0, draftEvents: 0 };
    ctx.audit({
      otps: counts.otps,
      tokens: counts.tokens,
      directLinks: counts.directLinks ?? 0,
      drafts: counts.drafts,
      draftEvents: counts.draftEvents,
      otpCutoff: otpCutoff.toISOString(),
      tokenCutoff: tokenCutoff.toISOString(),
    });
    return counts;
  },
});

export const envelopeSharedSummarySet = defineCommand({
  name: 'sign.envelope.shared_summary_set',
  input: z.strictObject({
    envelopeId: zId,
    shareSummaryWithSigners: z.boolean(),
    sharedSummary: zSignSharedSummary.nullable(),
    expectedVersion: z.number().int().positive().optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'share_summary_with_signers',
      'shared_summary_json',
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (ctx.role !== 'owner' && ctx.role !== 'admin' && row.created_by !== userId) {
      throw new DomainError(
        'SIGN_FORBIDDEN',
        403,
        'Only the envelope creator, organization owner, or admin can update the counterparty summary',
      );
    }
    if (row.status !== 'draft' && row.status !== 'sent' && row.status !== 'in_progress') {
      throw new DomainError('SIGN_ENVELOPE_TERMINAL', 409, 'Counterparty summary cannot be modified on a closed envelope');
    }
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw new DomainError('SIGN_VERSION_CONFLICT', 409, 'Envelope version conflict');
    }

    const cleanSummary = sanitizeSharedSummaryForWrite(input.sharedSummary, row.page_count);
    if (input.shareSummaryWithSigners && cleanSummary === null) {
      throw new DomainError('VALIDATION', 422, 'sharedSummary is required when shareSummaryWithSigners is true');
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        share_summary_with_signers: input.shareSummaryWithSigners,
        shared_summary_json: cleanSummary ? JSON.stringify(cleanSummary) : null,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_shared_summary_updated',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: {
        shareSummaryWithSigners: input.shareSummaryWithSigners,
        keyTermCount: cleanSummary?.keyTerms.length ?? 0,
      },
      occurredAt: ctx.now,
    });

    ctx.audit({
      envelopeId: row.id,
      shareSummaryWithSigners: input.shareSummaryWithSigners,
      keyTermCount: cleanSummary?.keyTerms.length ?? 0,
      version: nextVersion,
    });

    return {
      envelopeId: row.id,
      shareSummaryWithSigners: input.shareSummaryWithSigners,
      sharedSummary: cleanSummary,
      version: nextVersion,
    };
  },
});

export const signCommands = [
  envelopeCreate,
  envelopeInspectComplete,
  envelopeUpdate,
  envelopeSharedSummarySet,
  signerAdd,
  signerRemove,
  signerReorder,
  fieldSet,
  envelopeSend,
  signerCreateLink,
  signerCorrectRecipient,
  envelopeRemind,
  envelopeVoid,
  envelopeAcknowledgeDecline,
  envelopeSealComplete,
  envelopeExpireSweep,
  envelopePreExpiryRemindSweep,
  orgCleanup,
  ...signPublicCommands,
  ...signDirectPublicCommands,
  ...signTemplateCommands,
  ...signCaCommands,
  ...signInPersonCommands,
];
