// SPDX-License-Identifier: AGPL-3.0-only
// Browser push for the kernel's notifications on PostgreSQL 17 (#3736): a notice of a pushed kind (meetings.summary_ready) reaches the devices a member subscribed once for every app, through
// kernel.push.pending (what an event's dispatch wrote) and kernel.push.targets (system); the one mute switch, a read or old notice, a disabled account, a member who left and a kind that is not pushed
// get nothing; the line and path carry no text of the subject. The subscriptions themselves (limits, ownership, answers recorded) are covered with Social's in social-push.db.test.ts. The sender is a fake
// that records each request. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { PUSH_KINDS, PUSH_MAX_AGE_HOURS, createOrg, kernelCommands, kernelQueries, upsertIdentity, type PushTargets } from '@ludy/kernel';
import { SUMMARY_READY_KIND } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { createPushSender, generateVapidKeys, loadVapidKeys, runPushJob, type PushSender } from '../src/web-push.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const endpoint = () => `https://push.example.com/send/${randomUUID()}`;

suite('kernel browser push on PostgreSQL (#3736)', () => {
  const dbName = `crove_test_kernel_push_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let worker: Runtime;
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
  const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[]) => admin(async (c) => (await c.query<T>(text, values)).rows);

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@push.test`, name: null });
  }
  type Org = { orgId: string; slug: string; owner: string; member: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const slug = (await one<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]))[0]?.slug as string;
    return { orgId, slug, owner, member };
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const subscribe = (o: Org, user: string) => exec<{ id: string }>(o, user, 'kernel.push.subscribe', { endpoint: endpoint(), ...browserKeys(), label: 'Chrome trên Windows' });
  // A notice as notifyMembers writes it, with the event it came from.
  async function notice(o: Org, user: string, opts: { kind?: string; eventId?: string; subjectId?: string | null; hoursAgo?: number } = {}) {
    const id = randomUUID();
    const subjectId = opts.subjectId === undefined ? randomUUID() : opts.subjectId;
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, event_id, subject_type, subject_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'meetings.meeting', $7, now() - make_interval(hours => $8::int))`,
        [o.orgId, id, user, opts.kind ?? SUMMARY_READY_KIND, `test:${id}`, opts.eventId ?? randomUUID(), subjectId, opts.hoursAgo ?? 0],
      ),
    );
    return { id, subjectId };
  }
  const targets = (o: Org, notificationId: string) => worker.query<PushTargets | null>('kernel.push.targets', { notificationId }, { actor: system, orgId: o.orgId });
  const pending = (o: Org, eventId: string) => worker.query<string[]>('kernel.push.pending', { eventId }, { actor: system, orgId: o.orgId });

  function fakeService(statusOf: (url: string) => number = () => 201) {
    const pair = generateVapidKeys();
    const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:ops@push.test' });
    if (!keys) throw new Error('no keys');
    const requests: { url: string }[] = [];
    const sender: PushSender = createPushSender(keys, {
      request: async (url) => {
        requests.push({ url });
        return { url, status: statusOf(url), contentType: null, body: Buffer.alloc(0), truncated: false };
      },
    });
    const payloads: string[] = [];
    return { sender: { publicKey: sender.publicKey, send: async (s: Parameters<PushSender['send']>[0], payload: string) => (payloads.push(payload), sender.send(s, payload)) } satisfies PushSender, requests, payloads };
  }
  const push = (sender: PushSender, o: Org, notificationId: string) => runPushJob({ runtime: worker, sender, brand: 'Ludy', source: 'kernel' }, { orgId: o.orgId, notificationId });

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
    const registry = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'ludy_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  it('pushes a meetings notice to the devices the member subscribed once, with a fixed line and the meeting path and no text of it', async () => {
    const o = await org();
    await subscribe(o, o.member);
    await subscribe(o, o.member);
    const n = await notice(o, o.member);
    const t = await targets(o, n.id);
    expect(t?.subscriptions).toHaveLength(2);
    expect(t).toMatchObject({ line: PUSH_KINDS.get(SUMMARY_READY_KIND)?.line, path: `/o/${o.slug}/meetings/${n.subjectId}`, tag: `${SUMMARY_READY_KIND}:${n.subjectId}` });
    const service = fakeService();
    expect(await push(service.sender, o, n.id)).toEqual({ sent: 2, gone: 0, failed: 0 });
    expect(service.requests).toHaveLength(2);
    expect(JSON.parse(service.payloads[0] as string)).toEqual({ title: 'Ludy', body: PUSH_KINDS.get(SUMMARY_READY_KIND)?.line, url: `/o/${o.slug}/meetings/${n.subjectId}`, tag: `${SUMMARY_READY_KIND}:${n.subjectId}` });
    // The answers are recorded on the kernel's table: last used set, a 410 deletes.
    const used = await one<{ used: boolean }>('SELECT last_used_at IS NOT NULL AS used FROM ludy_kernel.push_subscription WHERE org_id = $1', [o.orgId]);
    expect(used.every((r) => r.used)).toBe(true);
    const gone = fakeService(() => 410);
    expect(await push(gone.sender, o, n.id)).toEqual({ sent: 0, gone: 2, failed: 0 });
    expect(await one('SELECT 1 FROM ludy_kernel.push_subscription WHERE org_id = $1', [o.orgId])).toHaveLength(0);
  });

  it('names what an event wrote: unread, of a pushed kind, within the day, and nothing for another event', async () => {
    const o = await org();
    const eventId = randomUUID();
    const fresh = await notice(o, o.member, { eventId });
    await notice(o, o.owner, { eventId, kind: 'kernel.task_assigned' });
    await notice(o, o.owner, { eventId, hoursAgo: PUSH_MAX_AGE_HOURS + 1 });
    const read = await notice(o, o.owner, { eventId });
    await admin((c) => c.query('UPDATE ludy_kernel.notification SET read_at = now() WHERE org_id = $1 AND id = $2', [o.orgId, read.id]));
    await notice(o, o.owner);
    expect(await pending(o, eventId)).toEqual([fresh.id]);
    expect(await pending(o, randomUUID())).toEqual([]);
  });

  it('pushes nothing for the one switch turned off, a read or old notice, another kind, a disabled account or a member who left', async () => {
    const o = await org();
    await subscribe(o, o.member);
    await subscribe(o, o.owner);
    // A kind that is not pushed.
    expect(await targets(o, (await notice(o, o.member, { kind: 'kernel.task_assigned' })).id)).toBeNull();
    // Turned off after the row was written: nothing, and back on, pushed again.
    const muted = await notice(o, o.member);
    await exec(o, o.member, 'kernel.notification.mute', { kind: SUMMARY_READY_KIND, muted: true });
    expect(await targets(o, muted.id)).toBeNull();
    expect(await push(fakeService().sender, o, muted.id)).toEqual({ sent: 0, gone: 0, failed: 0 });
    await exec(o, o.member, 'kernel.notification.mute', { kind: SUMMARY_READY_KIND, muted: false });
    expect(await targets(o, muted.id)).not.toBeNull();
    // Read, or older than a day.
    const read = await notice(o, o.owner);
    await exec(o, o.owner, 'kernel.notification.read', { ids: [read.id] });
    expect(await targets(o, read.id)).toBeNull();
    expect(await targets(o, (await notice(o, o.owner, { hoursAgo: PUSH_MAX_AGE_HOURS + 1 })).id)).toBeNull();
    // A disabled account: nothing; the subscription stays for when it is enabled again.
    const n = await notice(o, o.owner);
    await admin((c) => c.query('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.owner]));
    expect(await targets(o, n.id)).toBeNull();
    await admin((c) => c.query('UPDATE ludy_kernel.user_account SET disabled_at = NULL WHERE id = $1', [o.owner]));
    expect(await targets(o, n.id)).not.toBeNull();
    // A member who left: the subscriptions go with the membership.
    const left = await notice(o, o.member);
    expect(await targets(o, left.id)).not.toBeNull();
    await admin((c) => c.query('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]));
    expect(await targets(o, left.id)).toBeNull();
    expect(await one('SELECT 1 FROM ludy_kernel.push_subscription WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member])).toHaveLength(0);
  });

  it('reads each member own subscriptions only: a notice reaches its own member devices, never another member', async () => {
    const o = await org();
    await subscribe(o, o.owner);
    const n = await notice(o, o.member);
    // The member has no device; the owner has one, and is not the notice's member.
    expect(await targets(o, n.id)).toBeNull();
    const own = await notice(o, o.owner);
    expect((await targets(o, own.id))?.subscriptions).toHaveLength(1);
  });

  it('keeps the bookkeeping to the system and the member commands to users', async () => {
    const o = await org();
    const n = await notice(o, o.member);
    await expect(rt.query('kernel.push.targets', { notificationId: n.id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('kernel.push.pending', { eventId: randomUUID() }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(worker.execute('kernel.push.subscribe', { endpoint: endpoint(), ...browserKeys() }, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });
});
