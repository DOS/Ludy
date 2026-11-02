// SPDX-License-Identifier: AGPL-3.0-only
// The daily "Hôm nay cần bạn" mail on PostgreSQL 17 (#2406): a member opts in and out of their own row alone; only the system
// context writes last_sent_day; the send command claims the Vietnam day once per member, counts only what the member could see,
// queues counts and links and nothing else, and sends nothing to a member owed nothing; the due-orgs function is the worker's alone.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// 10:00 and 06:00 in Vietnam on 2026-11-10 and the day after at 10:00.
const MORNING = new Date('2026-11-10T03:00:00Z');
const EARLY = new Date('2026-11-09T23:00:00Z');
const NEXT_MORNING = new Date('2026-11-11T03:00:00Z');

suite('the daily brief mail on PostgreSQL (#2406)', () => {
  const dbName = `crove_test_today_mail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  // The worker's own login, the one that runs the system commands (it alone may read member addresses).
  let workerPool: pg.Pool;
  let workerRt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'kernel.today_mail' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  async function asLogin<T>(url: string, orgId: string | null, user: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      if (orgId && user) await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@mail.test`, name: null });
  type Org = { orgId: string; slug: string; owner: string; admin: string; lan: string; minh: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, slug: '', owner, admin: await person('admin'), lan: await person('lan'), minh: await person('minh'), viewer: await person('viewer') };
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, o.admin, o.lan, o.minh, o.viewer]);
      o.slug = ((await c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0] as { slug: string }).slug;
    });
    return o;
  }
  const set = (o: Org, user: string, enabled: boolean, language?: 'vi' | 'en') =>
    rt.execute<{ enabled: boolean }>('kernel.today_mail.set', { enabled, ...(language ? { language } : {}) }, { actor: asUser(user), orgId: o.orgId });
  // Opted in long before the test's days: a new opt-in is first mailed the next morning.
  const optIn = async (o: Org, users: string[]) => {
    for (const u of users) await set(o, u, true);
    await admin((c) => c.query("UPDATE crove_kernel.today_mail SET created_at = '2026-01-01T00:00:00Z' WHERE org_id = $1", [o.orgId]));
  };
  const get = (o: Org, user: string) => rt.query<{ enabled: boolean }>('kernel.today_mail.get', {}, { actor: asUser(user), orgId: o.orgId });
  const send = (o: Org, upstream = false) =>
    workerRt.execute<{ state: string; day: string; members: number; mails: number; suppressed: number }>('kernel.today_mail.send', { upstream }, { actor: system, orgId: o.orgId });
  const sendAt = async (o: Org, at: Date, upstream = false) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      return await send(o, upstream);
    } finally {
      vi.useRealTimers();
    }
  };
  const mails = (o: Org) =>
    admin(async (c) => (await c.query<{ to_address: string; payload: Record<string, unknown>; status: string }>("SELECT to_address, payload, status FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'kernel.today_mail.day' ORDER BY to_address", [o.orgId])).rows);
  const emailOf = (user: string) => admin(async (c) => ((await c.query<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [user])).rows[0] as { email: string }).email);
  const notify = (o: Org, user: string, n: number, kind = 'kernel.original_flagged') =>
    admin(async (c) => {
      for (let i = 0; i < n; i++) await c.query('INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key) VALUES ($1, $2, $3, $4)', [o.orgId, user, kind, `k-${randomUUID()}`]);
    });
  const proposal = (o: Org, approvers: string[], status = 'pending') =>
    admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, status)
         VALUES ($1, 'finance.purchase', 'finance.purchase.record', 'Mua hàng bí mật 123456789', '{}', $2::uuid[], '[]', $3)`,
        [o.orgId, approvers, status],
      ),
    );

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off by default, and a member turns it on and off for themselves alone', async () => {
    const o = await org();
    expect(await get(o, o.lan)).toEqual({ enabled: false });
    expect(await set(o, o.lan, true)).toEqual({ enabled: true });
    expect(await set(o, o.lan, true)).toEqual({ enabled: true });
    expect(await get(o, o.lan)).toEqual({ enabled: true });
    // A viewer may opt in too; nobody else's setting moves.
    expect(await get(o, o.minh)).toEqual({ enabled: false });
    await set(o, o.viewer, true);
    expect(await admin(async (c) => (await c.query('SELECT user_id FROM crove_kernel.today_mail WHERE org_id = $1 ORDER BY user_id', [o.orgId])).rowCount)).toBe(2);
    expect(await set(o, o.lan, false)).toEqual({ enabled: false });
    expect(await get(o, o.lan)).toEqual({ enabled: false });
    expect(await get(o, o.viewer)).toEqual({ enabled: true });
  });

  it('lets a member read, insert and delete their own row alone, and never write last_sent_day', async () => {
    const o = await org();
    await set(o, o.lan, true);
    await set(o, o.minh, true);
    // The table's policy: a member sees only their own row, not another's.
    expect(await asLogin(appUrl, o.orgId, o.lan, async (c) => (await c.query('SELECT user_id FROM crove_kernel.today_mail')).rows.map((r) => r.user_id))).toEqual([o.lan]);
    // Nothing is written in another member's name, and a row never arrives with its day set.
    await expect(asLogin(appUrl, o.orgId, o.viewer, (c) => c.query('INSERT INTO crove_kernel.today_mail (org_id, user_id) VALUES ($1, $2)', [o.orgId, o.admin]))).rejects.toThrow(/row-level security/);
    await expect(asLogin(appUrl, o.orgId, o.viewer, (c) => c.query("INSERT INTO crove_kernel.today_mail (org_id, user_id, last_sent_day) VALUES ($1, $2, '2026-11-10')", [o.orgId, o.viewer]))).rejects.toThrow(/row-level security/);
    // A member cannot move their own day (no mail would then ever be sent, or one sent twice), nor change whose row it is.
    expect(await asLogin(appUrl, o.orgId, o.lan, async (c) => (await c.query("UPDATE crove_kernel.today_mail SET last_sent_day = '2026-11-10'")).rowCount)).toBe(0);
    await expect(asLogin(appUrl, o.orgId, o.lan, (c) => c.query('UPDATE crove_kernel.today_mail SET user_id = $1', [o.minh]))).rejects.toThrow(/permission denied/);
    // Another member's row is not theirs to delete.
    expect(await asLogin(appUrl, o.orgId, o.viewer, async (c) => (await c.query('DELETE FROM crove_kernel.today_mail')).rowCount)).toBe(0);
    expect(await asLogin(appUrl, o.orgId, o.lan, async (c) => (await c.query('DELETE FROM crove_kernel.today_mail')).rowCount)).toBe(1);
    // Another org's owner reads none of it.
    const other = await org();
    expect(await asLogin(appUrl, other.orgId, other.owner, async (c) => (await c.query('SELECT 1 FROM crove_kernel.today_mail')).rowCount)).toBe(0);
  });

  it('goes with the membership', async () => {
    const o = await org();
    await set(o, o.minh, true);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.minh]));
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.today_mail WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
  });

  it('queues counts and links only, once a day, to opted-in members who are owed something', async () => {
    const o = await org();
    await optIn(o, [o.owner, o.lan, o.minh, o.viewer]);
    // The owner has a pending proposal to approve and two unread notifications (one approval-waiting, counted in the proposals);
    // lan has three work notifications; minh has nothing; the viewer has a proposal that does not name them.
    await proposal(o, [o.owner]);
    await proposal(o, [o.owner], 'rejected');
    await notify(o, o.owner, 2);
    await notify(o, o.owner, 1, 'kernel.approval_waiting');
    await notify(o, o.lan, 3);
    await admin((c) => c.query("UPDATE crove_kernel.notification SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND dedupe_key = (SELECT dedupe_key FROM crove_kernel.notification WHERE org_id = $1 AND user_id = $2 ORDER BY id LIMIT 1)", [o.orgId, o.lan]));

    // Before 07:30 in Vietnam nothing is due.
    expect(await sendAt(o, EARLY)).toMatchObject({ state: 'not_due', members: 0 });
    expect(await mails(o)).toEqual([]);

    const first = await sendAt(o, MORNING);
    expect(first).toMatchObject({ state: 'sent', day: '2026-11-10', members: 4, mails: 2 });
    const queued = await mails(o);
    expect(queued.map((m) => m.to_address).sort()).toEqual([(await emailOf(o.lan)).toLowerCase(), (await emailOf(o.owner)).toLowerCase()].sort());
    const byAddress = new Map(queued.map((m) => [m.to_address, m]));
    const owner = byAddress.get((await emailOf(o.owner)).toLowerCase());
    expect(owner?.payload).toEqual({
      org: expect.any(String),
      language: 'vi',
      day: '2026-11-10',
      counts: { proposals: 1, notifications: 2, messages: 0 },
      home: `/o/${o.slug}/overview`,
      settings: `/o/${o.slug}/notifications?todayMail=off`,
    });
    expect(byAddress.get((await emailOf(o.lan)).toLowerCase())?.payload).toMatchObject({ counts: { proposals: 0, notifications: 2, messages: 0 } });
    // Counts and links only: nothing of a proposal's title or any text of the org's records is in what is queued.
    expect(JSON.stringify(queued)).not.toContain('bí mật');
    expect(JSON.stringify(queued)).not.toContain('123456789');

    // The day is claimed: a second command the same day (a retry, a second worker) sends nothing.
    expect(await sendAt(o, MORNING)).toMatchObject({ state: 'not_due', mails: 0 });
    expect((await mails(o)).length).toBe(2);
    // Every opted-in member holds today's day, those who were sent nothing included.
    expect(await admin(async (c) => (await c.query("SELECT count(*)::int AS n FROM crove_kernel.today_mail WHERE org_id = $1 AND last_sent_day = '2026-11-10'", [o.orgId])).rows[0].n)).toBe(4);

    // Tomorrow the same members are mailed again; the one who turned it off is not.
    await set(o, o.lan, false);
    expect(await sendAt(o, NEXT_MORNING)).toMatchObject({ state: 'sent', day: '2026-11-11', members: 3, mails: 1 });
    expect((await mails(o)).length).toBe(3);
  });

  it('counts the conversations a member may read, not the ones they may not', async () => {
    const o = await org();
    const connection = randomUUID();
    const other = randomUUID();
    await admin(async (c) => {
      for (const [id, ext] of [[connection, 'ext-a'], [other, 'ext-b']] as const) {
        await c.query("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh', $4)", [o.orgId, id, ext, o.owner]);
      }
      // lan may use the second channel only.
      await c.query('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.lan, other, o.owner]);
      const thread = (conn: string, kind: string, tag: string, status = 'new') =>
        c.query(
          `INSERT INTO crove_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, status, resolved_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'resolved' THEN now() END)`,
          [o.orgId, conn, kind, `t-${tag}`, status],
        );
      await thread(connection, 'comment_thread', '1');
      await thread(other, 'comment_thread', '2');
      await thread(other, 'direct', '3');
      await thread(other, 'comment_thread', '4', 'resolved');
    });
    await optIn(o, [o.owner, o.lan, o.minh, o.viewer]);
    await sendAt(o, MORNING);
    const byUser = new Map<string, number>();
    for (const m of await mails(o)) byUser.set(m.to_address, (m.payload.counts as { messages: number }).messages);
    // The owner reads all three open threads; lan only the comment thread of their channel; minh (no channel list) both comment
    // threads but no direct message; a viewer cannot answer, so is owed none and gets no mail.
    expect(byUser.get((await emailOf(o.owner)).toLowerCase())).toBe(3);
    expect(byUser.get((await emailOf(o.lan)).toLowerCase())).toBe(1);
    expect(byUser.get((await emailOf(o.minh)).toLowerCase())).toBe(2);
    expect(byUser.has((await emailOf(o.viewer)).toLowerCase())).toBe(false);
  });

  it('mails a member at most once a day even when they turn it off and on again, and first the morning after they opt in', async () => {
    const o = await org();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EARLY);
    await set(o, o.lan, true);
    await notify(o, o.lan, 2);
    vi.useRealTimers();
    // Opted in today (Vietnam time): nothing is due today, however many times the sweep runs.
    expect(await sendAt(o, MORNING)).toMatchObject({ state: 'not_due', mails: 0 });
    expect(await mails(o)).toEqual([]);
    // The next morning the first mail goes out; the member turns it off and on again, and the same day brings no second one.
    expect(await sendAt(o, NEXT_MORNING)).toMatchObject({ state: 'sent', day: '2026-11-11', mails: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T03:30:00Z'));
    await set(o, o.lan, false);
    await set(o, o.lan, true);
    vi.useRealTimers();
    expect(await sendAt(o, new Date('2026-11-11T04:00:00Z'))).toMatchObject({ state: 'not_due', mails: 0 });
    expect((await mails(o)).length).toBe(1);
  });

  it('counts the proposals and notifications of a member limited to one legal entity only for that entity', async () => {
    const o = await org();
    const [home, branch] = await admin(async (c) => {
      const first = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 ORDER BY created_at LIMIT 1', [o.orgId])).rows[0]?.id as string;
      const second = (await c.query<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [o.orgId, o.owner])).rows[0]?.id as string;
      await c.query("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [o.orgId, o.lan, second, o.owner]);
      return [first, second] as const;
    });
    // A proposal and a notification in each entity; lan names both proposals as an approver and holds both notifications.
    await admin(async (c) => {
      for (const entity of [home, branch]) {
        await c.query(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, legal_entity_id)
           VALUES ($1, 'finance.purchase', 'finance.purchase.record', 'Hồ sơ', '{}', ARRAY[$2::uuid, $3::uuid], '[]', $4)`,
          [o.orgId, o.lan, o.minh, entity],
        );
        await c.query("INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, legal_entity_id) VALUES ($1, $2, 'kernel.original_flagged', $3, $4), ($1, $5, 'kernel.original_flagged', $6, $4)", [o.orgId, o.lan, `k-${randomUUID()}`, entity, o.minh, `k-${randomUUID()}`]);
      }
    });
    await optIn(o, [o.lan, o.minh]);
    await sendAt(o, MORNING);
    const byAddress = new Map((await mails(o)).map((m) => [m.to_address, m.payload.counts as { proposals: number; notifications: number }]));
    // lan reads the branch only; minh, with no assignment, reads every entity.
    expect(byAddress.get((await emailOf(o.lan)).toLowerCase())).toMatchObject({ proposals: 1, notifications: 1 });
    expect(byAddress.get((await emailOf(o.minh)).toLowerCase())).toMatchObject({ proposals: 2, notifications: 2 });
  });

  it('writes the mail in the language the member chose when they opted in, Vietnamese when they named none', async () => {
    const o = await org();
    await set(o, o.lan, true, 'en');
    await set(o, o.minh, true, 'vi');
    await set(o, o.owner, true);
    // Naming another language on a row already on replaces it with the new one.
    await set(o, o.minh, true, 'en');
    await set(o, o.minh, true, 'vi');
    await set(o, o.minh, true);
    const stored = await admin(async (c) => (await c.query('SELECT user_id, language FROM crove_kernel.today_mail WHERE org_id = $1', [o.orgId])).rows.map((r) => [r.user_id, r.language]));
    expect(stored.sort()).toEqual([[o.lan, 'en'], [o.minh, 'vi'], [o.owner, null]].sort());
    // Only the two languages the mail has are accepted, in the command and in the table.
    await expect(rt.execute('kernel.today_mail.set', { enabled: true, language: 'fr' }, { actor: asUser(o.lan), orgId: o.orgId })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(admin((c) => c.query("UPDATE crove_kernel.today_mail SET language = 'fr' WHERE org_id = $1", [o.orgId]))).rejects.toThrow(/check constraint/);
    await admin((c) => c.query("UPDATE crove_kernel.today_mail SET created_at = '2026-01-01T00:00:00Z' WHERE org_id = $1", [o.orgId]));
    for (const u of [o.lan, o.minh, o.owner]) await notify(o, u, 1);
    await sendAt(o, MORNING);
    const languages = new Map((await mails(o)).map((m) => [m.to_address, m.payload.language]));
    expect(languages.get((await emailOf(o.lan)).toLowerCase())).toBe('en');
    expect(languages.get((await emailOf(o.minh)).toLowerCase())).toBe('vi');
    expect(languages.get((await emailOf(o.owner)).toLowerCase())).toBe('vi');
  });

  it('is the system context alone that sends, and only the worker that lists the due orgs', async () => {
    const o = await org();
    await expect(rt.execute('kernel.today_mail.send', {}, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The member's API login and the tenant role cannot call the due-orgs function; the worker's login can, and gets ids only.
    await expect(asLogin(appUrl, null, null, (c) => c.query('SELECT * FROM crove_kernel.today_mail_due(NULL, 10)'))).rejects.toThrow(/permission denied/);
    await set(o, o.lan, true);
    const rows = await asLogin(workerUrl, null, null, async (c) => (await c.query('SELECT * FROM crove_kernel.today_mail_due(NULL, 500)')).fields.map((f) => f.name));
    expect(rows).toEqual(['org_id']);
  });

  it('lists an org as due only while a member is owed a day, and pages in org order', async () => {
    const a = await org();
    const b = await org();
    await optIn(a, [a.lan]);
    await optIn(b, [b.lan]);
    await admin((c) => c.query("UPDATE crove_kernel.today_mail SET last_sent_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE org_id = $1", [b.orgId]));
    // From 07:30 in Vietnam the org with an unsent day is due and the one sent today is not; before it, none is.
    const local = await admin(async (c) => (await c.query<{ m: number }>("SELECT (extract(hour FROM l) * 60 + extract(minute FROM l))::int AS m FROM (SELECT now() AT TIME ZONE 'Asia/Ho_Chi_Minh' AS l) t")).rows[0]?.m as number);
    const due = await asLogin(workerUrl, null, null, async (c) => (await c.query<{ org_id: string }>('SELECT org_id FROM crove_kernel.today_mail_due(NULL, 500)')).rows.map((r) => r.org_id));
    if (local >= 7 * 60 + 30) {
      expect(due).toContain(a.orgId);
      expect(due).not.toContain(b.orgId);
      const sorted = [...due].sort();
      expect(due).toEqual(sorted);
      const paged = await asLogin(workerUrl, null, null, async (c) => (await c.query<{ org_id: string }>('SELECT org_id FROM crove_kernel.today_mail_due($1::uuid, 500)', [a.orgId])).rows.map((r) => r.org_id));
      expect(paged).not.toContain(a.orgId);
    } else {
      expect(due).toEqual([]);
    }
  });

  // Self-host (AUTH_SESSION_CHECK=db): Supabase Auth keeps its own record of each email, and an address it has not confirmed is never
  // mailed (as for invites, #134). Runs last: it creates the auth tables.
  it('mails no member whose email is unconfirmed in Supabase Auth, and none while the confirmation cannot be read', async () => {
    await admin(async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, not_after timestamptz);
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, status text NOT NULL);
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    });
    await applyAuthGrants({ adminUrl, timeoutMs: 5000 });
    const o = await org();
    // Two members whose subject is a Supabase Auth user: one confirmed, one not. Another member has no auth record at all.
    async function authed(name: string, confirmed: boolean) {
      const subject = randomUUID();
      const email = `${name}-${randomUUID().slice(0, 8)}@mail.test`;
      await admin((c) => c.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, $3)', [subject, email, confirmed ? new Date() : null]));
      const id = await upsertIdentity(db, { issuer: 'test', subject, email, name: null });
      await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, id]));
      return { id, email };
    }
    const sure = await authed('confirmed', true);
    const unsure = await authed('unconfirmed', false);
    await optIn(o, [sure.id, unsure.id, o.lan]);
    for (const u of [sure.id, unsure.id, o.lan]) await notify(o, u, 1);
    // In db mode only the confirmed member is mailed: the unconfirmed one and the one with no Supabase Auth record are not.
    expect(await sendAt(o, MORNING, true)).toMatchObject({ state: 'sent', members: 3, mails: 1 });
    expect((await mails(o)).map((m) => m.to_address)).toEqual([sure.email.toLowerCase()]);
    // A deployment without Supabase Auth's record (an identity provider vouches for the address) mails all three the next day.
    expect(await sendAt(o, NEXT_MORNING, false)).toMatchObject({ state: 'sent', mails: 3 });

    // The confirmation cannot be read (the grant is gone): fail closed, nobody is mailed in db mode.
    await admin((c) => c.query('REVOKE SELECT (email_confirmed_at) ON auth.users FROM crove_auth_reader'));
    expect(await sendAt(o, new Date('2026-11-12T03:00:00Z'), true)).toMatchObject({ state: 'sent', mails: 0 });
    expect((await mails(o)).length).toBe(4);
  });
});
