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
  sideEffect: 'internal',
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

export const mcpWakeCommands = [mcpWakeSet, mcpWakeRotate, mcpWakeClear];
export const mcpWakeQueries = [mcpWakeGet];
