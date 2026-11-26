// SPDX-License-Identifier: AGPL-3.0-only
// Access, row-level security, tenancy, and retention invariants of `meetings.meeting.list` (#5052) on PostgreSQL 17.
// Part of the invariant suite: imports only package code under test and test/invariant/fixtures.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MeetingListInput, MeetingListItem } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meetings.meeting.list access invariants (#5052)', () => {
  const dbName = `ludy_test_meeting_list_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = {
    owner: 'Chủ Công Ty',
    rec: 'Người Ghi',
    solo: 'Thành Viên Chung',
    nam: 'Nguyễn Văn Nam',
    viewer: 'Người Xem',
    otherOwner: 'Chủ Công Ty Khác',
  };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const listMeetings = (who: string, input: MeetingListInput = {}, targetOrg = orgId) =>
    runtime.query<MeetingListItem[]>('meetings.meeting.list', input, { actor: asUser(who), orgId: targetOrg });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  async function seedMeeting(
    title: string,
    opts: {
      org?: string;
      recorder?: string;
      readers?: string[];
      visibility?: 'attendees' | 'org';
      startedAt?: string;
      expired?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const targetOrg = opts.org ?? orgId;
    const recorder = users[opts.recorder ?? 'rec'] as string;
    const startedAt = opts.startedAt ?? '2026-11-25T03:00:00.000Z';
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, created_at, updated_at)
       VALUES ($1, $2, $4, 'vi', $6::timestamptz, $6::timestamptz + interval '1 hour', 3600, $3, $5, 'ready', 'told_at_start', $3, $6::timestamptz, '1.0', current_date + 30, ${opts.expired ? 'current_date - 1' : 'current_date + 365'}, $6::timestamptz, $6::timestamptz)`,
      [targetOrg, id, recorder, title, opts.visibility ?? 'attendees', startedAt],
    );
    for (const reader of opts.readers ?? ['solo']) {
      await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [targetOrg, randomUUID(), id, users[reader]]);
    }
    return id;
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const login = (role: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(role) : role;
      url.password = password;
      return url.toString();
    };
    const appPool = createDbPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 }, dbIds);
    const workerPool = createDbPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 }, dbIds);
    pools.push(appPool, workerPool);
    const db = createDb(appPool);
    const registry = {
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of Object.keys(NAMES)) {
      users[key] = await upsertIdentity(db, { issuer: 'meeting-list-inv', subject: key, email: `${key}@meeting-list-inv.test`, name: NAMES[key] as string });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Bất Biến')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('otherOwner'), 'Công ty Khác Bất Biến')).orgId;
    await sqlAdmin(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, users.rec, users.solo, users.nam, users.viewer],
    );
    // `solo` belongs to BOTH orgId and otherOrgId so cross-org isolation is proved independently of reader membership.
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [otherOrgId, users.solo]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces RLS, visibility, retention expiry, org isolation, viewer refusal, and system actor refusal across search and cursors', async () => {
    const hiddenMs = await seedMeeting('Họp bí mật Hoa Sen', { readers: ['nam'], startedAt: '2026-11-25T04:00:00.000900Z' });
    const expired = await seedMeeting('Họp hết hạn Hoa Sen', { readers: ['solo'], expired: true, startedAt: '2026-11-25T04:00:00.000800Z' });
    const sharedOrg = await seedMeeting('Họp chung Hoa Sen', { visibility: 'org', readers: [], startedAt: '2026-11-25T04:00:00.000100Z' });
    const otherOrgMeeting = await seedMeeting('Họp Hoa Sen Công Ty Khác', {
      org: otherOrgId,
      recorder: 'otherOwner',
      readers: ['solo'],
      startedAt: '2026-11-25T06:00:00.000Z',
    });

    // Attendees-only meeting stays hidden from non-reader member and owner; both read org-visible meeting; expired meeting stays hidden.
    expect((await listMeetings('solo', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([sharedOrg]);
    expect((await listMeetings('owner', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([sharedOrg]);
    expect((await listMeetings('nam', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([hiddenMs, sharedOrg]);
    expect((await listMeetings('rec', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([hiddenMs, sharedOrg]);
    expect((await listMeetings('rec')).map((m) => m.id)).not.toContain(expired);

    // Passing a hidden or expired meeting's id with a truncated millisecond timestamp reveals no sub-millisecond metadata:
    // no server-side cursor lookup runs, so sharedOrg (.000100Z > .000Z) is never returned after a truncated cursor.
    const fromHiddenCursor = await listMeetings('solo', {
      afterStartedAt: '2026-11-25T04:00:00.000Z',
      afterId: hiddenMs,
    });
    expect(fromHiddenCursor).toEqual([]);

    const fromExpiredCursor = await listMeetings('solo', {
      afterStartedAt: '2026-11-25T04:00:00.000Z',
      afterId: expired,
    });
    expect(fromExpiredCursor).toEqual([]);

    // Authorized reader `nam` pages past `hiddenMs` to `sharedOrg` inside the same millisecond using the returned cursor.
    const namPage1 = await listMeetings('nam', { search: 'Hoa Sen', limit: 1 });
    expect(namPage1.map((m) => m.id)).toEqual([hiddenMs]);
    expect(namPage1[0]?.startedAt).toBeTruthy();
    const namPage2 = await listMeetings('nam', {
      search: 'Hoa Sen',
      limit: 1,
      afterStartedAt: namPage1[0]!.startedAt!,
      afterId: namPage1[0]!.id,
    });
    expect(namPage2.map((m) => m.id)).toEqual([sharedOrg]);

    // Same member `solo` sees `otherOrgMeeting` inside otherOrgId, never inside orgId.
    expect((await listMeetings('solo', { search: 'Công Ty Khác' }, otherOrgId)).map((m) => m.id)).toEqual([otherOrgMeeting]);
    expect(await listMeetings('solo', { search: 'Công Ty Khác' }, orgId)).toEqual([]);

    // Viewer role and system actor (via ludy_worker pool) are refused.
    await expect(listMeetings('viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      workerRuntime.query('meetings.meeting.list', {}, { actor: { type: 'system', component: 'test.meeting-list-inv' }, orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
