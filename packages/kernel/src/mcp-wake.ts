// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook of an MCP grant, its setup (ADR-0051 decision 4, issue #3024, step a). An owner or admin gives a grant one HTTPS receiver, an optional
// daily or weekly schedule and a secret that is shown once; a later step sends the signed wake-ups.
//
// - The secret never passes through a command in the clear. The API makes it, seals it with the credential broker and hands the command only the sealed
//   envelope and the public id beside it; the command answers neither, and its audit row names the grant and the receiver's host, never the URL (a URL can
//   carry a token in its path) and never a secret.
// - The URL is checked here by its shape (the contract's rule) and again by the database; the API looks the name up before it calls the command (a command
//   does no network I/O) and the egress guard checks every address again on every send.
// - Only a user, and no MCP grant, sets any of it: the handlers say so themselves, and a test reads them.
import { sql } from 'kysely';
import { z } from 'zod';
import { mcpWakeUrlProblem, zMcpWakeGetInput, zMcpWakeGrantRef, zMcpWakeSet, type McpWakeView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, hasFreshMfa } from '@crove/kernel-runtime';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

// The provider name a wake-up secret is sealed under (with the org and the grant), so it opens for nothing else.
export const MCP_WAKE_PROVIDER = 'mcp-wake';

// What the broker sealed: its key id, the envelope (base64) and the public id the receiver sees beside the secret.
export const zMcpWakeCredential = z.strictObject({
  keyId: z.string().min(1).max(64),
  envelope: z.string().min(16).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  hint: z.string().regex(/^whk_[0-9a-f]{8}$/),
});
export type McpWakeCredential = z.infer<typeof zMcpWakeCredential>;

// The command's input is the procedure's plus the sealed secret the API made; the procedure's input has no such field.
export const zMcpWakeSetCommand = z
  .strictObject({ ...zMcpWakeSet.def.shape, credential: zMcpWakeCredential })
  .refine((v) => v.schedule === 'off' || v.minute !== undefined, { message: 'Chọn giờ gửi', path: ['minute'] })
  .refine((v) => v.schedule !== 'weekly' || v.weekday !== undefined, { message: 'Chọn ngày trong tuần', path: ['weekday'] });

function wakeError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MCP_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới cài được địa chỉ nhận của quyền kết nối MCP');
    case 'MCP_WAKE_GRANT':
      throw new DomainError('MCP_WAKE_GRANT_NOT_FOUND', 404, 'Không tìm thấy quyền kết nối này, hoặc đã hết hiệu lực');
    case 'MCP_WAKE_TOO_SOON':
      throw new DomainError('MCP_WAKE_TOO_SOON', 429, 'Mỗi quyền kết nối chỉ gửi thử được một lần mỗi phút');
    case 'MCP_WAKE_INVALID':
      throw new DomainError('INVALID', 422, 'Địa chỉ nhận hoặc lịch gửi không hợp lệ');
    default:
      throw error;
  }
}

const sealedOf = (c: McpWakeCredential) => JSON.stringify({ keyId: c.keyId, envelope: c.envelope });

export const mcpWakeSet = defineCommand({
  name: 'kernel.mcp.wake.set',
  input: zMcpWakeSetCommand,
  risk: 'R2',
  // Business ids leave the deployment for the receiver it sets, once the delivery queue (which reaches the URL) has something to send.
  sideEffect: 'external',
  access: GRANTORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới cài được địa chỉ nhận của quyền kết nối MCP');
    // A receiver is where business ids leave the deployment: a member with a second factor sets it with a fresh one, as for a connection (ADR-0047 point 10).
    if (ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để cài địa chỉ nhận');
    }
    if (mcpWakeUrlProblem(input.url) !== null) throw new DomainError('INVALID', 422, 'Địa chỉ nhận phải là https, dùng tên miền công khai, cổng 443, không kèm tài khoản');
    const url = new URL(input.url);
    const { rows } = await sql<{ created: boolean }>`
      SELECT crove_kernel.mcp_wake_put(
        ${input.grantId}::uuid, ${url.href}, ${sealedOf(input.credential)}::jsonb, ${input.credential.hint}, ${input.schedule},
        ${input.schedule === 'off' ? null : (input.minute ?? null)}::smallint, ${input.schedule === 'weekly' ? (input.weekday ?? null) : null}::smallint, ${input.enabled}) AS created`
      .execute(ctx.trx)
      .catch(wakeError);
    const created = rows[0]?.created === true;
    // Ids, the receiver's host and the schedule: never the URL, a secret or the sealed envelope.
    ctx.audit({ grantId: input.grantId, host: url.hostname, schedule: input.schedule, enabled: input.enabled, created });
    return { grantId: input.grantId, created };
  },
});

