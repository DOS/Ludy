// SPDX-License-Identifier: AGPL-3.0-only
// The revoke at the platform of the token of a closed ads connection, as a flow (ADR-0043 point 4, issue #2296, W2-1; the invariants are in
// invariant/ads-token-seal.db.test.ts): every way a connection that runs ads is closed leaves a held copy and an obligation; the sweep opens the copy,
// calls the revoker, records the outcome and wipes the copy; a failure is tried again on the policy's schedule and a platform that never answers ends
// with the person told to remove the app by hand; the connection of a member who left is closed by the sweep and revoked; and nothing of the token
// reaches an audit row, an event, an idempotency key or a job. The revoker here is the sandbox's (no network) or a stand-in that fails as a platform does.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdPlatformError, adRevokers, sandboxWriteLogin, type AdRevoker } from '@crove/ad-platform';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { AdsWriteState } from '@crove/kernel-contract';
import { CredentialVault, mintContextToken, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { adsCommands, adsQueries } from '@crove/mod-ads';
import { runAdsRevoke, type AdsRevokeResult } from '../src/ads-revoke.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ACCOUNT = 'sbxads-0123456789abcdef';
const SYSTEM = { type: 'system' as const, component: 'test' };

const suite = ADMIN ? describe : describe.skip;

suite('the revoke at the platform of a closed ads connection token (#2296, W2-1)', () => {
  const dbName = `crove_test_adsrevoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  let vault: CredentialVault;
  let owner = '';
  let member = '';
  let orgId = '';
  let adAccountId = '';
  let readConnection = '';
  const secrets: string[] = [];

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);

  // The switch of running ads on, the way a proposal's effect turns it on: as a signed-in owner, in SQL (the database lets only that change it).
  async function switchOn() {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: owner, orgId, sessionId: null, aal: 'aal1', mfaAt: null })]);
      await c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [orgId]);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  // Another ad account read by a sandbox read connection (a platform account of its own), for a test that disconnects it.
  async function makeAccount(external: string) {
    const account = randomUUID();
    const connection = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Đọc', $4)`, [orgId, connection, external, owner]);
      await c.query(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Tài khoản khác', '2025-10-01')`, [orgId, account, connection, external]);
    });
    return { adAccountId: account, readConnection: connection };
  }

  // A write connection of an ad account, sealed as the API seals it, attached to the account when there is one (the switch is on). `by` is the
  // connecting member.
  async function connectWrite(by = owner, external = ACCOUNT, linked: string | null = external === ACCOUNT ? adAccountId : null) {
    const login = sandboxWriteLogin({ externalAccountId: external, currency: 'VND' });
    secrets.push(login.secret, (JSON.parse(login.secret) as { accessToken: string }).accessToken);
    const sealed = vault.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
    const done = await app.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: login.provider, externalAccountId: login.externalAccountId, displayName: login.displayName, scopes: [...login.scopes], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(by), orgId },
    );
    if (linked) await app.execute('ads.account.link_write', { connectionId: done.connectionId }, { actor: asUser(owner), orgId });
    return done.connectionId;
  }

  const obligation = async (connectionId: string) =>
    (
      await rows<{ id: string; state: string; kind: string; reason: string; attempts: number; how_done: string | null; give_up: string | null; last_error_kind: string | null; last_error_code: string | null; seals: string; credentials: string }>(
        `SELECT r.id, r.state, r.kind, r.reason, r.attempts, r.how_done, r.give_up, r.last_error_kind, r.last_error_code,
                (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id AND s.revoke_id = r.id) AS seals,
                (SELECT count(*)::text FROM crove_kernel.credential k WHERE k.org_id = r.org_id AND k.connection_id = r.connection_id) AS credentials
         FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1 AND r.connection_id = $2`,
        [orgId, connectionId],
      )
    )[0];
  const status = async (connectionId: string) => (await rows<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId]))[0];
  // Makes every pending obligation due at once (the policy's waits are minutes and hours; the database's clock is not moved).
  const dueNow = () => admin((c) => c.query(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() WHERE state = 'pending'`));

  const sandboxRevokers = adRevokers({ sandbox: true });
  const sweep = (revokers: Readonly<Record<string, AdRevoker>> = sandboxRevokers, broker: CredentialVault | undefined = vault): Promise<AdsRevokeResult> => runAdsRevoke({ runtime: worker, workerDb, broker, revokers });
  // A stand-in for the platform that answers with what a failure is: no network.
  const failing = (error: () => AdPlatformError): Readonly<Record<string, AdRevoker>> => ({
    sandboxwrite_ads: {
      revokeToken: async () => {
        throw error();
      },
    },
  });
  const settleAll = async () => {
    for (let i = 0; i < 3; i++) {
      await dueNow();
      await sweep();
    }
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    const runtimeFor = (url: string): { db: Db; runtime: Runtime } => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...adsQueries] }) };
    };
    const api = runtimeFor(appUrl);
    app = api.runtime;
    const w = runtimeFor(login('crove_worker', 'test-worker-pw'));
    worker = w.runtime;
    workerDb = w.db;
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    owner = await upsertIdentity(api.db, { issuer: 'ads-revoke', subject: 'owner', email: 'owner@ads-revoke.test', name: null });
    member = await upsertIdentity(api.db, { issuer: 'ads-revoke', subject: 'member', email: 'member@ads-revoke.test', name: null });
    orgId = (await createOrg(app, asUser(owner), 'Ads revoke')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, member]));
    // An ad account read by a sandbox read connection (as the RLS matrix seeds one), and the org's switches, off.
    adAccountId = randomUUID();
    readConnection = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Đọc', $4)`,
        [orgId, readConnection, ACCOUNT, owner],
      );
      await c.query(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Tài khoản thử', '2025-10-01')`, [
        orgId,
        adAccountId,
        readConnection,
        ACCOUNT,
      ]);
      await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1)', [orgId]);
    });
    await switchOn();
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('holds a copy and opens an obligation whichever way a connection that runs ads is closed, and a sweep revokes each from its copy and wipes it', async () => {
    type Path = [string, () => Promise<unknown>];
    const paths: Path[] = [
      // The owner turns running ads off for the org: every write connection closes.
      ['the org switch-off', () => app.execute('ads.write.disable', {}, { actor: asUser(owner), orgId })],
      // The owner withdraws one account's permission: its connection closes.
      ['an account withdrawn', () => app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId })],
      // A write connection made again replaces the one before it.
      ['a replaced connection', () => connectWrite()],
    ];
    for (const [name, run] of paths) {
      await switchOn();
      const closedId = await connectWrite();
      await run();
      expect(await obligation(closedId), name).toMatchObject({ state: 'pending', kind: 'write', reason: 'disconnected', attempts: 0, seals: '1', credentials: '0' });
      expect((await status(closedId))?.status, name).toBe('revoked');
      // The sweep revokes it from its copy (the sandbox has no platform behind it) and wipes the copy.
      await settleAll();
      expect(await obligation(closedId), name).toMatchObject({ state: 'done', how_done: 'sandbox', attempts: 1, seals: '0' });
    }
    // The generic door of the channel layer, which has no word of ads, is covered too: the hold is the database's, not a command's.
    await switchOn();
    const direct = await connectWrite();
    await app.execute('kernel.channel.disconnect', { connectionId: direct }, { actor: asUser(owner), orgId });
    expect(await obligation(direct)).toMatchObject({ state: 'pending', kind: 'write', seals: '1', credentials: '0' });
    // An account disconnected closes both its connections: the write one is held, revoked and wiped.
    const other = await makeAccount('sbxads-disconnect-me');
    const closing = await connectWrite(owner, 'sbxads-disconnect-me', other.adAccountId);
    await app.execute('ads.account.disconnect', { adAccountId: other.adAccountId }, { actor: asUser(owner), orgId });
    expect(await obligation(closing)).toMatchObject({ state: 'pending', kind: 'write', reason: 'disconnected', seals: '1', credentials: '0' });
    await settleAll();
    expect(await obligation(closing)).toMatchObject({ state: 'done', seals: '0' });
    expect(await obligation(direct)).toMatchObject({ state: 'done', seals: '0' });
  });

  it('records the try the way it happened and tells the screen: still being tried, then given up after ten tries, the copy wiped', async () => {
    await switchOn();
    const connectionId = await connectWrite();
    await app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId });
    // A platform that is down: each try fails and is counted, the copy stays, and the next try is later by the policy (a minute after the first).
    const down = failing(() => new AdPlatformError('transient', 'SERVER_BUSY'));
    await dueNow();
    expect((await sweep(down)).tried).toBeGreaterThanOrEqual(1);
    const first = await obligation(connectionId);
    expect(first).toMatchObject({ state: 'pending', attempts: 1, last_error_kind: 'transient', last_error_code: 'SERVER_BUSY', seals: '1' });
    const wait = Number((await rows<{ s: number }>(`SELECT extract(epoch FROM (next_attempt_at - now())) AS s FROM crove_ads.ad_token_revoke WHERE id = $1`, [first?.id]))[0]?.s);
    expect(wait).toBeGreaterThan(30);
    expect(wait).toBeLessThanOrEqual(61);
    // The screen says it: an owner sees the obligation as pending, with the count and the next time, and a member sees none of it.
    const pending = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes.find((r) => r.id === first?.id);
    expect(pending).toMatchObject({ state: 'pending', attempts: 1, giveUp: null, kind: 'write', accountName: 'Tài khoản thử', lastErrorKind: 'transient' });
    expect(pending?.nextAttemptAt).toEqual(expect.any(String));
    // A platform that keeps failing: nine tries keep the copy, the tenth ends it, and the screen says to remove the app by hand.
    for (let i = 2; i <= 9; i++) {
      await dueNow();
      await sweep(down);
      expect(await obligation(connectionId), `try ${i}`).toMatchObject({ state: 'pending', attempts: i, seals: '1' });
    }
    await dueNow();
    await sweep(down);
    expect(await obligation(connectionId)).toMatchObject({ state: 'gave_up', give_up: 'attempts', attempts: 10, seals: '0', last_error_code: 'SERVER_BUSY' });
    const gaveUp = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes.find((r) => r.id === first?.id);
    expect(gaveUp).toMatchObject({ state: 'gave_up', giveUp: 'attempts', attempts: 10, nextAttemptAt: null });
    // Nothing is tried again.
    expect(await sweep(down)).toMatchObject({ tried: 0 });
  });

  it('waits the platform’s own time when it is later than the backoff, counts a refused permission and a bad request as tries, and ends at once on a token it no longer accepts', async () => {
    await switchOn();
    const limited = await connectWrite();
    await app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId });
    const retryAt = new Date(Date.now() + 3 * 3_600_000);
    await dueNow();
    await sweep(failing(() => new AdPlatformError('rate_limited', 'TOO_MANY', retryAt)));
    const rate = await obligation(limited);
    expect(rate).toMatchObject({ state: 'pending', attempts: 1, last_error_kind: 'rate_limited', last_error_code: 'TOO_MANY', seals: '1' });
    const next = (await rows<{ at: Date }>('SELECT next_attempt_at AS at FROM crove_ads.ad_token_revoke WHERE id = $1', [rate?.id]))[0]?.at as Date;
    expect(next.getTime()).toBeGreaterThanOrEqual(retryAt.getTime() - 5_000);
    // A refused permission and a bad request are tries too: the screen words them differently, the copy stays until the limits.
    await dueNow();
    await sweep(failing(() => new AdPlatformError('permission', 'PERMISSION')));
    await dueNow();
    await sweep(failing(() => new AdPlatformError('bad_request', 'BAD')));
    expect(await obligation(limited)).toMatchObject({ state: 'pending', attempts: 3, last_error_kind: 'bad_request', seals: '1' });
    // A token the platform no longer accepts has nothing left to revoke: done, with how, and the copy wiped.
    await dueNow();
    await sweep(failing(() => new AdPlatformError('token_expired', 'EXPIRED')));
    expect(await obligation(limited)).toMatchObject({ state: 'done', how_done: 'already_invalid', attempts: 4, seals: '0' });
  });

  it('counts a try that could not even open the copy (no broker, no revoker for the provider) and still ends the copy at the limits', async () => {
    await switchOn();
    const connectionId = await connectWrite();
    await app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId });
    await dueNow();
    await sweep({});
    expect(await obligation(connectionId)).toMatchObject({ state: 'pending', attempts: 1, last_error_kind: 'unknown', last_error_code: 'NO_REVOKER', seals: '1' });
    await dueNow();
    await sweep(sandboxRevokers, undefined);
    expect(await obligation(connectionId)).toMatchObject({ state: 'pending', attempts: 2, last_error_code: 'NO_BROKER', seals: '1' });
    // The copy of a deployment whose key changed cannot be opened; that is a try that fails too, and the code says so without a word of the copy.
    const otherKey = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    await dueNow();
    await sweep(sandboxRevokers, otherKey);
    expect(await obligation(connectionId)).toMatchObject({ state: 'pending', attempts: 3, last_error_code: 'OPEN_FAILED', seals: '1' });
    // And a working sweep afterwards still revokes it (nothing was wiped by the failures).
    await settleAll();
    expect(await obligation(connectionId)).toMatchObject({ state: 'done', how_done: 'sandbox', seals: '0' });
  });

  it('closes the write connection of a member who left, then revokes and wipes it; a member who still manages the org keeps theirs', async () => {
    await switchOn();
    const mine = await connectWrite(owner, 'sbxads-owner-keeps-it');
    const theirs = await connectWrite(member, 'sbxads-member-leaves');
    // The member is removed from the org by the owner (a membership change needs the second factor).
    await app.execute('kernel.member.remove', { userId: member }, { actor: asMfa(owner), orgId });
    // The connection stays open and unusable until the sweep finds it: nothing wiped, nothing revoked yet.
    expect((await status(theirs))?.status).toBe('active');
    expect(await obligation(theirs)).toBeUndefined();
    const swept = await sweep();
    expect(swept.closed).toBeGreaterThanOrEqual(1);
    expect(await status(theirs)).toEqual({ status: 'revoked', status_reason: 'member_left' });
    // It was held, tried in the same sweep (the member's leaving did not stop the copy from being opened), and wiped by the revoke that worked.
    expect(await obligation(theirs)).toMatchObject({ state: 'done', kind: 'write', reason: 'member_left', how_done: 'sandbox', attempts: 1, seals: '0', credentials: '0' });
    // The owner's own connection was not touched.
    expect((await status(mine))?.status).toBe('active');
    expect(await obligation(mine)).toBeUndefined();
    // Run again: nothing more to close.
    expect((await sweep()).closed).toBe(0);
    // A system command refuses a connection that is not an ads write connection, and one whose connector is still in charge.
    await expect(worker.execute('kernel.channel.close_orphan', { connectionId: readConnection }, { actor: SYSTEM, orgId })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ORPHAN' });
    await expect(worker.execute('kernel.channel.close_orphan', { connectionId: mine }, { actor: SYSTEM, orgId })).resolves.toEqual({ connectionId: mine, closed: false });
    // And no user closes a connection this way.
    await expect(app.execute('kernel.channel.close_orphan', { connectionId: mine }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('shows the screen only to owners and admins, and nothing about a settled obligation that worked', async () => {
    const state = (await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState;
    expect(state.tokenRevokes.every((r) => r.state === 'pending' || r.state === 'gave_up')).toBe(true);
    expect(state.tokenRevokes.some((r) => r.state === 'gave_up')).toBe(true);
    // A viewer may not read it at all (the query is for owners and admins).
    const viewer = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'ads-revoke', subject: 'viewer', email: 'viewer@ads-revoke.test', name: null });
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgId, viewer]));
    await expect(app.query('ads.write.state', {}, { actor: asUser(viewer), orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('records ids, states and codes only: no token and no envelope in an audit row, an event, an idempotency key or a job', async () => {
    const audit = await rows<{ command: string; detail: unknown; input_sha256: string }>(`SELECT command, detail, input_sha256 FROM crove_kernel.audit_event WHERE org_id = $1 ORDER BY occurred_at`, [orgId]);
    expect(audit.some((a) => a.command === 'ads.token_revoke.record')).toBe(true);
    const events = await rows<{ event: unknown }>(`SELECT to_jsonb(e) AS event FROM crove_kernel.outbox_event e WHERE e.org_id = $1`, [orgId]);
    const keys = await rows<{ key: unknown }>(`SELECT to_jsonb(k) AS key FROM crove_kernel.idempotency_key k WHERE k.org_id = $1`, [orgId]);
    const jobs = await rows<{ job: unknown }>(`SELECT to_jsonb(j) AS job FROM crove_jobs.job j WHERE j.name = 'ads-revoke'`).catch(() => [] as Array<{ job: unknown }>);
    const everything = JSON.stringify({ audit, events, keys, jobs });
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(everything.includes(secret), secret.slice(0, 12)).toBe(false);
    expect(everything).not.toMatch(/sbxw_[A-Za-z0-9_-]{20,}/);
    // The record of a try names the obligation and what came of it.
    const record = audit.find((a) => a.command === 'ads.token_revoke.record');
    expect(Object.keys((record?.detail ?? {}) as Record<string, unknown>).sort()).toEqual(expect.arrayContaining(['attempts', 'revokeId', 'state']));
    // The sealed copies that are left are the pending ones only, and each is the envelope the broker made, never a token in the clear.
    const left = await rows<{ envelope: Buffer }>(`SELECT s.envelope FROM crove_ads.ad_token_seal s JOIN crove_ads.ad_token_revoke r ON r.org_id = s.org_id AND r.id = s.revoke_id WHERE r.state <> 'pending'`);
    expect(left).toEqual([]);
    for (const row of await rows<{ envelope: Buffer }>('SELECT envelope FROM crove_ads.ad_token_seal')) for (const secret of secrets) expect(row.envelope.toString('utf8').includes(secret)).toBe(false);
  });
});
