// SPDX-License-Identifier: AGPL-3.0-only
// Mobile native push device registrations and worker dispatch helpers (#4883, ADR-0059):
//   - A member registers their device APNs/FCM token bound to their signed-in session_id (never supplied by caller).
//   - Device tokens are sensitive: queries never return tokens, audit rows keep counts/ids/platforms only.
//   - Triggers and session checks drop registrations on session revoke, sign-out everywhere, member removal, disable, and org purge.
//   - Registration locks both physical token and (orgId, userId) in a global lock order to reclaim stale prior-user tokens cleanly.
//   - Re-registering the unchanged token preserves last_used_at, failure_count, and generation while refreshing refreshed_at.
//   - Worker dispatch rechecks live access/approval state and records outcomes keyed by (deviceId, generation).
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@ludy/db';
import { zId, zNativePushRegister, zNativePushUnregister, type NativePushPlatform } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { acquireAdvisoryXactLock, advisoryLockKey } from './advisory-lock.ts';
import { decideApproval } from './approval.ts';

const ALL = ['owner', 'admin', 'member', 'viewer'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NATIVE_PUSH_KINDS = ['kernel.conversation_new', 'kernel.approval_waiting'] as const;
export type NativePushKind = (typeof NATIVE_PUSH_KINDS)[number];

export const NATIVE_PUSH_DEVICE_LIMIT = 10;
export const NATIVE_PUSH_FAILURE_LIMIT = 10;
export const NATIVE_PUSH_MAX_AGE_HOURS = 24;

export interface NativePushDeviceSummary {
  id: string;
  platform: NativePushPlatform;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
}

export interface NativePushTargetRow {
  deviceId: string;
  generation: number;
  platform: NativePushPlatform;
  token: string;
  sessionValid: boolean;
}

export interface NativePushTargetsResult {
  orgSlug: string;
  kind: NativePushKind;
  subjectId: string | null;
  targets: NativePushTargetRow[];
}

export interface NativePushDeviceRef {
  id: string;
  generation: number;
}

const zDeviceRef = z.strictObject({
  id: zId,
  generation: z.number().int().min(1),
});

function normalizedSessionId(sessionId: string | undefined): string | null {
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

async function isSessionActive(
  trx: Transaction<Database>,
  orgId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await sql<{ active: boolean }>`
    SELECT ludy_kernel.native_push_session_active(${orgId}::uuid, ${userId}::uuid, ${sessionId}::uuid) AS active`.execute(trx);
  return rows[0]?.active === true;
}

export const nativePushDevices = defineQuery({
  name: 'kernel.native_push.devices',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ registered: boolean; devices: NativePushDeviceSummary[] }> => {
    if (ctx.actor.type !== 'user') return { registered: false, devices: [] };
    const currentSession = normalizedSessionId(ctx.actor.sessionId);
    const currentExpr = currentSession
      ? sql<boolean>`session_id = ${currentSession}::uuid`
      : sql<boolean>`false`;
    const rows = await ctx.trx
      .selectFrom('ludy_kernel.native_push_device')
      .select(['id', 'platform', 'label', 'created_at', 'last_used_at', currentExpr.as('current')])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .where(sql<boolean>`ludy_kernel.native_push_session_active(org_id, user_id, session_id)`)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    const devices: NativePushDeviceSummary[] = rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      label: row.label,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
      current: Boolean(row.current),
    }));
    return { registered: devices.some((d) => d.current), devices };
  },
});

