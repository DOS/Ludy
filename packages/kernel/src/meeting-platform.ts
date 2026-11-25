// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platforms a member connects and the recordings they offer (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1). The same shape as the
// outside calendars (calendar-connections.ts): thin commands over the ludy_kernel.meeting_platform_* definers.
//
// Who may do what:
// - A member who edits (owner, admin, member) connects their own platform account and reads only their own connections and recordings (the tables' row policies). No query returns a token.
// - The connect command never sees a token: the caller seals it with the credential broker for meetingPlatformBinding(org, provider, account) and passes the envelope, which the
//   meeting_platform_credential_put definer stores. The audit row holds ids and the provider, never the envelope.
// - Only the worker reads a credential back (kernel.meeting_platform.credential, system actor), and only while the member is still in the org.
// - The worker's sweep lists, downloads and expires through the system commands and queries below. The definers behind them check that the login is the worker; a system actor on another
//   login is refused by the database, not by this file alone.
// - The click that starts an import (meeting_platform_recording_begin) belongs to the command of the meetings module that creates the meeting in the same transaction.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  AGENDA_OVERLAP_MINUTES,
  meetingOverlapWindow,
  normalizeCaptureCall,
  vietnamToday,
  zId,
  zMeetingPlatformConnectionRef,
  MEETING_PLATFORM_OAUTH_NAME,
  zMeetingPlatformConnectProvider,
  zMeetingPlatformErrorCode,
  zMeetingPlatformListed,
  zMeetingPlatformProvider,
  zMeetingPlatformRecordingPick,
  zMeetingPlatformRecordingRef,
  type CaptureCall,
  type MeetingPlatformConnectionView,
  type MeetingPlatformRecordingView,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { offAppsOf } from './org-apps.ts';

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

// Canonical SHA-256 key identifying a call within one org (`sha256("${orgId}\n${platform}\n${id}")`), shared with live capture sessions (#4572).
export function captureCallKey(orgId: string, call: CaptureCall): string | null {
  const normalized = normalizeCaptureCall(call);
  return normalized === null ? null : createHash('sha256').update(`${orgId}\n${normalized.platform}\n${normalized.id}`).digest('hex');
}

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

const zStateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const OAUTH_ATTEMPT_SECONDS = 600;

// The errors the meeting_platform_oauth_* definers raise, as domain errors (the same codes as the calendar's pair, which the app already words).
function oauthError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'OAUTH_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Người xem không kết nối được nền tảng họp');
    case 'OAUTH_TOO_MANY':
      throw new DomainError('OAUTH_TOO_MANY', 429, 'Bạn đã mở quá nhiều lượt kết nối chưa hoàn tất, hãy thử lại sau ít phút');
    case 'OAUTH_STATE_INVALID':
      throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
    case 'OAUTH_STATE_USED':
      throw new DomainError('OAUTH_STATE_USED', 409, 'Lượt kết nối này đã được dùng, hãy bắt đầu lại');
    case 'OAUTH_STATE_EXPIRED':
      throw new DomainError('OAUTH_STATE_EXPIRED', 409, 'Lượt kết nối đã hết hạn, hãy bắt đầu lại');
    default:
      throw error;
  }
}

