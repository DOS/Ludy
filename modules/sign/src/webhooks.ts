// SPDX-License-Identifier: AGPL-3.0-only
// Runtime.execute() command and query handlers for eSign Slice 5b (#4440):
//   - Definer-only outbound HMAC webhook endpoints (crove_sign.webhook) with owner/admin RBAC,
//     edge-sealed CredentialBroker secrets, and 24-hour dual-secret rotation grace window.
//   - Safe-metadata delivery logs (crove_sign.webhook_delivery) and system worker delivery lifecycle
//     (sign.hook.{queued,record,delivery,target}), strictly excluding hr_contract and meeting_minutes envelopes.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  SIGN_MAX_WEBHOOKS,
  mcpWakeUrlProblem,
  tableWrite,
  zSignHookEventRef,
  zSignHookRecordInput,
  zSignHookTargetRef,
  zSignWebhookCreateCommandInput,
  zSignWebhookDeleteInput,
  zSignWebhookDeliveriesInput,
  zSignWebhookDeliveryRecord,
  zSignWebhookListInput,
  zSignWebhookPingInput,
  zSignWebhookPingResult,
  zSignWebhookRecord,
  zSignWebhookRotateSecretCommandInput,
  zSignWebhookUpdateInput,
  type SignHookDeliveryRow,
  type SignHookTargetRow,
  type SignWebhookDeliveryRecord,
  type SignWebhookEventType,
  type SignWebhookPingResult,
  type SignWebhookRecord,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  hasFreshMfa,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { signManifest } from './manifest.ts';

const SIGN_WEBHOOK_ADMINS: readonly MemberRole[] = ['owner', 'admin'];

let signWebhookBrokerAvailable = false;

export function setSignWebhookBrokerAvailable(available: boolean): void {
  signWebhookBrokerAvailable = available;
}

export function isSignWebhookBrokerAvailable(): boolean {
  return signWebhookBrokerAvailable;
}

export const WEBHOOK_DELIVERY_ENQUEUE_WRITE = tableWrite(
  signManifest.tables,
  'crove_sign',
  'webhook_delivery',
  ['org_id', 'id', 'webhook_id', 'envelope_id', 'event_type', 'status', 'payload_json', 'created_at'],
);

const webhookTarget = (input: { webhookId: string }) => ({ type: 'sign.webhook', id: input.webhookId });
const deliveryTarget = (input: { id: string }) => ({ type: 'sign.webhook_delivery', id: input.id });

function assertWebhookAdminUser(ctx: CommandContext | QueryContext, actionLabel: string): void {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp) {
    throw new DomainError('FORBIDDEN', 403, `Only signed-in workspace admins can ${actionLabel}`);
  }
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace owners and admins can manage eSign webhooks');
  }
}

function assertWebhookStepUp(ctx: CommandContext, actionLabel: string): void {
  if (ctx.actor.type === 'user' && ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
    throw new DomainError(
      'STEP_UP_REQUIRED',
      403,
      `Fresh two-factor authentication (MFA within 5 minutes) is required to ${actionLabel}`,
    );
  }
}

function assertWebhookSystem(ctx: CommandContext | QueryContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only the background worker can run webhook delivery operations');
  }
}

function mapSignWebhookSqlError(error: unknown): never {
  const msg = (error as { message?: unknown } | null)?.message;
  switch (msg) {
    case 'NO_CONTEXT':
    case 'SIGN_WEBHOOK_FORBIDDEN':
    case 'SIGN_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Only workspace owners and admins can manage eSign webhooks');
    case 'SIGN_APP_DISABLED':
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng sign đã được tắt cho công ty này', { module: 'sign' });
    case 'SIGN_WEBHOOK_NOT_FOUND':
      throw new DomainError('SIGN_WEBHOOK_NOT_FOUND', 404, 'Webhook endpoint not found');
    case 'SIGN_WEBHOOK_DISABLED':
      throw new DomainError('SIGN_WEBHOOK_DISABLED', 409, 'Webhook endpoint is currently disabled');
    case 'SIGN_WEBHOOKS_MAX':
      throw new DomainError(
        'SIGN_WEBHOOKS_MAX',
        422,
        `Workspace can configure at most ${SIGN_MAX_WEBHOOKS} eSign webhook endpoints`,
      );
    case 'SIGN_WEBHOOK_PING_RATE_LIMITED':
      throw new DomainError(
        'SIGN_WEBHOOK_PING_RATE_LIMITED',
        429,
        'Test ping can be sent at most once per minute and ten times per hour per webhook',
      );
    case 'SIGN_WEBHOOK_INVALID':
      throw new DomainError(
        'SIGN_WEBHOOK_INVALID',
        422,
        'Webhook URL must use HTTPS on a public domain (port 443, no credentials or IP literals)',
      );
    default:
      throw error;
  }
}