export const registerNativePushDevice = defineCommand({
  name: 'kernel.native_push.register',
  input: zNativePushRegister,
  risk: 'R2',
  sideEffect: 'external',
  access: ALL,
  handler: async (ctx, input): Promise<{ id: string }> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên mới đăng ký nhận thông báo đẩy');
    }
    const userId = ctx.actor.userId;
    const sessionId = normalizedSessionId(ctx.actor.sessionId);
    if (!sessionId) {
      throw new DomainError('SESSION_REQUIRED', 401, 'Phiên đăng nhập không hợp lệ để đăng ký thông báo');
    }
    const assertActiveSession = async () => {
      if (!(await isSessionActive(ctx.trx, ctx.orgId, userId, sessionId))) {
        throw new DomainError('SESSION_REVOKED', 401, 'Phiên đăng nhập này đã bị thu hồi');
      }
    };
    await assertActiveSession();

    // Fixed global lock order: physical token handoff lock first, then per-member device-cap lock.
    const tokenSha256 = createHash('sha256').update(input.token, 'utf8').digest('hex');
    await acquireAdvisoryXactLock(ctx.trx, advisoryLockKey('ludy_kernel.native_push.token', input.platform, tokenSha256));
    await acquireAdvisoryXactLock(ctx.trx, advisoryLockKey('ludy_kernel.native_push', ctx.orgId, ctx.actor.userId));
    await assertActiveSession();

    // Unlink any prior user's stale registration holding the exact same physical OS token (e.g., offline sign-out).
    await sql`SELECT ludy_kernel.native_push_claim_token(${ctx.orgId}::uuid, ${ctx.actor.userId}::uuid, ${input.platform}::text, ${input.token}::text)`.execute(
      ctx.trx,
    );

    // Drop stale revoked-session entries and rebind the same physical token if rotated into a fresh session of this user.
    await ctx.trx
      .deleteFrom('ludy_kernel.native_push_device')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .where((eb) =>
        eb.or([
          sql<boolean>`NOT ludy_kernel.native_push_session_active(org_id, user_id, session_id)`,
          eb.and([
            eb('platform', '=', input.platform),
            eb('token', '=', input.token),
            eb('session_id', '<>', sessionId),
          ]),
        ]),
      )
      .execute();

    const existing = await ctx.trx
      .selectFrom('ludy_kernel.native_push_device')
      .select(['id', 'token', 'label'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .where('session_id', '=', sessionId)
      .where('platform', '=', input.platform)
      .forUpdate()
      .executeTakeFirst();

    const label = input.label ?? null;
    let deviceId: string | undefined;
    let replaced = false;
    if (existing) {
      if (existing.token === input.token) {
        const updated = await ctx.trx
          .updateTable('ludy_kernel.native_push_device')
          .set({
            refreshed_at: ctx.now,
            ...(existing.label !== label ? { label } : {}),
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .returning('id')
          .executeTakeFirst();
        deviceId = updated?.id;
      } else {
        const updated = await ctx.trx
          .updateTable('ludy_kernel.native_push_device')
          .set({
            token: input.token,
            label,
            failure_count: 0,
            last_used_at: null,
            refreshed_at: ctx.now,
            generation: sql<number>`generation + 1`,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .returning('id')
          .executeTakeFirst();
        if (updated) {
          deviceId = updated.id;
          replaced = true;
        }
      }
    }

    if (!deviceId) {
      const { rows: countRows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n
        FROM ludy_kernel.native_push_device
        WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${ctx.actor.userId}::uuid`.execute(ctx.trx);
      if ((countRows[0]?.n ?? 0) >= NATIVE_PUSH_DEVICE_LIMIT) {
        throw new DomainError(
          'NATIVE_PUSH_DEVICE_LIMIT',
          409,
          `Mỗi tài khoản chỉ đăng ký tối đa ${NATIVE_PUSH_DEVICE_LIMIT} thiết bị nhận thông báo trong một tổ chức`,
        );
      }

      const inserted = await ctx.trx
        .insertInto('ludy_kernel.native_push_device')
        .values({
          org_id: ctx.orgId,
          user_id: ctx.actor.userId,
          session_id: sessionId,
          platform: input.platform,
          token: input.token,
          label,
          refreshed_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      deviceId = inserted.id;
    }

    // Re-verify session activity before commit so an overlapping revoke rolls back uncommitted writes cleanly.
    await assertActiveSession();
    ctx.audit({ deviceId, platform: input.platform, replaced });
    return { id: deviceId };
  },
});

export const unregisterNativePushDevice = defineCommand({
  name: 'kernel.native_push.unregister',
  input: zNativePushUnregister,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ removed: number }> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên mới hủy đăng ký thông báo đẩy');
    }
    let query = ctx.trx
      .deleteFrom('ludy_kernel.native_push_device')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId);

    let scope: 'id' | 'token' | 'current';
    if ('id' in input) {
      scope = 'id';
      query = query.where('id', '=', input.id);
    } else if ('token' in input) {
      scope = 'token';
      query = query.where('platform', '=', input.platform).where('token', '=', input.token);
    } else {
      scope = 'current';
      const sessionId = normalizedSessionId(ctx.actor.sessionId);
      if (!sessionId) return { removed: 0 };
      query = query.where('session_id', '=', sessionId);
    }

    const deleted = await query.returning('id').execute();
    ctx.audit({ removed: deleted.length, scope });
    return { removed: deleted.length };
  },
});

export const nativePushTargets = defineQuery({
  name: 'kernel.native_push.targets',
  input: z.strictObject({ notificationId: zId, checkUpstream: z.boolean().optional() }),
  access: 'system',
  handler: async (ctx, input): Promise<NativePushTargetsResult | null> => {
    const { rows } = await sql<{
      user_id: string;
      org_slug: string;
      kind: string;
      subject_id: string | null;
      device_id: string;
      generation: number;
      platform: NativePushPlatform;
      token: string;
      session_valid: boolean;
    }>`
      SELECT user_id, org_slug, kind, subject_id, device_id, generation, platform, token, session_valid
      FROM ludy_kernel.native_push_targets(${input.notificationId}::uuid, ${input.checkUpstream ?? false}::boolean)`.execute(
      ctx.trx,
    );

    const first = rows[0];
    if (!first) return null;
    if (!(NATIVE_PUSH_KINDS as readonly string[]).includes(first.kind)) return null;

    // For pending approval notices, verify decideApproval unconditionally so unmapped commands or missing subjects fail closed.
    if (first.kind === 'kernel.approval_waiting') {
      if (!first.subject_id) return null;
      const proposal = await ctx.trx
        .selectFrom('ludy_kernel.proposal')
        .select(['command', 'status', 'eligible_approvers', 'authors', 'co_authors'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', first.subject_id)
        .executeTakeFirst();
      if (!proposal) return null;
      const decision = await decideApproval(
        ctx.trx,
        ctx.orgId,
        { type: 'user', userId: first.user_id, aal: 'aal2' },
        proposal,
        { lock: false },
      );
      if (decision.reason !== 'ok') return null;
    }

    return {
      orgSlug: first.org_slug,
      kind: first.kind as NativePushKind,
      subjectId: first.subject_id,
      targets: rows.map((row) => ({
        deviceId: row.device_id,
        generation: Number(row.generation),
        platform: row.platform,
        token: row.token,
        sessionValid: row.session_valid,
      })),
    };
  },
});

export const recordNativePushDelivery = defineCommand({
  name: 'kernel.native_push.record',
  input: z.strictObject({
    sent: z.array(zDeviceRef).max(500),
    gone: z.array(zDeviceRef).max(500),
    expired: z.array(zDeviceRef).max(500).default([]),
    failed: z.array(zDeviceRef).max(500),
    checkUpstream: z.boolean().default(false),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: number; gone: number; failed: number }> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ worker mới ghi kết quả gửi thông báo đẩy');
    }

    const matchPairs = (refs: readonly NativePushDeviceRef[]) =>
      sql<boolean>`(id, generation) IN (${sql.join(refs.map((ref) => sql`(${ref.id}::uuid, ${ref.generation}::int)`))})`;

    if (input.sent.length > 0) {
      await ctx.trx
        .updateTable('ludy_kernel.native_push_device')
        .set({ failure_count: 0, last_used_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where(matchPairs(input.sent))
        .execute();
    }

    let goneCount = 0;
    if (input.gone.length > 0) {
      const deletedGone = await ctx.trx
        .deleteFrom('ludy_kernel.native_push_device')
        .where('org_id', '=', ctx.orgId)
        .where(matchPairs(input.gone))
        .returning('id')
        .execute();
      goneCount += deletedGone.length;
    }

    if (input.expired.length > 0) {
      const expiredIds = input.expired.map((ref) => ref.id);
      const expiredGens = input.expired.map((ref) => ref.generation);
      const { rows } = await sql<{ evicted: number }>`
        SELECT ludy_kernel.native_push_evict_expired(${expiredIds}::uuid[], ${expiredGens}::int[], ${input.checkUpstream}::boolean) AS evicted`.execute(
        ctx.trx,
      );
      goneCount += Number(rows[0]?.evicted ?? 0);
    }

    if (input.failed.length > 0) {
      await ctx.trx
        .updateTable('ludy_kernel.native_push_device')
        .set({ failure_count: sql<number>`failure_count + 1` })
        .where('org_id', '=', ctx.orgId)
        .where(matchPairs(input.failed))
        .execute();
      await ctx.trx
        .deleteFrom('ludy_kernel.native_push_device')
        .where('org_id', '=', ctx.orgId)
        .where(matchPairs(input.failed))
        .where('failure_count', '>=', NATIVE_PUSH_FAILURE_LIMIT)
        .execute();
    }

    ctx.audit({ sent: input.sent.length, gone: goneCount, failed: input.failed.length });
    return { sent: input.sent.length, gone: goneCount, failed: input.failed.length };
  },
});

export const nativePushCommands = [registerNativePushDevice, unregisterNativePushDevice, recordNativePushDelivery];
export const nativePushQueries = [nativePushDevices, nativePushTargets];