export const mcpWakeRotate = defineCommand({
  name: 'kernel.mcp.wake.rotate_secret',
  input: z.strictObject({ grantId: zMcpWakeGrantRef.shape.grantId, credential: zMcpWakeCredential }),
  risk: 'R2',
  sideEffect: 'internal',
  access: GRANTORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đổi được khóa bí mật của quyền kết nối MCP');
    if (ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để đổi khóa bí mật');
    }
    const { rows } = await sql<{ rotated: boolean }>`
      SELECT crove_kernel.mcp_wake_rotate(${input.grantId}::uuid, ${sealedOf(input.credential)}::jsonb, ${input.credential.hint}) AS rotated`
      .execute(ctx.trx)
      .catch(wakeError);
    if (rows[0]?.rotated !== true) throw new DomainError('MCP_WAKE_NOT_FOUND', 404, 'Quyền kết nối này chưa có địa chỉ nhận');
    ctx.audit({ grantId: input.grantId, hint: input.credential.hint });
    return { grantId: input.grantId, rotated: true as const };
  },
});

export const mcpWakeClear = defineCommand({
  name: 'kernel.mcp.wake.clear',
  input: zMcpWakeGrantRef,
  risk: 'R2',
  sideEffect: 'internal',
  access: GRANTORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gỡ được địa chỉ nhận của quyền kết nối MCP');
    const { rows } = await sql<{ cleared: boolean }>`SELECT crove_kernel.mcp_wake_clear(${input.grantId}::uuid) AS cleared`.execute(ctx.trx).catch(wakeError);
    if (rows[0]?.cleared !== true) throw new DomainError('MCP_WAKE_NOT_FOUND', 404, 'Quyền kết nối này chưa có địa chỉ nhận');
    ctx.audit({ grantId: input.grantId });
    return { grantId: input.grantId, cleared: true as const };
  },
});

// "Send a test": stores a `ping` for the grant's receiver (the sweep hands it to the delivery queue within a minute). It carries no data, and the database allows one a
// minute per grant. A user only, with a fresh second factor as for setting the receiver.
export const mcpWakeTest = defineCommand({
  name: 'kernel.mcp.wake.test',
  input: zMcpWakeGrantRef,
  risk: 'R2',
  sideEffect: 'external',
  access: GRANTORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gửi thử được tin nhắn đánh thức');
    if (ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để gửi thử');
    }
    const { rows } = await sql<{ id: string }>`SELECT crove_kernel.mcp_wake_test(${input.grantId}::uuid) AS id`.execute(ctx.trx).catch(wakeError);
    const eventId = rows[0]?.id;
    if (!eventId) throw new DomainError('MCP_WAKE_NOT_FOUND', 404, 'Quyền kết nối này chưa có địa chỉ nhận');
    ctx.audit({ grantId: input.grantId, eventId });
    return { grantId: input.grantId, eventId, queued: true as const };
  },
});

type WakeRow = {
  grant_id: string;
  url: string;
  enabled: boolean;
  paused_reason: 'failing' | null;
  secret_hint: string;
  previous_until: Date | null;
  schedule: 'off' | 'daily' | 'weekly';
  schedule_minute: number | null;
  schedule_weekday: number | null;
  next_due_at: Date | null;
  failing_since: Date | null;
  consecutive_failures: number;
  last_delivery_at: Date | null;
  last_status: 'sent' | 'failed' | null;
};
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// The wake-ups of the org (or of one grant) for an owner or admin: everything but the secrets.
export const mcpWakeGet = defineQuery({
  name: 'kernel.mcp.wake.get',
  input: zMcpWakeGetInput,
  access: GRANTORS,
  handler: async (ctx, input): Promise<McpWakeView[]> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được địa chỉ nhận của quyền kết nối MCP');
    const { rows } = await sql<WakeRow>`SELECT * FROM crove_kernel.mcp_wake_get(${input.grantId ?? null}::uuid)`.execute(ctx.trx).catch(wakeError);
    return rows.map((r) => ({
      grantId: r.grant_id,
      url: r.url,
      enabled: r.enabled,
      pausedReason: r.paused_reason,
      secretHint: r.secret_hint,
      previousUntil: iso(r.previous_until),
      schedule: r.schedule,
      minute: r.schedule_minute,
      weekday: r.schedule_weekday,
      nextDueAt: iso(r.next_due_at),
      failingSince: iso(r.failing_since),
      consecutiveFailures: r.consecutive_failures,
      lastDeliveryAt: iso(r.last_delivery_at),
      lastStatus: r.last_status,
    }));
  },
});