export async function enqueueSignWebhookEvent(
  ctx: CommandContext,
  params: {
    envelopeId: string;
    eventType: SignWebhookEventType;
    status: 'sent' | 'in_progress' | 'completed' | 'declined' | 'expired';
    occurredAt: Date;
    signerId?: string | null;
    signerRole?: 'signer' | 'approver' | null;
    signedAt?: Date | null;
    completedAt?: Date | null;
    certificateCode?: string | null;
    sealedSha256?: string | null;
  },
): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT crove_sign.webhook_enqueue_event(
      ${params.envelopeId}::uuid,
      ${params.eventType},
      ${params.status},
      ${params.occurredAt}::timestamptz,
      ${params.signerId ?? null}::uuid,
      ${params.signerRole ?? null},
      ${params.signedAt ?? null}::timestamptz,
      ${params.completedAt ?? null}::timestamptz,
      ${params.certificateCode ?? null},
      ${params.sealedSha256 ?? null}
    ) AS count
  `
    .execute(ctx.trx)
    .catch(mapSignWebhookSqlError);
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Admin queries
// ---------------------------------------------------------------------------

export const signWebhookList = defineQuery({
  name: 'sign.webhook.list',
  input: zSignWebhookListInput,
  access: SIGN_WEBHOOK_ADMINS,
  handler: async (ctx) => {
    assertWebhookAdminUser(ctx, 'view eSign webhooks');
    const { rows } = await sql<{ items: unknown }>`
      SELECT crove_sign.webhook_list() AS items
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const items = zSignWebhookRecord.array().parse(rows[0]?.items ?? []);
    return {
      items,
      brokerAvailable: signWebhookBrokerAvailable,
    };
  },
});

export const signWebhookDeliveries = defineQuery({
  name: 'sign.webhook.deliveries',
  input: zSignWebhookDeliveriesInput,
  access: SIGN_WEBHOOK_ADMINS,
  handler: async (ctx, input): Promise<{ items: SignWebhookDeliveryRecord[] }> => {
    assertWebhookAdminUser(ctx, 'view eSign webhook deliveries');
    const { rows } = await sql<{ items: unknown }>`
      SELECT crove_sign.webhook_deliveries_list(${input.webhookId ?? null}::uuid, ${input.limit}::int) AS items
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const items = zSignWebhookDeliveryRecord.array().parse(rows[0]?.items ?? []);
    return { items };
  },
});

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------

export const signWebhookCreate = defineCommand({
  name: 'sign.webhook.create',
  input: zSignWebhookCreateCommandInput,
  risk: 'R2',
  // Queued eSign lifecycle metadata is POSTed to the receiver URL configured here by sign-hook-deliver (#4440).
  sideEffect: 'external',
  access: SIGN_WEBHOOK_ADMINS,
  target: (input) => ({ type: 'sign.webhook', id: input.id }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'webhook', [
      'org_id',
      'id',
      'url',
      'events',
      'enabled',
      'key_id',
      'secret_envelope',
      'secret_hint',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignWebhookRecord> => {
    assertWebhookAdminUser(ctx, 'create an eSign webhook');
    assertWebhookStepUp(ctx, 'create an eSign webhook');
    if (mcpWakeUrlProblem(input.url) !== null) {
      throw new DomainError(
        'SIGN_WEBHOOK_INVALID',
        422,
        'Webhook URL must use HTTPS on a public domain (port 443, no credentials or IP literals)',
      );
    }
    const parsedUrl = new URL(input.url);
    const { rows } = await sql<{ item: unknown }>`
      SELECT crove_sign.webhook_create(
        ${input.id}::uuid,
        ${parsedUrl.href},
        ${input.events}::text[],
        ${input.enabled},
        ${input.keyId},
        ${input.secretEnvelope},
        ${input.secretHint}
      ) AS item
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const item = zSignWebhookRecord.parse(rows[0]?.item);
    // Audit host and non-secret metadata only; never persist the full URL path, plaintext secret, or sealed envelope.
    ctx.audit({
      webhookId: item.id,
      host: parsedUrl.hostname,
      events: item.events,
      enabled: item.enabled,
      secretHint: item.secretHint,
    });
    return item;
  },
});

