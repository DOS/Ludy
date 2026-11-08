// SPDX-License-Identifier: AGPL-3.0-only
// Meeting media file rows on PostgreSQL 17 (#2874, ADR-0047): a crove_kernel.file row with source meeting_audio or meeting_video names the meeting (filename),
// its size and its creator, so only the meeting's readers see it, in the file list, a search by name and a count, and the org export carries no such row.
// An attendees-only meeting's media rows are invisible to another member, an owner, an admin, a viewer, a member limited to a branch and an org-chart agent;
// the recorder and an attendee reader see them; an org-shared meeting's rows are seen by members with the whole-org scope. The system context (worker
// sweeps) keeps seeing every row. Ordinary files stay visible to every member.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, EXPORT_TABLES, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meeting media file rows are visible to readers only (#2874, ADR-0047)', () => {
  const dbName = `crove_test_meetings_media_rows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  const users = { owner: '', admin: '', recorder: '', attendee: '', member: '', viewer: '', limited: '', stranger: '', former: '' };
  let otherOrgId = '';
  const ids = {
    attendeesMeeting: randomUUID(),
    orgMeeting: randomUUID(),
    attendeesAudio: randomUUID(),
    attendeesVideo: randomUUID(),
    orgAudio: randomUUID(),
    plain: randomUUID(),
    formerUpload: randomUUID(),
  };
  let agent = { agentId: '', runId: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const member = (name: string, userId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId(), orgId)]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = {
    name: 'an agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
  };

  async function run<T>(actor: Actor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: actor.url() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await actor.enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // What the actor sees of the test's files, three ways: the plain list, a search by a name fragment (every media filename holds its meeting id),
  // and the count of media rows.
  async function seen(actor: Actor) {
    return run(actor, async (c) => {
      const list = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.file WHERE org_id = $1', [orgId])).rows.map((r) => r.id);
      const bySearch = (
        await c.query<{ id: string }>(`SELECT id FROM crove_kernel.file WHERE org_id = $1 AND (filename ILIKE $2 OR filename ILIKE $3)`, [
          orgId,
          `%${ids.attendeesMeeting}%`,
          `%${ids.orgMeeting}%`,
        ])
      ).rows.map((r) => r.id);
      const count = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.file WHERE org_id = $1 AND source IN ('meeting_audio', 'meeting_video')`, [orgId])
      ).rows[0]?.n;
      return { list, bySearch, count };
    });
  }

  const hidden = [ids.attendeesAudio, ids.attendeesVideo];
  const nonReaders: Actor[] = [
    member('another member', () => users.member),
    member('an owner', () => users.owner),
    member('an admin', () => users.admin),
    member('a viewer', () => users.viewer),
    member('a member limited to a branch', () => users.limited),
    agentActor,
  ];

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'meetings-media-rows', subject: key, email: `${key}@meetings-media-rows.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Cuộc họp riêng')).orgId;
    otherOrgId = (await createOrg(api.runtime, asUser(users.stranger), 'Công ty khác')).orgId;
    await admin(async (c) => {
      const branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [
          orgId,
          users.owner,
        ])
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer'), ($1, $7, 'member'), ($1, $8, 'member')`,
        [orgId, users.admin, users.recorder, users.attendee, users.member, users.viewer, users.limited, users.former],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      for (const [id, meeting, visibility] of [
        [ids.attendeesMeeting, 'Cuộc họp kín', 'attendees'],
        [ids.orgMeeting, 'Cuộc họp toàn công ty', 'org'],
      ] as const) {
        await c.query(
          `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, $4, 'vi', now(), now() + interval '30 minutes', 1800, $3, $5, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
          [orgId, id, users.recorder, meeting, visibility],
        );
      }
      await c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [
        orgId,
        randomUUID(),
        ids.attendeesMeeting,
        users.attendee,
      ]);
      const file = async (id: string, source: string, filename: string, createdBy: string | null) => {
        const sha256 = id.replaceAll('-', '').padEnd(64, '0');
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source, created_by)
           VALUES ($1, $2, $3, $4, $5, 'application/octet-stream', 100, $6, $7)`,
          [orgId, id, sha256, `org/${orgId}/${sha256}`, filename, source, createdBy],
        );
      };
      await file(ids.attendeesAudio, 'meeting_audio', `meeting-${ids.attendeesMeeting}-audio.bin`, users.recorder);
      await file(ids.attendeesVideo, 'meeting_video', `meeting-${ids.attendeesMeeting}-video.bin`, users.recorder);
      await file(ids.orgAudio, 'meeting_audio', `meeting-${ids.orgMeeting}-audio.bin`, users.recorder);
      await file(ids.plain, 'upload', 'hoa-don.pdf', users.owner);
      // An upload a former recorder left behind, with no segment row; the recorder is then removed from the org.
      await file(ids.formerUpload, 'meeting_audio', `meeting-${ids.attendeesMeeting}-left.bin`, users.former);
      await c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.former]);
      await c.query(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES
        ($1, $2, $3, $4, 0, 0, 600), ($1, $5, $6, $7, 0, 0, 600)`, [orgId, randomUUID(), ids.attendeesMeeting, ids.attendeesAudio, randomUUID(), ids.orgMeeting, ids.orgAudio]);
      await c.query(`INSERT INTO crove_meetings.meeting_video (org_id, id, meeting_id, file_id, length_seconds, video_retention_date) VALUES ($1, $2, $3, $4, 1800, current_date + 7)`, [
        orgId,
        randomUUID(),
        ids.attendeesMeeting,
        ids.attendeesVideo,
      ]);
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('the recorder and an attendee reader see an attendees-only meeting media rows', async () => {
    for (const actor of [member('the recorder', () => users.recorder), member('an attendee', () => users.attendee)]) {
      const s = await seen(actor);
      expect(s.list, actor.name).toEqual(expect.arrayContaining(hidden));
      expect(s.bySearch, actor.name).toEqual(expect.arrayContaining(hidden));
    }
  });

  it('every other actor sees none of them: file list, search and count', async () => {
    for (const actor of nonReaders) {
      const s = await seen(actor);
      for (const id of hidden) {
        expect(s.list, `${actor.name}: list`).not.toContain(id);
        expect(s.bySearch, `${actor.name}: search`).not.toContain(id);
      }
      expect(s.list, `${actor.name}: an ordinary file stays visible`).toContain(ids.plain);
    }
  });

  it('an org-shared meeting media row is seen by whole-org members and not by a limited member', async () => {
    for (const actor of [member('another member', () => users.member), member('an owner', () => users.owner), member('an admin', () => users.admin)]) {
      expect((await seen(actor)).list, actor.name).toContain(ids.orgAudio);
    }
    for (const actor of [member('a viewer', () => users.viewer), member('a member limited to a branch', () => users.limited), agentActor]) {
      expect((await seen(actor)).list, actor.name).not.toContain(ids.orgAudio);
    }
  });

  it('the system context keeps seeing every row, so worker sweeps work', async () => {
    const s = await seen(system);
    expect(s.list).toEqual(expect.arrayContaining([...hidden, ids.orgAudio, ids.plain]));
  });

  it('a creator reads the row of an upload that has no segment or video row yet', async () => {
    const fresh = randomUUID();
    const sha256 = fresh.replaceAll('-', '').padEnd(64, '1');
    const got = await run(member('the recorder', () => users.recorder), async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source, created_by)
           VALUES ($1, $2, $3, $4, 'pending.bin', 'application/octet-stream', 1, 'meeting_audio', $5) RETURNING id`,
          [orgId, fresh, sha256, `org/${orgId}/${sha256}`, users.recorder],
        )
      ).rows.map((r) => r.id),
    );
    expect(got).toEqual([fresh]);
    const other = await run(member('another member', () => users.member), async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM crove_kernel.file WHERE id = $1', [fresh])).rows.length,
    );
    expect(other).toBe(0);
  });

  it('a former recorder removed from the org and a member of another org see none of them', async () => {
    const former = await run(member('a former recorder', () => users.former), async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.file')).rows.map((r) => r.id)).then(
      (rows) => rows,
      () => [] as string[], // a context refused to a non-member also shows nothing
    );
    expect(former).not.toContain(ids.formerUpload);
    for (const id of [...hidden, ids.orgAudio, ids.formerUpload]) expect(former).not.toContain(id);
    const stranger: Actor = {
      name: 'a member of another org',
      url: () => appUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [otherOrgId, contextToken(users.stranger, otherOrgId)]),
    };
    const rows = await run(stranger, async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.file')).rows.map((r) => r.id));
    for (const id of [...hidden, ids.orgAudio, ids.plain, ids.formerUpload]) expect(rows).not.toContain(id);
  });

  it('the org export carries no meeting media row', async () => {
    const from = EXPORT_TABLES['kernel.file'].from;
    for (const actor of [system, member('an owner', () => users.owner)]) {
      const ids2 = await run(actor, async (c) => (await c.query<{ id: string }>(`SELECT t.id FROM ${from} t WHERE t.org_id = $1`, [orgId])).rows.map((r) => r.id));
      for (const id of [...hidden, ids.orgAudio]) expect(ids2, actor.name).not.toContain(id);
      expect(ids2, actor.name).toContain(ids.plain);
    }
  });
});
