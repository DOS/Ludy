// SPDX-License-Identifier: AGPL-3.0-only
// A meeting platform connection's access token, renewed before it expires, safely when the provider rotates the refresh token (issue #3878; the gap of the C1 core, #3173). Zoom's access tokens last about an
// hour and every refresh gives a NEW refresh token and kills the old one, so two uses of one refresh token, or a new token that is not stored, would leave the connection holding a dead grant.
//
// One command does it, `kernel.meeting_platform.credential_refresh` (system actor, worker only), in ONE transaction:
//   1. it takes the lock of the connection's row (SELECT ... FOR UPDATE), so a second worker waits here and never uses the same refresh token;
//   2. it opens the sealed credential UNDER the lock and looks at its expiry again: a worker that waited finds a token another one already renewed, and does nothing (`fresh`);
//   3. it asks the provider (one call, a few seconds at most: the database ends a transaction that waits longer, `idle_in_transaction_session_timeout`);
//   4. it seals the new access token, the rotated refresh token and the new expiry (the deployment's credential key, bound as at connect) and stores them in the same transaction, which commits the new
//      pair and releases the lock together.
// A provider that refuses the grant (`invalid_grant`, a revoked or expired grant, the app removed) expires the connection through the existing definer in the same transaction: the member connects again.
// A transient failure (a network error, a 429 or 5xx) changes nothing and is tried again at the next use. A token is never logged, audited or returned: the answer names an outcome and nothing else.
//
// What a crash can still do: after the provider rotated the token and before the commit, the transaction rolls back, the stored (old) refresh token is dead, and the next refresh is refused: the connection
// is then expired and its member reconnects. That window is one provider call wide, and nothing is posted or downloaded with a token nobody has (the same window `channel-refresh.ts` documents).
//
// The listing sweep and the download job call `freshCredential` before they use a token: a token that expires within REFRESH_HORIZON_MS is renewed first. A provider without a `refresh` (the sandbox) and a
// credential that carries no expiry are left alone.
import { sql } from 'kysely';
import { z } from 'zod';
import { MeetingPlatformError, type MeetingPlatformAdapter, type MeetingPlatformCredential } from '@ludy/channel';
import { meetingPlatformBinding, type MeetingPlatformProvider } from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CredentialBroker, type Runtime, type SystemActor } from '@ludy/kernel-runtime';

const ACTOR: SystemActor = { type: 'system', component: 'meetings.credential' };
// A token that expires within this long is renewed before it is used (the sweep comes every few minutes, a Zoom token lives an hour).
export const REFRESH_HORIZON_MS = 10 * 60_000;
// The one provider call inside the transaction. The database ends a transaction that sits idle longer than 10 seconds, so this stays well under it.
export const REFRESH_CALL_TIMEOUT_MS = 7_000;
// How long a second worker waits for the row while the first one is at the provider (the statement timeout of the worker's connections is 15 seconds).
const LOCK_WAIT = '12s';

// The provider call, with a hard limit that does not depend on the adapter honouring its signal: after `ms` the call is abandoned (and its signal aborted) with `platform_unavailable`. Without it an adapter that
// ignored the signal could keep the transaction idle past the database's limit, which would end the connection and release the lock while the provider call was still on its way.
export function withinTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MeetingPlatformError('platform_unavailable'));
    }, ms);
  });
  return Promise.race([run(controller.signal), limit]).finally(() => clearTimeout(timer));
}
// What a refreshing adapter that returns no expiry is taken to mean: a token that lives this long (shorter than any real one, so it is renewed early rather than late).
export const DEFAULT_TOKEN_LIFE_MS = 30 * 60_000;

export type RefreshOutcome =
  // The new pair is stored.
  | { outcome: 'refreshed'; expiresAt: string }
  // The credential was not due when the lock was taken (another worker renewed it while this one waited).
  | { outcome: 'fresh' }
  // The provider refused the grant: the connection is now expired.
  | { outcome: 'expired' }
  // The provider could not be reached or answered badly: nothing changed.
  | { outcome: 'unavailable' }
  // Nothing to do: the connection is not active (or its member left), the provider has no refresh, or the credential holds no refresh token.
  | { outcome: 'not_active' | 'unsupported' | 'no_refresh_token' };

interface Stored {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: Date | undefined;
}

