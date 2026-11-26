// Token refresh on PostgreSQL 17 (Social plan S6.4, issue #374): connections whose access token expires soon are
// renewed and their new tokens sealed in one transaction; a refused refresh marks the connection expired; one sweep
// runs at a time; only the worker scans across orgs. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its
// own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Refresher } from '@ludy/channel';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type SealedChannelCredential } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@ludy/kernel-runtime';
import { refreshChannels } from '../src/channel-refresh.ts';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_TOKEN_HOSTS, LazadaRefresher } from '../src/marketplace-lazada-token.ts';
import { fakeLazadaToken } from './fake-lazada-token.ts';
import { TIKTOK_TOKEN_HOSTS, TiktokRefresher } from '../src/marketplace-tiktok-token.ts';
import { fakeTiktok } from './fake-tiktok.ts';
import { SHOPEE_TOKEN_HOSTS, ShopeeRefresher } from '../src/marketplace-shopee-token.ts';
import { fakeShopee } from './fake-shopee.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('channel token refresh on PostgreSQL (S6.4)', () => {
  const dbName = `ludy_test_channel_refresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'refresh-test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function org() {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@refresh.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connect(o: { orgId: string; owner: string }, expiresInMs: number, secret = JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }), provider = 'zalo_oa') {
    const account = String(Math.floor(Math.random() * 1e15));
    const sealed = vault.seal(secret, { orgId: o.orgId, provider, externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider,
        externalAccountId: account,
        displayName: 'Zalo OA',
        scopes: ['oa'],
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  const secretOf = async (orgId: string, connectionId: string) => {
    const s = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: system, orgId });
    return vault.open({ keyId: s.keyId, envelope: Buffer.from(s.envelope, 'base64') }, { orgId, provider: s.provider, externalAccountId: s.externalAccountId });
  };
  const row = (connectionId: string) =>
    admin(async (c) =>
      (
        await c.query<{ status: string; expires_at: Date; updated_at: Date; refresh_failures: number; refresh_last_error: string | null; refresh_next_at: Date | null }>(
          'SELECT status, expires_at, updated_at, refresh_failures, refresh_last_error, refresh_next_at FROM ludy_kernel.channel_connection WHERE id = $1',
          [connectionId],
        )
      ).rows[0],
    );

  // Hands out a new pair per refresh and remembers what it was given.
  function fakeRefresher(answer: 'ok' | 'refused' | 'failed' = 'ok'): Refresher & { seen: string[] } {
    const seen: string[] = [];
    return {
      provider: 'zalo_oa',
      seen,
      refresh: async (secret) => {
        seen.push(secret);
        if (answer === 'refused') return { refused: '-14020' };
        if (answer === 'failed') return { failed: '503' };
        const n = seen.length + 1;
        return { secret: JSON.stringify({ accessToken: `a-${n}`, refreshToken: `r-${n}` }), expiresAt: new Date(Date.now() + 25 * HOUR) };
      },
    };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('ludy_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('connects an account of a provider with a one-character id, and starts its OAuth attempt (#784)', async () => {
    const o = await org();
    const id = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'x-1', refreshToken: 'r-1' }), 'x');
    expect((await row(id))?.status).toBe('active');
    const begun = await api.execute<{ attemptId: string }>(
      'kernel.channel.oauth_begin',
      { provider: 'x', stateHash: `sha256:${'a'.repeat(64)}`, codeVerifier: 'v'.repeat(43) },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(begun.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    // Still refused: an id that starts with a digit, or is longer than 32.
    await expect(connect(o, HOUR, '{}', '9x')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(connect(o, HOUR, '{}', 'x'.repeat(33))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('renews only connections expiring soon, sealing the new pair and moving the expiry', async () => {
    const o = await org();
    const soon = await connect(o, HOUR);
    const later = await connect(o, 3 * 24 * HOUR);
    const refresher = fakeRefresher();
    const outcome = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: refresher } });
    expect(outcome).toMatchObject({ refreshed: 1, expired: 0, skipped: false });
    expect(refresher.seen).toEqual([JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' })]);
    expect(await secretOf(o.orgId, soon)).toBe(JSON.stringify({ accessToken: 'a-2', refreshToken: 'r-2' }));
    expect((await row(soon))?.expires_at.getTime()).toBeGreaterThan(Date.now() + 24 * HOUR);
    expect(await secretOf(o.orgId, later)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
    // Renewed, it is no longer due: the next sweep leaves it alone.
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: refresher } })).refreshed).toBe(0);
    // No token in audit rows or events.
    const dump = await admin(async (c) => {
      const a = await c.query<{ t: string }>("SELECT coalesce(string_agg(detail::text, ' '), '') AS t FROM ludy_kernel.audit_event WHERE org_id = $1", [o.orgId]);
      const e = await c.query<{ t: string }>("SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM ludy_kernel.outbox_event WHERE org_id = $1", [o.orgId]);
      return `${a.rows[0]?.t} ${e.rows[0]?.t}`;
    });
    for (const token of ['a-2', 'r-2', 'r-1']) expect(dump).not.toContain(`"${token}"`);
  });

  it('marks a connection expired when the provider refuses the refresh, and keeps a failed one for the next sweep', async () => {
    const o = await org();
    const refused = await connect(o, HOUR);
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher('refused') } })).expired).toBeGreaterThanOrEqual(1);
    expect((await row(refused))?.status).toBe('expired');
    const flaky = await connect(o, HOUR);
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher('failed') } })).failed).toBeGreaterThanOrEqual(1);
    expect((await row(flaky))?.status).toBe('active');
  });

  // The Lazada refresher (#2524, S3a = #4240) through the real sweep: its provider is the marketplace connection's (`marketplace_lazada`), its secret holds the seller's own app and the OAuth result.
  describe('a Lazada connection', () => {
    const DAY = 24 * HOUR;
    const APP = { appKey: '123456', appSecret: 'test-only-app-secret' };
    const lazadaSecret = (refreshExpiresAt: number) =>
      JSON.stringify({ ...APP, accessToken: 'access-token-0', refreshToken: 'refresh-token-0', accessExpiresAt: new Date(Date.now() + 2 * DAY).toISOString(), refreshExpiresAt: new Date(refreshExpiresAt).toISOString(), sellerId: '1000100', country: 'vn' });
    const lazada = (refreshExpiresAtMs: number, intercept?: Parameters<typeof fakeLazadaToken>[0]['intercept']) => {
      const fake = fakeLazadaToken({ ...APP, refreshToken: 'refresh-token-0', refreshExpiresAtMs, ...(intercept ? { intercept } : {}) });
      return { fake, refreshers: { marketplace_lazada: new LazadaRefresher({ fetch: hostBoundFetch(LAZADA_TOKEN_HOSTS, fake.fetch) }) } };
    };
    const sweep = (refreshers: Record<string, Refresher>) => refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers });

    it('renews a token with under five days left, keeps the rotated pair whole, and never extends the refresh life', async () => {
      const o = await org();
      const end = Date.now() + 150 * DAY;
      const due = await connect(o, 2 * DAY, lazadaSecret(end), 'marketplace_lazada');
      const quiet = await connect(o, 20 * DAY, lazadaSecret(end), 'marketplace_lazada');
      const { fake, refreshers } = lazada(end);
      expect(await sweep(refreshers)).toMatchObject({ refreshed: 1, expired: 0, failed: 0 });
      const next = JSON.parse(await secretOf(o.orgId, due)) as Record<string, string>;
      expect(next).toMatchObject({ accessToken: 'access-token-1', refreshToken: 'refresh-token-1', sellerId: '1000100', ...APP });
      // Not extended: it is the date it was, or a moment sooner (Lazada's countdown is in whole seconds and the clock is the real one), never later.
      const kept = Date.parse(next.refreshExpiresAt ?? '');
      expect(kept).toBeLessThanOrEqual(end);
      expect(end - kept).toBeLessThan(5000);
      expect((await row(due))?.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
      expect((await row(due))?.status).toBe('active');
      // The one outside the window is untouched, and the renewed one is no longer due.
      expect(JSON.parse(await secretOf(o.orgId, quiet)).accessToken).toBe('access-token-0');
      expect((await sweep(refreshers)).refreshed).toBe(0);
      expect(fake.calls).toHaveLength(1);
      // No token or secret of it is in an audit row or an event.
      const dump = await admin(async (c) => {
        const a = await c.query<{ t: string }>("SELECT coalesce(string_agg(detail::text, ' '), '') AS t FROM ludy_kernel.audit_event WHERE org_id = $1", [o.orgId]);
        const e = await c.query<{ t: string }>("SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM ludy_kernel.outbox_event WHERE org_id = $1", [o.orgId]);
        return `${a.rows[0]?.t} ${e.rows[0]?.t}`;
      });
      for (const word of ['access-token-1', 'refresh-token-1', 'refresh-token-0', APP.appSecret]) expect(dump).not.toContain(word);
    });

    it('does not lose the rotated refresh token when two sweeps run at once: one call is made and the stored pair is the new one', async () => {
      const o = await org();
      const end = Date.now() + 150 * DAY;
      const id = await connect(o, 2 * DAY, lazadaSecret(end), 'marketplace_lazada');
      const { fake, refreshers } = lazada(end);
      const [a, b] = await Promise.all([sweep(refreshers), sweep(refreshers)]);
      expect(a.refreshed + b.refreshed).toBe(1);
      expect(fake.calls).toHaveLength(1);
      expect(JSON.parse(await secretOf(o.orgId, id))).toMatchObject({ accessToken: 'access-token-1', refreshToken: 'refresh-token-1' });
      expect(fake.currentRefreshToken()).toBe('refresh-token-1');
    });

    it('marks the connection expired when its refresh token is past its end (no call is made), or when Lazada refuses it, and never tries again', async () => {
      const o = await org();
      const past = await connect(o, 2 * DAY, lazadaSecret(Date.now() - DAY), 'marketplace_lazada');
      const dead = lazada(Date.now() - DAY);
      expect(await sweep(dead.refreshers)).toMatchObject({ refreshed: 0, expired: 1 });
      expect((await row(past))?.status).toBe('expired');
      expect(dead.fake.calls).toHaveLength(0);
      // Lazada's own refusal of a token that looked alive: expired as well.
      const refused = await connect(o, 2 * DAY, lazadaSecret(Date.now() + 150 * DAY), 'marketplace_lazada');
      const no = lazada(Date.now() + 150 * DAY, () => new Response(JSON.stringify({ code: 'IllegalRefreshToken', message: 'The refresh token is invalid' }), { status: 200 }));
      expect(await sweep(no.refreshers)).toMatchObject({ refreshed: 0, expired: 1 });
      expect((await row(refused))?.status).toBe('expired');
      expect(no.fake.calls).toHaveLength(1);
      // An expired connection is not picked again: no loop, no second call.
      expect(await sweep(no.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 0 });
      expect(no.fake.calls).toHaveLength(1);
    });

    it('keeps the connection active and tries again on the next sweep after an outage', async () => {
      const o = await org();
      const id = await connect(o, 2 * DAY, lazadaSecret(Date.now() + 150 * DAY), 'marketplace_lazada');
      const down = lazada(Date.now() + 150 * DAY, () => new Response('upstream', { status: 503 }));
      expect(await sweep(down.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      expect((await row(id))?.status).toBe('active');
      expect(JSON.parse(await secretOf(o.orgId, id)).refreshToken).toBe('refresh-token-0');
      const up = lazada(Date.now() + 150 * DAY);
      expect(await sweep(up.refreshers)).toMatchObject({ refreshed: 1 });
    });
  });

  // The TikTok Shop refresher (#2524, T1 = #4256) through the real sweep: provider `marketplace_tiktok_shop`, the seller's own app in the sealed secret, an access token of seven days renewed a day ahead.
  describe('a TikTok Shop connection', () => {
    const DAY = 24 * HOUR;
    const APP = { appKey: '123abc', appSecret: 'test-only-app-secret' };
    const tiktokSecret = (authorizationEnd: number) =>
      JSON.stringify({ ...APP, accessToken: 'TTP_access_0', refreshToken: 'TTP_R0', accessExpiresAt: new Date(Date.now() + 12 * HOUR).toISOString(), refreshExpiresAt: new Date(authorizationEnd).toISOString(), openId: 'open-1', region: 'VN' });
    const tiktok = (authorizationEndsAtMs: number, intercept?: Parameters<typeof fakeTiktok>[0]['intercept']) => {
      const fake = fakeTiktok({ ...APP, accessToken: 'TTP_access', refreshToken: 'TTP_R0', authorizationEndsAtMs, ...(intercept ? { intercept } : {}) });
      return { fake, refreshers: { marketplace_tiktok_shop: new TiktokRefresher({ fetch: hostBoundFetch(TIKTOK_TOKEN_HOSTS, fake.fetch) }) } };
    };
    const sweep = (refreshers: Record<string, Refresher>) => refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers });

    it('renews a token with under a day left, keeps the rotated pair whole, and never extends the end of the authorization', async () => {
      const o = await org();
      const end = Date.now() + 90 * DAY;
      const due = await connect(o, 12 * HOUR, tiktokSecret(end), 'marketplace_tiktok_shop');
      const quiet = await connect(o, 5 * DAY, tiktokSecret(end), 'marketplace_tiktok_shop');
      const { fake, refreshers } = tiktok(end);
      expect(await sweep(refreshers)).toMatchObject({ refreshed: 1, expired: 0, failed: 0 });
      const next = JSON.parse(await secretOf(o.orgId, due)) as Record<string, string>;
      expect(next).toMatchObject({ accessToken: 'TTP_access_1', refreshToken: 'TTP_R1', openId: 'open-1', ...APP });
      // Not extended: the date it was, or a moment sooner (the countdown is in whole seconds and the clock is the real one), never later.
      const kept = Date.parse(next.refreshExpiresAt ?? '');
      expect(kept).toBeLessThanOrEqual(end);
      expect(end - kept).toBeLessThan(5000);
      expect((await row(due))?.expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect((await row(due))?.status).toBe('active');
      // The one outside the window is untouched, and the renewed one is no longer due.
      expect(JSON.parse(await secretOf(o.orgId, quiet)).accessToken).toBe('TTP_access_0');
      expect((await sweep(refreshers)).refreshed).toBe(0);
      expect(fake.calls).toHaveLength(1);
      // The address of the call carries the app secret; nothing of it, or of a token, is in an audit row or an event.
      const dump = await admin(async (c) => {
        const a = await c.query<{ t: string }>("SELECT coalesce(string_agg(detail::text, ' '), '') AS t FROM ludy_kernel.audit_event WHERE org_id = $1", [o.orgId]);
        const e = await c.query<{ t: string }>("SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM ludy_kernel.outbox_event WHERE org_id = $1", [o.orgId]);
        return `${a.rows[0]?.t} ${e.rows[0]?.t}`;
      });
      for (const word of ['TTP_access_1', 'TTP_R1', 'TTP_R0', APP.appSecret, 'app_secret']) expect(dump).not.toContain(word);
    });

    it('does not lose the rotated refresh token when two sweeps run at once: one call is made and the stored pair is the new one', async () => {
      const o = await org();
      const end = Date.now() + 90 * DAY;
      const id = await connect(o, 12 * HOUR, tiktokSecret(end), 'marketplace_tiktok_shop');
      const { fake, refreshers } = tiktok(end);
      const [a, b] = await Promise.all([sweep(refreshers), sweep(refreshers)]);
      expect(a.refreshed + b.refreshed).toBe(1);
      expect(fake.calls).toHaveLength(1);
      expect(JSON.parse(await secretOf(o.orgId, id))).toMatchObject({ accessToken: 'TTP_access_1', refreshToken: 'TTP_R1' });
      expect(fake.state().refreshToken).toBe('TTP_R1');
    });

    it('marks the connection expired when the authorization has ended (no call is made) and never tries again', async () => {
      const o = await org();
      const past = await connect(o, 12 * HOUR, tiktokSecret(Date.now() - DAY), 'marketplace_tiktok_shop');
      const dead = tiktok(Date.now() - DAY);
      expect(await sweep(dead.refreshers)).toMatchObject({ refreshed: 0, expired: 1 });
      expect((await row(past))?.status).toBe('expired');
      expect(dead.fake.calls).toHaveLength(0);
      // An expired connection is not picked again: no loop, no second call.
      expect(await sweep(dead.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 0 });
      expect(dead.fake.calls).toHaveLength(0);
    });

    it('keeps the connection active and tries again on the next sweep after an outage or an answer whose code is not a documented refusal', async () => {
      const o = await org();
      const id = await connect(o, 12 * HOUR, tiktokSecret(Date.now() + 90 * DAY), 'marketplace_tiktok_shop');
      const down = tiktok(Date.now() + 90 * DAY, () => new Response('upstream', { status: 503 }));
      expect(await sweep(down.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      const odd = tiktok(Date.now() + 90 * DAY, () => new Response(JSON.stringify({ code: 99999, message: 'unknown' }), { status: 200 }));
      expect(await sweep(odd.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      expect((await row(id))?.status).toBe('active');
      expect(JSON.parse(await secretOf(o.orgId, id)).refreshToken).toBe('TTP_R0');
      const up = tiktok(Date.now() + 90 * DAY);
      expect(await sweep(up.refreshers)).toMatchObject({ refreshed: 1 });
    });
  });

  // The Shopee refresher (#2524, S1 = #4274) through the real sweep: provider `marketplace_shopee`, the partner in the sealed secret, an access token of four hours renewed half an hour ahead, and a refresh token
  // that WORKS ONCE: two sweeps at once must make one call and keep the new pair.
  describe('a Shopee connection', () => {
    const DAY = 24 * HOUR;
    const PARTNER = { partnerId: '1000012', partnerKey: 'test-only-partner-key' };
    const SHOP = '77777';
    const shopeeSecret = (authorizationEnd: number) =>
      JSON.stringify({ ...PARTNER, shopId: SHOP, accessToken: 'SHP_access_0', refreshToken: 'SHP_R0', accessExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 20 * DAY).toISOString(), authorizationEndsAt: new Date(authorizationEnd).toISOString() });
    const shopee = (authorizationEndsAtMs: number, intercept?: Parameters<typeof fakeShopee>[0]['intercept']) => {
      const fake = fakeShopee({ ...PARTNER, shopId: SHOP, accessToken: 'SHP_access', refreshToken: 'SHP_R0', authorizationEndsAtMs, ...(intercept ? { intercept } : {}) });
      return { fake, refreshers: { marketplace_shopee: new ShopeeRefresher({ fetch: hostBoundFetch(SHOPEE_TOKEN_HOSTS, fake.fetch) }) } };
    };
    const sweep = (refreshers: Record<string, Refresher>) => refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers });

    it('renews a token with under half an hour left, keeps the rotated pair whole, and never moves the authorization end', async () => {
      const o = await org();
      const end = Date.now() + 200 * DAY;
      const due = await connect(o, 20 * 60_000, shopeeSecret(end), 'marketplace_shopee');
      const quiet = await connect(o, 2 * HOUR, shopeeSecret(end), 'marketplace_shopee');
      const { fake, refreshers } = shopee(end);
      expect(await sweep(refreshers)).toMatchObject({ refreshed: 1, expired: 0, failed: 0 });
      const next = JSON.parse(await secretOf(o.orgId, due)) as Record<string, string>;
      expect(next).toMatchObject({ accessToken: 'SHP_access_1', refreshToken: 'SHP_R1', shopId: SHOP, ...PARTNER });
      // Not moved: the date it was (the sealed secret keeps it as written).
      expect(Date.parse(next.authorizationEndsAt ?? '')).toBe(end);
      expect((await row(due))?.expires_at.getTime()).toBeGreaterThan(Date.now() + 3 * HOUR);
      expect((await row(due))?.status).toBe('active');
      // The one outside the window is untouched, and the renewed one is no longer due.
      expect(JSON.parse(await secretOf(o.orgId, quiet)).accessToken).toBe('SHP_access_0');
      expect((await sweep(refreshers)).refreshed).toBe(0);
      expect(fake.calls).toHaveLength(1);
      // The refresh carries no token in its address, and nothing of a key or a token is in an audit row or an event.
      const dump = await admin(async (c) => {
        const a = await c.query<{ t: string }>("SELECT coalesce(string_agg(detail::text, ' '), '') AS t FROM ludy_kernel.audit_event WHERE org_id = $1", [o.orgId]);
        const e = await c.query<{ t: string }>("SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM ludy_kernel.outbox_event WHERE org_id = $1", [o.orgId]);
        return `${a.rows[0]?.t} ${e.rows[0]?.t}`;
      });
      for (const word of ['SHP_access_1', 'SHP_R1', 'SHP_R0', PARTNER.partnerKey]) expect(dump).not.toContain(word);
    });

    it('does not lose the rotated refresh token when two sweeps run at once: one call is made and the stored pair is the new one', async () => {
      const o = await org();
      const end = Date.now() + 200 * DAY;
      const id = await connect(o, 20 * 60_000, shopeeSecret(end), 'marketplace_shopee');
      const { fake, refreshers } = shopee(end);
      const [a, b] = await Promise.all([sweep(refreshers), sweep(refreshers)]);
      expect(a.refreshed + b.refreshed).toBe(1);
      expect(fake.calls).toHaveLength(1);
      expect(JSON.parse(await secretOf(o.orgId, id))).toMatchObject({ accessToken: 'SHP_access_1', refreshToken: 'SHP_R1' });
      expect(fake.state().refreshToken).toBe('SHP_R1');
    });

    it('marks the connection expired when the authorization has ended (no call is made) and never tries again', async () => {
      const o = await org();
      const past = await connect(o, 20 * 60_000, shopeeSecret(Date.now() - DAY), 'marketplace_shopee');
      const dead = shopee(Date.now() - DAY);
      expect(await sweep(dead.refreshers)).toMatchObject({ refreshed: 0, expired: 1 });
      expect((await row(past))?.status).toBe('expired');
      expect(dead.fake.calls).toHaveLength(0);
      expect(await sweep(dead.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 0 });
      expect(dead.fake.calls).toHaveLength(0);
    });

    it('keeps the connection active and tries again on the next sweep after an outage', async () => {
      const o = await org();
      const id = await connect(o, 20 * 60_000, shopeeSecret(Date.now() + 200 * DAY), 'marketplace_shopee');
      const down = shopee(Date.now() + 200 * DAY, () => new Response('upstream', { status: 503 }));
      expect(await sweep(down.refreshers)).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      expect((await row(id))?.status).toBe('active');
      expect(JSON.parse(await secretOf(o.orgId, id)).refreshToken).toBe('SHP_R0');
      const up = shopee(Date.now() + 200 * DAY);
      expect(await sweep(up.refreshers)).toMatchObject({ refreshed: 1 });
    });
  });

  it('drops tokens for a connection that changed during the refresh', async () => {
    const o = await org();
    const id = await connect(o, HOUR);
    const slow: Refresher = {
      provider: 'zalo_oa',
      refresh: async () => {
        // A reconnect lands while the provider answers.
        await admin((c) => c.query("UPDATE ludy_kernel.channel_connection SET updated_at = now() + interval '1 second' WHERE id = $1", [id]));
        return { secret: JSON.stringify({ accessToken: 'late', refreshToken: 'late' }), expiresAt: new Date(Date.now() + 25 * HOUR) };
      },
    };
    await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: slow } });
    expect(await secretOf(o.orgId, id)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
  });

  it('runs one sweep at a time, and only the worker scans across orgs', async () => {
    const o = await org();
    await connect(o, HOUR);
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('crove.channel-refresh', 0))");
      expect(await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher() } })).toMatchObject({ skipped: true, refreshed: 0 });
    } finally {
      await holder.end();
    }
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant']) r
         WHERE has_function_privilege(r, 'ludy_kernel.channel_refresh_due(int, text[], int)', 'EXECUTE') ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['ludy_worker']);
    // The API runtime cannot store a refresh: the command is the system's.
    await expect(api.execute('kernel.channel.refresh', { connectionId: randomUUID(), ifVersion: new Date().toISOString(), expiresAt: null, credential: { keyId: 'k', envelope: 'AA==' } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('renews each provider within its own window', async () => {
    const o = await org();
    const zalo = await connect(o, 3 * 24 * HOUR);
    const threads = await connect(o, 3 * 24 * HOUR, JSON.stringify({ accessToken: 't-1' }), 'threads');
    const seen: string[] = [];
    const longLived: Refresher = {
      provider: 'threads',
      horizonSeconds: 7 * 24 * 3600,
      refresh: async (secret) => {
        seen.push(secret);
        return { secret: JSON.stringify({ accessToken: 't-2' }), expiresAt: new Date(Date.now() + 60 * 24 * HOUR) };
      },
    };
    await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher(), threads: longLived } });
    expect(seen).toEqual([JSON.stringify({ accessToken: 't-1' })]);
    expect(await secretOf(o.orgId, threads)).toBe(JSON.stringify({ accessToken: 't-2' }));
    // Three days out is outside Zalo's 6-hour window: untouched.
    expect(await secretOf(o.orgId, zalo)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
  });

  it('backs off exponentially after 3 consecutive failures with the same code, logs once cleanly, and resets on success (#4251)', async () => {
    const o = await org();
    const id = await connect(o, HOUR);
    const initialUpdatedAt = (await row(id))?.updated_at.getTime();
    let calls = 0;
    let code = '503';
    let succeed = false;
    const refresher: Refresher = {
      provider: 'zalo_oa',
      refresh: async () => {
        calls += 1;
        if (succeed) return { secret: JSON.stringify({ accessToken: 'a-ok', refreshToken: 'r-ok' }), expiresAt: new Date(Date.now() + 25 * HOUR) };
        return { failed: code };
      },
    };
    const sweep = () => refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: refresher } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Failures 1 and 2: stay due on the next sweep with no backoff or log spam yet.
      expect(await sweep()).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      expect(await row(id)).toMatchObject({ status: 'active', refresh_failures: 1, refresh_last_error: '503', refresh_next_at: null });
      expect(await sweep()).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      expect(await row(id)).toMatchObject({ status: 'active', refresh_failures: 2, refresh_last_error: '503', refresh_next_at: null });
      expect(warnSpy).not.toHaveBeenCalled();

      // Failure 3 with the same code: enters 1-hour backoff and logs once cleanly.
      const before3 = Date.now();
      expect(await sweep()).toMatchObject({ refreshed: 0, expired: 0, failed: 1 });
      const r3 = await row(id);
      expect(r3).toMatchObject({ status: 'active', refresh_failures: 3, refresh_last_error: '503' });
      expect(r3?.refresh_next_at).not.toBeNull();
      const delay3 = (r3?.refresh_next_at?.getTime() ?? 0) - before3;
      expect(delay3).toBeGreaterThanOrEqual(3500_000);
      expect(delay3).toBeLessThanOrEqual(3700_000);
      // updated_at is untouched so concurrent ifVersion checks (authorize_complete / mark_expired) are not disrupted.
      expect(r3?.updated_at.getTime()).toBe(initialUpdatedAt);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(`connection=${id}`);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(`org=${o.orgId}`);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('code=503');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('backoff_seconds=3600');

      // Operator visibility via kernel.channel.list.
      const listed = await api.query<Array<{ id: string; refreshError: string | null; refreshFailures: number; refreshNextAt: string | null }>>('kernel.channel.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
      expect(listed.find((c) => c.id === id)).toMatchObject({ refreshError: '503', refreshFailures: 3 });

      // Next sweep while in backoff skips it completely: the refresher is not called.
      expect(await sweep()).toMatchObject({ refreshed: 0, expired: 0, failed: 0 });
      expect(calls).toBe(3);

      // Once backoff elapses: failure 4 backs off 6 hours, failure 5 backs off 24 hours, failure 6 stays capped at 24 hours, with no duplicate log spam.
      const expireBackoff = () => admin((c) => c.query("UPDATE ludy_kernel.channel_connection SET refresh_next_at = now() - interval '1 second' WHERE id = $1", [id]));
      for (const [expectedFailures, expectedHours] of [[4, 6], [5, 24], [6, 24]] as const) {
        await expireBackoff();
        const t = Date.now();
        expect(await sweep()).toMatchObject({ failed: 1 });
        const rn = await row(id);
        expect(rn?.refresh_failures).toBe(expectedFailures);
        const delayMs = (rn?.refresh_next_at?.getTime() ?? 0) - t;
        expect(delayMs).toBeGreaterThanOrEqual((expectedHours * 3600 - 120) * 1000);
        expect(delayMs).toBeLessThanOrEqual((expectedHours * 3600 + 120) * 1000);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Changing failure code resets the consecutive streak to 1 and clears backoff.
      await expireBackoff();
      code = 'NETWORK';
      expect(await sweep()).toMatchObject({ failed: 1 });
      expect(await row(id)).toMatchObject({ refresh_failures: 1, refresh_last_error: 'NETWORK', refresh_next_at: null });

      // Two more with NETWORK -> backs off again and logs once for the new streak.
      expect(await sweep()).toMatchObject({ failed: 1 });
      expect(await sweep()).toMatchObject({ failed: 1 });
      expect(await row(id)).toMatchObject({ refresh_failures: 3, refresh_last_error: 'NETWORK' });
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // A successful refresh after backoff elapses resets counter, error code, and backoff.
      await expireBackoff();
      succeed = true;
      expect(await sweep()).toMatchObject({ refreshed: 1, expired: 0, failed: 0 });
      expect(await row(id)).toMatchObject({ status: 'active', refresh_failures: 0, refresh_last_error: null, refresh_next_at: null });
      expect(await secretOf(o.orgId, id)).toBe(JSON.stringify({ accessToken: 'a-ok', refreshToken: 'r-ok' }));
      const afterSuccess = await api.query<Array<{ id: string; refreshError: string | null; refreshFailures: number; refreshNextAt: string | null }>>('kernel.channel.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
      expect(afterSuccess.find((c) => c.id === id)).toMatchObject({ refreshError: null, refreshFailures: 0, refreshNextAt: null });

      // Reconnecting an account while in backoff also clears the failure counter and backoff.
      succeed = false;
      code = '503';
      for (let i = 0; i < 3; i += 1) await sweep();
      expect(await row(id)).toMatchObject({ refresh_failures: 3, refresh_last_error: '503' });
      expect((await row(id))?.refresh_next_at).not.toBeNull();
      const accountRow = await admin((c) => c.query<{ external_account_id: string }>('SELECT external_account_id FROM ludy_kernel.channel_connection WHERE id = $1', [id]));
      const account = accountRow.rows[0]?.external_account_id as string;
      const resealed = vault.seal(JSON.stringify({ accessToken: 'a-re', refreshToken: 'r-re' }), { orgId: o.orgId, provider: 'zalo_oa', externalAccountId: account });
      await api.execute(
        'kernel.channel.connect',
        {
          provider: 'zalo_oa',
          externalAccountId: account,
          displayName: 'Zalo OA',
          scopes: ['oa'],
          expiresAt: new Date(Date.now() + HOUR).toISOString(),
          credential: { keyId: resealed.keyId, envelope: resealed.envelope.toString('base64') },
        },
        { actor: asUser(o.owner), orgId: o.orgId },
      );
      expect(await row(id)).toMatchObject({ refresh_failures: 0, refresh_last_error: null, refresh_next_at: null });
    } finally {
      warnSpy.mockRestore();
    }
  });
});