export const signWebhookUpdate = defineCommand({
  name: 'sign.webhook.update',
  input: zSignWebhookUpdateInput.omit({ idempotencyKey: true }),
  risk: 'R2',
  sideEffect: 'external',
  access: SIGN_WEBHOOK_ADMINS,
  target: webhookTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'webhook', [
      'url',
      'events',
      'enabled',
      'paused_reason',
      'failing_since',
      'consecutive_failures',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'webhook_delivery', ['status', 'payload_json']),
  ],
  handler: async (ctx, input): Promise<SignWebhookRecord> => {
    assertWebhookAdminUser(ctx, 'update an eSign webhook');
    assertWebhookStepUp(ctx, 'update an eSign webhook');
    if (mcpWakeUrlProblem(input.url) !== null) {
      throw new DomainError(
        'SIGN_WEBHOOK_INVALID',
        422,
        'Webhook URL must use HTTPS on a public domain (port 443, no credentials or IP literals)',
      );
    }
    const parsedUrl = new URL(input.url);
    const { rows } = await sql<{ item: unknown }>`
      SELECT crove_sign.webhook_update(
        ${input.webhookId}::uuid,
        ${parsedUrl.href},
        ${input.events}::text[],
        ${input.enabled}
      ) AS item
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const item = zSignWebhookRecord.parse(rows[0]?.item);
    ctx.audit({
      webhookId: item.id,
      host: parsedUrl.hostname,
      events: item.events,
      enabled: item.enabled,
    });
    return item;
  },
});

export const signWebhookRotateSecret = defineCommand({
  name: 'sign.webhook.rotate_secret',
  input: zSignWebhookRotateSecretCommandInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WEBHOOK_ADMINS,
  target: webhookTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'webhook', [
      'key_id',
      'secret_envelope',
      'secret_hint',
      'previous_key_id',
      'previous_secret_envelope',
      'previous_expires_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignWebhookRecord> => {
    assertWebhookAdminUser(ctx, 'rotate an eSign webhook secret');
    assertWebhookStepUp(ctx, 'rotate an eSign webhook secret');
    const { rows } = await sql<{ item: unknown }>`
      SELECT crove_sign.webhook_rotate_secret(
        ${input.webhookId}::uuid,
        ${input.keyId},
        ${input.secretEnvelope},
        ${input.secretHint}
      ) AS item
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const item = zSignWebhookRecord.parse(rows[0]?.item);
    ctx.audit({
      webhookId: item.id,
      secretHint: item.secretHint,
      previousExpiresAt: item.previousExpiresAt,
    });
    return item;
  },
});

export const signWebhookDelete = defineCommand({
  name: 'sign.webhook.delete',
  input: zSignWebhookDeleteInput.omit({ idempotencyKey: true }),
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WEBHOOK_ADMINS,
  target: webhookTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'webhook', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'webhook_delivery', ['id']),
  ],
  handler: async (ctx, input) => {
    assertWebhookAdminUser(ctx, 'delete an eSign webhook');
    const { rows } = await sql<{ deleted: boolean }>`
      SELECT crove_sign.webhook_delete(${input.webhookId}::uuid) AS deleted
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const deleted = rows[0]?.deleted === true;
    if (!deleted) {
      throw new DomainError('SIGN_WEBHOOK_NOT_FOUND', 404, 'Webhook endpoint not found');
    }
    ctx.audit({ webhookId: input.webhookId, deleted: true });
    return { webhookId: input.webhookId, deleted: true };
  },
});

export const signWebhookPing = defineCommand({
  name: 'sign.webhook.ping',
  input: zSignWebhookPingInput.omit({ idempotencyKey: true }),
  risk: 'R2',
  sideEffect: 'external',
  access: SIGN_WEBHOOK_ADMINS,
  target: webhookTarget,
  writes: [WEBHOOK_DELIVERY_ENQUEUE_WRITE],
  handler: async (ctx, input): Promise<SignWebhookPingResult> => {
    assertWebhookAdminUser(ctx, 'send a test eSign webhook');
    assertWebhookStepUp(ctx, 'send a test eSign webhook');
    const { rows } = await sql<{ item: unknown }>`
      SELECT crove_sign.webhook_ping(${input.webhookId}::uuid) AS item
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const item = zSignWebhookPingResult.parse(rows[0]?.item);
    ctx.audit({ webhookId: item.webhookId, deliveryId: item.deliveryId });
    return item;
  },
});

