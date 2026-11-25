// In-app notifications of Ludy Social on PostgreSQL 17 (#637): who each event tells, never the person who acted, the
// kinds a member turns off, reading and marking only one's own, a client's answer through a review link, and pruning.
// The worker's dispatch is run here by hand for each new outbox event. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL;
// each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { socialCommands, socialQueries, type NotificationItem, type PostView } from '@ludy/mod-social';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { createLogProvider } from '@ludy/mail';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { runMailJob, sweepMail, type MailJob } from '../src/mail-queue.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social notification mail on PostgreSQL (#579)', () => {
  const dbName = `ludy_test_social_notify_mail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's runtime (the ludy_worker login): only it enters an org's system context.
  let worker: Runtime;
  let workerDb: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles, dispatched: new Set() };
  }

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  type List = { items: NotificationItem[]; unread: number; muted: string[] };
  const list = (o: Org, user: string) => rt.query<List>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId });
  const kinds = async (o: Org, user: string) => (await list(o, user)).items.map((i) => i.kind);

  // What the worker does for each new event of the org: the dispatch, in the org's system context.
  async function deliver(o: Org): Promise<number> {
    const events = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId])).rows);
    let sent = 0;
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      sent += (await worker.execute<{ sent: number }>('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId })).sent;
    }
    return sent;
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
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'ludy_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
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
  type Mail = { to: string; status: string; subject: string | null; error_code: string | null };
  const mails = (o: Org) =>
    admin(async (c) => (await c.query<Mail>("SELECT to_address AS to, status, subject, error_code FROM ludy_kernel.mail_message WHERE org_id = $1 AND source = 'social.notification.dispatch' ORDER BY to_address", [o.orgId])).rows);
  const emailOf = (id: string) => admin(async (c) => (await c.query<{ email: string }>('SELECT email FROM ludy_kernel.user_account WHERE id = $1', [id])).rows[0]?.email as string);
  // The mail queue's sweep and jobs, as the worker runs them.
  async function send(mailer: MailProvider) {
    const jobs: MailJob[] = [];
    await sweepMail({ send: async (_q, data) => jobs.push(data) }, workerDb, worker, mailer);
    for (const job of jobs) await runMailJob({ runtime: worker, mailer, templates: MAIL_TEMPLATES, publicUrl: 'https://ludy.example', bounceDomain: null }, job);
  }
  function capturing(): { mailer: MailProvider; sent: OutboundMail[] } {
    const sent: OutboundMail[] = [];
    return { sent, mailer: { name: 'resend', enabled: true, sendRetrySafety: 'idempotent', send: async (m) => (sent.push(m), { status: 'accepted', providerMessageId: `em_${randomUUID()}` }) } };
  }

  it('mails the owners and admins a post to review, once, never the author, and not those who turned emails off', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.notification.mail', { enabled: false });
    expect((await rt.query<{ mailOff: boolean }>('social.notification.list', {}, { actor: asUser(o.owner), orgId: o.orgId })).mailOff).toBe(true);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khai trương cửa hàng', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await deliver(o);
    // The owner still has the in-app notification, without the mail.
    expect(await kinds(o, o.owner)).toEqual(['review_requested']);
    expect(await mails(o)).toEqual([{ to: await emailOf(o.admin), status: 'queued', subject: 'Có bài chờ duyệt: Khai trương cửa hàng', error_code: null }]);
    // A replayed event mails nobody again.
    o.dispatched.clear();
    await deliver(o);
    expect(await mails(o)).toHaveLength(1);

    const { mailer, sent } = capturing();
    await send(mailer);
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    const slug = await admin(async (c) => (await c.query<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [o.orgId])).rows[0]?.slug);
    expect(mail?.to).toBe(await emailOf(o.admin));
    expect(mail?.subject).toBe('Có bài chờ duyệt: Khai trương cửa hàng');
    expect(mail?.text).toContain('Có một bài đang chờ bạn duyệt.');
    expect(mail?.text).toContain(`Mở bài viết: https://ludy.example/o/${slug}/social/${postId}`);
    expect(mail?.html).toContain(`href="https://ludy.example/o/${slug}/social/${postId}"`);
    expect((await mails(o))[0]?.status).toBe('sent');
  });

  it("mails the author a reviewer's decision, but not a comment, and records mail off when the server has none", async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Giảm giá cuối tuần', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'changes_requested', comment: 'Thêm giá', variants: seen(await get(o, o.owner, postId)) });
    // An internal comment is an in-app notification only.
    await exec(o, o.other, 'social.post_comment.add', { postId, body: 'Ảnh hơi tối' });
    await deliver(o);
    expect(await kinds(o, o.member)).toContain('comment');
    const toMember = (await mails(o)).filter((m) => m.subject?.startsWith('Bài của bạn'));
    expect(toMember).toEqual([{ to: await emailOf(o.member), status: 'queued', subject: 'Bài của bạn cần sửa: Giảm giá cuối tuần', error_code: null }]);
    // Mail off on the server: recorded as not sent, nothing fails.
    await send(createLogProvider(() => {}));
    expect((await mails(o)).every((m) => m.status === 'failed' && m.error_code === 'MAIL_OFF')).toBe(true);
  });
  it('keeps member addresses to the worker, and to the members of the org it acts for', async () => {
    const grants = await admin(
      async (c) =>
        (await c.query<{ grantee: string }>("SELECT grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'ludy_kernel' AND routine_name = 'member_emails' AND grantee <> 'postgres' ORDER BY 1")).rows.map((r) => r.grantee),
    );
    expect(grants).toEqual(['ludy_worker']);
    const a = await org();
    const b = await org();
    // A notification of org A for a member of org B mails nobody: B's member is not A's.
    const conn = await connection(a.orgId, a.owner);
    await admin((c) => c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [b.orgId, a.admin, 'member']));
    const { postId } = await exec<{ postId: string }>(a, a.member, 'social.post.create', { body: 'Chỉ trong tổ chức A', channels: [{ connectionId: conn }] });
    await exec(a, a.member, 'social.post.submit', { postId });
    await deliver(a);
    expect((await mails(a)).map((m) => m.to).sort()).toEqual([await emailOf(a.owner), await emailOf(a.admin)].sort());
    expect(await mails(b)).toEqual([]);
  });
});