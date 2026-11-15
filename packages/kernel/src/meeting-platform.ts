// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platforms a member connects and the recordings they offer (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1). The same shape as the
// outside calendars (calendar-connections.ts): thin commands over the crove_kernel.meeting_platform_* definers.
//
// Who may do what:
// - A member who edits (owner, admin, member) connects their own platform account and reads only their own connections and recordings (the tables' row policies). No query returns a token.
// - The connect command never sees a token: the caller seals it with the credential broker for meetingPlatformBinding(org, provider, account) and passes the envelope, which the
//   meeting_platform_credential_put definer stores. The audit row holds ids and the provider, never the envelope.
// - Only the worker reads a credential back (kernel.meeting_platform.credential, system actor), and only while the member is still in the org.
// - The worker's sweep lists, downloads and expires through the system commands and queries below. The definers behind them check that the login is the worker; a system actor on another
//   login is refused by the database, not by this file alone.
// - The click that starts an import (meeting_platform_recording_begin) belongs to the command of the meetings module that creates the meeting in the same transaction.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  zId,
  zMeetingPlatformConnectionRef,
  zMeetingPlatformErrorCode,
  zMeetingPlatformListed,
  zMeetingPlatformProvider,
  zMeetingPlatformRecordingRef,
  type MeetingPlatformConnectionView,
  type MeetingPlatformRecordingView,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// A member demoted to viewer after connecting still sees and removes their own connection, as for calendars.
const OWN: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The sealed envelope as base64; its size is checked again by the column (64 KiB).
const zEnvelope = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(90_000);
const zInstant = z.iso.datetime({ offset: true });
const SYNC_PAGE_MAX = 1000;
const IMPORT_PAGE_MAX = 200;
const RECORDINGS_LIMIT = 50;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới kết nối được nền tảng họp');
  return ctx.actor.userId;
}

function requireSystem(actor: { type: string }): void {
  if (actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
}

// Errors the meeting_platform_* definers raise, as domain errors. Anything else goes through the runtime's mapping.
function platformError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MEETING_PLATFORM_NOT_FOUND':
      throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy kết nối hoặc bản ghi này');
    case 'MEETING_PLATFORM_NOT_ACTIVE':
      throw new DomainError('MEETING_PLATFORM_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    case 'MEETING_PLATFORM_OWNER_LEFT':
      throw new DomainError('MEETING_PLATFORM_OWNER_LEFT', 409, 'Chủ của kết nối này không còn là thành viên của tổ chức');
    case 'MEETING_PLATFORM_STATE':
      throw new DomainError('MEETING_PLATFORM_STATE', 409, 'Bản ghi này đang ở trạng thái không cho phép thao tác này');
    case 'MEETING_PLATFORM_NO_AUDIO':
      throw new DomainError('MEETING_PLATFORM_NO_AUDIO', 422, 'Nền tảng không cung cấp âm thanh hay video của bản ghi này');
    case 'MEETING_PLATFORM_INVALID':
      throw new DomainError('VALIDATION', 422, 'Dữ liệu bản ghi không hợp lệ');
    case 'MEETING_PLATFORM_FORBIDDEN':
    case 'NO_CONTEXT':
      throw new DomainError('FORBIDDEN', 403, 'Bạn chỉ quản lý được kết nối của chính mình');
    case 'MEETING_PLATFORM_WORKER_ONLY':
    case 'MEETING_PLATFORM_SYSTEM_CONTEXT':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    default:
      throw error;
  }
}

export const zMeetingPlatformConnect = z.strictObject({
  provider: zMeetingPlatformProvider,
  externalAccount: z.string().trim().toLowerCase().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().min(1).max(200)).max(20),
  expiresAt: zInstant.nullable(),
  credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
});

