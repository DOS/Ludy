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
} from '@crove/db';
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import { tableWrite, zId } from '@crove/kernel-contract';
import { DomainError, GENERATION_PATTERN, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { signManifest } from './manifest.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const REMIND_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_LINK_TTL_HOURS = 30 * 24;
const DEFAULT_RETENTION_DAYS = 90;
const EXPIRE_SWEEP_BATCH = 100;
const NORM_SCALE = 1_000_000;
const MAX_ROUTING_ORDER = 100;

const zSha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '64-character lowercase sha256 hex');
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

const ENVELOPE_VERSION_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['version', 'updated_at']);

const SIGNING_EVENT_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_event', [
  'org_id',
  'envelope_id',
  'signer_id',
  'seq',
  'event_type',
  'actor_type',
  'actor_id',
  'actor_label',
  'document_sha256',
  'prev_event_hash',
  'event_hash',
  'payload_json',
  'ip_hash',
  'user_agent',
  'occurred_at',
]);

const SIGNING_TOKEN_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_token', [
  'org_id',
  'envelope_id',
  'signer_id',
  'token_sha256',
  'expires_at',
  'revoked_at',
  'revoked_by',
  'created_by',
  'created_at',
]);

const SIGNING_OTP_INVALIDATE_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['invalidated_at']);

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
  sourceKind: z.enum(SIGN_SOURCE_KINDS).default('standalone'),
  sourceId: zId.nullable().optional(),
  sourceFileId: zId,
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
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
      'source_kind',
      'source_id',
      'source_file_id',
      'source_storage_key',
      'source_generation',
      'source_sha256',
      'inspect_status',
      'expires_at',
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
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt !== null && expiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }

    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'source', 'content_type', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.sourceFileId)
      .executeTakeFirst();
    if (!file) throw new DomainError('SIGN_FILE_NOT_FOUND', 404, 'Source file not found');
    if (file.source !== 'sign_document') {
      throw new DomainError('SIGN_INVALID_SOURCE_FILE', 422, 'Envelope source file must have source sign_document');
    }
    if (file.content_type !== 'application/pdf') {
      throw new DomainError('SIGN_INVALID_FILE_TYPE', 422, 'Envelope source file must be application/pdf');
    }
    if (!file.generation) {
      throw new DomainError('SIGN_INVALID_SOURCE_FILE', 422, 'Source file is missing storage generation');
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
        source_kind: input.sourceKind,
        source_id: sourceId,
        source_file_id: file.id,
        source_storage_key: file.storage_key,
        source_generation: file.generation,
        source_sha256: file.sha256,
        inspect_status: 'pending',
        expires_at: expiresAt,
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
      'version',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    if (row.inspect_status !== 'pending') {
      ctx.audit({ envelopeId: row.id, inspectStatus: row.inspect_status, idempotent: true });
      return { envelopeId: row.id, inspectStatus: row.inspect_status, pageCount: row.page_count };
    }
    if (input.outcome === 'passed') {
      if (input.pageDimensions.length !== input.pageCount) {
        throw new DomainError('SIGN_INVALID_INSPECT', 422, 'pageDimensions length must equal pageCount');
      }
      const nextVersion = row.version + 1;
      await ctx.trx
        .updateTable('crove_sign.envelope')
        .set({
          inspect_status: 'passed',
          inspect_error: null,
          page_count: input.pageCount,
          page_dimensions_json: JSON.stringify(input.pageDimensions),
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
        payloadJson: { pageCount: input.pageCount },
        occurredAt: ctx.now,
      });
      ctx.audit({ envelopeId: row.id, inspectStatus: 'passed', pageCount: input.pageCount });
      return { envelopeId: row.id, inspectStatus: 'passed' as const, pageCount: input.pageCount };
    }
    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        inspect_status: 'failed',
        inspect_error: input.error,
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
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
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
      'expires_at',
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
    const changed: string[] = [];
    if (nextTitle !== row.title) changed.push('title');
    if (nextSubject !== row.subject) changed.push('subject');
    if (nextMessage !== row.message) changed.push('message');
    if (nextRoutingMode !== row.routing_mode) changed.push('routing_mode');
    if (input.expiresAt !== undefined) {
      const oldIso = row.expires_at ? new Date(row.expires_at).toISOString() : null;
      const newIso = nextExpiresAt ? nextExpiresAt.toISOString() : null;
      if (oldIso !== newIso) changed.push('expires_at');
    }
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
        expires_at: nextExpiresAt,
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
  })
  .superRefine((item, issueCtx) => {
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

export interface IssuedSigningLink {
  signerId: string;
  tokenId: string;
  token: string;
  expiresAt: string;
}

export const envelopeSend = defineCommand({
  name: 'sign.envelope.send',
  input: z.strictObject({ envelopeId: zId }),
  risk: 'R2',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['status', 'sent_at', 'version', 'updated_at']),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['status', 'updated_at']),
    SIGNING_TOKEN_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userOf(ctx);
    const row = await lockEnvelope(ctx, input.envelopeId);
    assertDraft(row.status);
    if (row.inspect_status !== 'passed' || row.page_count === null) {
      throw new DomainError('SIGN_DOCUMENT_NOT_INSPECTED', 409, 'Document must pass PDF inspection before sending');
    }
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope expiry timestamp is already in the past');
    }

    const signers = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'routing_order', 'signer_role', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forUpdate()
      .execute();
    const activeRoleSigners = signers.filter((s) => s.signer_role !== 'cc');
    if (activeRoleSigners.length === 0) {
      throw new DomainError('SIGN_NO_SIGNERS', 409, 'Envelope requires at least one signer or approver before sending');
    }

    const fields = await ctx.trx
      .selectFrom('crove_sign.field')
      .select(['id', 'signer_id', 'field_type', 'page_number'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .forShare()
      .execute();

    const sigCountBySigner = new Map<string, number>();
    for (const f of fields) {
      if (f.page_number > row.page_count) {
        throw new DomainError(
          'SIGN_FIELD_OUT_OF_BOUNDS',
          409,
          `Field ${f.id} references page ${f.page_number}, exceeding document page count ${row.page_count}`,
        );
      }
      if (f.field_type === 'signature') {
        sigCountBySigner.set(f.signer_id, (sigCountBySigner.get(f.signer_id) ?? 0) + 1);
      }
    }
    for (const s of activeRoleSigners) {
      if (s.signer_role === 'signer' && (sigCountBySigner.get(s.id) ?? 0) < 1) {
        throw new DomainError('SIGN_SIGNATURE_FIELD_REQUIRED', 409, `Signer ${s.id} requires at least one signature field`);
      }
    }

    const sortedActive = [...activeRoleSigners].sort((a, b) => {
      if (a.routing_order !== b.routing_order) return a.routing_order - b.routing_order;
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });
    const minOrder = sortedActive[0]!.routing_order;
    const dueNow = row.routing_mode === 'parallel' ? sortedActive : sortedActive.filter((s) => s.routing_order === minOrder);
    const dueIds = dueNow.map((s) => s.id);

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        status: 'sent',
        sent_at: ctx.now,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await ctx.trx
      .updateTable('crove_sign.signer')
      .set({ status: 'pending', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', 'in', dueIds)
      .execute();

    const defaultExpiry = new Date(ctx.now.getTime() + DEFAULT_LINK_TTL_HOURS * 3_600_000);
    const tokenExpiresAt = row.expires_at ? new Date(row.expires_at) : defaultExpiry;

    const links: IssuedSigningLink[] = [];
    for (const signer of dueNow) {
      const rawToken = generateRawSigningToken();
      const tokenHash = hashSigningToken(rawToken);
      const { rows: minted } = await sql<{ id: string }>`
        SELECT crove_sign.mint_signing_token(
          ${row.id}::uuid,
          ${signer.id}::uuid,
          ${tokenHash},
          ${tokenExpiresAt}::timestamptz
        ) AS id
      `.execute(ctx.trx);
      const tokenId = minted[0]?.id;
      if (!tokenId) throw new Error('mint_signing_token returned no id');
      links.push({
        signerId: signer.id,
        tokenId,
        token: rawToken,
        expiresAt: tokenExpiresAt.toISOString(),
      });
    }

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'envelope_sent',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { routingMode: row.routing_mode, activeSignerIds: dueIds },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, routingMode: row.routing_mode, mintedCount: links.length });
    return {
      envelopeId: row.id,
      status: 'sent' as const,
      version: nextVersion,
      links,
    };
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

export const envelopeRemind = defineCommand({
  name: 'sign.envelope.remind',
  input: z.strictObject({
    envelopeId: zId,
    signerId: zId.optional(),
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [tableWrite(signManifest.tables, 'crove_sign', 'signer', ['token_last_reminded_at', 'updated_at']), SIGNING_EVENT_WRITE],
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
      .select(['id', 'status', 'signer_role', 'token_last_reminded_at'])
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

const zStoredEvidenceFile = z.strictObject({
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  sha256: zSha256Hex,
  storageKey: z.string().min(1),
  generation: z.string().regex(GENERATION_PATTERN),
});

const zEnvelopeSealComplete = z.discriminatedUnion('outcome', [
  z.strictObject({
    envelopeId: zId,
    outcome: z.literal('sealed'),
    certificateCode: z.string().min(1).max(64),
    sealedFile: zStoredEvidenceFile,
    certificateFile: zStoredEvidenceFile,
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
  // Runs nested kernel.file.ingest (same rule as social.media.save_stock, #1698: static job-egress check treats
  // any caller of kernel.file.ingest as reaching the extraction queue's provider egress).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target,
  // Omit writes: calls nested kernel.file.ingest (which writes crove_kernel.file with no writes declaration of its own).
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

    const sealedIngest = await ctx.run<{ fileId: string; duplicate: boolean }>('kernel.file.ingest', {
      ...input.sealedFile,
      contentType: 'application/pdf',
      source: 'sign_sealed',
    });
    const certIngest = await ctx.run<{ fileId: string; duplicate: boolean }>('kernel.file.ingest', {
      ...input.certificateFile,
      contentType: 'application/json',
      source: 'sign_certificate',
    });

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.envelope')
      .set({
        sealed_file_id: sealedIngest.fileId,
        sealed_storage_key: input.sealedFile.storageKey,
        sealed_generation: input.sealedFile.generation,
        sealed_sha256: input.sealedFile.sha256,
        certificate_file_id: certIngest.fileId,
        certificate_storage_key: input.certificateFile.storageKey,
        certificate_generation: input.certificateFile.generation,
        certificate_sha256: input.certificateFile.sha256,
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
      documentSha256: input.sealedFile.sha256,
      payloadJson: {
        certificateCode: input.certificateCode,
        sealedSha256: input.sealedFile.sha256,
        certificateSha256: input.certificateFile.sha256,
      },
      occurredAt: ctx.now,
    });
    ctx.audit({
      envelopeId: row.id,
      sealStatus: 'sealed',
      sealedFileId: sealedIngest.fileId,
      certificateFileId: certIngest.fileId,
    });
    return {
      envelopeId: row.id,
      sealStatus: 'sealed' as const,
      sealedFileId: sealedIngest.fileId,
      certificateFileId: certIngest.fileId,
      certificateCode: input.certificateCode,
    };
  },
});

export const envelopeExpireSweep = defineCommand({
  name: 'sign.envelope.expire_sweep',
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
  input: z.strictObject({
    draftRetentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
    secretRetentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
  }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'signing_otp', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_token', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'field', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'ai_analysis', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'signing_event', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', ['id']),
  ],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    const draftCutoff = new Date(ctx.now.getTime() - input.draftRetentionDays * 86_400_000);
    const secretCutoff = new Date(ctx.now.getTime() - input.secretRetentionDays * 86_400_000);
    const { rows } = await sql<{
      counts: { otps: number; tokens: number; drafts: number; draftEvents: number };
    }>`
      SELECT crove_sign.cleanup_org_stale(${draftCutoff}::timestamptz, ${secretCutoff}::timestamptz) AS counts
    `.execute(ctx.trx);
    const counts = rows[0]?.counts ?? { otps: 0, tokens: 0, drafts: 0, draftEvents: 0 };
    ctx.audit({
      otps: counts.otps,
      tokens: counts.tokens,
      drafts: counts.drafts,
      draftEvents: counts.draftEvents,
      draftCutoff: draftCutoff.toISOString(),
      secretCutoff: secretCutoff.toISOString(),
    });
    return counts;
  },
});

export const signCommands = [
  envelopeCreate,
  envelopeInspectComplete,
  envelopeUpdate,
  signerAdd,
  signerRemove,
  signerReorder,
  fieldSet,
  envelopeSend,
  signerCreateLink,
  envelopeRemind,
  envelopeVoid,
  envelopeSealComplete,
  envelopeExpireSweep,
  orgCleanup,
];
