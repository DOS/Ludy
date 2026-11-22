// SPDX-License-Identifier: AGPL-3.0-only
// The results reads of the MCP endpoint (#3860, E1 of #3857) as the runtime runs them for a grant: `social.mcp.metrics_summary` (ludy_social_metrics_summary), `social.mcp.metrics_totals`
// (ludy_social_metrics_totals), `ads.mcp.spend` (ludy_ads_spend), `ads.mcp.flags` (ludy_ads_flags) and `ads.mcp.today` (ludy_ads_today). All five are R0 reads for the consenting owner or admin of a
// company grant; this test pins what the projections add on top of the screens' loaders: the exact keys, that every text is one plain line, that nothing beyond the privacy review leaves (the full
// text of a post, an unpublished or another org's post, the connection of an ad account), the filters and their hard maximums, and who may read (a person who is only a member or a viewer is refused
// even on a member-bound grant; a browser session and a grant without the scope are refused). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { adsCommands, adsQueries } from '@ludy/mod-ads';
import { MCP_EXCERPT_MAX, socialCommands, socialQueries } from '@ludy/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const CANARY = 'BÍ MẬT-3860';
// A character a person cannot see or that breaks the line, but a model reads.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ZWSP = '​';
const RLO = '‮';
const BEL = '\u0007';
const DAY = 86_400_000;

const SUMMARY_ROW_KEYS = ['capturedAt', 'clicks', 'connectionId', 'excerpt', 'externalUrl', 'metrics', 'postId', 'provider', 'publishedAt', 'variantId'];
const SUMMARY_KEYS = ['rows', 'truncated'];
const TOTALS_KEYS = ['channels', 'channelsTruncated', 'clicks', 'days', 'metrics', 'posts', 'previous', 'rateBases'];
const PREVIOUS_KEYS = ['channels', 'channelsTruncated', 'clicks', 'metrics', 'posts', 'rateBases'];
const CHANNEL_TOTALS_KEYS = ['clicks', 'connectionId', 'metrics', 'posts', 'provider', 'rateBases'];
const ACCOUNT_KEYS = ['currency', 'id', 'name', 'resultKind', 'syncedThrough', 'timeZone'];
const SPEND_KEYS = ['accounts', 'accountsTruncated', 'summary'];
const SUMMARY_OF_ACCOUNT_KEYS = ['adAccountId', 'campaigns', 'currency', 'days', 'from', 'months', 'resultKind', 'settledThrough', 'syncedThrough', 'timeZone', 'to', 'total'];