// Starts a connect: only the hash of the state and the PKCE verifier reach the database (the state itself is the browser's). The attempt is the member's own and single use.
export const meetingPlatformOAuthBegin = defineCommand({
  name: 'kernel.meeting_platform.oauth_begin',
  input: z.strictObject({ provider: zMeetingPlatformConnectProvider, stateHash: zStateHash, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ id: string }>`
      SELECT ludy_kernel.meeting_platform_oauth_begin(${MEETING_PLATFORM_OAUTH_NAME[input.provider]}, ${input.stateHash}, ${input.codeVerifier}, ${OAUTH_ATTEMPT_SECONDS}::integer) AS id`
      .execute(ctx.trx)
      .catch(oauthError);
    const attemptId = rows[0]?.id;
    if (!attemptId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the attempt and provider only: never the hash or the verifier.
    ctx.audit({ attempt_id: attemptId, provider: input.provider });
    return { attemptId, expiresAt: new Date(ctx.now.getTime() + OAUTH_ATTEMPT_SECONDS * 1000).toISOString() };
  },
});

// Uses the attempt up before the code is exchanged, so a code and state work once even if the exchange fails.
export const meetingPlatformOAuthConsume = defineCommand({
  name: 'kernel.meeting_platform.oauth_consume',
  input: z.strictObject({ provider: zMeetingPlatformConnectProvider, stateHash: zStateHash }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ code_verifier: string | null }>`
      SELECT code_verifier FROM ludy_kernel.meeting_platform_oauth_consume(${MEETING_PLATFORM_OAUTH_NAME[input.provider]}, ${input.stateHash})`
      .execute(ctx.trx)
      .catch(oauthError);
    if (rows.length !== 1) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    ctx.audit({ provider: input.provider });
    return { codeVerifier: rows[0]?.code_verifier ?? null };
  },
});

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
      .selectFrom('ludy_kernel.meeting_platform_connection')
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
        .updateTable('ludy_kernel.meeting_platform_connection')
        .set({ display_name: input.displayName, scopes: input.scopes, expires_at: input.expiresAt, status: 'active', status_reason: null, last_synced_at: null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
      id = existing.id;
    } else {
      const row = await ctx.trx
        .insertInto('ludy_kernel.meeting_platform_connection')
        .values({ org_id: ctx.orgId, user_id: userId, provider: input.provider, external_account: input.externalAccount, display_name: input.displayName, scopes: input.scopes, expires_at: input.expiresAt, status: 'active', status_reason: null, connected_at: ctx.now, updated_at: ctx.now })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    }
    await sql`SELECT ludy_kernel.meeting_platform_credential_put(${id}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
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
      .selectFrom('ludy_kernel.meeting_platform_connection')
      .select(['provider', 'user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.user_id !== userId) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy kết nối này');
    // An import in flight holds bytes in staging and a meeting being made: it finishes or fails first, so a disconnect never strands them.
    const busy = await ctx.trx
      .selectFrom('ludy_kernel.meeting_platform_recording')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('status', 'in', ['importing', 'staged', 'claimed'])
      .limit(1)
      .executeTakeFirst();
    if (busy) throw new DomainError('MEETING_PLATFORM_BUSY', 409, 'Đang nhập một bản ghi từ kết nối này, hãy thử lại sau khi nhập xong');
    // The tokens first, then the row: its foreign keys delete the recordings it listed.
    await sql`SELECT ludy_kernel.meeting_platform_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(platformError);
    await ctx.trx.deleteFrom('ludy_kernel.meeting_platform_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
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
      .updateTable('ludy_kernel.meeting_platform_connection')
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
    await sql`SELECT ludy_kernel.meeting_platform_recording_dismiss(${input.recordingId}::uuid)`.execute(ctx.trx).catch(platformError);
    ctx.audit({ recording_id: input.recordingId });
    return { recordingId: input.recordingId, dismissed: true as const };
  },
});

// The member picked the recording's file in Google Picker (#3174, ADR-0025 amendment): the Drive file id is kept on their own row, nothing else of the pick. A recording that needs no pick, is not the member's, or
// is past the point of importing is not found. The id is checked by the worker's import job against the id Meet gave, so a wrong id fails the import (`pick_mismatch`), never reads another file.
export const meetingPlatformRecordingPick = defineCommand({
  name: 'kernel.meeting_platform.recording.pick',
  input: zMeetingPlatformRecordingPick,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    // A person picks, in their own browser: never an agent acting for one.
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới chọn được tệp ghi hình');
    await sql`SELECT ludy_kernel.meeting_platform_recording_pick(${input.recordingId}::uuid, ${input.fileId}::text)`.execute(ctx.trx).catch(platformError);
    // The id of the recording only: a Drive file id names a file in a member's Drive, and an audit row never holds one.
    ctx.audit({ recording_id: input.recordingId });
    return { recordingId: input.recordingId, picked: true as const };
  },
});