// ---------------------------------------------------------------------------
// System worker commands & queries (sign-hook-sweep / sign-hook-deliver)
// ---------------------------------------------------------------------------

export const signHookQueued = defineCommand({
  name: 'sign.hook.queued',
  input: zSignHookEventRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: deliveryTarget,
  writes: [tableWrite(signManifest.tables, 'crove_sign', 'webhook_delivery', ['handed_at'])],
  handler: async (ctx, input) => {
    assertWebhookSystem(ctx);
    const { rows } = await sql<{ done: boolean }>`
      SELECT crove_sign.webhook_touch(${input.id}::uuid) AS done
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    return { id: input.id, touched: rows[0]?.done === true };
  },
});

export const signHookRecord = defineCommand({
  name: 'sign.hook.record',
  runsWhenOff: 'records what an eSign webhook delivery answered, so a call already made is not lost when the app is switched off',
  input: zSignHookRecordInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: deliveryTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'webhook_delivery', [
      'id',
      'status',
      'payload_json',
      'attempts',
      'last_code',
      'sent_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'webhook', [
      'enabled',
      'paused_reason',
      'failing_since',
      'consecutive_failures',
      'last_delivery_at',
      'last_status',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    assertWebhookSystem(ctx);
    const { rows } = await sql<{ done: boolean }>`
      SELECT crove_sign.webhook_record(${input.id}::uuid, ${input.outcome}, ${input.code ?? null}::int) AS done
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const done = rows[0]?.done === true;
    ctx.audit({
      deliveryId: input.id,
      outcome: input.outcome,
      code: input.code ?? null,
      settled: done,
    });
    return { id: input.id, recorded: done };
  },
});

export const signHookDelivery = defineQuery({
  name: 'sign.hook.delivery',
  input: zSignHookEventRef,
  access: 'system',
  handler: async (ctx, input): Promise<SignHookDeliveryRow | null> => {
    assertWebhookSystem(ctx);
    const { rows } = await sql<{
      id: string;
      webhook_id: string;
      envelope_id: string | null;
      envelope_source_kind: string | null;
      event_type: SignHookDeliveryRow['eventType'];
      payload_json: SignHookDeliveryRow['payload'];
      status: SignHookDeliveryRow['status'];
      attempts: number;
    }>`
      SELECT id, webhook_id, envelope_id, envelope_source_kind, event_type, payload_json, status, attempts
      FROM crove_sign.webhook_delivery_get(${ctx.orgId}::uuid, ${input.id}::uuid)
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      webhookId: r.webhook_id,
      envelopeId: r.envelope_id,
      envelopeSourceKind: r.envelope_source_kind,
      eventType: r.event_type,
      payload: r.payload_json,
      status: r.status,
      attempts: r.attempts,
    };
  },
});

export const signHookTarget = defineQuery({
  name: 'sign.hook.target',
  input: zSignHookTargetRef,
  access: 'system',
  handler: async (ctx, input): Promise<SignHookTargetRow | null> => {
    assertWebhookSystem(ctx);
    const { rows } = await sql<{
      id: string;
      url: string;
      key_id: string;
      secret_envelope: string;
      previous_key_id: string | null;
      previous_secret_envelope: string | null;
    }>`
      SELECT id, url, key_id, secret_envelope, previous_key_id, previous_secret_envelope
      FROM crove_sign.webhook_target(${input.webhookId}::uuid)
    `
      .execute(ctx.trx)
      .catch(mapSignWebhookSqlError);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      url: r.url,
      sealed: { keyId: r.key_id, envelope: r.secret_envelope },
      previous:
        r.previous_key_id && r.previous_secret_envelope
          ? { keyId: r.previous_key_id, envelope: r.previous_secret_envelope }
          : null,
    };
  },
});

export const signWebhookQueries = [signWebhookList, signWebhookDeliveries, signHookDelivery, signHookTarget];
export const signWebhookCommands = [
  signWebhookCreate,
  signWebhookUpdate,
  signWebhookRotateSecret,
  signWebhookDelete,
  signWebhookPing,
  signHookQueued,
  signHookRecord,
];