interface MetricsRow {
  variantId: string;
  postId: string;
  provider: string;
  connectionId: string;
  excerpt: string;
  publishedAt: string | null;
  externalUrl: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
  clicks: number | null;
  [key: string]: unknown;
}
interface MetricsSummary {
  rows: MetricsRow[];
  truncated: boolean;
}
interface Window {
  posts: number;
  metrics: Record<string, number>;
  clicks: number | null;
  rateBases: Record<string, unknown>;
  channels: Array<{ connectionId: string; provider: string; posts: number; metrics: Record<string, number>; clicks: number | null; rateBases: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}
interface Totals extends Window {
  days: number;
  previous: Window;
}
interface Metric {
  spend: string;
  impressions: number;
  clicks: number;
  results: string | null;
  costPerResult: string | null;
  [key: string]: unknown;
}
interface Account {
  id: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
  resultKind: string | null;
  syncedThrough: string | null;
  [key: string]: unknown;
}
interface Spend {
  accounts: Account[];
  accountsTruncated: boolean;
  summary: {
    adAccountId: string;
    total: Metric;
    months: Array<Metric & { month: string }>;
    campaigns: Array<Metric & { externalObjectId: string; name: string }>;
    days: Array<Metric & { day: string }>;
    [key: string]: unknown;
  } | null;
}
interface Flag {
  kind: string;
  [key: string]: unknown;
}
interface Item {
  id: string;
  title: { key: string; params: Record<string, unknown> };
  [key: string]: unknown;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, days: number): string => isoDay(Date.parse(`${iso}T00:00:00Z`) + days * DAY);

suite('the results MCP reads: Social metrics and Ads spend, flags and today (#3860)', () => {
  const dbName = `crove_test_engage_mcp_results_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  const orgs = { a: '', b: '', c: '', d: '' };
  const users: Record<string, string> = {};
  const conn: Record<string, string> = {};
  const post: Record<string, string> = {};
  const acct: Record<string, string> = {};
  // Yesterday in the Ho Chi Minh City time zone of the main ad account: the day the flags judge.
  const yesterday = addDays(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }), -1);
  let longText = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  let counter = 0;
  async function grant(org: string, userId: string, kind: 'company' | 'member'): Promise<UserActor> {
    const id = randomUUID();
    counter += 1;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', $3, $6, $7)`,
      [org, id, userId, `client-${counter}-${id}`, `oauth-${id}`, kind, kind === 'member' ? userId : null],
    );
    return { type: 'user', userId, aal: 'aal1', mcp: { grantId: id, clientId: 'client', clientName: 'Test client', scopes: ['ludy.read'], kind } };
  }
  const as = async (who: string, kind: 'company' | 'member' = 'company', org = orgs.a) => ({ actor: await grant(org, users[who] as string, kind), orgId: org });
  const browser = (who: string, org = orgs.a) => ({ actor: { type: 'user', userId: users[who] as string, aal: 'aal1' } as UserActor, orgId: org });
  const summary = async (input: unknown = {}, who = 'owner', org = orgs.a) => runtime.query<MetricsSummary>('social.mcp.metrics_summary', input, await as(who, 'company', org));
  const totals = async (input: unknown = {}, who = 'owner', org = orgs.a) => runtime.query<Totals>('social.mcp.metrics_totals', input, await as(who, 'company', org));
  const spend = async (input: unknown = {}, who = 'owner', org = orgs.a) => runtime.query<Spend>('ads.mcp.spend', input, await as(who, 'company', org));
  const flags = async (input: unknown = {}, who = 'owner', org = orgs.a) => runtime.query<{ flags: Flag[]; truncated: boolean }>('ads.mcp.flags', input, await as(who, 'company', org));
  const today = async (input: unknown = {}, who = 'owner', org = orgs.a) => runtime.query<{ items: Item[] }>('ads.mcp.today', input, await as(who, 'company', org));
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  async function channel(orgId: string, owner: string, name: string, provider = 'sandbox', external = `acct-${randomUUID().slice(0, 8)}`) {
    const id = randomUUID();
    await sqlAdmin('INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, provider, external, name, owner]);
    return id;
  }

  // A post that went out `secs` seconds ago on a channel, with the counts a snapshot holds (an older, smaller capture first, so the latest is the one shown) and the clicks of a short link when given.
  async function published(orgId: string, owner: string, connectionId: string, secs: number, body: string, metrics: Record<string, number> | null, opts: { url?: string; clicks?: number } = {}) {
    const { postId } = await runtime.execute<{ postId: string }>('social.post.create', { body, channels: [{ connectionId }] }, { actor: { type: 'user', userId: owner, aal: 'aal1' }, orgId });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() - make_interval(secs => $2), external_url = $3 WHERE org_id = $4 AND post_id = $1 RETURNING id", [postId, secs, opts.url ?? null, orgId]);
      const id = rows[0]?.id as string;
      await c.query("UPDATE crove_social.post SET status = 'published' WHERE org_id = $1 AND id = $2", [orgId, postId]);
      if (metrics !== null) {
        await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics, captured_at) VALUES ($1, $2, 'old', '{\"reach\": 1}', now() - interval '2 days')", [orgId, id]);
        await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'new', $3)", [orgId, id, JSON.stringify(metrics)]);
      }
      if (opts.clicks !== undefined) {
        const link = await c.query<{ id: string }>("INSERT INTO crove_social.short_link (org_id, code, variant_id, revision, post_id, target_url) VALUES ($1, $2, $3, 1, $4, 'https://shop.example/') RETURNING id", [
          orgId,
          randomUUID().replace(/-/g, '').slice(0, 12),
          id,
          postId,
        ]);
        await c.query('INSERT INTO crove_social.short_link_click (org_id, short_link_id, day, clicks) VALUES ($1, $2, current_date, $3)', [orgId, link.rows[0]?.id, opts.clicks]);
      }
    });
    return postId;
  }

  async function adAccount(orgId: string, owner: string, o: { name: string; currency: string | null; timeZone: string | null; resultKind?: string | null; syncedThrough?: string | null; connectionName?: string; external?: string }) {
    const connectionId = await channel(orgId, owner, o.connectionName ?? 'Kết nối quảng cáo', 'sandbox_ads', o.external ?? `act-${randomUUID().slice(0, 8)}`);
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone, result_kind, synced_through)
       VALUES ($1, $2, $3, 'sandbox_ads', $4, $5, '2025-10-01', $6, $7, $8, $9)`,
      [orgId, id, connectionId, o.external ?? `act-${randomUUID().slice(0, 8)}`, o.name, o.currency, o.timeZone, o.resultKind ?? null, o.syncedThrough ?? null],
    );
    return id;
  }
  const spendDay = (orgId: string, accountId: string, level: 'account' | 'campaign', objectId: string, name: string, day: string, amount: string, purchases: string | null = null) =>
    sqlAdmin(
      `INSERT INTO crove_ads.ad_spend_day (org_id, ad_account_id, level, external_object_id, object_name, day, currency, spend, impressions, clicks, results)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', $7, 1000, 10, $8::jsonb)`,
      [orgId, accountId, level, objectId, name, day, amount, purchases === null ? '{}' : JSON.stringify({ purchase: purchases })],
    );

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, ...adsQueries] });
    for (const key of ['owner', 'admin', 'member', 'viewer', 'foreign']) {
      users[key] = await upsertIdentity(db, { issuer: 'engage-mcp-results', subject: key, email: `${key}@engage-mcp-results.test`, name: key });
    }
    const asUser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
    orgs.a = (await createOrg(runtime, asUser('owner'), 'Org A')).orgId;
    orgs.b = (await createOrg(runtime, asUser('foreign'), 'Org B')).orgId;
    orgs.c = (await createOrg(runtime, asUser('owner'), 'Org C (many posts)')).orgId;
    orgs.d = (await createOrg(runtime, asUser('owner'), 'Org D (archived)')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgs.a, users.admin, users.member, users.viewer]);
    // The org's member grants are on, so a member or a viewer may connect their own AI app (the access test needs those grants to exist).
    await sqlAdmin('UPDATE ludy_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1', [orgs.a]);

    // ---- Social, org A: channels and published posts.
    conn.a1 = await channel(orgs.a, users.owner as string, 'Trang A một');
    conn.a2 = await channel(orgs.a, users.owner as string, 'Trang A hai');
    conn.b1 = await channel(orgs.b, users.foreign as string, 'Trang của tổ chức B');
    conn.c1 = await channel(orgs.c, users.owner as string, 'Trang C');
    conn.d1 = await channel(orgs.d, users.owner as string, 'Trang D');
    // A text with characters a person cannot see, longer than the excerpt, with a canary far past it.
    longText = `Khuyến mãi lớn${ZWSP}${RLO}${BEL} ${'Dài '.repeat(60)}${CANARY}`;
    expect(longText.indexOf(CANARY)).toBeGreaterThan(200);
    post.long = await published(orgs.a, users.owner as string, conn.a1, 2 * 86_400, longText, { reach: 600, reactions: 30 }, { url: 'https://facebook.example/p/1', clicks: 5 });
    post.short = await published(orgs.a, users.owner as string, conn.a1, 5 * 86_400, 'Bài ngắn', { reach: 100 });
    post.ten = await published(orgs.a, users.owner as string, conn.a2, 10 * 86_400, 'Bài mười ngày', { reach: 40, views: 4 });
    post.old = await published(orgs.a, users.owner as string, conn.a1, 40 * 86_400, 'Bài cũ', { reach: 9 });
    // Never shown: a draft, an archived draft, a channel cancelled, and another org's published post.
    const create = async (orgId: string, owner: string, connectionId: string, body: string) =>
      (await runtime.execute<{ postId: string }>('social.post.create', { body, channels: [{ connectionId }] }, { actor: { type: 'user', userId: owner, aal: 'aal1' }, orgId })).postId;
    post.draft = await create(orgs.a, users.owner as string, conn.a1, `Bản nháp chưa đăng ${CANARY}-NHÁP`);
    post.archivedDraft = await create(orgs.a, users.owner as string, conn.a1, `Bản nháp đã lưu trữ ${CANARY}-LƯU`);
    await runtime.execute('social.post.archive', { postId: post.archivedDraft }, { actor: asUser('owner'), orgId: orgs.a });
    post.cancelled = await create(orgs.a, users.owner as string, conn.a1, `Kênh đã hủy ${CANARY}-HỦY`);
    await sqlAdmin("UPDATE crove_social.post_variant SET status = 'cancelled' WHERE org_id = $1 AND post_id = $2", [orgs.a, post.cancelled]);
    post.other = await published(orgs.b, users.foreign as string, conn.b1, 86_400, `Bài của tổ chức B ${CANARY}-ORGB`, { reach: 7000, reactions: 700 }, { clicks: 70 });
    // A post the channel published outside Ludy, 3 days ago, with its latest counts; and one of another org's.
    await sqlAdmin(
      "INSERT INTO crove_social.external_post (org_id, channel_connection_id, external_post_id, excerpt, permalink, published_at, metrics, captured_at) VALUES ($1, $2, 'ext-3860', 'Đăng thẳng', 'https://www.facebook.com/ext-3860', now() - interval '3 days', '{\"reach\": 7}', now())",
      [orgs.a, conn.a1],
    );
    await sqlAdmin(
      "INSERT INTO crove_social.external_post (org_id, channel_connection_id, external_post_id, excerpt, permalink, published_at, metrics, captured_at) VALUES ($1, $2, 'ext-b', 'Của B', 'https://www.facebook.com/ext-b', now() - interval '3 days', '{\"reach\": 5000}', now())",
      [orgs.b, conn.b1],
    );
    // Org C: 52 published posts, a minute apart, for the limits.
    for (let i = 0; i < 52; i++) await create(orgs.c, users.owner as string, conn.c1, `Bài số ${i}`);
    await sqlAdmin(
      `UPDATE crove_social.post_variant v SET status = 'published', published_at = now() - make_interval(mins => r.n::int)
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM crove_social.post_variant WHERE org_id = $1) r WHERE v.org_id = $1 AND v.id = r.id`,
      [orgs.c],
    );
    // Org D: a post that went out and was archived afterwards.
    post.archivedPublished = await published(orgs.d, users.owner as string, conn.d1, 3 * 86_400, `Bài đã đăng rồi lưu trữ ${CANARY}-ĐĐ`, { reach: 11 });
    await runtime.execute('social.post.archive', { postId: post.archivedPublished }, { actor: asUser('owner'), orgId: orgs.d });

    // ---- Ads, org A: a main account (VND, Ho Chi Minh City, a result chosen, synced through yesterday) whose connection and platform number carry canaries, one never synced, and one with 51 campaigns.
    acct.main = await adAccount(orgs.a, users.owner as string, { name: `Tài khoản${ZWSP} chính${RLO}`, currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', resultKind: 'purchase', syncedThrough: yesterday, connectionName: `${CANARY}-kết nối`, external: `act-${CANARY}` });
    acct.fresh = await adAccount(orgs.a, users.owner as string, { name: 'Chưa đồng bộ', currency: null, timeZone: null });
    acct.many = await adAccount(orgs.a, users.owner as string, { name: 'Nhiều chiến dịch', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' });
    for (let k = 0; k <= 19; k++) await spendDay(orgs.a, acct.main as string, 'account', 'acct', 'Tài khoản', addDays(yesterday, -k), '10000');
    // Campaign one: 1 000 a result for 14 days, then 3 000 for the last 3 days (a cost per result that jumped); campaign two stays at 1 000.
    for (let k = 0; k <= 16; k++) {
      await spendDay(orgs.a, acct.main as string, 'campaign', 'c1', `Chiến dịch A${ZWSP}${RLO}${BEL}`, addDays(yesterday, -k), k <= 2 ? '300000' : '100000', '100');
      await spendDay(orgs.a, acct.main as string, 'campaign', 'c2', 'Chiến dịch B', addDays(yesterday, -k), '100000', '100');
    }
    // A daily cap of 5 000 against the 10 000 spent yesterday.
    await sqlAdmin(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, 'account', $2, 'daily', '5000', 'VND', $3)`, [orgs.a, acct.main, users.owner]);
    await sqlAdmin(
      `INSERT INTO crove_ads.ad_spend_day (org_id, ad_account_id, level, external_object_id, object_name, day, currency, spend, impressions, clicks, results)
       SELECT $1, $2, 'campaign', 'camp-' || g, 'Chiến dịch ' || g, $3::date, 'VND', g * 100, 0, 0, '{}'::jsonb FROM generate_series(1, 51) g`,
      [orgs.a, acct.many, yesterday],
    );
    // Org B: an account with figures and nothing to flag (no cap, no result chosen).
    acct.other = await adAccount(orgs.b, users.foreign as string, { name: 'Tài khoản của B', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', syncedThrough: yesterday });
    await spendDay(orgs.b, acct.other as string, 'account', 'acct', 'Tài khoản B', yesterday, '99999');
  }, 600_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('social.mcp.metrics_summary', () => {
    it('lists the published channel copies of the window for an owner and an admin, the newest first, and none of another org', async () => {
      const got = await summary();
      expect(got.rows.map((r) => r.postId)).toEqual([post.long, post.short, post.ten]);
      expect(got.truncated).toBe(false);
      expect((await summary({}, 'admin')).rows.map((r) => r.postId)).toEqual([post.long, post.short, post.ten]);
      const times = got.rows.map((r) => Date.parse(r.publishedAt as string));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const first = got.rows[0] as MetricsRow;
      expect(first).toMatchObject({ connectionId: conn.a1, provider: 'sandbox', externalUrl: 'https://facebook.example/p/1', metrics: { reach: 600, reactions: 30 }, clicks: 5 });
      expect(first.capturedAt).not.toBeNull();
      // A copy without a short link has no clicks, one without a snapshot of its own answer is not in the window here, and the latest real capture is the one shown, not the older.
      expect((got.rows[1] as MetricsRow).clicks).toBeNull();
      expect((got.rows[1] as MetricsRow).metrics).toEqual({ reach: 100 });
      expect(JSON.stringify(got)).not.toContain(post.other as string);
      expect((await summary({}, 'foreign', orgs.b)).rows.map((r) => r.postId)).toEqual([post.other]);
    });

    it('returns exactly the keys of the answer and of a row', async () => {
      const got = await summary();
      expect(Object.keys(got).sort()).toEqual(SUMMARY_KEYS);
      expect(got.rows.length).toBeGreaterThan(0);
      for (const row of got.rows) expect(Object.keys(row).sort(), row.postId).toEqual(SUMMARY_ROW_KEYS);
    });

    it('shows a post\'s text as one plain line of at most 160 characters, and never the full text', async () => {
      const got = await summary();
      const row = got.rows.find((r) => r.postId === post.long) as MetricsRow;
      expect(row.excerpt.startsWith('Khuyến mãi lớn')).toBe(true);
      expect(row.excerpt).not.toMatch(HIDDEN);
      expect([...row.excerpt].length).toBeLessThanOrEqual(MCP_EXCERPT_MAX);
      expect(MCP_EXCERPT_MAX).toBe(160);
      expect(JSON.stringify(got)).not.toContain(CANARY);
      expect(JSON.stringify(got)).not.toMatch(HIDDEN);
      for (const r of got.rows) expect(r.excerpt, r.postId).not.toMatch(HIDDEN);
    });

    it('filters by days and by post (a post is found whenever it went out)', async () => {
      expect((await summary({ days: 3 })).rows.map((r) => r.postId)).toEqual([post.long]);
      expect((await summary({ days: 7 })).rows.map((r) => r.postId)).toEqual([post.long, post.short]);
      expect((await summary({ days: 365 })).rows.map((r) => r.postId)).toEqual([post.long, post.short, post.ten, post.old]);
      expect((await summary({ postId: post.short })).rows.map((r) => r.postId)).toEqual([post.short]);
      // The post of 40 days ago is outside the default 30 days, but asked for by id it is listed, whatever `days` says.
      expect((await summary({ days: 1, postId: post.old })).rows.map((r) => r.postId)).toEqual([post.old]);
      // Another org's post, or a post that does not exist, finds nothing.
      expect((await summary({ postId: post.other })).rows).toEqual([]);
      expect((await summary({ postId: randomUUID() })).rows).toEqual([]);
    });

    it('caps the rows: 25 by default, up to 50 on request, 51 refused, and says when there are more', async () => {
      const byDefault = await summary({}, 'owner', orgs.c);
      expect(byDefault.rows).toHaveLength(25);
      expect(byDefault.truncated).toBe(true);
      const fifty = await summary({ limit: 50 }, 'owner', orgs.c);
      expect(fifty.rows).toHaveLength(50);
      expect(fifty.truncated).toBe(true);
      const times = fifty.rows.map((r) => Date.parse(r.publishedAt as string));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect((await refusal(summary({ limit: 51 }, 'owner', orgs.c))).status).toBeLessThan(500);
      expect((await refusal(summary({ limit: 0 }))).status).toBeLessThan(500);
      // Exactly as many as asked for is not truncated; one fewer is.
      expect(await summary({ limit: 3 })).toMatchObject({ truncated: false });
      expect((await summary({ limit: 3 })).rows).toHaveLength(3);
      expect(await summary({ limit: 2 })).toMatchObject({ truncated: true });
      expect((await summary({ limit: 2 })).rows).toHaveLength(2);
    });

    it('never shows a draft, an archived post, a cancelled channel or another org\'s post', async () => {
      const everything = JSON.stringify(await summary({ days: 365, limit: 50 }));
      for (const id of [post.draft, post.archivedDraft, post.cancelled, post.other]) expect(everything).not.toContain(id as string);
      expect(everything).not.toContain(CANARY);
      expect((await summary({ postId: post.draft })).rows).toEqual([]);
      expect((await summary({ postId: post.archivedDraft })).rows).toEqual([]);
      expect((await summary({ postId: post.cancelled })).rows).toEqual([]);
    });

    // The privacy review of the tool says an archived copy is never returned, but the query keeps no filter on the post's archived_at, and the Social module says a published post that was archived stays
    // in metrics and reports. So a post that went out and was archived is listed: marked `fails` until the query leaves it out (or the review text is changed to match the screens).
    it('does not show a post that went out and was archived afterwards', async () => {
      const got = await summary({ days: 365 }, 'owner', orgs.d);
      expect(got.rows.map((r) => r.postId)).not.toContain(post.archivedPublished);
    });

    it('refuses an argument outside the schema', async () => {
      for (const bad of [{ days: 366 }, { days: 0 }, { days: 1.5 }, { postId: 'not-an-id' }, { labelId: randomUUID() }, { orgId: orgs.b }, { limit: 'many' }]) {
        expect((await refusal(summary(bad))).status, JSON.stringify(bad)).toBeLessThan(500);
      }
    });
  });

  describe('social.mcp.metrics_totals', () => {
    it('returns exactly the keys of the answer, of the previous window and of a channel, with counts as numbers', async () => {
      const got = await totals();
      expect(Object.keys(got).sort()).toEqual(TOTALS_KEYS);
      expect(Object.keys(got.previous).sort()).toEqual(PREVIOUS_KEYS);
      expect(got.days).toBe(30);
      expect(typeof got.posts).toBe('number');
      expect(typeof got.previous.posts).toBe('number');
      for (const channelTotals of [...got.channels, ...got.previous.channels]) {
        expect(Object.keys(channelTotals).sort()).toEqual(CHANNEL_TOTALS_KEYS);
        expect(typeof channelTotals.posts).toBe('number');
        for (const value of Object.values(channelTotals.metrics)) expect(typeof value).toBe('number');
      }
      for (const value of Object.values(got.metrics)) expect(typeof value).toBe('number');
    });

    it('sums the window and the window of the same length just before it, in total and per channel', async () => {
      const got = await totals({ days: 30 });
      expect(got).toMatchObject({ days: 30, posts: 3, metrics: { reach: 740, reactions: 30, views: 4 }, clicks: 5 });
      expect(got.channels.map((c) => [c.connectionId, c.provider, c.posts, c.metrics, c.clicks])).toEqual([
        [conn.a1, 'sandbox', 2, { reach: 700, reactions: 30 }, 5],
        [conn.a2, 'sandbox', 1, { reach: 40, views: 4 }, null],
      ]);
      // The window before (30 to 60 days ago) holds the post of 40 days ago; the channels are the same list in both.
      expect(got.previous).toMatchObject({ posts: 1, metrics: { reach: 9 }, clicks: null });
      expect(got.previous.channels.map((c) => [c.connectionId, c.posts])).toEqual([
        [conn.a1, 1],
        [conn.a2, 0],
      ]);
      // The default window is 30 days.
      expect(await totals({})).toEqual(got);
      // A 7-day window: the posts of 2 and 5 days ago, against the week before it (the post of 10 days ago).
      expect(await totals({ days: 7 })).toMatchObject({ days: 7, posts: 2, metrics: { reach: 700, reactions: 30 }, previous: { posts: 1, metrics: { reach: 40, views: 4 } } });
      // An admin reads the same.
      expect(await totals({ days: 30 }, 'admin')).toEqual(got);
    });

    it('counts the posts published outside Ludy only when asked for', async () => {
      const own = await totals({ days: 30 });
      expect(await totals({ days: 30, includeExternal: false })).toEqual(own);
      const withExternal = await totals({ days: 30, includeExternal: true });
      expect(withExternal).toMatchObject({ posts: own.posts + 1, metrics: { reach: 747, reactions: 30, views: 4 } });
      expect(withExternal.channels.find((c) => c.connectionId === conn.a1)).toMatchObject({ posts: 3, metrics: { reach: 707, reactions: 30 } });
      // The outside post has no clicks: the clicks stay those of Ludy's own.
      expect(withExternal.clicks).toBe(own.clicks);
      expect(Object.keys(withExternal).sort()).toEqual(TOTALS_KEYS);
    });

    it('counts nothing of another org', async () => {
      const mine = JSON.stringify(await totals({ days: 365, includeExternal: true }));
      expect(mine).not.toContain('7000');
      expect(mine).not.toContain('5000');
      expect(mine).not.toContain(conn.b1 as string);
      expect(await totals({ days: 30, includeExternal: true }, 'foreign', orgs.b)).toMatchObject({ posts: 2, metrics: { reach: 12000, reactions: 700 }, clicks: 70 });
      expect(await totals({ days: 30 }, 'foreign', orgs.b)).toMatchObject({ posts: 1, metrics: { reach: 7000, reactions: 700 } });
    });

    it('refuses an argument outside the schema', async () => {
      for (const bad of [{ days: 366 }, { days: 0 }, { includeExternal: 'yes' }, { labelId: randomUUID() }, { orgId: orgs.b }]) {
        expect((await refusal(totals(bad))).status, JSON.stringify(bad)).toBeLessThan(500);
      }
    });
  });

  describe('ads.mcp.spend', () => {
    it('leaves a fallback account name (made when the platform gave none) as its label, never with the platform\'s account number', async () => {
      const fallback = await adAccount(orgs.a, users.owner as string, { name: 'Meta ad account 1234567890123', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' });
      try {
        const got = await spend();
        expect(got.accounts.find((a) => a.id === fallback)?.name).toBe('Meta ad account');
        expect(JSON.stringify(got)).not.toContain('1234567890123');
      } finally {
        await sqlAdmin('DELETE FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2', [orgs.a, fallback]);
      }
    });

    it('without an account lists the org\'s ad accounts, with no summary', async () => {
      const got = await spend();
      expect(Object.keys(got).sort()).toEqual(SPEND_KEYS);
      expect(got.summary).toBeNull();
      expect(got.accountsTruncated).toBe(false);
      expect(got.accounts.map((a) => a.id).sort()).toEqual([acct.main, acct.fresh, acct.many].sort());
      for (const a of got.accounts) expect(Object.keys(a).sort(), a.id).toEqual(ACCOUNT_KEYS);
      expect(got.accounts.find((a) => a.id === acct.main)).toEqual({ id: acct.main, name: 'Tài khoản chính', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', resultKind: 'purchase', syncedThrough: yesterday });
      expect(got.accounts.find((a) => a.id === acct.fresh)).toEqual({ id: acct.fresh, name: 'Chưa đồng bộ', currency: null, timeZone: null, resultKind: null, syncedThrough: null });
      expect(JSON.stringify(got)).not.toContain(acct.other as string);
      expect((await spend({}, 'admin')).accounts).toHaveLength(3);
    });

    it('with an account returns its summary: money as decimal strings, by month, by campaign (the most spending first) and by day', async () => {
      const from = addDays(yesterday, -19);
      const got = await spend({ adAccountId: acct.main, from, to: yesterday });
      const s = got.summary as NonNullable<Spend['summary']>;
      expect(Object.keys(s).sort()).toEqual(SUMMARY_OF_ACCOUNT_KEYS);
      expect(s).toMatchObject({ adAccountId: acct.main, currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', resultKind: 'purchase', from, to: yesterday, syncedThrough: yesterday });
      expect(s.total.spend).toBe('200000');
      expect(typeof s.total.spend).toBe('string');
      expect(s.days).toHaveLength(20);
      expect(s.days.map((d) => d.day)).toEqual(s.days.map((d) => d.day).sort());
      for (const d of s.days) expect(d.spend).toBe('10000');
      expect(s.months.length).toBeGreaterThanOrEqual(1);
      expect(s.months.reduce((sum, m) => sum + Number(m.spend), 0)).toBe(200000);
      // Campaign one spent 14 x 100 000 and 3 x 300 000; campaign two 17 x 100 000: the one that spent more is first.
      expect(s.campaigns.map((c) => [c.externalObjectId, c.spend])).toEqual([
        ['c1', '2300000'],
        ['c2', '1700000'],
      ]);
      for (const c of s.campaigns) for (const money of [c.spend, c.costPerResult]) expect(typeof money).toBe('string');
      expect(Object.keys(got).sort()).toEqual(SPEND_KEYS);
      // The default stretch is the 30 days up to today.
      const byDefault = (await spend({ adAccountId: acct.main })).summary as NonNullable<Spend['summary']>;
      expect(byDefault.total.spend).toBe('200000');
    });

    it('lists at most 50 campaigns, the most spending first', async () => {
      const s = (await spend({ adAccountId: acct.many, from: addDays(yesterday, -1), to: yesterday })).summary as NonNullable<Spend['summary']>;
      expect(s.campaigns).toHaveLength(50);
      expect(s.campaigns[0]?.externalObjectId).toBe('camp-51');
      // The one that spent least is the one left out.
      expect(s.campaigns.map((c) => c.externalObjectId)).not.toContain('camp-1');
      expect(s.campaigns.map((c) => c.externalObjectId)).toContain('camp-2');
    });

    it('refuses a stretch of 94 days, accepts 93, and refuses a stretch that ends before it begins', async () => {
      const to = yesterday;
      const tooLong = await refusal(spend({ adAccountId: acct.main, from: addDays(to, -93), to }));
      expect(tooLong.code).toBe('ADS_RANGE_INVALID');
      expect(tooLong.status).toBeLessThan(500);
      const ok = await spend({ adAccountId: acct.main, from: addDays(to, -92), to });
      expect(ok.summary?.days).toHaveLength(20);
      expect((await refusal(spend({ adAccountId: acct.main, from: to, to: addDays(to, -1) }))).code).toBe('ADS_RANGE_INVALID');
      expect((await refusal(spend({ adAccountId: acct.main, from: 'yesterday' }))).status).toBeLessThan(500);
    });

    it('answers account not found for an account of another org, or one that does not exist, the same', async () => {
      const other = await refusal(spend({ adAccountId: acct.other }));
      const none = await refusal(spend({ adAccountId: randomUUID() }));
      expect(other.code).toBe('ADS_ACCOUNT_NOT_FOUND');
      expect(other.status).toBe(404);
      expect(none.code).toBe(other.code);
    });

    it('shows account and campaign names as one plain line and nothing of the connection', async () => {
      const listed = await spend();
      const detail = await spend({ adAccountId: acct.main, from: addDays(yesterday, -19), to: yesterday });
      const s = detail.summary as NonNullable<Spend['summary']>;
      expect(s.campaigns.find((c) => c.externalObjectId === 'c1')?.name).toBe('Chiến dịch A');
      for (const a of listed.accounts) expect(a.name, a.id).not.toMatch(HIDDEN);
      for (const c of s.campaigns) expect(c.name, c.externalObjectId).not.toMatch(HIDDEN);
      expect(JSON.stringify(listed)).not.toMatch(HIDDEN);
      expect(JSON.stringify(detail)).not.toMatch(HIDDEN);
      // The canaries sit in the connection's name and the platform's account number: neither may ever be in an answer, and no connection field is.
      for (const answer of [listed, detail]) {
        const json = JSON.stringify(answer);
        expect(json).not.toContain(CANARY);
        expect(json).not.toMatch(/connection|token|externalAccountId|external_account_id/i);
      }
    });

    it('refuses an argument outside the schema', async () => {
      for (const bad of [{ orgId: orgs.b }, { adAccountId: 'not-an-id' }, { campaigns: 500 }, { limit: 10 }]) {
        expect((await refusal(spend(bad))).status, JSON.stringify(bad)).toBeLessThan(500);
      }
    });
  });

  describe('ads.mcp.flags and ads.mcp.today', () => {
    it('raises the flags the figures call for, with the account\'s own currency, money as decimal strings and plain names', async () => {
      const got = await flags();
      expect(Object.keys(got).sort()).toEqual(['flags', 'truncated']);
      expect(got.truncated).toBe(false);
      // The day over its share of the daily cap, then the cost per result that jumped (pace needs days of the month behind it, so it is not seeded: the date of the run would decide).
      expect(got.flags.map((f) => f.kind)).toEqual(['day', 'cpr']);
      expect(got.flags[0]).toEqual({ kind: 'day', scope: 'account', adAccountId: acct.main, accountName: 'Tài khoản chính', currency: 'VND', skippedAccounts: 0, period: 'daily', cap: '5000', share: '5000', day: yesterday, spend: '10000', ratio: '2.00' });
      expect(got.flags[1]).toMatchObject({ kind: 'cpr', adAccountId: acct.main, accountName: 'Tài khoản chính', campaignId: 'c1', campaignName: 'Chiến dịch A', currency: 'VND', day: yesterday, recentCost: '3000', medianCost: '1000', ratio: '3.00', recentResults: '300', historyDays: 14 });
      const json = JSON.stringify(got);
      expect(json).not.toMatch(HIDDEN);
      expect(json).not.toContain(CANARY);
      expect(json).not.toContain(acct.other as string);
      // An admin reads the same.
      expect(await flags({}, 'admin')).toEqual(got);
    });

    it('lists what needs a person today as the items Home shows, message keys with params, names plain', async () => {
      const got = await today();
      expect(Object.keys(got)).toEqual(['items']);
      expect(got.items.map((i) => i.id)).toEqual([`day:${acct.main}:daily`, `cpr:${acct.main}:c1`]);
      expect(got.items[0]).toMatchObject({ kind: 'flag', app: 'ads', title: { key: 'ads.dayAccountDaily', params: { account: 'Tài khoản chính', ratio: '2.00', day: yesterday } }, amount: '10000', currency: 'VND', severity: 'warn', href: '/ads' });
      expect(got.items[1]).toMatchObject({ kind: 'flag', app: 'ads', title: { key: 'ads.cpr', params: { campaign: 'Chiến dịch A', account: 'Tài khoản chính', ratio: '3.00' } }, severity: 'warn', href: '/ads' });
      const json = JSON.stringify(got);
      expect(json).not.toMatch(HIDDEN);
      expect(json).not.toContain(CANARY);
      expect(await today({}, 'admin')).toEqual(got);
    });

    it('answers empty lists when there is nothing to flag: an account without a cap or a result chosen, and an org without an ad account', async () => {
      // Org B has an account with yesterday's figures but no cap and no result kind; org C has no ad account at all.
      for (const [who, org] of [['foreign', orgs.b], ['owner', orgs.c]] as const) {
        expect(await flags({}, who, org)).toEqual({ flags: [], truncated: false });
        expect(await today({}, who, org)).toEqual({ items: [] });
      }
    });

    it('takes an empty input only', async () => {
      for (const bad of [{ now: '2026-11-10T05:00:00.000Z' }, { orgId: orgs.b }, { limit: 1 }]) {
        expect((await refusal(flags(bad))).status, `flags ${JSON.stringify(bad)}`).toBeLessThan(500);
        expect((await refusal(today(bad))).status, `today ${JSON.stringify(bad)}`).toBeLessThan(500);
      }
    });
  });

  describe('ads.mcp.pages', () => {
    interface PagesView {
      pages: Array<{ id: string; name: string }>;
      truncated: boolean;
    }
    const pages = async (who = 'owner', org = orgs.a, input: unknown = {}) => runtime.query<PagesView>('ads.mcp.pages', input, await as(who, 'company', org));

    it('lists the org\'s active Facebook Pages as an id and a plain-line name, and nothing else: not another provider, not a revoked Page, not another org\'s, no token or platform id', async () => {
      const owner = users.owner as string;
      const first = await channel(orgs.a, owner, `Trang${'\u200b'} Cà phê\n${CANARY}`, 'facebook_page', 'fb-page-111');
      const second = await channel(orgs.a, owner, 'Trang A', 'facebook_page', 'fb-page-222');
      // A Page whose own name starts like an ad account's fallback name keeps all of it (only an ad account's made-up name loses its platform id).
      const lookalike = await channel(orgs.a, owner, 'Meta ad account East', 'facebook_page', 'fb-page-555');
      const revoked = await channel(orgs.a, owner, 'Trang đã thu hồi', 'facebook_page', 'fb-page-333');
      await sqlAdmin(`UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2`, [orgs.a, revoked]);
      const notAPage = await channel(orgs.a, owner, 'Kênh khác', 'sandbox');
      const foreign = await channel(orgs.b, users.foreign as string, 'Trang của tổ chức khác', 'facebook_page', 'fb-page-444');
      const got = await pages();
      expect(Object.keys(got).sort()).toEqual(['pages', 'truncated']);
      expect(got.truncated).toBe(false);
      expect(got.pages.map((p) => p.id).sort()).toEqual([first, second, lookalike].sort());
      for (const page of got.pages) expect(Object.keys(page).sort()).toEqual(['id', 'name']);
      // Every name is one plain line (the invisible and line-breaking characters are gone); the Page's own words stay data.
      expect(got.pages.map((p) => p.name).sort()).toEqual(['Meta ad account East', 'Trang A', `Trang Cà phê ${CANARY}`]);
      const json = JSON.stringify(got);
      expect(json).not.toMatch(HIDDEN);
      for (const id of [revoked, notAPage, foreign]) expect(json).not.toContain(id);
      for (const word of ['fb-page-111', 'fb-page-222', 'fb-page-333', 'fb-page-444', 'token', 'credential', 'external']) expect(json, word).not.toContain(word);
      // An admin reads the same; the other org's owner reads its own Page only.
      expect(await pages('admin')).toEqual(got);
      expect((await pages('foreign', orgs.b)).pages.map((p) => p.id)).toEqual([foreign]);
    });

    it('answers an empty list for an org with no Page, and takes an empty input only', async () => {
      expect(await pages('owner', orgs.c)).toEqual({ pages: [], truncated: false });
      for (const bad of [{ orgId: orgs.b }, { limit: 1 }, { provider: 'sandbox' }]) expect((await refusal(pages('owner', orgs.a, bad))).status, JSON.stringify(bad)).toBeLessThan(500);
    });
  });

  describe('kernel.mcp.seats', () => {
    interface SeatsView {
      seats: Array<{ id: string; title: string }>;
      truncated: boolean;
    }
    const seats = async (who = 'owner', org = orgs.a, input: unknown = {}) => runtime.query<SeatsView>('kernel.mcp.seats', input, await as(who, 'company', org));
    const seat = async (orgId: string, title: string, status = 'active', role = 'finance.chief_accountant') => {
      const id = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, status, job_description) VALUES ($1, $2, $3, 'finance', $4, $5, '{"secret":"never leaves"}'::jsonb)`, [orgId, id, title, role, status]);
      return id;
    };

    it('lists the org chart\'s active seats as an id and a plain-line title, and nothing else: not a paused or archived seat, not another org\'s, no holder, role, job description or reporting line', async () => {
      const first = await seat(orgs.a, `Kế toán${'\u200b'} trưởng\n${CANARY}`);
      const second = await seat(orgs.a, 'Trưởng phòng bán hàng');
      const paused = await seat(orgs.a, 'Vị trí tạm dừng', 'paused');
      const archived = await seat(orgs.a, 'Vị trí đã lưu trữ', 'archived');
      const foreign = await seat(orgs.b, 'Vị trí của tổ chức khác');
      const got = await seats();
      expect(Object.keys(got).sort()).toEqual(['seats', 'truncated']);
      expect(got.truncated).toBe(false);
      expect(got.seats.map((s) => s.id)).toEqual([first, second]);
      for (const s of got.seats) expect(Object.keys(s).sort()).toEqual(['id', 'title']);
      // The title is one plain line (the invisible and line-breaking characters are gone); the people's own words stay data.
      expect(got.seats.map((s) => s.title)).toEqual([`Kế toán trưởng ${CANARY}`, 'Trưởng phòng bán hàng']);
      const json = JSON.stringify(got);
      expect(json).not.toMatch(HIDDEN);
      for (const id of [paused, archived, foreign]) expect(json).not.toContain(id);
      for (const word of ['never leaves', 'finance', 'chief_accountant', 'holder', 'reports', 'role']) expect(json, word).not.toContain(word);
      // An admin reads the same; the other org's owner reads its own seat only.
      expect(await seats('admin')).toEqual(got);
      expect((await seats('foreign', orgs.b)).seats.map((s) => s.id)).toEqual([foreign]);
    });

    it('answers an empty list for an org with no seat, and takes an empty input only', async () => {
      expect(await seats('owner', orgs.c)).toEqual({ seats: [], truncated: false });
      for (const bad of [{ orgId: orgs.b }, { limit: 1 }, { status: 'paused' }]) expect((await refusal(seats('owner', orgs.a, bad))).status, JSON.stringify(bad)).toBeLessThan(500);
    });

    it('is for an owner or an admin only: a member or a viewer is refused even on a company grant (the member-bound grants are refused with the other reads below)', async () => {
      for (const who of ['member', 'viewer']) {
        const error = await refusal(seats(who));
        // The grant of a member or a viewer is no company grant at all (its consenting user must be an owner or an admin), so the call is refused before the query: 401 or 403, never an answer.
        expect([401, 403], `company grant of ${who}`).toContain(error.status);
      }
      for (const who of ['owner', 'admin']) await expect(seats(who), who).resolves.toMatchObject({ truncated: false });
    });

    it('stops at 50 seats and says there are more', async () => {
      for (let i = 0; i < 51; i += 1) await seat(orgs.d, `Vị trí ${String(i).padStart(2, '0')}`);
      const got = await seats('owner', orgs.d);
      expect(got.seats).toHaveLength(50);
      expect(got.truncated).toBe(true);
    });
  });

  describe('who may read', () => {
    const calls: Array<[string, unknown]> = [
      ['social.mcp.metrics_summary', {}],
      ['social.mcp.metrics_totals', {}],
      ['ads.mcp.spend', {}],
      ['ads.mcp.flags', {}],
      ['ads.mcp.today', {}],
      // Added by E4b (#4147): the started launches, whose projection and the proposals made with its ids are in engage-mcp-launches.db.test.ts.
      ['ads.mcp.launches', {}],
      // Added by #4367: the org's active Facebook Pages, the ids a campaign draft names.
      ['ads.mcp.pages', {}],
      // Added by #4369: the org chart's active seats, the ids a proposed follow-up task names.
      ['kernel.mcp.seats', {}],
    ];

    it('lets a company grant of an owner or an admin read each of them', async () => {
      for (const [name, input] of calls) {
        for (const who of ['owner', 'admin']) await expect(runtime.query(name, input, await as(who, 'company')), `${name} ${who}`).resolves.toBeDefined();
      }
    });

    it('refuses a member-bound grant of a plain member or of a viewer with FORBIDDEN, on each of them', async () => {
      for (const [name, input] of calls) {
        for (const who of ['member', 'viewer']) {
          const error = await refusal(runtime.query(name, input, await as(who, 'member')));
          expect(error.code, `${name} ${who}`).toBe('FORBIDDEN');
          expect(error.status, `${name} ${who}`).toBe(403);
        }
      }
    });

    // The tool list does not offer these tools to a member-bound grant at all (tested in engage-mcp-tools.test.ts); a call that names one anyway is held to the same rule as the person.
    it('refuses a member-bound grant even when its member is an owner or an admin: these are a company grant\'s alone', async () => {
      for (const [name, input] of calls) {
        for (const who of ['owner', 'admin']) {
          const error = await refusal(runtime.query(name, input, await as(who, 'member')));
          expect(error.code, `${name} ${who}`).toBe('FORBIDDEN');
        }
      }
    });

    it('refuses a browser session (no grant) with 403 on each of them', async () => {
      for (const [name, input] of calls) expect((await refusal(runtime.query(name, input, browser('owner')))).status, name).toBe(403);
    });

    it('refuses a grant without the scope on each of them', async () => {
      for (const [name, input] of calls) {
        const company = await as('owner', 'company');
        const noScope = { actor: { ...company.actor, mcp: { ...(company.actor.mcp as NonNullable<UserActor['mcp']>), scopes: [] } } satisfies UserActor, orgId: orgs.a };
        expect((await refusal(runtime.query(name, input, noScope))).details, name).toMatchObject({ rule: 'mcp_scope' });
      }
    });

    it('refuses a grant of org A pointed at another org', async () => {
      for (const [name, input] of calls) await refusal(runtime.query(name, input, { actor: (await as('owner', 'company')).actor, orgId: orgs.b }));
    });
  });
});
