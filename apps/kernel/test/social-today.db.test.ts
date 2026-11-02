// SPDX-License-Identifier: AGPL-3.0-only
// social.today (#2387), the Social line of Home's "Hôm nay cần bạn", on PostgreSQL 17 through the runtime as each member: the posts waiting for the
// caller's approval, the channels to reconnect, the posts that failed or are paused, and the posts due in the next 24 hours that still wait for
// approval; what a member limited to some channels (#1081) and a viewer do not get, and another org's nothing. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zTodayItems, type TodayItem } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, TODAY_SOCIAL_DUE } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const NOW = '2026-11-10T05:00:00.000Z';
const hoursFromNow = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000);

suite('social.today: what needs the member in Social (#2387)', () => {
  const dbName = `crove_test_social_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

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
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social-today.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; limited: string; free: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), limited: await person('limited'), free: await person('free'), viewer: await person('viewer') };
    const role = { admin: 'admin', limited: 'member', free: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        provider,
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const today = (o: Org, user: string) => rt.query<TodayItem[]>('social.today', { now: NOW }, { actor: asUser(user), orgId: o.orgId });
  const ofKind = (items: TodayItem[], kind: TodayItem['kind']) => items.filter((i) => i.kind === kind);
  // A post of the author on these channels, submitted for review (so it waits for an owner or admin).
  async function submitted(o: Org, author: string, channels: string[], body = 'Bài chờ duyệt') {
    const { postId } = await exec<{ postId: string }>(o, author, 'social.post.create', { body, channels: channels.map((connectionId) => ({ connectionId })) });
    await exec(o, author, 'social.post.submit', { postId });
    return postId;
  }
  const schedule = (postId: string, at: Date) => admin((c) => c.query('UPDATE crove_social.post SET scheduled_at = $2 WHERE id = $1', [postId, at]));
  const setVariant = (postId: string, connectionId: string, status: string) => admin((c) => c.query('UPDATE crove_social.post_variant SET status = $3 WHERE post_id = $1 AND channel_connection_id = $2', [postId, connectionId, status]));

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
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('says nothing when nothing needs anyone, to every role, and nothing to another org', async () => {
    const o = await org();
    await connection(o.orgId, o.owner);
    for (const who of [o.owner, o.admin, o.limited, o.free, o.viewer]) expect(await today(o, who), who).toEqual([]);
    const other = await org();
    expect(await today(other, other.owner)).toEqual([]);
  });

  it('lists the posts waiting for an owner or admin as one proposal, to nobody else', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const first = await submitted(o, o.free, [a]);
    // One post opens itself, several open the Review tab.
    expect(await today(o, o.owner)).toEqual([{ kind: 'proposal', app: 'social', id: 'review', title: { key: 'social.review', params: { count: 1 } }, count: 1, href: `/social/${first}` }]);
    const second = await submitted(o, o.free, [a], 'Bài thứ hai');
    const items = ofKind(await today(o, o.admin), 'proposal');
    expect(items).toEqual([{ kind: 'proposal', app: 'social', id: 'review', title: { key: 'social.review', params: { count: 2 } }, count: 2, href: '/social?tab=review' }]);
    // A member decides nothing and a viewer can act on nothing; a draft waits for no one.
    expect(ofKind(await today(o, o.free), 'proposal')).toEqual([]);
    expect(ofKind(await today(o, o.limited), 'proposal')).toEqual([]);
    expect(await today(o, o.viewer)).toEqual([]);
    const draft = await exec<{ postId: string }>(o, o.free, 'social.post.create', { body: 'Nháp', channels: [{ connectionId: a }] });
    expect(ofKind(await today(o, o.owner), 'proposal')[0]?.count).toBe(2);
    // Decided: gone.
    const view = await rt.query<{ variants: { id: string; revision: number; contentHash: string }[] }>('social.post.get', { postId: second }, { actor: asUser(o.owner), orgId: o.orgId });
    await exec(o, o.owner, 'social.variant.decide', { postId: second, decision: 'approved', variants: view.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    expect(ofKind(await today(o, o.owner), 'proposal')[0]?.count).toBe(1);
    expect(draft.postId).toBeTruthy();
  });

  it('warns owners and admins of channels whose sign-in expired or broke, and no one else, leaving out ad accounts', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    const ads = await connection(o.orgId, o.owner, 'sandbox_ads');
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = ANY ($1::uuid[])", [[a, ads]]));
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'error' WHERE id = $1", [b]));
    const expected = [{ kind: 'flag', app: 'social', id: 'channels', title: { key: 'social.channels', params: { count: 2 } }, count: 2, severity: 'warn', href: '/social/channels' }];
    expect(await today(o, o.owner)).toEqual(expected);
    expect(await today(o, o.admin)).toEqual(expected);
    // A member cannot reconnect a channel; a viewer can act on nothing.
    expect(await today(o, o.free)).toEqual([]);
    expect(await today(o, o.limited)).toEqual([]);
    expect(await today(o, o.viewer)).toEqual([]);
    // Disconnected on purpose (revoked) is not a channel to reconnect.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [a]));
    expect(ofKind(await today(o, o.owner), 'flag')[0]?.count).toBe(1);
  });

  it('blocks on the posts that failed or are paused, as the Attention list counts them, for a member only on the channels they may use', async () => {
    const o = await org();
    const mine = await connection(o.orgId, o.owner);
    const theirs = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.limited, channelConnectionIds: [mine] });
    const own = (await exec<{ postId: string }>(o, o.limited, 'social.post.create', { body: 'Của tôi', channels: [{ connectionId: mine }] })).postId;
    const other = (await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Của kênh khác', channels: [{ connectionId: theirs }] })).postId;
    const paused = (await exec<{ postId: string }>(o, o.limited, 'social.post.create', { body: 'Tạm dừng', channels: [{ connectionId: mine }] })).postId;
    await setVariant(own, mine, 'failed');
    await setVariant(other, theirs, 'needs_attention');
    await setVariant(paused, mine, 'paused');
    const block = (items: TodayItem[]) => items.filter((i) => i.id === 'attention');
    expect(block(await today(o, o.owner))).toEqual([{ kind: 'flag', app: 'social', id: 'attention', title: { key: 'social.attention', params: { count: 3 } }, count: 3, severity: 'block', href: '/social?tab=attention' }]);
    // The limited member sees only their channel's posts (a failed one and a paused one); a member of no limit sees all; a viewer none.
    expect(block(await today(o, o.limited))[0]).toMatchObject({ count: 2 });
    expect(block(await today(o, o.free))[0]).toMatchObject({ count: 3 });
    expect(block(await today(o, o.viewer))).toEqual([]);
    // The count equals the list it opens.
    const list = await rt.query<unknown[]>('social.post.list', { stage: 'attention', limit: 200 }, { actor: asUser(o.limited), orgId: o.orgId });
    expect(list).toHaveLength(2);
    // An archived post leaves the count, and so does one that went out.
    await admin((c) => c.query('UPDATE crove_social.post SET archived_at = now(), archived_by = $2 WHERE id = $1', [other, o.owner]));
    expect(block(await today(o, o.owner))[0]).toMatchObject({ count: 2 });
    await setVariant(own, mine, 'published');
    await setVariant(paused, mine, 'published');
    expect(block(await today(o, o.owner))).toEqual([]);
  });

  it('lists the posts due in the next 24 hours, or overdue by up to 7 days, that still wait for approval, each with its time, for the channels a member may use', async () => {
    const o = await org();
    const mine = await connection(o.orgId, o.owner);
    const theirs = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.limited, channelConnectionIds: [mine] });
    const soon = await submitted(o, o.owner, [mine], 'Sắp đến giờ');
    const named = await submitted(o, o.owner, [mine], 'Có tên');
    const later = await submitted(o, o.owner, [mine], 'Còn lâu');
    // A time that has passed stays on Home for 7 days, with its own wording; after that it is gone.
    const past = await submitted(o, o.owner, [mine], 'Đã quá giờ');
    const fewDays = await submitted(o, o.owner, [mine], 'Quá giờ mấy ngày');
    const longAgo = await submitted(o, o.owner, [mine], 'Quá giờ lâu rồi');
    const elsewhere = await submitted(o, o.owner, [theirs], 'Kênh khác');
    // The calendar's time of a variant is its own when it has one: a variant meant for 3 hours from now on a post dated 40, and the reverse.
    const viaVariant = await submitted(o, o.owner, [mine], 'Giờ của kênh');
    const movedOut = await submitted(o, o.owner, [mine], 'Kênh dời giờ');
    const archived = await submitted(o, o.owner, [mine], 'Đã lưu trữ');
    // On both channels, but only the other channel's variant waits for approval: the limited member has nothing to approve there.
    const split = await submitted(o, o.owner, [mine, theirs], 'Hai kênh');
    await schedule(soon, hoursFromNow(10));
    await schedule(named, hoursFromNow(2));
    await admin((c) => c.query('UPDATE crove_social.post SET title = $2 WHERE id = $1', [named, '  Khuyến   mãi\ncuối \u202Etuần\u200B ']));
    await schedule(later, hoursFromNow(30));
    await schedule(past, hoursFromNow(-1));
    await schedule(fewDays, hoursFromNow(-6 * 24));
    await admin((c) => c.query('UPDATE crove_social.post SET title = $2 WHERE id = $1', [fewDays, 'Bài cũ']));
    await schedule(longAgo, hoursFromNow(-8 * 24));
    await schedule(elsewhere, hoursFromNow(5));
    await schedule(viaVariant, hoursFromNow(40));
    await admin((c) => c.query('UPDATE crove_social.post_variant SET scheduled_at = $2 WHERE post_id = $1', [viaVariant, hoursFromNow(3)]));
    await schedule(movedOut, hoursFromNow(3));
    await admin((c) => c.query('UPDATE crove_social.post_variant SET scheduled_at = $2 WHERE post_id = $1', [movedOut, hoursFromNow(40)]));
    await schedule(archived, hoursFromNow(4));
    await admin((c) => c.query('UPDATE crove_social.post SET archived_at = now(), archived_by = $2 WHERE id = $1', [archived, o.owner]));
    await schedule(split, hoursFromNow(6));
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'approved' WHERE post_id = $1 AND channel_connection_id = $2", [split, mine]));
    const due = (items: TodayItem[]) => ofKind(items, 'deadline');
    const forOwner = due(await today(o, o.owner));
    // The oldest first; none for a post 8 days overdue, 30 hours away, with its channel's time 40 hours away, archived, or with no time.
    expect(forOwner.map((i) => i.id)).toEqual([`due:${fewDays}`, `due:${past}`, `due:${named}`, `due:${viaVariant}`, `due:${elsewhere}`, `due:${split}`, `due:${soon}`]);
    // An overdue one is said to be overdue, with its title when it has one.
    expect(forOwner[0]).toMatchObject({ title: { key: 'social.dueOverdueTitled', params: { title: 'Bài cũ' } }, dueAt: hoursFromNow(-6 * 24).toISOString() });
    expect(forOwner[1]).toMatchObject({ title: { key: 'social.dueOverdue' }, dueAt: hoursFromNow(-1).toISOString() });
    // The title is one short line, with no invisible or control character.
    expect(forOwner[2]).toEqual({ kind: 'deadline', app: 'social', id: `due:${named}`, title: { key: 'social.dueTitled', params: { title: 'Khuyến mãi cuối tuần' } }, dueAt: hoursFromNow(2).toISOString(), href: `/social/${named}` });
    expect(forOwner[3]).toMatchObject({ dueAt: hoursFromNow(3).toISOString() });
    expect(forOwner[6]).toEqual({ kind: 'deadline', app: 'social', id: `due:${soon}`, title: { key: 'social.due' }, dueAt: hoursFromNow(10).toISOString(), href: `/social/${soon}` });
    // The limited member sees theirs only, and not a post whose only channel in review is another's; the member with no limit sees all; a viewer none.
    expect(due(await today(o, o.limited)).map((i) => i.id)).toEqual([`due:${fewDays}`, `due:${past}`, `due:${named}`, `due:${viaVariant}`, `due:${soon}`]);
    expect(due(await today(o, o.free)).map((i) => i.id)).toEqual([`due:${fewDays}`, `due:${past}`, `due:${named}`, `due:${viaVariant}`, `due:${elsewhere}`, `due:${split}`, `due:${soon}`]);
    expect(await today(o, o.viewer)).toEqual([]);
    // Approved: no longer waiting.
    const view = await rt.query<{ variants: { id: string; revision: number; contentHash: string }[] }>('social.post.get', { postId: soon }, { actor: asUser(o.owner), orgId: o.orgId });
    await exec(o, o.owner, 'social.variant.decide', { postId: soon, decision: 'approved', variants: view.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    expect(due(await today(o, o.owner)).map((i) => i.id)).toEqual([`due:${fewDays}`, `due:${past}`, `due:${named}`, `due:${viaVariant}`, `due:${elsewhere}`, `due:${split}`]);
  });

  it('groups the posts past the limit into one item with their count and the next time, and every item is valid for the shared schema', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const total = TODAY_SOCIAL_DUE + 3;
    for (let i = 0; i < total; i++) await schedule(await submitted(o, o.owner, [a], `Bài ${i}`), hoursFromNow(1 + i * 0.1));
    const items = await today(o, o.owner);
    expect(zTodayItems.safeParse(items).success).toBe(true);
    const due = ofKind(items, 'deadline');
    expect(due).toHaveLength(TODAY_SOCIAL_DUE + 1);
    expect(due.at(-1)).toEqual({ kind: 'deadline', app: 'social', id: 'due:more', title: { key: 'social.dueMore', params: { count: 3 } }, count: 3, dueAt: hoursFromNow(1 + TODAY_SOCIAL_DUE * 0.1).toISOString(), href: '/social?tab=review' });
    // The review group counts all of them.
    expect(ofKind(items, 'proposal')[0]).toMatchObject({ count: total, href: '/social?tab=review' });
  });

  it('keeps every other org out', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    await submitted(o, o.free, [a]);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [a]));
    expect((await today(o, o.owner)).length).toBeGreaterThan(0);
    const other = await org();
    expect(await today(other, other.owner)).toEqual([]);
    // Not a member of that org: the runtime refuses before the query runs.
    await expect(today(other, o.owner)).rejects.toBeTruthy();
  });
});
