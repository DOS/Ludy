// SPDX-License-Identifier: AGPL-3.0-only
// The revoke at the platform of the token of a closed ads connection, as a flow (ADR-0043 point 4, issue #2296, W2-1; the invariants are in
// invariant/ads-token-seal.db.test.ts): every way a connection that runs ads is closed leaves a held copy and an obligation; the sweep opens the copy,
// calls the revoker, records the outcome and wipes the copy; the try is counted as the copy is opened; a failure is tried again on the policy's schedule
// and a platform that never answers, a token it refuses for another reason or a copy that cannot be opened ends with the person told to remove the app by
// hand; another live connection of the same person keeps the call from being made; connecting the account again cancels the revoke; the connection of a
// member who left is closed by the sweep and revoked; and nothing of the token reaches an audit row, an event, an idempotency key or a job. The revoker
// here is the sandbox's (no network) or a stand-in that fails as a platform does.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
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
import { noCredentialBroker } from '../src/credentials.ts';
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
  async function makeAccount(external: string, grantedBy: string | null = null) {
    const account = randomUUID();
    const connection = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Đọc', $4)`, [orgId, connection, external, owner]);
      await c.query(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, granted_by_hash) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Tài khoản khác', '2025-10-01', $5)`, [
        orgId,
        account,
        connection,
        external,
        grantedBy,
      ]);
    });
    return { adAccountId: account, readConnection: connection };
  }

  // A write connection of an ad account, sealed as the API seals it, attached to the account when there is one (the switch is on), with the keyed hash of
  // the person who granted it when there is one. `by` is the connecting member.
  async function connectWrite(by = owner, external = ACCOUNT, linked: string | null = external === ACCOUNT ? adAccountId : null, grantedByHash: string | null = null) {
    const login = sandboxWriteLogin({ externalAccountId: external, currency: 'VND' });
    secrets.push(login.secret, (JSON.parse(login.secret) as { accessToken: string }).accessToken);
    const sealed = vault.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
    const done = await app.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: login.provider, externalAccountId: login.externalAccountId, displayName: login.displayName, scopes: [...login.scopes], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(by), orgId },
    );
    if (linked) await app.execute('ads.account.link_write', { connectionId: done.connectionId, ...(grantedByHash ? { grantedByHash } : {}) }, { actor: asUser(owner), orgId });
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
  const dueNow = async () => {
    await admin((c) => c.query(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() WHERE state = 'pending'`));
    await admin((c) => c.query('UPDATE crove_ads.ad_token_seal SET lease_until = NULL, lease_token = NULL'));
  };

  const sandboxRevokers = adRevokers({ sandbox: true });
  // What a revoker answers to the pause of a launch (W2-4a) when none is behind the connection: nothing found, nothing to pause. The stand-ins below only say how a revoke ends.
  const nothingToPause: AdRevoker['pauseLaunch'] = async () => ({ listed: { campaign: { ok: true }, ad_set: { ok: true }, ad: { ok: true } }, found: [], paused: [], failed: [], notTried: 0, tokenRefused: false, retryAt: null });
  type StandIn = Pick<AdRevoker, 'revokeToken'> & Partial<Pick<AdRevoker, 'pauseLaunch'>>;
  const sweep = (revokers: Readonly<Record<string, StandIn>> = sandboxRevokers, broker: CredentialVault | undefined = vault): Promise<AdsRevokeResult> =>
    runAdsRevoke({ runtime: worker, workerDb, broker, revokers: Object.fromEntries(Object.entries(revokers).map(([provider, r]) => [provider, { pauseLaunch: nothingToPause, ...r }])) });
  // A stand-in for the platform that answers with what a failure is: no network.
  const failing = (error: () => AdPlatformError): Readonly<Record<string, StandIn>> => ({
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

  it('waits the platform’s own time when it is later than the backoff, counts a refused permission and a bad request as tries, and ends at once when nothing can be revoked', async () => {
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
    // The person removed the app at the platform (the revoker says so): there is nothing left to revoke, done, and the copy wiped.
    await dueNow();
    await sweep({ sandboxwrite_ads: { revokeToken: async () => ({ how: 'already_invalid' as const }) } });
    expect(await obligation(limited)).toMatchObject({ state: 'done', how_done: 'already_invalid', attempts: 4, seals: '0' });

    // A token the platform refuses for another reason (expired, invalidated, password changed) cannot revoke anything and the grant may still stand: the
    // copy is wiped, the obligation is given up as unrevocable, and it is never shown as revoked.
    const refused = await connectWrite(owner, 'sbxads-refused');
    await app.execute('kernel.channel.disconnect', { connectionId: refused }, { actor: asUser(owner), orgId });
    await dueNow();
    await sweep(failing(() => new AdPlatformError('token_expired', '190_463')));
    expect(await obligation(refused)).toMatchObject({ state: 'gave_up', give_up: 'unrevocable', attempts: 1, last_error_code: '190_463', how_done: null, seals: '0' });
    const view = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes.find((r) => r.externalAccountId === 'sbxads-refused');
    expect(view).toMatchObject({ state: 'gave_up', giveUp: 'unrevocable' });
  });

  const closeWrite = async (external: string) => {
    const id = await connectWrite(owner, external);
    await app.execute('kernel.channel.disconnect', { connectionId: id }, { actor: asUser(owner), orgId });
    return id;
  };

  it('gives up at once, wipes the copy and says to revoke by hand when the copy does not open', async () => {
    await switchOn();
    // The copy of a deployment whose key changed cannot be opened: the try was counted as it opened, the copy is wiped, and the code says so without a word of it.
    const wrongKey = await closeWrite('sbxads-wrong-key');
    const otherKey = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    await dueNow();
    await sweep(sandboxRevokers, otherKey);
    expect(await obligation(wrongKey)).toMatchObject({ state: 'gave_up', give_up: 'unrevocable', attempts: 1, last_error_code: 'OPEN_FAILED', seals: '0' });
    // And it is shown on the screen as given up, to be revoked by hand.
    const shown = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes.filter((r) => r.externalAccountId === 'sbxads-wrong-key');
    expect(shown.map((r) => [r.state, r.giveUp])).toEqual([['gave_up', 'unrevocable']]);
  });

  // A worker started without the platform app's secret or the credential key is a configuration fault, not a finding about the token (#2296 review): nothing is
  // recorded, the copy stays pending, a fix restores the revoke, and only the seventh day ends it, with "revoke by hand".
  it('keeps the copy pending when the deployment cannot call the platform (no revoker, no broker), revokes once it is fixed, and lets the seventh day end it', async () => {
    await switchOn();
    await settleAll();
    const noRevoker = await closeWrite('sbxads-no-revoker');
    await dueNow();
    await sweep({}, vault);
    // Nothing was opened (no try counted) and nothing was recorded: the obligation is as the close left it, with its copy.
    expect(await obligation(noRevoker)).toMatchObject({ state: 'pending', give_up: null, last_error_kind: null, last_error_code: null, attempts: 0, seals: '1' });
    const noBroker = await closeWrite('sbxads-no-broker');
    await dueNow();
    await runAdsRevoke({ runtime: worker, workerDb, broker: undefined, revokers: sandboxRevokers });
    expect(await obligation(noBroker)).toMatchObject({ state: 'pending', give_up: null, last_error_kind: null, last_error_code: null, attempts: 0, seals: '1' });
    // A worker with no credential key is given the broker that refuses everything (the object the kernel passes, not an absent one): the same, and no try is
    // counted for a copy that "does not open".
    await dueNow();
    await runAdsRevoke({ runtime: worker, workerDb, broker: noCredentialBroker, revokers: sandboxRevokers });
    expect(await obligation(noBroker)).toMatchObject({ state: 'pending', give_up: null, last_error_code: null, attempts: 0, seals: '1' });
    // Many sweeps later it is the same (the claim runs out and is taken again without counting a try).
    for (let i = 0; i < 3; i++) {
      await dueNow();
      await sweep({}, undefined);
      await dueNow();
      await runAdsRevoke({ runtime: worker, workerDb, broker: noCredentialBroker, revokers: sandboxRevokers });
    }
    expect(await obligation(noRevoker)).toMatchObject({ state: 'pending', attempts: 0, seals: '1' });
    expect(await obligation(noBroker)).toMatchObject({ state: 'pending', attempts: 0, seals: '1' });
    // The configuration is fixed: both are revoked, each with its one counted try.
    await dueNow();
    await sweep();
    expect(await obligation(noRevoker)).toMatchObject({ state: 'done', how_done: 'sandbox', attempts: 1, seals: '0' });
    expect(await obligation(noBroker)).toMatchObject({ state: 'done', how_done: 'sandbox', attempts: 1, seals: '0' });
    // Never fixed: the seventh day ends it as given up by age, the copy is wiped and the screen says to revoke by hand (the age is the database's, whatever the config).
    const neverFixed = await closeWrite('sbxads-never-fixed');
    await dueNow();
    await sweep({}, undefined);
    expect(await obligation(neverFixed)).toMatchObject({ state: 'pending', attempts: 0, seals: '1' });
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days' WHERE org_id = $1 AND connection_id = $2`, [orgId, neverFixed]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    await sweep({}, undefined);
    expect(await obligation(neverFixed)).toMatchObject({ state: 'gave_up', give_up: 'age', last_error_code: null, attempts: 0, seals: '0' });
    const shown = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes.filter((r) => r.externalAccountId === 'sbxads-never-fixed');
    expect(shown.map((r) => [r.state, r.giveUp])).toEqual([['gave_up', 'age']]);
  });

  it('counts the try when the copy is opened, so a crash after the open and before the answer still counts, and the claim runs out to be tried again', async () => {
    await switchOn();
    const id = await connectWrite(owner, 'sbxads-crash');
    await app.execute('kernel.channel.disconnect', { connectionId: id }, { actor: asUser(owner), orgId });
    // The worker dies after the open and before the answer is recorded: the runtime it records through fails.
    const through = worker.execute.bind(worker) as (...a: unknown[]) => Promise<unknown>;
    const deaf = { execute: (name: string, ...rest: unknown[]) => (name === 'ads.token_revoke.record' ? Promise.reject(new Error('the process was killed')) : through(name, ...rest)) } as unknown as Runtime;
    await dueNow();
    await runAdsRevoke({ runtime: deaf, workerDb, broker: vault, revokers: sandboxRevokers });
    // The open counted the try, the answer was lost, the copy stays, and the next try is ten minutes away (the open's own lease), not claimed at once.
    const [after] = await rows<{ attempts: number; minutes: number }>(
      `SELECT attempts, extract(epoch FROM (next_attempt_at - now())) / 60 AS minutes FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND connection_id = $2`,
      [orgId, id],
    );
    expect(after?.attempts).toBe(1);
    expect(Number(after?.minutes)).toBeGreaterThan(8);
    expect(await obligation(id)).toMatchObject({ state: 'pending', seals: '1' });
    expect((await sweep()).tried).toBe(0);
    // When the ten minutes have passed it is claimed again, tried again, and the second try is the one counted as done.
    await dueNow();
    await sweep();
    expect(await obligation(id)).toMatchObject({ state: 'done', how_done: 'sandbox', attempts: 2, seals: '0' });
    // An error that is not the platform's (here a revoker that throws) is a failed try too, counted, the copy kept.
    const other = await connectWrite(owner, 'sbxads-plain-error');
    await app.execute('kernel.channel.disconnect', { connectionId: other }, { actor: asUser(owner), orgId });
    await dueNow();
    await sweep({ sandboxwrite_ads: { revokeToken: async () => Promise.reject(new Error('socket hang up')) } });
    expect(await obligation(other)).toMatchObject({ state: 'pending', attempts: 1, last_error_kind: 'unknown', last_error_code: 'ERROR', seals: '1' });
  });

  it('does not call the platform while another live connection of the same person needs the grant, and calls it once that connection is closed', async () => {
    await switchOn();
    // Whatever earlier tests left pending is settled first, so the revoker's calls are this obligation's alone.
    await settleAll();
    const HASH = 'c'.repeat(64);
    // The person granted the write connection of this account and, in the same app, the reading connection of another account.
    const other = await makeAccount('sbxads-same-person', HASH);
    const write = await connectWrite(owner, ACCOUNT, adAccountId, HASH);
    await app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId });
    expect(await obligation(write)).toMatchObject({ state: 'pending', seals: '1' });
    expect((await rows<{ grantor_hash: string | null }>('SELECT grantor_hash FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND connection_id = $2', [orgId, write]))[0]?.grantor_hash).toBe(HASH);
    let calls = 0;
    const counting: Readonly<Record<string, StandIn>> = {
      sandboxwrite_ads: {
        revokeToken: async () => {
          calls++;
          return { how: 'revoked' as const };
        },
      },
    };
    await dueNow();
    await sweep(counting);
    // Revoking would cut the other connection's grant too: no call, done as a shared grant, the copy wiped, no try counted.
    expect(calls).toBe(0);
    expect(await obligation(write)).toMatchObject({ state: 'done', how_done: 'shared_grant', attempts: 0, seals: '0' });

    // The same, with the other connection closed first: the person's grant is not needed by anyone, so the call is made.
    await app.execute('ads.account.disconnect', { adAccountId: other.adAccountId }, { actor: asUser(owner), orgId });
    await switchOn();
    const again = await connectWrite(owner, ACCOUNT, adAccountId, HASH);
    await app.execute('ads.account.disable_write', { adAccountId }, { actor: asUser(owner), orgId });
    await dueNow();
    await sweep(counting);
    expect(calls).toBe(1);
    expect(await obligation(again)).toMatchObject({ state: 'done', how_done: 'revoked', attempts: 1, seals: '0' });
  });

  it('cancels the pending revoke when the account is connected again, in the same transaction, and tries nothing', async () => {
    await switchOn();
    const first = await connectWrite(owner, 'sbxads-reconnect');
    await app.execute('kernel.channel.disconnect', { connectionId: first }, { actor: asUser(owner), orgId });
    expect(await obligation(first)).toMatchObject({ state: 'pending', seals: '1' });
    // The person connects the same account again: a new connection, whose sealed credential cancels the revoke the closed one left.
    const again = await connectWrite(owner, 'sbxads-reconnect');
    expect(again).not.toBe(first);
    expect(await obligation(first)).toMatchObject({ state: 'done', how_done: 'reconnected', attempts: 0, seals: '0' });
    let calls = 0;
    await dueNow();
    await sweep({ sandboxwrite_ads: { revokeToken: async () => (calls++, { how: 'revoked' as const }) } });
    expect(calls).toBe(0);
    expect(await status(again)).toMatchObject({ status: 'active' });
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

  it('holds one copy when a link is refused and the connection is closed to roll it back, as the API does, and refuses a late answer from a run that lost its claim', async () => {
    // The org's switch is off: the owner connects (the credential is sealed), the link is refused, and the API closes the connection it made.
    await app.execute('ads.write.disable', {}, { actor: asUser(owner), orgId });
    const login = sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' });
    secrets.push(login.secret);
    const sealed = vault.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
    const made = await app.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: login.provider, externalAccountId: login.externalAccountId, displayName: login.displayName, scopes: [...login.scopes], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(owner), orgId },
    );
    await expect(app.execute('ads.account.link_write', { connectionId: made.connectionId }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ code: 'ADS_WRITE_OFF' });
    await app.execute('kernel.channel.disconnect', { connectionId: made.connectionId }, { actor: asUser(owner), orgId });
    const held = await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND connection_id = $2', [orgId, made.connectionId]);
    expect(held[0]?.n).toBe('1');
    expect(await obligation(made.connectionId)).toMatchObject({ state: 'pending', kind: 'write', seals: '1', credentials: '0' });

    // A run that lost its claim cannot record: the command refuses an answer that carries another claim's token, and accepts the claim's own, once.
    await dueNow();
    const claimed = (await sql<{ id: string; lease_token: string }>`SELECT id, lease_token FROM crove_ads.token_revoke_due(100)`.execute(workerDb)).rows;
    const row = await obligation(made.connectionId);
    const ours = claimed.find((r) => r.id === row?.id);
    expect(ours).toBeDefined();
    const outcome = { kind: 'done' as const, how: 'shared_grant' as const };
    await expect(worker.execute('ads.token_revoke.record', { revokeId: row?.id, leaseToken: randomUUID(), outcome }, { actor: SYSTEM, orgId })).rejects.toMatchObject({ code: 'ADS_REVOKE_STALE' });
    expect(await obligation(made.connectionId)).toMatchObject({ state: 'pending', seals: '1' });
    await expect(worker.execute('ads.token_revoke.record', { revokeId: row?.id, leaseToken: ours?.lease_token, outcome }, { actor: SYSTEM, orgId })).resolves.toMatchObject({ state: 'done', recorded: true });
    expect(await obligation(made.connectionId)).toMatchObject({ state: 'done', how_done: 'shared_grant', seals: '0' });
    // Answered already: a second answer finds the obligation settled and records nothing.
    await expect(worker.execute('ads.token_revoke.record', { revokeId: row?.id, leaseToken: ours?.lease_token, outcome }, { actor: SYSTEM, orgId })).resolves.toMatchObject({ recorded: false });
  });

  it('holds the revoke of a write grant that is another person’s when the platform asks to erase an account, and none for the requester’s own grant', async () => {
    await switchOn();
    const REQUESTER = 'e'.repeat(64);
    // The requester granted both the reading and the writing: they removed the app, so there is nothing to revoke and nothing is held.
    const own = await makeAccount('sbxads-erase-own', REQUESTER);
    const ownWrite = await connectWrite(owner, 'sbxads-erase-own', own.adAccountId, REQUESTER);
    await worker.execute('ads.account.erase', { adAccountId: own.adAccountId }, { actor: SYSTEM, orgId });
    expect((await status(ownWrite))?.status_reason).toBe('platform_deletion');
    expect(await obligation(ownWrite)).toBeUndefined();
    // Another person granted the writing: the request is not theirs, so the connection is closed under its own reason and its revoke is held.
    const other = await makeAccount('sbxads-erase-other', REQUESTER);
    const otherWrite = await connectWrite(owner, 'sbxads-erase-other', other.adAccountId, 'f'.repeat(64));
    await worker.execute('ads.account.erase', { adAccountId: other.adAccountId }, { actor: SYSTEM, orgId });
    expect((await status(otherWrite))?.status_reason).toBe('account_erased');
    expect(await obligation(otherWrite)).toMatchObject({ state: 'pending', kind: 'write', reason: 'account_erased', seals: '1', credentials: '0' });
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

  it('limits the open obligations and the ones that gave up separately, so many of one cannot push the other off the screen', async () => {
    const before = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes;
    const gaveUp = before.filter((r) => r.state === 'gave_up').map((r) => r.id);
    expect(gaveUp.length).toBeGreaterThan(0);
    // Fifty-one newer open obligations (made as the table owner; they have no copy, so no sweep touches them), then removed again.
    const made: string[] = [];
    try {
      for (let i = 0; i < 51; i++) {
        const [row] = await rows<{ id: string }>(
          `INSERT INTO crove_ads.ad_token_revoke (org_id, connection_id, provider, external_account_id, kind, reason) VALUES ($1, $2, 'sandboxwrite_ads', $3, 'write', 'other') RETURNING id`,
          [orgId, randomUUID(), `sbxads-crowd-${i}`],
        );
        made.push(row?.id as string);
      }
      const after = ((await app.query('ads.write.state', {}, { actor: asUser(owner), orgId })) as AdsWriteState).tokenRevokes;
      expect(after.filter((r) => r.state === 'pending')).toHaveLength(50);
      expect(after.filter((r) => r.state === 'gave_up').map((r) => r.id).sort()).toEqual([...gaveUp].sort());
    } finally {
      for (const id of made) await admin((c) => c.query('DELETE FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND id = $2', [orgId, id]));
    }
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