// The member's request takes the bytes the worker staged: the row must be theirs and staged; it becomes claimed and the staging key comes back for the sealing (the same route as an upload).
export const meetingPlatformImportClaim = defineCommand({
  name: 'kernel.meeting_platform.import.claim',
  // The meeting the request is for: the definer refuses a recording that was begun for another meeting before anything moves.
  input: z.strictObject({ recordingId: zId, meetingId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input): Promise<{ stagingKey: string; meetingId: string; sizeBytes: number | null }> => {
    requireUser(ctx);
    const { rows } = await sql<{ staging_key: string; meeting_id: string; size_bytes: string | number | null }>`
      SELECT staging_key, meeting_id, size_bytes FROM ludy_kernel.meeting_platform_recording_claim(${input.recordingId}::uuid, ${input.meetingId}::uuid)`
      .execute(ctx.trx)
      .catch(platformError);
    const row = rows[0];
    if (!row) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the recording only: never the staging key.
    ctx.audit({ recording_id: input.recordingId, meeting_id: input.meetingId });
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
    await sql`SELECT ludy_kernel.meeting_platform_recording_claim_failed(${input.recordingId}::uuid, ${input.code})`.execute(ctx.trx).catch(platformError);
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
      SELECT key_id, envelope, provider, external_account FROM ludy_kernel.meeting_platform_credential_get(${input.connectionId}::uuid)`
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
      SELECT org_id, connection_id, provider FROM ludy_kernel.meeting_platform_sync_due(${input.afterOrg}::uuid, ${input.afterId}::uuid, ${input.limit}::int)`
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
      SELECT ludy_kernel.meeting_platform_recording_replace(${input.connectionId}::uuid, ${JSON.stringify(input.rows)}::jsonb) AS count`
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
    await sql`SELECT ludy_kernel.meeting_platform_sync_failed(${input.connectionId}::uuid, ${input.code}, ${input.expired})`.execute(ctx.trx).catch(platformError);
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
      FROM ludy_kernel.meeting_platform_import_open(${input.limit}::integer)`
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
    const { rows } = await sql<{ n: number }>`SELECT ludy_kernel.meeting_platform_import_staged(${input.recordingId}::uuid, ${input.stagingKey}) AS n`.execute(ctx.trx).catch(platformError);
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
    const { rows } = await sql<{ n: number }>`SELECT ludy_kernel.meeting_platform_import_failed(${input.recordingId}::uuid, ${input.code}, ${input.stagingKey}) AS n`.execute(ctx.trx).catch(platformError);
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
    const { rows } = await sql<{ holds: 'importing' | 'staged' | 'claimed' | 'none' }>`SELECT ludy_kernel.meeting_platform_import_holds(${input.recordingId}::uuid, ${input.stagingKey}) AS holds`.execute(ctx.trx).catch(platformError);
    return rows[0]?.holds ?? 'none';
  },
});

// The Drive file id the member picked for a recording that is importing under exactly this staging key, for the job that compares it with the id Meet gave; null when none was picked or the row moved on.
export const meetingPlatformImportPick = defineQuery({
  name: 'kernel.meeting_platform.import_pick',
  input: z.strictObject({ recordingId: zId, stagingKey: zStagingKey }),
  access: 'system',
  handler: async (ctx, input): Promise<string | null> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ picked: string | null }>`SELECT ludy_kernel.meeting_platform_import_pick(${input.recordingId}::uuid, ${input.stagingKey}) AS picked`.execute(ctx.trx).catch(platformError);
    return rows[0]?.picked ?? null;
  },
});