// A sealed credential's text: the access token, and when it has them the refresh token and the expiry (an ISO instant).
export function parseCredential(secret: string): Stored {
  let parsed: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  try {
    parsed = JSON.parse(secret) as typeof parsed;
  } catch {
    // The message of a JSON error quotes a piece of the text, which here is a secret: say only that it is not JSON (the job reads a SyntaxError as an expired connection).
    throw new SyntaxError('the credential is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new SyntaxError('the credential is not JSON');
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') throw new MeetingPlatformError('connection_expired');
  const expires = typeof parsed.expiresAt === 'string' ? new Date(parsed.expiresAt) : undefined;
  return {
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === 'string' && parsed.refreshToken !== '' ? { refreshToken: parsed.refreshToken } : {}),
    ...(expires && !Number.isNaN(expires.getTime()) ? { expiresAt: expires } : {}),
  };
}
const textOf = (credential: Stored): string =>
  JSON.stringify({ accessToken: credential.accessToken, ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}), ...(credential.expiresAt ? { expiresAt: credential.expiresAt.toISOString() } : {}) });
const dueAt = (credential: Stored, now: number) => credential.expiresAt !== undefined && credential.expiresAt.getTime() - now < REFRESH_HORIZON_MS;

interface SealedRow {
  key_id: string;
  envelope: Buffer;
  provider: string;
  external_account: string;
}

const NOT_ACTIVE = /MEETING_PLATFORM_(NOT_ACTIVE|OWNER_LEFT|NOT_FOUND)/;

export interface RefreshCommandDeps {
  broker: CredentialBroker;
  adapters: Readonly<Partial<Record<string, MeetingPlatformAdapter>>>;
  // Tests: the clock and the provider call's timeout.
  now?: (() => Date) | undefined;
  callTimeoutMs?: number | undefined;
}

