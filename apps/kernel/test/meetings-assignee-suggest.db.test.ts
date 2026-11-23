// SPDX-License-Identifier: AGPL-3.0-only
// Who an action item probably belongs to, from the name said in the meeting, on a real database (#3921). Code finds the one attendee, else the one
// member of the org, a said name answers to; two matches or none give nothing; nothing is stored, and the person still picks the seat.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the assignee suggested for an action item (#3921)', () => {
  const dbName = `crove_test_assignee_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });

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

  async function seedMeeting(recorder: string, readers: string[]): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    return meetingId;
  }
  async function seedPosition(who: string, title: string): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, holder_user_id) VALUES ($1, $2, $3, 'kernel', 'member', $4)`, [orgId, id, title, users[who]]);
    return id;
  }
  async function member(key: string, name: string | null): Promise<void> {
    users[key] = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'assignee', subject: key, email: `${key}@assignee.test`, name });
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [orgId, users[key]]);
  }
  type Suggestion = { userId: string; name: string; source: 'attendee' | 'member'; positions: Array<{ id: string; title: string }> } | null;
  type Items = { items: Array<{ id: string; who: string; whoUserId: string | null; suggestion: Suggestion }> };
  // One item per said name, as the recorder's draft; returns what the recorder reads for each.
  async function suggestionsFor(meetingId: string, said: string[]): Promise<Record<string, Suggestion>> {
    const ids: Record<string, string> = {};
    for (const who of said) ids[who] = (await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', { meetingId, title: `Việc của ${who}`, who, whoUserId: null, when: '', whenDate: null, transcriptSeconds: 10 })).itemId;
    const read = await query<Items>('recorder', 'meetings.result.get', { meetingId });
    return Object.fromEntries(said.map((who) => [who, read.items.find((i) => i.id === ids[who])?.suggestion ?? null]));
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    users.owner = await upsertIdentity(createDb(pool), { issuer: 'assignee', subject: 'owner', email: 'owner@assignee.test', name: 'Chủ Tiệm' });
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Assignee')).orgId;
    await member('recorder', 'Trần Văn Nam');
    await member('reader', 'Lê Thị Lan');
    await member('quan', 'Nguyễn Minh Quân');
    await member('minh1', 'Phạm Hoàng Minh');
    await member('minh2', 'Võ Văn Minh');
    await member('nameless', null);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('suggests the one attendee a said name answers to, then the one other member, and nobody when it is ambiguous or unknown', async () => {
    const meetingId = await seedMeeting('recorder', ['reader']);
    const got = await suggestionsFor(meetingId, ['anh Nam', 'chi lan bên kế toán', 'Quân', 'anh Minh', 'bạn Hùng', 'mọi người']);
    expect(got['anh Nam']).toMatchObject({ userId: users.recorder, name: 'Trần Văn Nam', source: 'attendee' });
    expect(got['chi lan bên kế toán']).toMatchObject({ userId: users.reader, name: 'Lê Thị Lan', source: 'attendee' });
    expect(got.Quân).toMatchObject({ userId: users.quan, name: 'Nguyễn Minh Quân', source: 'member' });
    // Two members called Minh, and no attendee of that name: no guess.
    expect(got['anh Minh']).toBeNull();
    expect(got['bạn Hùng']).toBeNull();
    expect(got['mọi người']).toBeNull();
  });

  it('lists the seats the suggested person holds now, and stores nothing of the suggestion', async () => {
    const meetingId = await seedMeeting('recorder', ['reader']);
    const seatA = await seedPosition('quan', 'Kế toán');
    const before = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1`, [orgId]);
    const got = await suggestionsFor(meetingId, ['Quân']);
    expect(got.Quân?.positions).toEqual([{ id: seatA, title: 'Kế toán' }]);
    const stored = await sqlAdmin<{ who_parsed: string | null }>(`SELECT who_parsed FROM ludy_meetings.action_item WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]);
    expect(stored.rows.every((r) => r.who_parsed === null)).toBe(true);
    const after = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1`, [orgId]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('never suggests for an item that already names an attendee, and ignores a member with no display name', async () => {
    const meetingId = await seedMeeting('recorder', ['reader']);
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Việc đã có người', who: 'Quân', whoUserId: users.reader, when: '', whenDate: null, transcriptSeconds: 10 });
    const read = await query<Items>('recorder', 'meetings.result.get', { meetingId });
    expect(read.items[0]).toMatchObject({ whoUserId: users.reader, suggestion: null });
    // The member with no name is never found by an empty or a made-up name, and an email local part is not a name.
    const got = await suggestionsFor(meetingId, ['nameless']);
    expect(got.nameless).toBeNull();
  });
});
