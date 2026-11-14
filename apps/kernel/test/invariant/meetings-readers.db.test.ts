// SPDX-License-Identifier: AGPL-3.0-only
// Meeting notes readers and permissions on PostgreSQL 17 (issue #2575, ADR-0047, meetings plan M1):
// - an attendees-only meeting is read and written only by its recorder and attendee readers;
//   another member, owner, admin, viewer, entity-limited member, org-chart agent, and the worker system context
//   read and write nothing of it;
// - an attendee, owner, and admin read and write no draft result rows (stage = 'draft'), only the meeting recorder does;
// - no non-owner role or PUBLIC has any table or column privilege on crove_meetings.media_key;
// - worker and admin SECURITY DEFINER functions in crove_meetings pin search_path = pg_catalog, pg_temp, grant no EXECUTE to PUBLIC,
//   and return only allowed metadata scalar or table column types, never meeting text.
// While crove_meetings tables do not exist yet (to_regclass is null), the tests pass cleanly with zero skipped tests.
// Staged table arrival across M2 (#2576), M4 (#2578), and M6 (#2580) is tested with explicit assertions and zero skipped tests.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

function validateDefinerReturnType(rawRetType: string): { ok: boolean; reason?: string } {
  const norm = rawRetType.toLowerCase().trim();
  if (norm === 'trigger') return { ok: true };
  const stripped = norm.replace(/^setof\s+/, '');
  const ALLOWED_SCALARS = new Set([
    'void',
    'uuid',
    'boolean',
    'integer',
    'bigint',
    'smallint',
    'timestamp with time zone',
    'date',
    'bytea',
  ]);
  if (ALLOWED_SCALARS.has(stripped)) {
    return { ok: true };
  }
  const tableMatch = stripped.match(/^table\s*\((.*)\)$/);
  if (tableMatch) {
    const cols = tableMatch[1]!.split(',').map((c) => c.trim()).filter(Boolean);
    if (cols.length === 0) return { ok: false, reason: 'empty TABLE(...) definition' };
    for (const col of cols) {
      const parts = col.split(/\s+/);
      const colName = parts[0];
      const colType = parts.slice(1).join(' ');
      if (ALLOWED_SCALARS.has(colType)) {
        continue;
      }
      if ((colType === 'text' || colType === 'varchar' || colType === 'character varying') && (colName === 'key_id' || colName === 'kind')) {
        continue;
      }
      return { ok: false, reason: `disallowed column in TABLE(...): ${col} (type ${colType} not permitted for ${colName})` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `disallowed return type: ${rawRetType}` };
}

suite('meeting notes readers and permissions on PostgreSQL (#2575, ADR-0047)', () => {
  const dbName = `crove_test_meetings_readers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const tables = {
    meeting: false,
    meeting_reader: false,
    audio_segment: false,
    meeting_video: false,
    media_key: false,
    transcript_segment: false,
    meeting_result: false,
    action_item: false,
  };
  const users = { owner: '', admin: '', recorder: '', attendee: '', member: '', viewer: '', limited: '' };
  const meetings = { attendeesMeeting: randomUUID(), orgMeeting: randomUUID(), file: randomUUID() };
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

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
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

  const recorder = member('the recorder', () => users.recorder);
  const attendee = member('an attendee', () => users.attendee);
  const nonReaders: Actor[] = [
    member('another member', () => users.member),
    member('an owner', () => users.owner),
    member('an admin', () => users.admin),
    member('a viewer', () => users.viewer),
    member('a member limited to a branch', () => users.limited),
    agentActor,
    system,
  ];
  // Deduplicated per review: nonReaders already contains owner and admin
  const nonRecorders: Actor[] = [attendee, ...nonReaders];

  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }),
    );

  async function expectNoHiddenDelete(actor: Actor, table: string, opts?: { mustSeeZero?: boolean }) {
    const res = await outcome(
      run(actor, async (c) => {
        const before = (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0;
        if (opts?.mustSeeZero) {
          expect(before, `${actor.name} must see 0 rows in ${table} before delete`).toBe(0);
        }
        const del = await c.query(`DELETE FROM ${table}`);
        const after = (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0;
        return { before, after, changed: del.rowCount ?? 0 };
      }),
    );
    if (!res.ok) {
      expect(res, `${actor.name} deleting from ${table}`).toMatchObject({ code: '42501' });
    } else {
      expect(res.value.changed, `${actor.name} deleted rows must equal visible rows removed`).toBe(res.value.before - res.value.after);
      expect(res.value.after, `${actor.name} after delete`).toBeLessThanOrEqual(res.value.before);
    }
  }

  async function expectNoHiddenUpdate(actor: Actor, table: string, col: string, sentinel: unknown, opts?: { mustSeeZero?: boolean }) {
    const res = await outcome(
      run(actor, async (c) => {
        const before = (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0;
        if (opts?.mustSeeZero) {
          expect(before, `${actor.name} must see 0 rows in ${table} before update`).toBe(0);
        }
        const upd = await c.query(`UPDATE ${table} SET ${col} = $1`, [sentinel]);
        const after = (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0;
        const matching = (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE ${col} = $1`, [sentinel])).rows[0]?.count ?? 0;
        return { before, after, changed: upd.rowCount ?? 0, matching };
      }),
    );
    if (!res.ok) {
      expect(res, `${actor.name} updating ${table}.${col}`).toMatchObject({ code: '42501' });
    } else {
      expect(res.value.after, `${actor.name} total rows after update must equal before`).toBe(res.value.before);
      expect(res.value.changed, `${actor.name} changed rows must not exceed matching rows`).toBeLessThanOrEqual(res.value.matching);
    }
  }

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
      users[key] = await upsertIdentity(api.db, { issuer: 'meetings-readers', subject: key, email: `${key}@meetings-readers.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Cuộc họp riêng')).orgId;
    await admin(async (c) => {
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [
          orgId,
          users.owner,
        ])
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer'), ($1, $7, 'member')`,
        [orgId, users.admin, users.recorder, users.attendee, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      const sha256 = '0'.repeat(64);
      await c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, 'audio.opus', 'audio/ogg', 100, 'upload')`,
        [orgId, meetings.file, sha256, `org/${orgId}/${sha256}`],
      );
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };

    const checkTable = async (name: string) =>
      (await admin(async (c) => (await c.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0]?.ok)) === true;

    tables.meeting = await checkTable('crove_meetings.meeting');
    tables.meeting_reader = await checkTable('crove_meetings.meeting_reader');
    tables.audio_segment = await checkTable('crove_meetings.audio_segment');
    tables.meeting_video = await checkTable('crove_meetings.meeting_video');
    tables.media_key = await checkTable('crove_meetings.media_key');
    tables.transcript_segment = await checkTable('crove_meetings.transcript_segment');
    tables.meeting_result = await checkTable('crove_meetings.meeting_result');
    tables.action_item = await checkTable('crove_meetings.action_item');

    if (tables.meeting) {
      await admin(async (c) => {
        // Attendees-only meeting
        await c.query(
          `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, 'Cuộc họp kín', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
          [orgId, meetings.attendeesMeeting, users.recorder],
        );
        // Org-shared meeting
        await c.query(
          `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, 'Cuộc họp toàn công ty', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'org', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
          [orgId, meetings.orgMeeting, users.recorder],
        );

        // Reader attendee for attendees-only meeting
        if (tables.meeting_reader) {
          await c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [
            orgId,
            randomUUID(),
            meetings.attendeesMeeting,
            users.attendee,
          ]);
        }

        // Audio segments
        if (tables.audio_segment) {
          await c.query(
            `INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES
               ($1, $2, $3, $5, 0, 0, 600),
               ($1, $4, $6, $5, 0, 0, 600)`,
            [orgId, randomUUID(), meetings.attendeesMeeting, randomUUID(), meetings.file, meetings.orgMeeting],
          );
        }

        // Meeting videos
        if (tables.meeting_video) {
          await c.query(
            `INSERT INTO crove_meetings.meeting_video (org_id, id, meeting_id, file_id, length_seconds, video_retention_date) VALUES
               ($1, $2, $3, $5, 1800, current_date + 7),
               ($1, $4, $6, $5, 1800, current_date + 7)`,
            [orgId, randomUUID(), meetings.attendeesMeeting, randomUUID(), meetings.file, meetings.orgMeeting],
          );
        }

        // Transcript segments (M4)
        if (tables.transcript_segment) {
          await c.query(
            `INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES
               ($1, $2, $4, 0, 10, 'Người nói 1', 'Đã công bố', 'published'),
               ($1, $3, $4, 10, 20, 'Người nói 2', 'Bản nháp', 'draft'),
               ($1, $5, $7, 0, 10, 'Người nói 1', 'Đã công bố toàn công ty', 'published'),
               ($1, $6, $7, 10, 20, 'Người nói 2', 'Bản nháp toàn công ty', 'draft')`,
            [orgId, randomUUID(), randomUUID(), meetings.attendeesMeeting, randomUUID(), randomUUID(), meetings.orgMeeting],
          );
        }

        // Meeting results (M6)
        if (tables.meeting_result) {
          await c.query(
            `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted) VALUES
               ($1, $2, $4, 'Tóm tắt công bố', '["Quyết định 1"]', 'meetings.summary', 'published', false),
               ($1, $3, $4, 'Tóm tắt nháp', '["Quyết định nháp"]', 'meetings.summary', 'draft', true),
               ($1, $5, $7, 'Tóm tắt toàn công ty', '["Quyết định công ty"]', 'meetings.summary', 'published', false),
               ($1, $6, $7, 'Tóm tắt nháp công ty', '["Quyết định nháp"]', 'meetings.summary', 'draft', true)`,
            [orgId, randomUUID(), randomUUID(), meetings.attendeesMeeting, randomUUID(), randomUUID(), meetings.orgMeeting],
          );
        }

        // Action items (M6)
        if (tables.action_item) {
          await c.query(
            `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, flags, tainted) VALUES
               ($1, $2, $4, 'Việc công bố', 'A', $5, 'Hôm nay', '2026-11-04', 5, 'published', 'accepted', '[]', false),
               ($1, $3, $4, 'Việc nháp', 'B', $5, 'Ngày mai', '2026-11-05', 15, 'draft', 'suggested', '[]', true),
               ($1, $6, $8, 'Việc công ty', 'A', $5, 'Hôm nay', '2026-11-04', 5, 'published', 'accepted', '[]', false),
               ($1, $7, $8, 'Việc nháp công ty', 'B', $5, 'Ngày mai', '2026-11-05', 15, 'draft', 'suggested', '[]', true)`,
            [orgId, randomUUID(), randomUUID(), meetings.attendeesMeeting, users.recorder, randomUUID(), randomUUID(), meetings.orgMeeting],
          );
        }
      });
    }
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('passes cleanly while crove_meetings tables do not exist; once present, lets the recorder and attendee readers read attendees-only meetings, and whole-org members read org meetings', async () => {
    if (!tables.meeting) {
      // Assert all 8 crove_meetings tables are absent (fail closed on orphan tables)
      expect(tables.meeting).toBe(false);
      expect(tables.meeting_reader).toBe(false);
      expect(tables.audio_segment).toBe(false);
      expect(tables.meeting_video).toBe(false);
      expect(tables.media_key).toBe(false);
      expect(tables.transcript_segment).toBe(false);
      expect(tables.meeting_result).toBe(false);
      expect(tables.action_item).toBe(false);
      return;
    }

    // When crove_meetings.meeting exists (M2+), core M2 tables must be present
    expect(tables.meeting_reader).toBe(true);
    expect(tables.audio_segment).toBe(true);
    expect(tables.meeting_video).toBe(true);
    expect(tables.media_key).toBe(true);

    // The recorder reads the attendees-only meeting
    const recorderSeen = await run(recorder, async (c) => ({
      meetings: (await c.query<{ id: string }>('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.attendeesMeeting])).rowCount,
      audio: (await c.query('SELECT id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
      video: (await c.query('SELECT id FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
      transcripts: tables.transcript_segment ? (await c.query('SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
      results: tables.meeting_result ? (await c.query('SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
      items: tables.action_item ? (await c.query('SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
    }));
    expect(recorderSeen.meetings).toBe(1);
    expect(recorderSeen.audio).toBe(1);
    expect(recorderSeen.video).toBe(1);
    if (tables.transcript_segment) expect(recorderSeen.transcripts).toBe(2);
    if (tables.meeting_result) expect(recorderSeen.results).toBe(2);
    if (tables.action_item) expect(recorderSeen.items).toBe(2);

    // The attendee reads the attendees-only meeting and its published child records
    const attendeeSeen = await run(attendee, async (c) => ({
      meetings: (await c.query<{ id: string }>('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.attendeesMeeting])).rowCount,
      audio: (await c.query('SELECT id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
      video: (await c.query('SELECT id FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
      publishedTranscripts: tables.transcript_segment
        ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'published'", [meetings.attendeesMeeting])).rowCount
        : 0,
      publishedResults: tables.meeting_result
        ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'published'", [meetings.attendeesMeeting])).rowCount
        : 0,
      publishedItems: tables.action_item
        ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'published'", [meetings.attendeesMeeting])).rowCount
        : 0,
    }));
    expect(attendeeSeen.meetings).toBe(1);
    expect(attendeeSeen.audio).toBe(1);
    expect(attendeeSeen.video).toBe(1);
    if (tables.transcript_segment) expect(attendeeSeen.publishedTranscripts).toBe(1);
    if (tables.meeting_result) expect(attendeeSeen.publishedResults).toBe(1);
    if (tables.action_item) expect(attendeeSeen.publishedItems).toBe(1);

    // Whole-org members (owner, admin, member) read the org-shared meeting and its published child records
    const orgMembers: Actor[] = [
      member('an owner', () => users.owner),
      member('an admin', () => users.admin),
      member('another member', () => users.member),
    ];
    for (const actor of orgMembers) {
      const orgSeen = await run(actor, async (c) => ({
        meetings: (await c.query<{ id: string }>('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.orgMeeting])).rowCount,
        audio: (await c.query('SELECT id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount,
        video: (await c.query('SELECT id FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount,
        publishedTranscripts: tables.transcript_segment
          ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'published'", [meetings.orgMeeting])).rowCount
          : 0,
        publishedResults: tables.meeting_result
          ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'published'", [meetings.orgMeeting])).rowCount
          : 0,
        publishedItems: tables.action_item
          ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'published'", [meetings.orgMeeting])).rowCount
          : 0,
      }));
      expect(orgSeen.meetings, `${actor.name} reading org meeting`).toBe(1);
      expect(orgSeen.audio, `${actor.name} reading org audio`).toBe(1);
      expect(orgSeen.video, `${actor.name} reading org video`).toBe(1);
      if (tables.transcript_segment) expect(orgSeen.publishedTranscripts, `${actor.name} reading org published transcripts`).toBe(1);
      if (tables.meeting_result) expect(orgSeen.publishedResults, `${actor.name} reading org published results`).toBe(1);
      if (tables.action_item) expect(orgSeen.publishedItems, `${actor.name} reading org published items`).toBe(1);
    }
  });

  it('lets non-readers read and write nothing of an attendees-only meeting, and restricts org meetings from non-members and system context', async () => {
    if (!tables.meeting) {
      expect(tables.meeting).toBe(false);
      return;
    }

    // 1. Reads on attendees-only meeting
    for (const actor of nonReaders) {
      const where = actor.name;
      const seen = await run(actor, async (c) => ({
        meetings: (await c.query('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.attendeesMeeting])).rowCount,
        readers: (await c.query('SELECT id FROM crove_meetings.meeting_reader WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
        audio: (await c.query('SELECT id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
        video: (await c.query('SELECT id FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount,
        transcripts: tables.transcript_segment ? (await c.query('SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
        results: tables.meeting_result ? (await c.query('SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
        items: tables.action_item ? (await c.query('SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1', [meetings.attendeesMeeting])).rowCount : 0,
      }));
      expect(seen.meetings, `${where} reading attendees-only meeting`).toBe(0);
      expect(seen.readers, `${where} reading readers of attendees-only meeting`).toBe(0);
      expect(seen.audio, `${where} reading audio segments of attendees-only meeting`).toBe(0);
      expect(seen.video, `${where} reading video of attendees-only meeting`).toBe(0);
      if (tables.transcript_segment) expect(seen.transcripts, `${where} reading transcripts of attendees-only meeting`).toBe(0);
      if (tables.meeting_result) expect(seen.results, `${where} reading results of attendees-only meeting`).toBe(0);
      if (tables.action_item) expect(seen.items, `${where} reading action items of attendees-only meeting`).toBe(0);
    }

    // 2. Restricted actors on org-shared meeting (viewer, limited, agentActor, system)
    const restrictedFromOrg: Actor[] = [
      member('a viewer', () => users.viewer),
      member('a member limited to a branch', () => users.limited),
      agentActor,
      system,
    ];
    for (const actor of restrictedFromOrg) {
      const where = actor.name;
      const seen = await run(actor, async (c) => ({
        meetings: (await c.query('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.orgMeeting])).rowCount,
        audio: (await c.query('SELECT id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount,
        video: (await c.query('SELECT id FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount,
        transcripts: tables.transcript_segment ? (await c.query('SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount : 0,
        results: tables.meeting_result ? (await c.query('SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount : 0,
        items: tables.action_item ? (await c.query('SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1', [meetings.orgMeeting])).rowCount : 0,
      }));
      expect(seen.meetings, `${where} reading org meeting`).toBe(0);
      expect(seen.audio, `${where} reading org audio`).toBe(0);
      expect(seen.video, `${where} reading org video`).toBe(0);
      if (tables.transcript_segment) expect(seen.transcripts, `${where} reading org transcripts`).toBe(0);
      if (tables.meeting_result) expect(seen.results, `${where} reading org results`).toBe(0);
      if (tables.action_item) expect(seen.items, `${where} reading org action items`).toBe(0);
    }

    // 3. Write isolation on attendees-only meeting
    for (const actor of nonReaders) {
      const where = actor.name;

      // Update and delete meeting by id
      const updated = await outcome(run(actor, (c) => c.query("UPDATE crove_meetings.meeting SET title = 'đổi' WHERE id = $1", [meetings.attendeesMeeting])));
      if (updated.ok) expect(updated.value.rowCount, `${where} updating attendees-only meeting`).toBe(0);
      else expect(updated, `${where} updating attendees-only meeting`).toMatchObject({ code: '42501' });

      const deleted = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.meeting WHERE id = $1', [meetings.attendeesMeeting])));
      if (deleted.ok) expect(deleted.value.rowCount, `${where} deleting attendees-only meeting`).toBe(0);
      else expect(deleted, `${where} deleting attendees-only meeting`).toMatchObject({ code: '42501' });

      // Update and delete meeting_reader by meeting_id
      const updatedReader = await outcome(run(actor, (c) => c.query('UPDATE crove_meetings.meeting_reader SET user_id = $2 WHERE meeting_id = $1', [meetings.attendeesMeeting, users.member])));
      if (updatedReader.ok) expect(updatedReader.value.rowCount, `${where} updating reader by meeting_id`).toBe(0);
      else expect(updatedReader, `${where} updating reader by meeting_id`).toMatchObject({ code: '42501' });

      const deletedReader = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.meeting_reader WHERE meeting_id = $1', [meetings.attendeesMeeting])));
      if (deletedReader.ok) expect(deletedReader.value.rowCount, `${where} deleting reader by meeting_id`).toBe(0);
      else expect(deletedReader, `${where} deleting reader by meeting_id`).toMatchObject({ code: '42501' });

      // Child update and delete by meeting_id
      const updatedAudio = await outcome(run(actor, (c) => c.query('UPDATE crove_meetings.audio_segment SET length_seconds = 1 WHERE meeting_id = $1', [meetings.attendeesMeeting])));
      if (updatedAudio.ok) expect(updatedAudio.value.rowCount, `${where} updating audio`).toBe(0);
      else expect(updatedAudio, `${where} updating audio`).toMatchObject({ code: '42501' });

      const deletedAudio = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])));
      if (deletedAudio.ok) expect(deletedAudio.value.rowCount, `${where} deleting audio`).toBe(0);
      else expect(deletedAudio, `${where} deleting audio`).toMatchObject({ code: '42501' });

      const updatedVideo = await outcome(run(actor, (c) => c.query('UPDATE crove_meetings.meeting_video SET length_seconds = 1 WHERE meeting_id = $1', [meetings.attendeesMeeting])));
      if (updatedVideo.ok) expect(updatedVideo.value.rowCount, `${where} updating video`).toBe(0);
      else expect(updatedVideo, `${where} updating video`).toMatchObject({ code: '42501' });

      const deletedVideo = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.meeting_video WHERE meeting_id = $1', [meetings.attendeesMeeting])));
      if (deletedVideo.ok) expect(deletedVideo.value.rowCount, `${where} deleting video`).toBe(0);
      else expect(deletedVideo, `${where} deleting video`).toMatchObject({ code: '42501' });

      if (tables.transcript_segment) {
        const u = await outcome(run(actor, (c) => c.query("UPDATE crove_meetings.transcript_segment SET text = 'đổi' WHERE meeting_id = $1", [meetings.attendeesMeeting])));
        if (u.ok) expect(u.value.rowCount, `${where} updating transcript`).toBe(0);
        else expect(u, `${where} updating transcript`).toMatchObject({ code: '42501' });

        const d = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [meetings.attendeesMeeting])));
        if (d.ok) expect(d.value.rowCount, `${where} deleting transcript`).toBe(0);
        else expect(d, `${where} deleting transcript`).toMatchObject({ code: '42501' });
      }

      if (tables.meeting_result) {
        const u = await outcome(run(actor, (c) => c.query("UPDATE crove_meetings.meeting_result SET summary = 'đổi' WHERE meeting_id = $1", [meetings.attendeesMeeting])));
        if (u.ok) expect(u.value.rowCount, `${where} updating result`).toBe(0);
        else expect(u, `${where} updating result`).toMatchObject({ code: '42501' });

        const d = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.meeting_result WHERE meeting_id = $1', [meetings.attendeesMeeting])));
        if (d.ok) expect(d.value.rowCount, `${where} deleting result`).toBe(0);
        else expect(d, `${where} deleting result`).toMatchObject({ code: '42501' });
      }

      if (tables.action_item) {
        const u = await outcome(run(actor, (c) => c.query("UPDATE crove_meetings.action_item SET title = 'đổi' WHERE meeting_id = $1", [meetings.attendeesMeeting])));
        if (u.ok) expect(u.value.rowCount, `${where} updating action item`).toBe(0);
        else expect(u, `${where} updating action item`).toMatchObject({ code: '42501' });

        const d = await outcome(run(actor, (c) => c.query('DELETE FROM crove_meetings.action_item WHERE meeting_id = $1', [meetings.attendeesMeeting])));
        if (d.ok) expect(d.value.rowCount, `${where} deleting action item`).toBe(0);
        else expect(d, `${where} deleting action item`).toMatchObject({ code: '42501' });
      }

      // Self-insert into meeting_reader on attendeesMeeting (escalation probe)
      const selfReader = await outcome(
        run(actor, (c) => c.query('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetings.attendeesMeeting, users.member])),
      );
      expect(selfReader, `${where} self-inserting as reader`).toMatchObject({ ok: false, code: '42501' });

      // Forged recorder_user_id INSERT into crove_meetings.meeting (attempting to record as someone else)
      const victim = actor.name === 'an owner' ? users.recorder : users.owner;
      const forgedMeeting = await outcome(
        run(actor, (c) =>
          c.query(
            `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
             VALUES ($1, $2, 'Giả mạo', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
            [orgId, randomUUID(), victim],
          ),
        ),
      );
      expect(forgedMeeting, `${where} forging recorder_user_id`).toMatchObject({ ok: false, code: '42501' });

      // Child inserts by non-readers
      const insertAudio = await outcome(
        run(actor, (c) =>
          c.query('INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 1, 600, 600)', [
            orgId,
            randomUUID(),
            meetings.attendeesMeeting,
            meetings.file,
          ]),
        ),
      );
      expect(insertAudio, `${where} inserting audio into attendees-only meeting`).toMatchObject({ ok: false, code: '42501' });

      const insertVideo = await outcome(
        run(actor, (c) =>
          c.query('INSERT INTO crove_meetings.meeting_video (org_id, id, meeting_id, file_id, length_seconds, video_retention_date) VALUES ($1, $2, $3, $4, 1800, current_date + 7)', [
            orgId,
            randomUUID(),
            meetings.attendeesMeeting,
            meetings.file,
          ]),
        ),
      );
      expect(insertVideo, `${where} inserting video into attendees-only meeting`).toMatchObject({ ok: false, code: '42501' });

      // No-WHERE sweeps across present tables using expectNoHiddenUpdate and expectNoHiddenDelete
      const presentTables: Array<{ table: string; col: string; sentinel: unknown }> = [
        { table: 'crove_meetings.meeting', col: 'title', sentinel: 'quét' },
        { table: 'crove_meetings.meeting_reader', col: 'user_id', sentinel: randomUUID() },
        { table: 'crove_meetings.audio_segment', col: 'length_seconds', sentinel: 999 },
        { table: 'crove_meetings.meeting_video', col: 'length_seconds', sentinel: 999 },
      ];
      if (tables.transcript_segment) presentTables.push({ table: 'crove_meetings.transcript_segment', col: 'text', sentinel: 'quét' });
      if (tables.meeting_result) presentTables.push({ table: 'crove_meetings.meeting_result', col: 'summary', sentinel: 'quét' });
      if (tables.action_item) presentTables.push({ table: 'crove_meetings.action_item', col: 'title', sentinel: 'quét' });

      for (const { table, col, sentinel } of presentTables) {
        const mustSeeZero = ['a viewer', 'a member limited to a branch', 'an agent context', 'the system context'].includes(actor.name) || table === 'crove_meetings.meeting_reader';
        await expectNoHiddenUpdate(actor, table, col, sentinel, { mustSeeZero });
        await expectNoHiddenDelete(actor, table, { mustSeeZero });
      }
    }

    // 4. Nobody changes who recorded a meeting, not even the recorder
    const changedRecorder = await outcome(
      run(recorder, (c) => c.query('UPDATE crove_meetings.meeting SET recorder_user_id = $2 WHERE id = $1', [meetings.attendeesMeeting, users.member])),
    );
    if (changedRecorder.ok) expect(changedRecorder.value.rowCount, 'updating recorder_user_id').toBe(0);
    else expect(changedRecorder, 'updating recorder_user_id').toMatchObject({ code: '42501' });

    // 5. Sealed context tamper probe
    const forged = await outcome(
      run(member('another member, forging the recorder', () => users.member), async (c) => {
        await c.query(`SELECT set_config('crove.ctx', (current_setting('crove.ctx')::jsonb || $1::jsonb)::text, true)`, [JSON.stringify({ user: users.recorder })]);
        return (await c.query('SELECT id FROM crove_meetings.meeting WHERE id = $1', [meetings.attendeesMeeting])).rowCount;
      }),
    );
    if (!forged.ok) {
      expect(forged, 'tampering with crove.ctx must fail with 42501').toMatchObject({ code: '42501' });
    } else {
      expect(forged.value, 'tampered context must return 0 rows').toBe(0);
    }
  });

  it('lets only the recorder read and write draft rows, while attendee, owner, and admin read and write none', async () => {
    if (!tables.meeting) {
      expect(tables.meeting).toBe(false);
      return;
    }
    if (!tables.transcript_segment && !tables.meeting_result && !tables.action_item) {
      expect(tables.transcript_segment).toBe(false);
      expect(tables.meeting_result).toBe(false);
      expect(tables.action_item).toBe(false);
      return;
    }

    // Recorder reads draft rows on attendeesMeeting and orgMeeting
    const recorderDrafts = await run(recorder, async (c) => ({
      transcripts: tables.transcript_segment ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
      results: tables.meeting_result ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
      items: tables.action_item ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
      orgTranscripts: tables.transcript_segment ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
      orgResults: tables.meeting_result ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
      orgItems: tables.action_item ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
    }));
    if (tables.transcript_segment) {
      expect(recorderDrafts.transcripts).toBe(1);
      expect(recorderDrafts.orgTranscripts).toBe(1);
    }
    if (tables.meeting_result) {
      expect(recorderDrafts.results).toBe(1);
      expect(recorderDrafts.orgResults).toBe(1);
    }
    if (tables.action_item) {
      expect(recorderDrafts.items).toBe(1);
      expect(recorderDrafts.orgItems).toBe(1);
    }

    // Non-recorders (attendee, owner, admin, and other members) read and write 0 draft rows
    for (const actor of nonRecorders) {
      const drafts = await run(actor, async (c) => ({
        transcripts: tables.transcript_segment ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
        results: tables.meeting_result ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
        items: tables.action_item ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'draft'", [meetings.attendeesMeeting])).rowCount : 0,
        orgTranscripts: tables.transcript_segment ? (await c.query("SELECT id FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
        orgResults: tables.meeting_result ? (await c.query("SELECT id FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
        orgItems: tables.action_item ? (await c.query("SELECT id FROM crove_meetings.action_item WHERE meeting_id = $1 AND stage = 'draft'", [meetings.orgMeeting])).rowCount : 0,
      }));
      if (tables.transcript_segment) {
        expect(drafts.transcripts, `${actor.name} reading draft transcript`).toBe(0);
        expect(drafts.orgTranscripts, `${actor.name} reading draft transcript on org meeting`).toBe(0);
      }
      if (tables.meeting_result) {
        expect(drafts.results, `${actor.name} reading draft result`).toBe(0);
        expect(drafts.orgResults, `${actor.name} reading draft result on org meeting`).toBe(0);
      }
      if (tables.action_item) {
        expect(drafts.items, `${actor.name} reading draft action item`).toBe(0);
        expect(drafts.orgItems, `${actor.name} reading draft action item on org meeting`).toBe(0);
      }

      // Write-denial sweeps on present draft tables using expectNoHiddenUpdate and expectNoHiddenDelete
      const presentDraftTables = [
        ...(tables.transcript_segment ? ['crove_meetings.transcript_segment'] : []),
        ...(tables.meeting_result ? ['crove_meetings.meeting_result'] : []),
        ...(tables.action_item ? ['crove_meetings.action_item'] : []),
      ];
      for (const table of presentDraftTables) {
        await expectNoHiddenUpdate(actor, table, 'stage', 'published');
        await expectNoHiddenDelete(actor, table);
      }

      // Draft insert denial on BOTH attendeesMeeting AND orgMeeting
      if (tables.transcript_segment) {
        const insAttendees = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 30, 40, 'x', 'y', 'draft')", [
              orgId,
              randomUUID(),
              meetings.attendeesMeeting,
            ]),
          ),
        );
        expect(insAttendees, `${actor.name} inserting draft transcript into attendees meeting`).toMatchObject({ ok: false, code: '42501' });

        const insOrg = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 30, 40, 'x', 'y', 'draft')", [
              orgId,
              randomUUID(),
              meetings.orgMeeting,
            ]),
          ),
        );
        expect(insOrg, `${actor.name} inserting draft transcript into org meeting`).toMatchObject({ ok: false, code: '42501' });
      }

      if (tables.meeting_result) {
        const insAttendees = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted) VALUES ($1, $2, $3, 's', '[]', 'meetings.summary', 'draft', true)", [
              orgId,
              randomUUID(),
              meetings.attendeesMeeting,
            ]),
          ),
        );
        expect(insAttendees, `${actor.name} inserting draft result into attendees meeting`).toMatchObject({ ok: false, code: '42501' });

        const insOrg = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted) VALUES ($1, $2, $3, 's', '[]', 'meetings.summary', 'draft', true)", [
              orgId,
              randomUUID(),
              meetings.orgMeeting,
            ]),
          ),
        );
        expect(insOrg, `${actor.name} inserting draft result into org meeting`).toMatchObject({ ok: false, code: '42501' });
      }

      if (tables.action_item) {
        const insAttendees = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, flags, tainted) VALUES ($1, $2, $3, 't', 'w', $4, 'now', '2026-11-04', 1, 'draft', 'suggested', '[]', true)", [
              orgId,
              randomUUID(),
              meetings.attendeesMeeting,
              users.recorder,
            ]),
          ),
        );
        expect(insAttendees, `${actor.name} inserting draft action item into attendees meeting`).toMatchObject({ ok: false, code: '42501' });

        const insOrg = await outcome(
          run(actor, (c) =>
            c.query("INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, flags, tainted) VALUES ($1, $2, $3, 't', 'w', $4, 'now', '2026-11-04', 1, 'draft', 'suggested', '[]', true)", [
              orgId,
              randomUUID(),
              meetings.orgMeeting,
              users.recorder,
            ]),
          ),
        );
        expect(insOrg, `${actor.name} inserting draft action item into org meeting`).toMatchObject({ ok: false, code: '42501' });
      }
    }
  });

  it('grants no table privilege on crove_meetings.media_key to any non-superuser non-owner role or PUBLIC', async () => {
    if (!tables.media_key) {
      expect(tables.media_key).toBe(false);
      return;
    }

    // 1. Runtime roles cannot own crove_meetings.media_key
    const RUNTIME_ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
    const { rows: owners } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM pg_catalog.unnest($1::text[]) r
         WHERE pg_catalog.pg_has_role(r, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'crove_meetings.media_key'::regclass), 'MEMBER')`,
        [RUNTIME_ROLES],
      ),
    );
    expect(owners.map((o) => o.role), 'runtime roles that own crove_meetings.media_key').toEqual([]);

    // 2. Table grants: no non-superuser non-owner role holds privileges
    const { rows: grants } = await admin((c) =>
      c.query<{ role: string; op: string }>(
        `SELECT r.rolname AS role, p AS op
         FROM pg_catalog.pg_roles r, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
           AND NOT pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'crove_meetings.media_key'::regclass), 'MEMBER')
           AND pg_catalog.has_table_privilege(r.oid, 'crove_meetings.media_key'::regclass, p)
         ORDER BY 1, 2`,
      ),
    );
    expect(grants, 'crove_meetings.media_key must have no table privileges granted to non-owner roles').toEqual([]);

    // 3. Column grants: no non-superuser non-owner role holds column privileges
    const { rows: columnGrants } = await admin((c) =>
      c.query<{ role: string; op: string }>(
        `SELECT r.rolname AS role, p AS op
         FROM pg_catalog.pg_roles r, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
         WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
           AND NOT pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'crove_meetings.media_key'::regclass), 'MEMBER')
           AND pg_catalog.has_any_column_privilege(r.oid, 'crove_meetings.media_key'::regclass, p)
         ORDER BY 1, 2`,
      ),
    );
    expect(columnGrants, 'crove_meetings.media_key must have no column privileges granted to non-owner roles').toEqual([]);

    // 4. Zero PUBLIC grants
    const { rows: publicGrants } = await admin((c) =>
      c.query<{ op: string }>(
        `SELECT p AS op
         FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         WHERE pg_catalog.has_table_privilege('public', 'crove_meetings.media_key'::regclass, p)
            OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND pg_catalog.has_any_column_privilege('public', 'crove_meetings.media_key'::regclass, p))`,
      ),
    );
    expect(publicGrants, 'crove_meetings.media_key must have no privileges granted to PUBLIC').toEqual([]);
  });

  it('ensures worker and admin SECURITY DEFINER functions in crove_meetings pin search_path, grant no EXECUTE to PUBLIC, and return no meeting text', async () => {
    const { rows } = await admin((c) =>
      c.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; rettype: string; hasPublicExec: boolean }>(
        `SELECT p.proname, p.prosecdef, p.proconfig,
                pg_get_function_result(p.oid) AS rettype,
                has_function_privilege('public', p.oid, 'EXECUTE') AS "hasPublicExec"
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_meetings' AND p.prosecdef = true`,
      ),
    );
    if (rows.length === 0) {
      expect(rows).toEqual([]);
      return;
    }
    for (const fn of rows) {
      expect(fn.proconfig, `${fn.proname} must pin search_path to pg_catalog, pg_temp`).toContain('search_path=pg_catalog, pg_temp');
      expect(fn.hasPublicExec, `${fn.proname} must not grant EXECUTE to PUBLIC`).toBe(false);
      // The door through which a member's own translation run reads the transcript lines that member reads (#3185, meetings E2, ADR-0049 stage B): the one definer of this schema that returns
      // meeting text, accepted by its name and by its exact result (the id and the text of each line, and the meeting's language flag; no speaker, no time), and held to the two checks
      // above like every other. It answers only inside a member's own run context (worker login, the run's own meeting, the member reading that stage); that is pinned by its own
      // database test. A second function, or this one with another result, still fails below.
      if (fn.proname === 'transcript_for_member_vy') {
        expect(fn.rettype, `${fn.proname}: the door's result is exactly the line's id and text and a language flag`).toBe('TABLE(segment_id uuid, line_text text, is_english boolean)');
        continue;
      }
      const val = validateDefinerReturnType(fn.rettype);
      expect(val.ok, `${fn.proname}: ${val.reason}`).toBe(true);
    }
  });
});