// ---------------------------------------------------------------------------------------------------------------------------------------------
// The delivery's own steps (step b): commands of the system actor, run by the worker's sweep and delivery job in the org's system context. None is a
// procedure of the contract, and no user, agent or MCP grant reaches any of them (access is empty and each handler says so). A command here changes
// nothing a person sees: it stores a delivery (and, with it, the signals it carries or the schedule it moves on), notes it was handed to the queue, records an attempt's
// outcome and looks at which signals were already sent. The body of a delivery is built by the worker (apps/kernel/src/mcp-wake-body.ts, the only builder) and checked again by the
// database; the URL and the secret are never an input of any of them.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const zWakeEventId = z.uuid();
const zWakeKey = z.string().max(300);
export const zMcpWakeEnqueue = z.strictObject({
  id: zWakeEventId,
  grantId: zMcpWakeGrantRef.shape.grantId,
  type: z.enum(['signal.fired', 'schedule.due', 'ping']),
  body: z.record(z.string(), z.unknown()),
  // The signal keys this event carries: noted as seen in the same transaction that stores it.
  keys: z.array(zWakeKey).max(20).optional(),
});
// 'expired': waited too long with no attempt made, so it fails without counting against the receiver.
export const zMcpWakeRecord = z.strictObject({ id: zWakeEventId, outcome: z.enum(['sent', 'retry', 'failed', 'dropped', 'expired']), code: z.number().int().min(100).max(599).optional() });
export const zMcpWakeTouch = z.strictObject({ id: zWakeEventId });
// `complete`: the short names of the rules that answered in full (the part of a key before the first colon); only their keys are forgotten.
export const zMcpWakeSignalsCheck = z.strictObject({ grantId: zMcpWakeGrantRef.shape.grantId, keys: z.array(zWakeKey).max(200), complete: z.array(z.string().max(60)).max(10) });

function wakeSystemError(error: unknown): never {
  const message = (error as { message?: unknown; code?: unknown } | null)?.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (message === 'MCP_WAKE_GRANT') throw new DomainError('MCP_WAKE_GRANT_NOT_FOUND', 404, 'Không tìm thấy quyền kết nối này, hoặc đã hết hiệu lực');
  if (message === 'MCP_WAKE_INVALID' || code === '23514') throw new DomainError('INVALID', 422, 'Nội dung báo thức không hợp lệ');
  throw error;
}

export const mcpWakeEnqueue = defineCommand({
  name: 'kernel.mcp.wake.enqueue',
  input: zMcpWakeEnqueue,
  // Storing a delivery leads to a request to a URL the org chose, so it declares the external effect its queue reaches.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới xếp hàng một lần báo thức');
    const { rows } = await sql<{ stored: boolean }>`
      SELECT crove_kernel.mcp_wake_enqueue(${input.id}::uuid, ${input.grantId}::uuid, ${input.type}, ${JSON.stringify(input.body)}::jsonb, ${input.keys ?? null}::text[]) AS stored`
      .execute(ctx.trx)
      .catch(wakeSystemError);
    const stored = rows[0]?.stored === true;
    // Ids and the event type: never the body.
    ctx.audit({ grantId: input.grantId, eventId: input.id, type: input.type, stored });
    return { id: input.id, stored };
  },
});