export const meetingPlatformConnect = defineCommand({
  name: 'kernel.meeting_platform.connect',
  input: zMeetingPlatformConnect,
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    // Two connects of one account at once serialize here, so the second finds the first's row and reconnects instead of failing on the unique index.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.meeting_platform:${ctx.orgId}:${userId}:${input.provider}:${input.externalAccount}`}, 0))`.execute(ctx.trx);
    const existing = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('provider', '=', input.provider)
      .where('external_account', '=', input.externalAccount)
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      // Active again, and listed at the sweep's next pass (last_synced_at cleared).
      await ctx.trx
        .updateTable('crove_kernel.meeting_platform_connection')
        .set({ display_name: input.displayName, scopes: input.scopes, expires_at: input.expiresAt, status: 'active', status_reason: null, last_synced_at: null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
      id = existing.id;
    } else {
      const row = await ctx.trx
        .insertInto('crove_kernel.meeting_platform_connection')
        .values({ org_id: ctx.orgId, user_id: userId, provider: input.provider, external_account: input.externalAccount, display_name: input.displayName, scopes: input.scopes, expires_at: input.expiresAt, status: 'active', status_reason: null, connected_at: ctx.now, updated_at: ctx.now })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    }
    await sql`SELECT crove_kernel.meeting_platform_credential_put(${id}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(platformError);
    // The audit row names the connection and provider only: never the envelope, the account or the display name.
    ctx.audit({ connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    return { connectionId: id, reconnected: Boolean(existing) };
  },
});

export const meetingPlatformDisconnect = defineCommand({
  name: 'kernel.meeting_platform.disconnect',
  input: zMeetingPlatformConnectionRef,
  risk: 'R2',
  sideEffect: 'external',
  access: OWN,
  target: (input) => ({ type: 'kernel.meeting_platform_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    // The row policy shows a member only their own, so another member's connection is not found.
    const row = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_connection')
      .select(['provider', 'user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.user_id !== userId) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy kết nối này');
    // An import in flight holds bytes in staging and a meeting being made: it finishes or fails first, so a disconnect never strands them.
    const busy = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_recording')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('status', 'in', ['importing', 'staged', 'claimed'])
      .limit(1)
      .executeTakeFirst();
    if (busy) throw new DomainError('MEETING_PLATFORM_BUSY', 409, 'Đang nhập một bản ghi từ kết nối này, hãy thử lại sau khi nhập xong');
    // The tokens first, then the row: its foreign keys delete the recordings it listed.
    await sql`SELECT crove_kernel.meeting_platform_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(platformError);
    await ctx.trx.deleteFrom('crove_kernel.meeting_platform_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider });
    return { connectionId: input.connectionId, disconnected: true as const };
  },
});

// "Làm mới": the member asks for their connections to be listed again. Nothing is fetched here (the worker's sweep does, at its next pass): the connection's last_synced_at is cleared, which makes
// it due at once. Only the member's own active connections, all of them or one.
export const meetingPlatformRefresh = defineCommand({
  name: 'kernel.meeting_platform.refresh',
  input: z.strictObject({ connectionId: zId.optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const rows = await ctx.trx
      .updateTable('crove_kernel.meeting_platform_connection')
      .set({ last_synced_at: null })
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .$if(input.connectionId !== undefined, (q) => q.where('id', '=', input.connectionId as string))
      .returning('id')
      .execute();
    ctx.audit({ count: rows.length });
    return { refreshed: rows.length };
  },
});

export const meetingPlatformRecordingDismiss = defineCommand({
  name: 'kernel.meeting_platform.recording.dismiss',
  input: zMeetingPlatformRecordingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    await sql`SELECT crove_kernel.meeting_platform_recording_dismiss(${input.recordingId}::uuid)`.execute(ctx.trx).catch(platformError);
    ctx.audit({ recording_id: input.recordingId });
    return { recordingId: input.recordingId, dismissed: true as const };
  },
});

// The member's request takes the bytes the worker staged: the row must be theirs and staged; it becomes claimed and the staging key comes back for the sealing (the same route as an upload).
export const meetingPlatformImportClaim = defineCommand({
  name: 'kernel.meeting_platform.import.claim',
  input: zMeetingPlatformRecordingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input): Promise<{ stagingKey: string; meetingId: string; sizeBytes: number | null }> => {
    requireUser(ctx);
    const { rows } = await sql<{ staging_key: string; meeting_id: string; size_bytes: string | number | null }>`
      SELECT staging_key, meeting_id, size_bytes FROM crove_kernel.meeting_platform_recording_claim(${input.recordingId}::uuid)`
      .execute(ctx.trx)
      .catch(platformError);
    const row = rows[0];
    if (!row) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the recording only: never the staging key.
    ctx.audit({ recording_id: input.recordingId });
    return { stagingKey: row.staging_key, meetingId: row.meeting_id, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes) };
  },
});

