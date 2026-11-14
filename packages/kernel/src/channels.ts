// Channel connections (ADR-0025, Social plan step S2, issue #232): an org connects a page or account once, and the
// kernel keeps its sealed tokens for every module that publishes to it or reads from it.
//
// Who may do what:
// - Owners and admins connect and disconnect (R2, permission kernel.connection.bind in plan §7.4 terms); every member
//   lists the org's connections. No query ever returns a credential.
// - The command never sees a token: the caller (the OAuth callback, the sandbox route) seals it with the credential
//   broker for the binding (org, provider, account) and passes the envelope, which the credential_put definer
//   stores. Connecting an account that is already connected replaces its tokens on the same connection row.
// - Only the worker reads a credential back (kernel.channel.credential, system actor, credential_get granted to
//   crove_worker alone), and only while the member who connected the account is still in the org.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { isAdProviderId, isAdWriteProviderId, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// One character is enough: X's id is x (#784).
const zProvider = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The sealed envelope as base64; its size is checked again by the column (64 KiB).
const zEnvelope = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(90_000);

// Errors the credential_* definers raise, as domain errors. Anything else goes through the runtime's mapping.
function credentialError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'CHANNEL_NOT_FOUND':
      throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    case 'CHANNEL_NOT_ACTIVE':
      throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    case 'CHANNEL_OWNER_LEFT':
      throw new DomainError('CHANNEL_OWNER_LEFT', 409, 'Người đã kết nối kênh này không còn quyền quản lý kênh trong tổ chức, hãy kết nối lại');
    case 'CREDENTIAL_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới quản lý được kênh kết nối');
    default:
      throw error;
  }
}

// A fresh hook for a Telegram connection's webhook (#3132): 32 random bytes, base64url, 43 characters.
const newChatHook = (): string => randomBytes(32).toString('base64url');

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới kết nối được kênh');
  return ctx.actor.userId;
}