export const mcpWakeTouch = defineCommand({
  name: 'kernel.mcp.wake.queued',
  input: zMcpWakeTouch,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới ghi nhận lần chuyển vào hàng đợi');
    const { rows } = await sql<{ done: boolean }>`SELECT crove_kernel.mcp_wake_touch(${input.id}::uuid) AS done`.execute(ctx.trx).catch(wakeSystemError);
    return { id: input.id, touched: rows[0]?.done === true };
  },
});

export const mcpWakeRecord = defineCommand({
  name: 'kernel.mcp.wake.record',
  input: zMcpWakeRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới ghi nhận kết quả một lần gửi');
    const { rows } = await sql<{ done: boolean }>`
      SELECT crove_kernel.mcp_wake_record(${input.id}::uuid, ${input.outcome}, ${input.code ?? null}::int) AS done`
      .execute(ctx.trx)
      .catch(wakeSystemError);
    const done = rows[0]?.done === true;
    // The outcome and the receiver's status code: never the answer, which is not read.
    ctx.audit({ eventId: input.id, outcome: input.outcome, code: input.code ?? null, settled: done });
    return { id: input.id, recorded: done };
  },
});

export const mcpWakeSignalsCheck = defineCommand({
  name: 'kernel.mcp.wake.signals_check',
  input: zMcpWakeSignalsCheck,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới kiểm tra các tín hiệu đã gửi báo thức');
    const { rows } = await sql<{ fresh: string[] }>`
      SELECT crove_kernel.mcp_wake_signals_check(${input.grantId}::uuid, ${input.keys}::text[], ${input.complete}::text[]) AS fresh`
      .execute(ctx.trx)
      .catch(wakeSystemError);
    return { fresh: rows[0]?.fresh ?? [] };
  },
});

// What the delivery job reads, for the org in its system context: the delivery by its event id, and the receiver and sealed secrets of a grant while the grant can
// still be woken. The sealed envelopes are what the credential broker made (they open only with this org, grant and provider); the worker opens them for the call
// and drops the clear value.
export interface McpWakeDeliveryRow {
  id: string;
  grantId: string;
  type: 'signal.fired' | 'schedule.due' | 'ping';
  body: Record<string, unknown>;
  status: 'queued' | 'sent' | 'failed' | 'dropped';
  attempts: number;
}
export interface McpWakeTargetRow {
  url: string;
  sealed: { keyId: string; envelope: string };
  previous: { keyId: string; envelope: string } | null;
}

export const mcpWakeDelivery = defineQuery({
  name: 'kernel.mcp.wake.delivery',
  input: z.strictObject({ id: z.uuid() }),
  access: 'system',
  handler: async (ctx, input): Promise<McpWakeDeliveryRow | null> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới đọc một lần báo thức đang chờ gửi');
    const { rows } = await sql<{ id: string; grant_id: string; type: McpWakeDeliveryRow['type']; body: Record<string, unknown>; status: McpWakeDeliveryRow['status']; attempts: number }>`
      SELECT id, grant_id, type, body, status, attempts FROM crove_kernel.mcp_wake_delivery_get(${ctx.orgId}::uuid, ${input.id}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? { id: r.id, grantId: r.grant_id, type: r.type, body: r.body, status: r.status, attempts: r.attempts } : null;
  },
});

export const mcpWakeTarget = defineQuery({
  name: 'kernel.mcp.wake.target',
  input: z.strictObject({ grantId: zMcpWakeGrantRef.shape.grantId }),
  access: 'system',
  handler: async (ctx, input): Promise<McpWakeTargetRow | null> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới đọc địa chỉ nhận của một quyền kết nối');
    const { rows } = await sql<{ url: string; secret_sealed: { keyId: string; envelope: string }; previous_sealed: { keyId: string; envelope: string } | null }>`
      SELECT url, secret_sealed, previous_sealed FROM crove_kernel.mcp_wake_target(${ctx.orgId}::uuid, ${input.grantId}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? { url: r.url, sealed: r.secret_sealed, previous: r.previous_sealed } : null;
  },
});

export const mcpWakeCommands = [mcpWakeSet, mcpWakeRotate, mcpWakeClear, mcpWakeTest, mcpWakeEnqueue, mcpWakeTouch, mcpWakeRecord, mcpWakeSignalsCheck];
export const mcpWakeQueries = [mcpWakeGet, mcpWakeDelivery, mcpWakeTarget];