// The route's failure after a claim (a hostile or unreadable file, a refused size): the row fails with a short code and forgets its staging key.
export const meetingPlatformImportClaimFailed = defineCommand({
  name: 'kernel.meeting_platform.import.claim_failed',
  input: z.strictObject({ recordingId: zId, code: zMeetingPlatformErrorCode }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    await sql`SELECT crove_kernel.meeting_platform_recording_claim_failed(${input.recordingId}::uuid, ${input.code})`.execute(ctx.trx).catch(platformError);
    ctx.audit({ recording_id: input.recordingId, code: input.code });
    return { recordingId: input.recordingId, code: input.code };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The worker's side (system actor). The definers behind each check that the login is the worker and, where they act for one
// org, that the context is that org's system context.
// ---------------------------------------------------------------------------------------------------------------------

export interface SealedMeetingPlatformCredential {
  provider: string;
  externalAccount: string;
  keyId: string;
  // base64
  envelope: string;
}

// The sealed credential of an active connection, for the sweep and the download in the worker. The caller opens it with the credential broker for the binding returned here and drops the plaintext
// after the call.
export const meetingPlatformCredential = defineQuery({
  name: 'kernel.meeting_platform.credential',
  input: zMeetingPlatformConnectionRef,
  access: 'system',
  handler: async (ctx, input): Promise<SealedMeetingPlatformCredential> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account: string }>`
      SELECT key_id, envelope, provider, external_account FROM crove_kernel.meeting_platform_credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(platformError);
    const row = rows[0];
    if (!row) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy kết nối này');
    return { provider: row.provider, externalAccount: row.external_account, keyId: row.key_id, envelope: row.envelope.toString('base64') };
  },
});

export interface MeetingPlatformSyncDue {
  orgId: string;
  connectionId: string;
  provider: string;
}

// A page of the active connections of active orgs after a key, for the sweep. The definer lists every org; the context's org only hosts the call.
export const meetingPlatformSyncDue = defineQuery({
  name: 'kernel.meeting_platform.sync_due',
  input: z.strictObject({ afterOrg: zId.nullable(), afterId: zId.nullable(), limit: z.number().int().min(1).max(SYNC_PAGE_MAX) }),
  access: 'system',
  handler: async (ctx, input): Promise<MeetingPlatformSyncDue[]> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ org_id: string; connection_id: string; provider: string }>`
      SELECT org_id, connection_id, provider FROM crove_kernel.meeting_platform_sync_due(${input.afterOrg}::uuid, ${input.afterId}::uuid, ${input.limit}::int)`
      .execute(ctx.trx)
      .catch(platformError);
    return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider }));
  },
});

// The sweep's answer for one connection: its suggestions become exactly these recordings (see the definer). Returns a count.
export const meetingPlatformRecordingReplace = defineCommand({
  name: 'kernel.meeting_platform.recording_replace',
  input: z.strictObject({ connectionId: zId, rows: z.array(zMeetingPlatformListed).max(100) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.meeting_platform_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ count: number }>`
      SELECT crove_kernel.meeting_platform_recording_replace(${input.connectionId}::uuid, ${JSON.stringify(input.rows)}::jsonb) AS count`
      .execute(ctx.trx)
      .catch(platformError);
    const count = Number(rows[0]?.count ?? 0);
    // A count only: never a title.
    ctx.audit({ connection_id: input.connectionId, count });
    return { count };
  },
});

// The sweep could not list a connection: a short code becomes its status_reason and its last listing moves to now, so the next try waits (the due list skips it for 10 minutes; a refresh brings it
// back). expired: the provider refused the grant, so the member connects again.
export const meetingPlatformSyncFailed = defineCommand({
  name: 'kernel.meeting_platform.sync_failed',
  input: z.strictObject({ connectionId: zId, code: zMeetingPlatformErrorCode, expired: z.boolean() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.meeting_platform_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireSystem(ctx.actor);
    await sql`SELECT crove_kernel.meeting_platform_sync_failed(${input.connectionId}::uuid, ${input.code}, ${input.expired})`.execute(ctx.trx).catch(platformError);
    ctx.audit({ connection_id: input.connectionId, code: input.code, expired: input.expired });
    return { connectionId: input.connectionId, code: input.code, expired: input.expired };
  },
});

export interface MeetingPlatformImportOpen {
  orgId: string;
  recordingId: string;
  connectionId: string;
  provider: string;
  externalId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number | null;
  stagingKey: string;
}

// The importing rows of every org, for the worker's sweep to queue one download each: ids, the provider and the platform's id, the staging key. No title.
export const meetingPlatformImportOpen = defineQuery({
  name: 'kernel.meeting_platform.import_open',
  input: z.strictObject({ limit: z.number().int().min(1).max(IMPORT_PAGE_MAX) }),
  access: 'system',
  handler: async (ctx, input): Promise<MeetingPlatformImportOpen[]> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{
      org_id: string;
      id: string;
      connection_id: string;
      provider: string;
      external_id: string;
      has_audio: boolean;
      has_video: boolean;
      size_bytes: string | number | null;
      staging_key: string;
    }>`
      SELECT org_id, id, connection_id, provider, external_id, has_audio, has_video, size_bytes, staging_key
      FROM crove_kernel.meeting_platform_import_open(${input.limit}::integer)`
      .execute(ctx.trx)
      .catch(platformError);
    return rows.map((r) => ({
      orgId: r.org_id,
      recordingId: r.id,
      connectionId: r.connection_id,
      provider: r.provider,
      externalId: r.external_id,
      hasAudio: r.has_audio,
      hasVideo: r.has_video,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      stagingKey: r.staging_key,
    }));
  },
});

// The worker's outcomes: the bytes are in staging, or the download failed (a short code, never the platform's message). Each names the staging key the job was handed and changes only an importing row that still
// holds exactly that key, so a duplicate or stale job cannot stage or fail a row that moved on; `applied` is how many rows it changed (0 or 1).
const zStagingKey = z.string().regex(/^staging\/[0-9a-f]{64}$/);

export const meetingPlatformImportStaged = defineCommand({
  name: 'kernel.meeting_platform.import_staged',
  input: z.strictObject({ recordingId: zId, stagingKey: zStagingKey }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.meeting_platform_import_staged(${input.recordingId}::uuid, ${input.stagingKey}) AS n`.execute(ctx.trx).catch(platformError);
    ctx.audit({ recording_id: input.recordingId, applied: rows[0]?.n ?? 0 });
    return { recordingId: input.recordingId, applied: rows[0]?.n ?? 0 };
  },
});

export const meetingPlatformImportFailed = defineCommand({
  name: 'kernel.meeting_platform.import_failed',
  input: z.strictObject({ recordingId: zId, code: zMeetingPlatformErrorCode, stagingKey: zStagingKey }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.meeting_platform_import_failed(${input.recordingId}::uuid, ${input.code}, ${input.stagingKey}) AS n`.execute(ctx.trx).catch(platformError);
    ctx.audit({ recording_id: input.recordingId, code: input.code, applied: rows[0]?.n ?? 0 });
    return { recordingId: input.recordingId, code: input.code, applied: rows[0]?.n ?? 0 };
  },
});

// What the row holds for a staging key, for the job (an enum): importing is this job's turn, staged or claimed means another job already did it and its bytes are live, none means the row moved on.
export const meetingPlatformImportHolds = defineQuery({
  name: 'kernel.meeting_platform.import_holds',
  input: z.strictObject({ recordingId: zId, stagingKey: zStagingKey }),
  access: 'system',
  handler: async (ctx, input): Promise<'importing' | 'staged' | 'claimed' | 'none'> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ holds: 'importing' | 'staged' | 'claimed' | 'none' }>`SELECT crove_kernel.meeting_platform_import_holds(${input.recordingId}::uuid, ${input.stagingKey}) AS holds`.execute(ctx.trx).catch(platformError);
    return rows[0]?.holds ?? 'none';
  },
});

// Expiry across every org (the context's org only hosts the audit row): old suggestions go, staged bytes nobody claimed, stalled claims and downloads fail. Returns the staging keys whose bytes the
// job must delete.
export const meetingPlatformSweep = defineCommand({
  name: 'kernel.meeting_platform.sweep',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx): Promise<{ keys: string[] }> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ staging_key: string }>`SELECT staging_key FROM crove_kernel.meeting_platform_recording_sweep()`.execute(ctx.trx).catch(platformError);
    ctx.audit({ expired: rows.length });
    return { keys: rows.map((r) => r.staging_key) };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The member's reads
// ---------------------------------------------------------------------------------------------------------------------

// The member's own connections (the row policy hides everyone else's).
export const meetingPlatformConnections = defineQuery({
  name: 'kernel.meeting_platform.connections',
  input: z.strictObject({}),
  access: OWN,
  handler: async (ctx): Promise<MeetingPlatformConnectionView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được kết nối nền tảng họp');
    const rows = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_connection')
      .select(['id', 'provider', 'display_name', 'status', 'status_reason', 'last_synced_at', 'connected_at'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .orderBy('connected_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      displayName: r.display_name,
      status: r.status,
      statusReason: r.status_reason,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      connectedAt: r.connected_at.toISOString(),
    }));
  },
});

// The member's own recordings, newest first: the suggestions and what became of the ones they imported. A dismissed one is hidden.
export const meetingPlatformRecordings = defineQuery({
  name: 'kernel.meeting_platform.recordings',
  input: z.strictObject({}),
  access: OWN,
  handler: async (ctx): Promise<MeetingPlatformRecordingView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được bản ghi từ nền tảng họp');
    const rows = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_recording as r')
      .innerJoin('crove_kernel.meeting_platform_connection as c', (join) => join.onRef('c.org_id', '=', 'r.org_id').onRef('c.id', '=', 'r.connection_id'))
      .select(['r.id', 'r.connection_id', 'c.provider', 'r.title', 'r.started_at', 'r.length_seconds', 'r.size_bytes', 'r.has_audio', 'r.has_video', 'r.has_transcript', 'r.status', 'r.meeting_id', 'r.error_code'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.user_id', '=', ctx.actor.userId)
      .where('r.status', '<>', 'dismissed')
      .orderBy('r.started_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(RECORDINGS_LIMIT)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      provider: r.provider,
      title: r.title,
      startedAt: r.started_at.toISOString(),
      lengthSeconds: r.length_seconds,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      hasAudio: r.has_audio,
      hasVideo: r.has_video,
      hasTranscript: r.has_transcript,
      status: r.status,
      meetingId: r.meeting_id,
      errorCode: r.error_code,
    }));
  },
});

export const meetingPlatformCommands = [
  meetingPlatformConnect,
  meetingPlatformDisconnect,
  meetingPlatformRefresh,
  meetingPlatformRecordingDismiss,
  meetingPlatformImportClaim,
  meetingPlatformImportClaimFailed,
  meetingPlatformRecordingReplace,
  meetingPlatformSyncFailed,
  meetingPlatformImportStaged,
  meetingPlatformImportFailed,
  meetingPlatformSweep,
];
export const meetingPlatformQueries = [meetingPlatformConnections, meetingPlatformRecordings, meetingPlatformCredential, meetingPlatformImportHolds, meetingPlatformSyncDue, meetingPlatformImportOpen];