export const zChannelConnect = z.strictObject({
  provider: zProvider,
  externalAccountId: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().min(1).max(200)).max(100),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
  // Keyed hash of the platform user who granted the connection (CV6 #2305, CV2 #2307: Meta's data-deletion callback).
  grantedByHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export type ChannelConnectInput = z.infer<typeof zChannelConnect>;

export const channelConnect = defineCommand({
  name: 'kernel.channel.connect',
  input: zChannelConnect,
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const values = {
      display_name: input.displayName,
      scopes: input.scopes,
      expires_at: input.expiresAt,
      status: 'active' as const,
      status_reason: null,
      connected_by: userId,
      // A reconnect is a takeover: the Meta user who granted the connection before no longer holds it, so Meta's data deletion callback
      // (CV6, #2305) does not reach this connection's conversations through them. The connector that knows the new grantor sets it again
      // (Ads connections keep their hash on the ad account table instead).
      granted_by_hash: isAdProviderId(input.provider) ? null : (input.grantedByHash ?? null),
      // A reconnect is read again at once for what the webhook missed (CV5b, #2329).
      history_synced_at: null,
      // ... also a YouTube channel, whose due time is its own interval (#3134): a reconnect after a refused token must not wait out the hold.
      history_next_at: null,
      updated_at: ctx.now,
    };
    // Two connects of one account at once serialize here, so the second finds the first's row and reconnects
    // instead of failing on the unique index (no row exists yet for FOR UPDATE to lock).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.channel:${ctx.orgId}:${input.provider}:${input.externalAccountId}`}, 0))`.execute(ctx.trx);
    // Reconnecting a live connection of the same account keeps its row; a revoked one is history and stays. The
    // member who reconnects becomes its connector, so the credential lives on their membership from now on.
    const existing = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'chat_state'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', input.provider)
      .where('external_account_id', '=', input.externalAccountId)
      .where('status', '<>', 'revoked')
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      await ctx.trx.updateTable('crove_kernel.channel_connection').set(values).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      id = existing.id;
      // A Telegram connection that answers chats gets a new hook, and so a new secret, with its new token (#3132): the webhook is set again by a job,
      // with the token that was just sealed, and the old hook stays valid until then. A connection being turned off stays as it is.
      if (input.provider === 'telegram' && (existing.chat_state === 'on' || existing.chat_state === 'enabling')) {
        await ctx.trx
          .updateTable('crove_kernel.channel_connection')
          .set({ chat_hook_next: newChatHook(), chat_state: 'enabling', chat_error: null, chat_changed_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .execute();
        await ctx.emit(TELEGRAM_CHAT_QUEUED, { connectionId: id, action: 'enable' });
      }
    } else {
      const row = await ctx.trx
        .insertInto('crove_kernel.channel_connection')
        .values({ org_id: ctx.orgId, provider: input.provider, external_account_id: input.externalAccountId, ...values })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          // A WhatsApp number is connected by a pasted token, which proves no more than that its holder may call the number, so one org holds it at a time:
          // a second org would otherwise receive every message the first org's customers send (the intake finds each connection of the account).
          const pg = error as { code?: string; constraint?: string } | null;
          if (pg?.code === '23505' && pg.constraint === 'channel_connection_whatsapp_account_uq') {
            throw new DomainError('CHANNEL_ACCOUNT_TAKEN', 409, 'Số WhatsApp này đang được một tổ chức khác kết nối. Hãy ngắt kết nối ở đó trước khi kết nối lại ở đây');
          }
          throw error;
        });
      id = row.id;
    }
    await sql`SELECT crove_kernel.credential_put(${id}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    ctx.audit({ connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    await ctx.emit('kernel.channel.connected', { connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    return { connectionId: id, reconnected: Boolean(existing) };
  },
});

export const channelDisconnect = defineCommand({
  name: 'kernel.channel.disconnect',
  // `reason` is for a command that closes a connection for a reason the screen has words for (Ads closes a reading connection whose
  // token can also change campaigns when running ads is switched off, #2294): it becomes the status reason. The API never passes it.
  input: z.strictObject({ connectionId: zId, reason: z.literal('spend_scopes').optional() }),
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider', 'chat_state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    // A Telegram connection that still receives chats is turned off first (#3132): turning off is what removes the webhook at Telegram, which
    // needs the token this disconnect forgets.
    // One that is no longer active (its token was refused) cannot be asked, so it may go: the webhook is then removed in BotFather.
    if (row.status === 'active' && row.chat_state !== 'off') {
      throw new DomainError('CHAT_IS_ON', 409, 'Hãy tắt nhận tin nhắn của khách trước khi ngắt kết nối kênh này, để Ludy gỡ webhook ở Telegram');
    }
    if (row.status !== 'revoked') {
      await ctx.trx
        .updateTable('crove_kernel.channel_connection')
        // A Telegram connection that answered chats gives its hook up too (#3132): the webhook at Telegram is left to be removed in BotFather, and a
        // notice that still comes in on it finds no connection and is dropped.
        .set({ status: 'revoked', status_reason: input.reason ?? 'disconnected', updated_at: ctx.now, chat_state: 'off', chat_hook: null, chat_hook_next: null, chat_bot_id: null, chat_business: '[]' })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
      await ctx.emit('kernel.channel.disconnected', { connection_id: input.connectionId, provider: row.provider });
    }
    // Forget the tokens even when the row was already revoked: a disconnect leaves nothing to decrypt.
    await sql`SELECT crove_kernel.credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(credentialError);
    return { connectionId: input.connectionId, status: 'revoked' as const };
  },
});

// A provider refused a connection's token (expired or revoked on the platform): the connection becomes 'expired' until
// an owner or admin reconnects it. Run by provider jobs (system actor) in their own transaction, through ctx.run.
export const channelMarkExpired = defineCommand({
  name: 'kernel.channel.mark_expired',
  // ifVersion: the connection's updated_at the caller saw; a connection changed since (reconnected with a new token)
  // is left alone.
  input: z.strictObject({ connectionId: zId, reason: z.string().min(1).max(200), ifVersion: z.iso.datetime({ offset: true }).optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.status !== 'active') return { connectionId: input.connectionId, status: row.status };
    // Compared at millisecond precision, the precision the caller read it at.
    if (input.ifVersion && Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) return { connectionId: input.connectionId, status: row.status };
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ status: 'expired', status_reason: input.reason, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    await ctx.emit('kernel.channel.expired', { connection_id: input.connectionId, provider: row.provider, reason: input.reason });
    return { connectionId: input.connectionId, status: 'expired' as const };
  },
});