// The command. It closes over the deployment's broker and adapters, so only the runtime that has them (the worker's) registers it.
export function meetingPlatformRefreshCommand(deps: RefreshCommandDeps) {
  const now = deps.now ?? (() => new Date());
  return defineCommand({
    name: 'kernel.meeting_platform.credential_refresh',
    input: z.strictObject({ connectionId: z.uuid() }),
    // It calls the provider (for a token, nothing else): external, so R2; no agent runs it, only the system.
    risk: 'R2',
    sideEffect: 'external',
    access: 'system',
    target: (input) => ({ type: 'kernel.meeting_platform_connection', id: input.connectionId }),
    handler: async (ctx, input): Promise<RefreshOutcome> => {
      if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
      // 1. The lock. A second refresh of this connection waits here (up to LOCAL lock_timeout) until the first one commits, and then finds the token renewed.
      await sql`SELECT pg_catalog.set_config('lock_timeout', ${LOCK_WAIT}, true)`.execute(ctx.trx);
      const row = await ctx.trx
        .selectFrom('ludy_kernel.meeting_platform_connection')
        .select(['status', 'provider'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy kết nối này');
      if (row.status !== 'active') return { outcome: 'not_active' };
      const adapter = deps.adapters[row.provider];
      if (!adapter?.refresh) return { outcome: 'unsupported' };
      const renew = adapter.refresh.bind(adapter);
      // 2. The credential, under the lock. The definer refuses a connection whose member left or that is no longer active.
      // In a savepoint: a definer that raises would otherwise leave the transaction aborted, and the command could not answer `not_active` and commit.
      let sealed: SealedRow | undefined;
      await sql`SAVEPOINT meeting_platform_credential_read`.execute(ctx.trx);
      try {
        sealed = (
          await sql<SealedRow>`SELECT key_id, envelope, provider, external_account FROM ludy_kernel.meeting_platform_credential_get(${input.connectionId}::uuid)`.execute(ctx.trx)
        ).rows[0];
        await sql`RELEASE SAVEPOINT meeting_platform_credential_read`.execute(ctx.trx);
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT meeting_platform_credential_read`.execute(ctx.trx);
        if (NOT_ACTIVE.test(String((error as { message?: unknown })?.message ?? ''))) return { outcome: 'not_active' };
        throw error;
      }
      if (!sealed) return { outcome: 'not_active' };
      const binding = meetingPlatformBinding(ctx.orgId, sealed.provider as MeetingPlatformProvider, sealed.external_account);
      const credential = parseCredential(deps.broker.open({ keyId: sealed.key_id, envelope: sealed.envelope }, binding));
      if (!dueAt(credential, now().getTime())) return { outcome: 'fresh' };
      if (!credential.refreshToken) return { outcome: 'no_refresh_token' };
      // 3. The provider. A MeetingPlatformError or anything else is a failure to renew, not a refusal: nothing is changed, and the transaction commits no write.
      let renewed: Awaited<ReturnType<NonNullable<MeetingPlatformAdapter['refresh']>>> | { refused: true };
      try {
        renewed = await withinTimeout((signal) => renew({ accessToken: credential.accessToken, refreshToken: credential.refreshToken, ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}) }, signal), deps.callTimeoutMs ?? REFRESH_CALL_TIMEOUT_MS);
      } catch (error) {
        // An adapter that says the grant is gone by throwing `connection_expired` is read as a refusal, like the value `{ refused: true }`.
        if (error instanceof MeetingPlatformError && error.code === 'connection_expired') renewed = { refused: true };
        else {
          console.warn(`[meeting-platform-refresh] ${input.connectionId.slice(0, 8)} not renewed`, error instanceof MeetingPlatformError ? error.code : 'error');
          ctx.audit({ connection_id: input.connectionId, provider: row.provider, outcome: 'unavailable' });
          return { outcome: 'unavailable' };
        }
      }
      // The provider will not renew the grant: the connection expires in this transaction, and the member connects again.
      if ('refused' in renewed) {
        await sql`SELECT ludy_kernel.meeting_platform_sync_failed(${input.connectionId}::uuid, ${'connection_expired'}, ${true})`.execute(ctx.trx);
        ctx.audit({ connection_id: input.connectionId, provider: row.provider, refreshed: false, expired: true, outcome: 'expired' });
        return { outcome: 'expired' };
      }
      // An answer with no access token is no renewal (and nothing is stored: a blank token would make the next open fail).
      if (!renewed.accessToken) {
        console.warn(`[meeting-platform-refresh] ${input.connectionId.slice(0, 8)} not renewed`, 'no_access_token');
        ctx.audit({ connection_id: input.connectionId, provider: row.provider, outcome: 'unavailable' });
        return { outcome: 'unavailable' };
      }
      // 4. The new pair, sealed as at connect, stored in the same transaction as the call that rotated it. An answer with no expiry is stored with a short assumed life, so renewals go on.
      const next: Stored = {
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken || credential.refreshToken,
        expiresAt: renewed.expiresAt ?? new Date(now().getTime() + DEFAULT_TOKEN_LIFE_MS),
      };
      const resealed = deps.broker.seal(textOf(next), binding);
      await sql`SELECT ludy_kernel.meeting_platform_credential_put(${input.connectionId}::uuid, ${resealed.keyId}, decode(${resealed.envelope.toString('base64')}, 'base64'))`.execute(ctx.trx);
      await ctx.trx
        .updateTable('ludy_kernel.meeting_platform_connection')
        .set({ expires_at: next.expiresAt ?? null, updated_at: now() })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
      // The audit row names the connection and the provider: never a token, the account or the envelope.
      ctx.audit({ connection_id: input.connectionId, provider: row.provider, refreshed: true, outcome: 'refreshed' });
      return { outcome: 'refreshed', expiresAt: (next.expiresAt as Date).toISOString() };
    },
  });
}

export interface FreshCredentialDeps {
  runtime: Pick<Runtime, 'query' | 'execute'>;
  broker: CredentialBroker;
  now?: (() => Date) | undefined;
}

// The connection's credential, opened by the worker (ADR-0025: only a job opens a token).
export async function openCredential(deps: Pick<FreshCredentialDeps, 'runtime' | 'broker'>, orgId: string, connectionId: string): Promise<MeetingPlatformCredential> {
  const sealed = await deps.runtime.query<{ keyId: string; envelope: string; provider: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId }, { actor: ACTOR, orgId });
  const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(orgId, sealed.provider as MeetingPlatformProvider, sealed.externalAccount));
  return parseCredential(secret);
}

// The credential to use now: opened, and when it expires within REFRESH_HORIZON_MS and its provider can refresh, renewed first (the command above) and opened again. A connection the provider no longer
// honours is `connection_expired`; an unreachable provider is `platform_unavailable`, unless the token in hand still has time.
export async function freshCredential(deps: FreshCredentialDeps, orgId: string, connectionId: string, adapter: MeetingPlatformAdapter): Promise<MeetingPlatformCredential> {
  const now = (deps.now ?? (() => new Date()))();
  const credential = await openCredential(deps, orgId, connectionId);
  if (!adapter.refresh || !dueAt(credential, now.getTime())) return credential;
  const result = await deps.runtime.execute<RefreshOutcome>('kernel.meeting_platform.credential_refresh', { connectionId }, { actor: ACTOR, orgId });
  switch (result.outcome) {
    case 'expired':
      throw new MeetingPlatformError('connection_expired');
    case 'refreshed':
    case 'fresh':
      // Another worker (or this one a moment ago) stored a new pair: use it.
      return openCredential(deps, orgId, connectionId);
    case 'unavailable':
      if (credential.expiresAt && credential.expiresAt.getTime() > now.getTime()) return credential;
      throw new MeetingPlatformError('platform_unavailable');
    default:
      return credential;
  }
}