// Expiry across every org (the context's org only hosts the audit row): old suggestions go, staged bytes nobody claimed, stalled claims and downloads fail. Returns the staging keys whose bytes the
// job must delete.
// Not called by the worker, which runs the definer directly on its own login (as the conversation and campaign sweeps do): this command is the audited, system-only seam of the same definer, kept so that its
// expiry rules are tested through the runtime (meeting-platform.db.test.ts) and so that a later job may call it without a new grant.
export const meetingPlatformSweep = defineCommand({
  name: 'kernel.meeting_platform.sweep',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx): Promise<{ keys: string[] }> => {
    requireSystem(ctx.actor);
    const { rows } = await sql<{ staging_key: string }>`SELECT staging_key FROM ludy_kernel.meeting_platform_recording_sweep()`.execute(ctx.trx).catch(platformError);
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
      .selectFrom('ludy_kernel.meeting_platform_connection')
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

// How big a platform video file this deployment can take the audio out of (C2a, #3306), or null when it cannot (crove-media is not configured). Set once at start by the kernel; every recording the member lists
// carries it, so the app offers "Nhập" for a video-only recording only when the import can work. The module's import command checks the on/off fact with its own copy.
let videoImportMaxBytes: number | null = null;
export function setMeetingPlatformVideoImport(maxBytes: number | null): void {
  videoImportMaxBytes = maxBytes;
}

// Finds the Ludy meeting a suggested recording is already recorded as (#4123 Step 3, #4537), by the member's own calendar event (ADR-0055 3.4). A platform recording carries no join address, no meeting key and no
// calendar event of its own (only the platform's id, a title, a start and a length), so the event is found by time: the member's events overlapping the recording within the B1 15-minute window. Exactly one
function tallyUniqueCandidates(
  candidates: ReadonlyArray<{ recording_id: string; meeting_id: string }>,
): { matched: Map<string, string>; resolved: Set<string> } {
  const counts = new Map<string, { first: string; count: number }>();
  for (const cand of candidates) {
    const entry = counts.get(cand.recording_id);
    if (entry === undefined) counts.set(cand.recording_id, { first: cand.meeting_id, count: 1 });
    else entry.count += 1;
  }
  const matched = new Map<string, string>();
  const resolved = new Set<string>();
  for (const [recId, entry] of counts) {
    resolved.add(recId);
    if (entry.count === 1) matched.set(recId, entry.first);
  }
  return { matched, resolved };
}

// Matches each suggested recording to an existing visible meeting in the member's org (#4123, #4537, #4572).
// Precedence:
//   1. Capture session `meeting_key` on an open or ended capture of a visible meeting whose window overlaps `meetingOverlapWindow` (so members without a connected calendar also see "already recorded", while recurring calls stay scoped to the matching occurrence).
//   2. Member's own calendar event (`calendar_agenda`) overlapping strictly one event within 15 minutes -> linked `calendar_agenda.meeting_id` OR
//   3. One visible meeting overlapping that calendar event and no other.
// Runs in the caller's transaction so PostgreSQL RLS (`meeting_read` and `capture_session_match_keys`) enforces org scope, role and reader visibility; zero or two-plus visible candidates return no match so hidden or ambiguous meetings are never exposed.
async function matchedMeetingsForSuggestions(
  ctx: QueryContext,
  userId: string,
  rows: ReadonlyArray<{ id: string; status: string; started_at: Date; length_seconds: number | null; meeting_key: string | null }>,
): Promise<ReadonlyMap<string, string>> {
  const suggested = rows.filter((r) => r.status === 'suggested');
  if (suggested.length === 0 || !ctx.installed('meetings')) return new Map();
  if ((await offAppsOf(ctx.trx, ctx.orgId)).includes('meetings')) return new Map();

  const today = vietnamToday();
  const slack = sql`(${AGENDA_OVERLAP_MINUTES}::int * interval '1 minute')`;
  // The meeting's own span, as the B1 rule reads it: its start to its end (or its start plus its length).
  const meetingEnd = sql`GREATEST(m.started_at, COALESCE(m.ended_at, m.started_at + (GREATEST(COALESCE(m.length_seconds, 0), 0) * interval '1 second')))`;

  const matched = new Map<string, string>();
  const keyResolved = new Set<string>();

  const keyed = suggested.filter((r) => r.meeting_key !== null);
  if (keyed.length > 0) {
    const uniqueKeys = Array.from(new Set(keyed.map((r) => r.meeting_key as string)));
    const keyIndexByHex = new Map(uniqueKeys.map((k, idx) => [k, idx + 1]));
    const keyedRecIds: string[] = [];
    const keyedKeyIndices: number[] = [];
    const keyedWinStarts: string[] = [];
    const keyedWinEnds: string[] = [];
    for (const r of keyed) {
      const window = meetingOverlapWindow({ startedAt: r.started_at, lengthSeconds: r.length_seconds });
      keyedRecIds.push(r.id);
      keyedKeyIndices.push(keyIndexByHex.get(r.meeting_key as string) as number);
      keyedWinStarts.push(window.windowStart.toISOString());
      keyedWinEnds.push(window.windowEnd.toISOString());
    }
    const { rows: keyCandidates } = await sql<{ recording_id: string; meeting_id: string }>`
      WITH key_cand AS (
        SELECT k.key_index, k.meeting_id
        FROM ludy_meetings.capture_session_match_keys(${uniqueKeys}::text[]) k
      ),
      rec AS (
        SELECT * FROM ROWS FROM (
          pg_catalog.unnest(${keyedRecIds}::uuid[]),
          pg_catalog.unnest(${keyedKeyIndices}::int[]),
          pg_catalog.unnest(${keyedWinStarts}::timestamptz[]),
          pg_catalog.unnest(${keyedWinEnds}::timestamptz[])
        ) AS r(id, key_index, win_start, win_end)
      )
      SELECT rec.id AS recording_id, cand.meeting_id
      FROM rec
      CROSS JOIN LATERAL (
        SELECT m.id AS meeting_id
        FROM key_cand kc
        JOIN ludy_meetings.meeting m
          ON m.org_id = ${ctx.orgId}::uuid
         AND m.id = kc.meeting_id
        WHERE kc.key_index = rec.key_index
          AND m.started_at IS NOT NULL
          AND (m.text_retention_date IS NULL OR m.text_retention_date > ${today}::date)
          AND m.started_at < rec.win_end
          AND ${meetingEnd} > rec.win_start
          AND NOT EXISTS (
            SELECT 1 FROM ludy_kernel.meeting_platform_recording pr
            WHERE pr.org_id = m.org_id AND pr.meeting_id = m.id AND pr.status IN ('failed', 'dismissed')
          )
        ORDER BY m.started_at DESC
        LIMIT 2
      ) AS cand`.execute(ctx.trx);

    const keyTallied = tallyUniqueCandidates(keyCandidates);
    for (const recId of keyTallied.resolved) keyResolved.add(recId);
    for (const [recId, meetingId] of keyTallied.matched) matched.set(recId, meetingId);
  }

  const remaining = suggested.filter((r) => !keyResolved.has(r.id));
  if (remaining.length === 0) return matched;

  const recIds: string[] = [];
  const winStarts: string[] = [];
  const winEnds: string[] = [];
  for (const r of remaining) {
    const window = meetingOverlapWindow({ startedAt: r.started_at, lengthSeconds: r.length_seconds });
    recIds.push(r.id);
    winStarts.push(window.windowStart.toISOString());
    winEnds.push(window.windowEnd.toISOString());
  }

  const { rows: candidates } = await sql<{ recording_id: string; meeting_id: string }>`
    WITH rec AS (
      SELECT * FROM ROWS FROM (
        pg_catalog.unnest(${recIds}::uuid[]),
        pg_catalog.unnest(${winStarts}::timestamptz[]),
        pg_catalog.unnest(${winEnds}::timestamptz[])
      ) AS r(id, win_start, win_end)
    ),
    ev AS (
      SELECT rec.id AS recording_id, rec.win_start, rec.win_end,
             (pg_catalog.array_agg(a.id))[1] AS event_id,
             (pg_catalog.array_agg(a.meeting_id))[1] AS linked_meeting_id
      FROM rec
      CROSS JOIN LATERAL (
        SELECT e.id, e.meeting_id
        FROM ludy_meetings.calendar_agenda e
        WHERE e.org_id = ${ctx.orgId}::uuid AND e.user_id = ${userId}::uuid
          AND e.starts_at < rec.win_end AND e.ends_at > rec.win_start
        LIMIT 2
      ) a
      GROUP BY rec.id, rec.win_start, rec.win_end
      HAVING pg_catalog.count(*) = 1
    )
    SELECT ev.recording_id, cand.meeting_id
    FROM ev
    CROSS JOIN LATERAL (
      SELECT m.id AS meeting_id
      FROM ludy_meetings.meeting m
      WHERE m.org_id = ${ctx.orgId}::uuid
        AND m.started_at IS NOT NULL
        AND (m.text_retention_date IS NULL OR m.text_retention_date > ${today}::date)
        AND NOT EXISTS (
          SELECT 1 FROM ludy_kernel.meeting_platform_recording pr
          WHERE pr.org_id = m.org_id AND pr.meeting_id = m.id AND pr.status IN ('failed', 'dismissed')
        )
        AND (
          m.id = ev.linked_meeting_id
          OR (
            ev.linked_meeting_id IS NULL
            AND m.started_at < ev.win_end
            AND ${meetingEnd} > ev.win_start
            AND EXISTS (
              SELECT 1 FROM ludy_meetings.calendar_agenda x
              WHERE x.org_id = m.org_id AND x.user_id = ${userId}::uuid AND x.id = ev.event_id
                AND x.starts_at < ${meetingEnd} + ${slack} AND x.ends_at > m.started_at - ${slack}
            )
            AND NOT EXISTS (
              SELECT 1 FROM ludy_meetings.calendar_agenda y
              WHERE y.org_id = m.org_id AND y.user_id = ${userId}::uuid AND y.id <> ev.event_id
                AND y.starts_at < ${meetingEnd} + ${slack} AND y.ends_at > m.started_at - ${slack}
            )
          )
        )
      ORDER BY m.started_at DESC
      LIMIT 2
    ) AS cand`.execute(ctx.trx);

  const calendarTallied = tallyUniqueCandidates(candidates);
  for (const [recId, meetingId] of calendarTallied.matched) matched.set(recId, meetingId);
  return matched;
}

// The member's own recordings, newest first: the suggestions and what became of the ones they imported. A dismissed one is hidden. With `recordingId` it is that one row (or none), found by its id
// whatever its age, so a caller that needs one row does not depend on it being among the newest RECORDINGS_LIMIT; that lookup neither sorts nor limits (one row at most).
export const meetingPlatformRecordings = defineQuery({
  name: 'kernel.meeting_platform.recordings',
  input: z.strictObject({ recordingId: zId.optional() }),
  access: OWN,
  handler: async (ctx, input): Promise<MeetingPlatformRecordingView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được bản ghi từ nền tảng họp');
    const only = input.recordingId;
    let query = ctx.trx
      .selectFrom('ludy_kernel.meeting_platform_recording as r')
      .innerJoin('ludy_kernel.meeting_platform_connection as c', (join) => join.onRef('c.org_id', '=', 'r.org_id').onRef('c.id', '=', 'r.connection_id'))
      .select(['r.id', 'r.connection_id', 'c.provider', 'r.title', 'r.started_at', 'r.length_seconds', 'r.size_bytes', 'r.has_audio', 'r.has_video', 'r.has_transcript', 'r.status', 'r.meeting_id', 'r.error_code', 'r.meeting_key'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.user_id', '=', ctx.actor.userId)
      .where('r.status', '<>', 'dismissed');
    // One row by its id: the primary key finds it, so there is nothing to order or to cap. The list is newest first and capped.
    query = only === undefined ? query.orderBy('r.started_at', 'desc').orderBy('r.id', 'desc').limit(RECORDINGS_LIMIT) : query.where('r.id', '=', only);
    const rows = await query.execute();
    const matchedByRecordingId = only === undefined ? await matchedMeetingsForSuggestions(ctx, ctx.actor.userId, rows) : new Map<string, string>();
    return rows.map((r) => {
      const matchedId = matchedByRecordingId.get(r.id);
      return {
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
        videoImportMaxBytes,
        status: r.status,
        meetingId: r.meeting_id,
        errorCode: r.error_code,
        matchedMeeting: matchedId === undefined ? null : { meetingId: matchedId },
      };
    });
  },
});

export const meetingPlatformCommands = [
  meetingPlatformOAuthBegin,
  meetingPlatformOAuthConsume,
  meetingPlatformConnect,
  meetingPlatformDisconnect,
  meetingPlatformRefresh,
  meetingPlatformRecordingDismiss,
  meetingPlatformRecordingPick,
  meetingPlatformImportClaim,
  meetingPlatformImportClaimFailed,
  meetingPlatformRecordingReplace,
  meetingPlatformSyncFailed,
  meetingPlatformImportStaged,
  meetingPlatformImportFailed,
  meetingPlatformSweep,
];
export const meetingPlatformQueries = [meetingPlatformConnections, meetingPlatformRecordings, meetingPlatformCredential, meetingPlatformImportHolds, meetingPlatformSyncDue, meetingPlatformImportOpen, meetingPlatformImportPick];