// A platform's own data deletion request (Meta's callback for Ads, plan docs/plan/ads.md section 9, #2219): the connection is
// closed as a disconnect closes it, and its tokens are forgotten, but by the worker as the system, not by a member. Run once
// per connection; one already closed only has its credential dropped again.
export const channelRevokeByPlatform = defineCommand({
  name: 'kernel.channel.revoke_by_platform',
  // `reason` 'account_erased' is for the erasure of an ad account whose write grant is another person's than the requester's: the platform's deletion request
  // is not that person's, so the connection is closed under its own reason and the revoke at the platform is held for it (ads W2-1, #2296).
  input: z.strictObject({ connectionId: zId, reason: z.literal('account_erased').optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.status !== 'revoked') {
      await ctx.trx
        .updateTable('crove_kernel.channel_connection')
        // The ad account's name and the permissions its token held go with the token: what a revoked connection keeps is its
        // platform id and the time it closed.
        .set({ status: 'revoked', status_reason: input.reason ?? 'platform_deletion', display_name: 'Deleted', scopes: [], updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
      await ctx.emit('kernel.channel.disconnected', { connection_id: input.connectionId, provider: row.provider });
    }
    await sql`SELECT crove_kernel.credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(credentialError);
    return { connectionId: input.connectionId, status: 'revoked' as const };
  },
});

// An ads write connection whose connector is no longer an owner or admin of the org (removed, demoted or disabled), closed by the revoke sweep as the
// system (ads W2-1, #2296): its token can no longer be used (credential_get refuses it), so it would sit in Ludy for ever while the person's permission at
// the platform stays valid. Closing it drops the credential, which the ads module's trigger on that table copies into the sealed holding of the revoke, in
// the same transaction; the revoke runs from there. Only ads write connections are closed this way, and only while the connector is gone, as the
// database says under the row's lock (channel_connector_gone): a connector who is still an owner or admin leaves the connection as it is.
export const channelCloseOrphan = defineCommand({
  name: 'kernel.channel.close_orphan',
  input: z.strictObject({ connectionId: zId }),
  // R2 and external like the member's own disconnect: closing it feeds the revoke sweep, which calls the platform.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (!isAdWriteProviderId(row.provider)) throw new DomainError('CHANNEL_NOT_ORPHAN', 409, 'Chỉ kết nối chạy quảng cáo mới đóng được theo cách này');
    if (row.status === 'revoked') return { connectionId: input.connectionId, closed: false };
    const { rows } = await sql<{ gone: boolean }>`SELECT crove_kernel.channel_connector_gone(${input.connectionId}::uuid) AS gone`.execute(ctx.trx);
    if (rows[0]?.gone !== true) return { connectionId: input.connectionId, closed: false };
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ status: 'revoked', status_reason: 'member_left', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    await ctx.emit('kernel.channel.disconnected', { connection_id: input.connectionId, provider: row.provider });
    await sql`SELECT crove_kernel.credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(credentialError);
    ctx.audit({ connection_id: input.connectionId, provider: row.provider });
    return { connectionId: input.connectionId, closed: true };
  },
});

// Connecting through a provider's OAuth dialog (Social plan §3.5, S6.1): the API hashes a fresh state and starts an
// attempt for the signed-in owner or admin; the browser comes back with the state, and the same member finishes the
// attempt once, which hands out its PKCE verifier. Both run in the oauth_state_* definers, which bind the attempt to
// the org and user in context; the commands never see the state itself, only its hash.
const zStateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// 10 minutes, the longest a user takes in a provider's dialog.
const OAUTH_ATTEMPT_SECONDS = 600;

function oauthError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'OAUTH_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
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

export const channelOAuthBegin = defineCommand({
  name: 'kernel.channel.oauth_begin',
  input: z.strictObject({ provider: zProvider, stateHash: zStateHash, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ id: string }>`
      SELECT crove_kernel.oauth_state_create(${input.provider}, ${input.stateHash}, ${input.codeVerifier}, ${OAUTH_ATTEMPT_SECONDS}::integer) AS id`
      .execute(ctx.trx)
      .catch(oauthError);
    const attemptId = rows[0]?.id;
    if (!attemptId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the attempt and provider only: never the hash or the verifier.
    ctx.audit({ attempt_id: attemptId, provider: input.provider });
    return { attemptId, expiresAt: new Date(ctx.now.getTime() + OAUTH_ATTEMPT_SECONDS * 1000).toISOString() };
  },
});

export const channelOAuthConsume = defineCommand({
  name: 'kernel.channel.oauth_consume',
  input: z.strictObject({ provider: zProvider, stateHash: zStateHash }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ code_verifier: string | null }>`
      SELECT code_verifier FROM crove_kernel.oauth_state_consume(${input.provider}, ${input.stateHash})`
      .execute(ctx.trx)
      .catch(oauthError);
    if (rows.length !== 1) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    ctx.audit({ provider: input.provider });
    return { codeVerifier: rows[0]?.code_verifier ?? null };
  },
});

// A provider job renewed a connection's tokens (Social plan S6.4): the new credential is sealed in and the expiry
// moves, in one transaction, so a rotated single-use refresh token is never lost to a half-done write. ifVersion is the
// connection's updated_at the refresh started from; a connection changed since (reconnected, disconnected, expired) is
// left alone, and the answer says so: the caller then drops the new tokens.
export const channelRefresh = defineCommand({
  name: 'kernel.channel.refresh',
  input: z.strictObject({
    connectionId: zId,
    ifVersion: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    // Compared at millisecond precision, the precision the caller read it at.
    if (row.status !== 'active' || Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) {
      return { connectionId: input.connectionId, refreshed: false };
    }
    await sql`SELECT crove_kernel.credential_put(${input.connectionId}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ expires_at: input.expiresAt, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider });
    return { connectionId: input.connectionId, refreshed: true };
  },
});

// Stores a credential sealed again with the current key after a rotation (#776), for the worker's reseal sweep. The
// envelope is replaced only while it is still the one the worker read (its key id and the sha256 of its bytes): a
// reconnect or refresh in between sealed a newer one, even with the old key on a replica not yet restarted, and the
// answer says nothing was changed. The connection's version is left alone,
// so a refresh about to compare it is not turned away.
export const channelReseal = defineCommand({
  name: 'kernel.channel.reseal',
  input: z.strictObject({ connectionId: zId, fromKeyId: zKeyId, fromEnvelopeSha256: z.string().regex(/^[0-9a-f]{64}$/), credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status !== 'active') return { connectionId: input.connectionId, resealed: false };
    const { rows } = await sql<{ key_id: string; envelope_sha256: string }>`
      SELECT key_id, encode(sha256(envelope), 'hex') AS envelope_sha256 FROM crove_kernel.credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(credentialError);
    const stored = rows[0];
    if (!stored || stored.key_id !== input.fromKeyId || stored.envelope_sha256 !== input.fromEnvelopeSha256 || input.fromKeyId === input.credential.keyId) {
      return { connectionId: input.connectionId, resealed: false };
    }
    await sql`SELECT crove_kernel.credential_put(${input.connectionId}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    // Key ids only: they name a key without revealing it.
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, from_key_id: input.fromKeyId, key_id: input.credential.keyId });
    return { connectionId: input.connectionId, resealed: true };
  },
});

export interface ChannelConnectionView {
  id: string;
  provider: string;
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked' | 'error';
  statusReason: string | null;
  connectedBy: string;
  expiresAt: string | null;
  connectedAt: string;
  // Whether the connection also answers customers' private chats (Telegram, #3132): off, enabling, on or disabling; and the code of the last
  // attempt that failed (only while off), for the screen to word.
  chatState: 'off' | 'enabling' | 'on' | 'disabling';
  chatError: string | null;
  // When the state last changed: a switch standing for minutes was lost, and the screen offers it again.
  chatChangedAt: string | null;
  // The business accounts a Telegram bot is connected to (#3191), for the screen to name: `ref` is a short fingerprint a member of the org may name to
  // allow or stop an account, never the platform's id.
  chatBusiness: Array<{ ref: string; name: string | null; username: string | null; enabled: boolean; canReply: boolean; approved: boolean }>;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

// The org's connections, live ones first. Never a credential: the columns are listed, not selected with *.
export const channelsList = defineQuery({
  name: 'kernel.channel.list',
  input: z.object({ includeRevoked: z.boolean().optional(), includeEmail: z.boolean().optional(), includeMessaging: z.boolean().optional() }),
  access: ALL,
  handler: async (ctx: QueryContext, input): Promise<ChannelConnectionView[]> => {
    let q = ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'external_account_id', 'display_name', 'scopes', 'status', 'status_reason', 'connected_by', 'expires_at', 'connected_at', 'chat_state', 'chat_error', 'chat_changed_at', 'chat_business'])
      .where('org_id', '=', ctx.orgId)
      // Social and messaging channels only: a bank feed's connection (provider bank_..., ADR-0039) is the finance
      // module's, listed with its accounts by finance.bank_feed.accounts. Left out before the limit, so they never
      // crowd a channel out.
      .where('provider', 'not like', 'bank\\_%')
      // Nor an ad account's (provider ..._ads, ADR-0040): the ads module lists it with its settings.
      .where('provider', 'not like', '%\\_ads')
      // Nor an e-invoice provider's (provider einvoice_..., ADR-0044): its external account id holds the seller's tax code and the legal entity, which only the
      // finance module's list shows, to the members of that entity.
      .where('provider', 'not like', 'einvoice\\_%')
      // Nor a marketplace seller account's (provider marketplace_..., ADR-0045 point 7): its external account id names the legal entity, which only the finance module's list shows.
      .where('provider', 'not like', 'marketplace\\_%')
      // Nor the Inbox's email connection (#2439): it is made by the first customer mail and is not a place to publish. The screen that limits which
      // channels a member may read (includeEmail) lists it, since reading email is one of those channels.
      .where('provider', input.includeEmail ? 'is not' : '<>', input.includeEmail ? null : 'email')
      // Nor a messaging-only channel's (WhatsApp, #3131), which never publishes: the composer and every Social picker would offer a channel nothing can post to.
      // The Channels screen and the Inbox ask for it (includeMessaging), and a member's channel access list (includeEmail) has it with the rest.
      .where('provider', input.includeEmail || input.includeMessaging ? 'is not' : '<>', input.includeEmail || input.includeMessaging ? null : 'whatsapp');
    if (!input.includeRevoked) q = q.where('status', '<>', 'revoked');
    const rows = await q.orderBy(sql`status = 'revoked'`).orderBy('connected_at', 'desc').limit(500).execute();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalAccountId: r.external_account_id,
      displayName: r.display_name,
      scopes: r.scopes,
      status: r.status,
      statusReason: r.status_reason,
      connectedBy: r.connected_by,
      expiresAt: iso(r.expires_at),
      connectedAt: iso(r.connected_at) ?? '',
      chatState: r.chat_state as ChannelConnectionView['chatState'],
      chatError: r.chat_error,
      chatChangedAt: iso(r.chat_changed_at),
      chatBusiness: parseBusinessAccounts(r.chat_business).map((a) => ({ ref: businessRef(a.id), name: a.name, username: a.username, enabled: a.enabled, canReply: a.canReply, approved: a.approved })),
    }));
  },
});

export interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  // base64
  envelope: string;
}

// The sealed credential of an active connection, for provider jobs in the worker. The caller opens it with the
// credential broker for the binding returned here and drops the plaintext after the call.
export const channelCredential = defineQuery({
  name: 'kernel.channel.credential',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SealedChannelCredential> => {
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account_id: string }>`
      SELECT key_id, envelope, provider, external_account_id FROM crove_kernel.credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(credentialError);
    const row = rows[0];
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    return { provider: row.provider, externalAccountId: row.external_account_id, keyId: row.key_id, envelope: row.envelope.toString('base64') };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Telegram bot chats (#3132, plan docs/plan/conversations-channels.md section 4.2). A Telegram connection already holds the bot token (to
// post to a channel); an owner or admin may also turn on "answer chats", which points the bot's webhook at this deployment. The platform call
// is the worker's (it alone opens the token); these commands say what to do and record what came of it. The hook (the connection's address in
// the webhook path) is a capability: it is never in an audit row, an event or a command result, only in the one query the worker reads.
//
// The state machine (channel_connection.chat_state): off, enabling (chat_hook_next is being set at Telegram by a job), on (chat_hook is live),
// disabling (a job is deleting the webhook). A new hook (a first turn on, or a reconnect with a new token) is put in chat_hook_next and replaces
// chat_hook only once the worker has set it at Telegram, so the old webhook stays valid meanwhile and no message in between is lost. A job that was
// lost leaves a switch standing: after CHAT_RETRY_AFTER_MS the same command asks again, so the screen never stays stuck.
// ---------------------------------------------------------------------------------------------------------------------

export const TELEGRAM_CHAT_QUEUED = 'kernel.channel.chat_queued';
const zChatAction = z.enum(['enable', 'disable']);
const zChatCode = z.string().regex(/^[A-Za-z0-9_.:-]{1,60}$/);
const zHookFp = z.string().regex(/^[0-9a-f]{16}$/);
// A switch whose job has not recorded its answer after this long is asked again.
const CHAT_RETRY_AFTER_MS = 2 * 60_000;
// A short fingerprint of a hook: lets a job say which hook it set without the hook travelling back in a command's input.
const hookFp = (hook: string): string => createHash('sha256').update(hook).digest('hex').slice(0, 16);
type ChatState = ChannelConnectionView['chatState'];

// Turns the chats of a Telegram connection on or off. On puts a fresh hook in chat_hook_next (so turning off and on again rotates the address)
// and hands the worker the setWebhook call; off keeps the hooks until the worker has deleted the webhook. A connection that is no longer active
// (its token was refused) cannot be asked of Telegram: turning it off is done here, and the webhook is left to be removed in BotFather.
// R2 and external: the call it leads to reaches Telegram.
export const channelTelegramChatSet = defineCommand({
  name: 'kernel.channel.telegram_chat_set',
  input: z.strictObject({ connectionId: zId, on: z.boolean() }),
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ chatState: ChatState }> => {
    requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'chat_state', 'chat_changed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.provider !== 'telegram') throw new DomainError('CHAT_NOT_SUPPORTED', 409, 'Kênh này không nhận tin nhắn riêng của khách');
    const state = row.chat_state as ChatState;
    const stale = row.chat_changed_at === null || ctx.now.getTime() - row.chat_changed_at.getTime() > CHAT_RETRY_AFTER_MS;
    const update = (set: Record<string, unknown>) =>
      ctx.trx
        .updateTable('crove_kernel.channel_connection')
        .set({ ...set, chat_changed_at: ctx.now } as never)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
    if (input.on) {
      if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
      if (state === 'on' || (state === 'enabling' && !stale)) return { chatState: state };
      if (state === 'disabling' && !stale) throw new DomainError('CHAT_BUSY', 409, 'Đang tắt nhận tin nhắn, hãy thử lại sau ít giây');
      await update({ chat_hook_next: newChatHook(), chat_state: 'enabling', chat_error: null, chat_bot_id: null });
      await ctx.emit(TELEGRAM_CHAT_QUEUED, { connectionId: input.connectionId, action: 'enable' });
      ctx.audit({ connection_id: input.connectionId, action: 'enable' });
      return { chatState: 'enabling' };
    }
    if (state === 'off') {
      // Nothing is set at Telegram: only a failed attempt's message is cleared.
      await ctx.trx.updateTable('crove_kernel.channel_connection').set({ chat_error: null }).where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
      return { chatState: 'off' };
    }
    if (row.status !== 'active') {
      await update({ chat_hook: null, chat_hook_next: null, chat_state: 'off', chat_bot_id: null, chat_error: null });
      ctx.audit({ connection_id: input.connectionId, action: 'disable', local: true });
      return { chatState: 'off' };
    }
    if (state === 'disabling' && !stale) return { chatState: state };
    await update({ chat_state: 'disabling' });
    await ctx.emit(TELEGRAM_CHAT_QUEUED, { connectionId: input.connectionId, action: 'disable' });
    ctx.audit({ connection_id: input.connectionId, action: 'disable' });
    return { chatState: 'disabling' };
  },
});

export interface TelegramChatWork {
  action: 'call' | 'none';
  // The hook to set (an enable), for the worker to build the webhook address and its secret from. In memory only: never logged or stored.
  hook?: string;
  // Its fingerprint, which the worker hands back to say which hook it set.
  hookFp?: string;
  // The bots the org's other connections already answer chats with: the same bot cannot have two webhooks.
  takenBotIds?: string[];
}

// What the worker's job is to do for a connection. An enable sets the hook being set (chat_hook_next); when the live hook changed while the worker
// was at it (`usedHookFp` is the one it set), it is to set the live one again. A disable needs no hook. `none` when the connection moved on since
// the event (turned off again, disconnected, inactive). A query, so its answer (the hook) is never an audit row.
export const channelTelegramChatWork = defineQuery({
  name: 'kernel.channel.telegram_chat_work',
  input: z.strictObject({ connectionId: zId, action: zChatAction, usedHookFp: zHookFp.optional() }),
  access: 'system',
  handler: async (ctx, input): Promise<TelegramChatWork> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'chat_state', 'chat_hook', 'chat_hook_next'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || row.provider !== 'telegram' || row.status !== 'active') return { action: 'none' };
    if (input.action === 'disable') return row.chat_state === 'disabling' ? { action: 'call' } : { action: 'none' };
    const hook =
      row.chat_state === 'enabling' && row.chat_hook_next
        ? row.chat_hook_next
        : row.chat_state === 'on' && row.chat_hook && input.usedHookFp && hookFp(row.chat_hook) !== input.usedHookFp
          ? row.chat_hook
          : null;
    if (!hook) return { action: 'none' };
    const others = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select('chat_bot_id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '<>', input.connectionId)
      .where('provider', '=', 'telegram')
      .where('status', '=', 'active')
      .where('chat_state', 'in', ['enabling', 'on'])
      .where('chat_bot_id', 'is not', null)
      .execute();
    return { action: 'call', hook, hookFp: hookFp(hook), takenBotIds: others.flatMap((o) => (o.chat_bot_id ? [o.chat_bot_id] : [])) };
  },
});

// What came of the worker's call. An enable that worked makes the hook being set the live one (and remembers the bot); one that failed leaves the
// old live hook (a reconnect that did not take) or none, with the code for the screen to word. A disable ends with no hook, failed or not: nothing
// is received any more either way. Applies only while the connection is still in the state the call was for, and an enable only if the hook it set is
// still the one wanted (`hookFp`): `hookChanged` tells the job to look again. The code is code-shaped: what Telegram says in words never lands in a row.
export const channelTelegramChatRecord = defineCommand({
  name: 'kernel.channel.telegram_chat_record',
  input: z.strictObject({ connectionId: zId, action: zChatAction, outcome: z.enum(['done', 'failed']), botId: z.string().regex(/^[0-9]{3,20}$/).optional(), code: zChatCode.optional(), hookFp: zHookFp.optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ applied: boolean; hookChanged: boolean; chatState: ChatState | null }> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['chat_state', 'chat_hook', 'chat_hook_next'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    const state = (row?.chat_state ?? null) as ChatState | null;
    const skipped = (hookChanged = false) => ({ applied: false, hookChanged, chatState: state });
    if (!row) return skipped();
    const set = (values: Record<string, unknown>) =>
      ctx.trx
        .updateTable('crove_kernel.channel_connection')
        .set({ ...values, chat_changed_at: ctx.now } as never)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
    const failure = input.outcome === 'failed' ? (input.code ?? 'FAILED') : null;
    if (input.action === 'disable') {
      if (state !== 'disabling') return skipped();
      await set({ chat_hook: null, chat_hook_next: null, chat_state: 'off', chat_bot_id: null, chat_error: failure });
      ctx.audit({ connection_id: input.connectionId, action: 'disable', outcome: input.outcome, ...(failure ? { code: failure } : {}) });
      return { applied: true, hookChanged: false, chatState: 'off' };
    }
    if (state === 'enabling' && row.chat_hook_next) {
      if (input.hookFp && hookFp(row.chat_hook_next) !== input.hookFp) return skipped(true);
      if (input.outcome === 'done') {
        await set({ chat_hook: row.chat_hook_next, chat_hook_next: null, chat_state: 'on', chat_error: null, chat_bot_id: input.botId ?? null });
      } else if (row.chat_hook) {
        await set({ chat_hook_next: null, chat_state: 'on', chat_error: failure });
      } else {
        await set({ chat_hook: null, chat_hook_next: null, chat_state: 'off', chat_bot_id: null, chat_error: failure });
      }
      ctx.audit({ connection_id: input.connectionId, action: 'enable', outcome: input.outcome, ...(failure ? { code: failure } : {}) });
      return { applied: true, hookChanged: false, chatState: input.outcome === 'done' || row.chat_hook ? 'on' : 'off' };
    }
    // The worker set a hook that is no longer the live one (a newer enable finished first): it is to set the live one again.
    return skipped(state === 'on' && row.chat_hook !== null && input.hookFp !== undefined && hookFp(row.chat_hook) !== input.hookFp);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Telegram Business mode (#3191, plan section 4.2). An owner with Telegram Premium connects the bot to their own account in Telegram's settings; Telegram
// then sends `business_connection` updates (connected, edited, disconnected), and the bot receives that account's customer chats. The connections a
// bot has are kept on the connection as a small list, written only from such an update the webhook route verified; the core stores a business message
// only while the list says its business connection is enabled.
// ---------------------------------------------------------------------------------------------------------------------

const zBusinessAccount = z.strictObject({
  // Telegram's business connection id: printable ASCII, no space.
  id: z.string().regex(/^[!-~]{1,100}$/),
  // The business account's own Telegram user id.
  userId: z.string().regex(/^-?\d{1,20}$/),
  name: z.string().max(200).nullable(),
  // The account's @username, unique on Telegram: what lets an owner tell their own account from a stranger who wears the same name.
  username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),
  canReply: z.boolean(),
  enabled: z.boolean(),
  // An owner or admin of the org allowed this account's chats in. Telegram lets any Premium user connect a bot that has Business Mode on, so an account
  // Telegram reports is not yet one the org chose: nothing of it is stored until a person allows it, and only a person can.
  approved: z.boolean(),
});
export type TelegramBusinessAccount = z.infer<typeof zBusinessAccount>;
// What Telegram tells of an account; whether the org allowed it is the org's, never Telegram's.
const zBusinessReport = zBusinessAccount.omit({ approved: true });
// A short fingerprint of an account's id for the screen to name it by (the id itself stays on the server).
export const businessRef = (id: string): string => createHash('sha256').update(`telegram.business:${id}`).digest('hex').slice(0, 12);
export const TELEGRAM_BUSINESS_ACCOUNTS_MAX = 10;

// The accounts a connection holds. An entry that is not a whole account is dropped, never half read.
export function parseBusinessAccounts(value: unknown): TelegramBusinessAccount[] {
  const list = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const parsed = zBusinessAccount.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Records what Telegram said about one business connection: a new account is added, a known one updated (also to disabled, which stops its messages
// coming in). Only for a Telegram connection that is active and has chats on or being switched: anything else was sent to a hook that no longer
// counts. At most TELEGRAM_BUSINESS_ACCOUNTS_MAX accounts: a new one when the list is full replaces the oldest disabled one, else is refused. The
// audit row holds the state and the right, never an id or a name.
export const channelTelegramBusinessRecord = defineCommand({
  name: 'kernel.channel.telegram_business_record',
  input: z.strictObject({ connectionId: zId, account: zBusinessReport }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ applied: boolean }> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'chat_state', 'chat_business'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.provider !== 'telegram' || row.status !== 'active' || row.chat_state === 'off') return { applied: false };
    const accounts = parseBusinessAccounts(row.chat_business);
    const at = accounts.findIndex((a) => a.id === input.account.id);
    // A new account is not allowed yet; one already known keeps what the org decided about it.
    const account: TelegramBusinessAccount = { ...input.account, approved: at >= 0 ? (accounts[at] as TelegramBusinessAccount).approved : false };
    let next: TelegramBusinessAccount[];
    if (at >= 0) {
      next = accounts.map((a, i) => (i === at ? account : a));
    } else if (accounts.length < TELEGRAM_BUSINESS_ACCOUNTS_MAX) {
      next = [...accounts, account];
    } else {
      // Full: a stranger's account must not keep the org's own out. The oldest account nobody allowed goes first, then the oldest allowed one that is off.
      const gone = accounts.findIndex((a) => !a.approved) >= 0 ? accounts.findIndex((a) => !a.approved) : accounts.findIndex((a) => !a.enabled);
      if (gone < 0) return { applied: false };
      next = [...accounts.filter((_, i) => i !== gone), account];
    }
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ chat_business: JSON.stringify(next) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    ctx.audit({ connection_id: input.connectionId, action: 'business', enabled: account.enabled, can_reply: account.canReply, approved: account.approved });
    return { applied: true };
  },
});

// An owner or admin allows an account's chats in, or stops them (#3191). Telegram lets any Premium user connect a bot that has Business Mode on, and
// the bot's name is public, so the accounts Telegram reports are not the org's own until a person says so: a new one stores nothing until then, and
// stopping one ends its messages at once. The account is named by `ref`, a fingerprint the screen was given; the audit row holds the choice and the ref.
export const channelTelegramBusinessAllow = defineCommand({
  name: 'kernel.channel.telegram_business_allow',
  input: z.strictObject({ connectionId: zId, ref: z.string().regex(/^[0-9a-f]{12}$/), allow: z.boolean() }),
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ approved: boolean }> => {
    requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'chat_business'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.provider !== 'telegram') throw new DomainError('CHAT_NOT_SUPPORTED', 409, 'Kênh này không nhận tin nhắn riêng của khách');
    const accounts = parseBusinessAccounts(row.chat_business);
    const at = accounts.findIndex((a) => businessRef(a.id) === input.ref);
    if (at < 0) throw new DomainError('BUSINESS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản Telegram Business này');
    const next = accounts.map((a, i) => (i === at ? { ...a, approved: input.allow } : a));
    await ctx.trx.updateTable('crove_kernel.channel_connection').set({ chat_business: JSON.stringify(next) }).where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
    ctx.audit({ connection_id: input.connectionId, action: input.allow ? 'business_allow' : 'business_stop', ref: input.ref });
    return { approved: input.allow };
  },
});

// Whether a business message that named a connection Ludy may not know is to be looked up at Telegram (#3224): true only for an active Telegram connection
// whose chats are not off and whose list holds no account with that id. A listed one, whether enabled, off or not yet allowed, is known: what Telegram told
// is kept, and a person's choice is never replaced by a second look. Names nothing of the account.
export const channelTelegramBusinessKnown = defineQuery({
  name: 'kernel.channel.telegram_business_known',
  input: z.strictObject({ connectionId: zId, id: z.string().regex(/^[!-~]{1,100}$/) }),
  access: 'system',
  handler: async (ctx, input): Promise<{ lookup: boolean }> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'chat_state', 'chat_business'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || row.provider !== 'telegram' || row.status !== 'active' || row.chat_state === 'off') return { lookup: false };
    return { lookup: !parseBusinessAccounts(row.chat_business).some((a) => a.id === input.id) };
  },
});

export const channelCommands = [channelConnect, channelDisconnect, channelMarkExpired, channelRevokeByPlatform, channelCloseOrphan, channelOAuthBegin, channelOAuthConsume, channelRefresh, channelReseal, channelTelegramChatSet, channelTelegramChatRecord, channelTelegramBusinessRecord, channelTelegramBusinessAllow];
export const channelQueries = [channelsList, channelCredential, channelTelegramChatWork, channelTelegramBusinessKnown];
