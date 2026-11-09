// SPDX-License-Identifier: AGPL-3.0-only
// What a person's erasure request may and may not do to meeting text (issue #2594, meetings plan L5, ADR-0047 points 7 and 11, ADR-0037 section 5), on PostgreSQL 17.
// Step 1 of the two-step rule: these checks hold on main today and must keep holding when the finder reaches transcripts, so the code that does it meets them
// before it is written. The base branch's copy runs against that code.
// - The finder and the erasure never show or change the text of a meeting the owner cannot read (an attendees-only meeting, a draft): no row, no title, no text
//   in the answer or in the audit row, and an erasure with no notice leaves it byte for byte as it was.
// - The one matcher of every finder (crove_kernel.text_redact) replaces a value only as a whole number or address: digits inside a longer number, an amount, a date
//   and a phone number that only contains the value are left alone; a value that equals the probe exactly goes, with its usual separators.
// - The meeting text columns stay in the registry with handling erase (as a kind other today, free text once the finder searches them).
// - A personal-data definer of crove_meetings, once it exists, pins search_path, is granted to no PUBLIC, refuses every caller but an owner's user context (or, for the row ids the
//   finder reads, an owner's or an admin's: member, viewer, agent, system refused), and answers numbers and ids, never text; the row ids are of rows the caller can read anyway.
// While a definer does not exist yet, the walk over the functions that exist passes with nothing to check. Part of the invariant suite; imports package code under test only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, PERSONAL_DATA_COLUMNS, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'khach.hang@congty.example';
const TITLE = 'Họp báo giá cho anh Tuấn';
const LINE = `Anh Tuấn nói gửi hợp đồng về ${EMAIL} nhé`;
const SUMMARY = `Chốt giá, gửi báo giá tới ${EMAIL}`;
// The definers the personal-data step adds (plan L5), by exact signature, with who may call each: the owner's counts, notice and erase are an owner's alone (the counts are an
// oracle for a guessed value, #1972); the row ids the finder reads only an owner or an admin may ask for, and they are ids of rows the caller can read anyway.
const PERSONAL_DEFINERS: Record<string, 'owner' | 'admin'> = {
  'crove_meetings.personal_matches(text, text)': 'owner',
  'crove_meetings.personal_notice_items(text, text)': 'owner',
  'crove_meetings.personal_erase(text, text)': 'owner',
  'crove_meetings.personal_row_ids(text, text)': 'admin',
};
// What the kind code of a personal_row_ids answer stands for.
const ROW_KIND_TABLE: Record<number, string> = { 1: 'transcript_segment', 2: 'meeting_result', 3: 'action_item', 4: 'meeting' };

suite('personal data in meeting text on PostgreSQL (#2594, ADR-0047)', () => {
  const dbName = `crove_test_meetings_personal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let meetingId = '';
  let segmentId = '';
  let resultId = '';
  let itemId = '';
  let sharedMeetingId = '';
  let sharedSegmentId = '';
  const users = { owner: '', admin: '', recorder: '', member: '', viewer: '' };
  let agent = { agentId: '', runId: '' };
  let api: Runtime;
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
  const owner = member('an owner', () => users.owner);
  // Runs fn as a login role in a context, always rolled back.
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
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  const textOf = async (): Promise<string> =>
    JSON.stringify(
      await admin(async (c) => [
        (await c.query('SELECT title FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows,
        (await c.query('SELECT text, speaker_label, stage FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY id', [meetingId])).rows,
        (await c.query('SELECT summary, decisions, stage FROM crove_meetings.meeting_result WHERE meeting_id = $1 ORDER BY id', [meetingId])).rows,
        (await c.query('SELECT title, who_drafted, when_drafted, stage FROM crove_meetings.action_item WHERE meeting_id = $1 ORDER BY id', [meetingId])).rows,
      ]),
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
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const apiRuntime = runtimeFor(appUrl);
    api = apiRuntime.runtime;
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(apiRuntime.db, { issuer: 'meetings-personal', subject: key, email: `${key}@meetings-personal.test`, name: null });
    }
    orgId = (await createOrg(api, asUser(users.owner), 'Họp có dữ liệu cá nhân')).orgId;
    meetingId = randomUUID();
    segmentId = randomUUID();
    resultId = randomUUID();
    itemId = randomUUID();
    sharedMeetingId = randomUUID();
    sharedSegmentId = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [
        orgId,
        users.admin,
        users.recorder,
        users.member,
        users.viewer,
      ]);
      // An attendees-only meeting of the recorder: the owner is no reader. Its title, a transcript line and a draft summary and item all hold the value.
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, $3, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, 'attendees', 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, `${TITLE} ${EMAIL}`, users.recorder],
      );
      await c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 10, 'Tuấn', $4, 'published')`, [orgId, segmentId, meetingId, LINE]);
      await c.query(`INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, $3, $4, $5::jsonb, 'manual', 'draft')`, [orgId, resultId, meetingId, SUMMARY, JSON.stringify([`Gửi ${EMAIL}`])]);
      await c.query(`INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, when_drafted, stage) VALUES ($1, $2, $3, $4, 'Tuấn', 'thứ sáu', 'draft')`, [orgId, itemId, meetingId, `Gửi báo giá tới ${EMAIL}`]);
    });
    // The admin is no reader of the hidden meeting, and not its recorder: row security gives them none of it.
    await admin(async (c) => {
      expect((await c.query('SELECT 1 FROM crove_meetings.meeting_reader WHERE org_id = $1 AND meeting_id = $2 AND user_id = $3', [orgId, meetingId, users.admin])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2 AND recorder_user_id = $3', [orgId, meetingId, users.admin])).rowCount).toBe(0);
    });
    // A meeting shared with the whole org, which an owner and an admin read: its line is what the row ids may name.
    await admin(async (c) => {
      const shared = sharedMeetingId;
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp chung', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'org', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, shared, users.recorder],
      );
      await c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 10, 'Hà', $4, 'published')`, [orgId, sharedSegmentId, shared, `Gửi về ${EMAIL}`]);
    });
    const installed = await api.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'finance.chief_accountant', reportsTo: null }, { actor: asMfa(users.owner), orgId });
    await api.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
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

  it('shows the owner no title, line, summary or item of a meeting they cannot read, in the finder\'s answer or its audit row', async () => {
    const found = await api.execute<{ matches: Array<{ column: string; row: Record<string, unknown> }> }>('kernel.personal_data.find', { value: EMAIL }, { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() });
    // Rows of meetings the owner reads (the org-shared one) may be listed; no row of the hidden meeting is, whatever its table.
    expect(found.matches.filter((m) => m.column.startsWith('crove_meetings.') && (m.row.meeting_id === meetingId || m.row.id === meetingId))).toEqual([]);
    const answer = JSON.stringify(found);
    for (const secret of [TITLE, LINE, SUMMARY, 'Tuấn']) expect(answer, secret).not.toContain(secret);
    const audit = JSON.stringify(
      await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.find'`, [orgId])).rows),
    );
    for (const secret of [EMAIL, TITLE, LINE, SUMMARY]) expect(audit, secret).not.toContain(secret);
  });

  it('leaves the text of a meeting the owner cannot read as it was after an erasure with no notice, and puts none of it in the answer or the audit row', async () => {
    const before = await textOf();
    expect(before).toContain(EMAIL);
    const erased = await api.execute('kernel.personal_data.erase', { value: EMAIL }, { actor: asMfa(users.owner), orgId, idempotencyKey: randomUUID() });
    expect(await textOf()).toBe(before);
    const answer = JSON.stringify(erased);
    for (const secret of [TITLE, LINE, SUMMARY]) expect(answer, secret).not.toContain(secret);
    const audit = JSON.stringify(
      await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase'`, [orgId])).rows),
    );
    for (const secret of [EMAIL, TITLE, LINE, SUMMARY]) expect(audit, secret).not.toContain(secret);
  });

  it('replaces a value only as a whole number or address: amounts, dates and longer numbers are left alone', async () => {
    const redact = (text: string, kind: 'digits' | 'email', value: string) =>
      admin(async (c) => (await c.query<{ out: string }>(`SELECT crove_kernel.text_redact($1, $2, $3, '[đã xóa]') AS out`, [text, kind, value])).rows[0]?.out);
    // Numbers that merely contain, or sit next to, the value's digits.
    const untouched = [
      'Tổng 1.250.000 đồng, hạn 12/03/2026, mã đơn 000123',
      'Số lớn 10901234567 và 09012345678 và 90123456789',
      'Hóa đơn 0901234567890 đã thanh toán',
      'Chuyển 2026-11-10 lúc 09:01:23, mã 0901 2345 6789',
      'Ngày 09/01/2345 và số 0901.234.5678',
    ];
    for (const text of untouched) expect(await redact(text, 'digits', '0901234567'), text).toBe(text);
    // The value itself goes, as written with the usual separators and with +84; the numbers around it stay.
    expect(await redact('Gọi 0901 234 567 hoặc 0901.234.567, tổng 1.250.000 đồng', 'digits', '0901234567')).toBe('Gọi [đã xóa] hoặc [đã xóa], tổng 1.250.000 đồng');
    expect(await redact('Số +84 901 234 567 nhé', 'digits', '0901234567')).toBe('Số [đã xóa] nhé');
    // A 10-digit amount that is exactly the probe's digits is the value, by the rule of the matcher: it is the one case a number goes.
    expect(await redact('Trả 1250000000 đồng', 'digits', '1250000000')).toBe('Trả [đã xóa] đồng');
    // An address only as a whole address.
    expect(await redact(`cab.${EMAIL} và ${EMAIL}.`, 'email', EMAIL)).toBe(`cab.${EMAIL} và [đã xóa].`);
    expect(await redact(`x${EMAIL} ${EMAIL}.test`, 'email', EMAIL)).toBe(`x${EMAIL} ${EMAIL}.test`);
  });

  it('keeps every meeting text column in the registry with handling erase', () => {
    const columns = [
      'crove_meetings.meeting.title',
      'crove_meetings.transcript_segment.text',
      'crove_meetings.transcript_segment.speaker_label',
      'crove_meetings.meeting_result.summary',
      'crove_meetings.meeting_result.decisions',
      'crove_meetings.action_item.title',
      'crove_meetings.action_item.who_drafted',
      'crove_meetings.action_item.when_drafted',
    ];
    for (const key of columns) {
      const entry = (PERSONAL_DATA_COLUMNS as Record<string, { handling: string; kind: string }>)[key];
      expect(entry, key).toBeDefined();
      expect(entry?.handling, key).toBe('erase');
      expect(['other', 'free_text'], key).toContain(entry?.kind);
    }
  });

  it('pins every personal-data definer of crove_meetings that exists: search_path, no PUBLIC or worker grant, an owner\'s user context only, no text', async () => {
    const present = await admin(async (c) =>
      (
        await c.query<{ sig: string; secdef: boolean; config: string[] | null; public_exec: boolean }>(
          `SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS sig, p.prosecdef AS secdef, p.proconfig AS config,
                  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'crove_meetings' AND p.proname LIKE 'personal\\_%'`,
        )
      ).rows,
    );
    // The names are part of the contract: a personal-data definer under another name than the listed ones is a new surface to review.
    for (const row of present) {
      expect(Object.keys(PERSONAL_DEFINERS), `an unlisted personal-data definer ${row.sig}`).toContain(row.sig);
      expect(row.secdef, `${row.sig} is SECURITY DEFINER`).toBe(true);
      expect(row.config?.some((s) => s === 'search_path=pg_catalog, pg_temp'), `${row.sig} pins search_path`).toBe(true);
      expect(row.public_exec, `${row.sig} granted to PUBLIC`).toBe(false);
      const who = PERSONAL_DEFINERS[row.sig] as 'owner' | 'admin';
      const call = `SELECT * FROM ${row.sig.replace(/\(.*/, '')}('email', '${EMAIL}')`;
      const refused = [member('the recorder', () => users.recorder), member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor, system];
      if (who === 'owner') refused.push(member('an admin', () => users.admin));
      for (const actor of refused) expect(await outcome(run(actor, (c) => c.query(call))), `${row.sig} for ${actor.name}`).toMatchObject({ ok: false, code: '42501' });
      const allowed = who === 'owner' ? [owner] : [owner, member('an admin', () => users.admin)];
      for (const actor of allowed) {
        const answered = await outcome(run(actor, (c) => c.query(call)));
        expect(answered, `${row.sig} for ${actor.name}`).toMatchObject({ ok: true });
        if (!answered.ok) continue;
        // Numbers, ids and flags: no column that could hold text. text (25), varchar (1043) and jsonb (3802) are the types a line of meeting text would travel in.
        for (const field of answered.value.fields) expect([25, 1043, 3802], `${row.sig} column ${field.name}`).not.toContain(field.dataTypeID);
        expect(JSON.stringify(answered.value.rows), row.sig).not.toContain(TITLE);
      }
      if (row.sig.startsWith('crove_meetings.personal_row_ids')) {
        // Ids of rows the caller can read anyway, and never one of a meeting they cannot: asked for again under row security, every id is there, and none is the hidden meeting's.
        for (const actor of allowed) {
          const checked = await outcome(
            run(actor, async (c) => {
              const ids = (await c.query<{ kind: number; id: string }>(call)).rows;
              const visible = await Promise.all(ids.map(async (r) => (await c.query(`SELECT 1 FROM crove_meetings.${ROW_KIND_TABLE[r.kind] ?? 'unknown'} WHERE id = $1`, [r.id])).rowCount === 1));
              return { ids, visible };
            }),
          );
          expect(checked, `${row.sig} for ${actor.name}`).toMatchObject({ ok: true });
          if (!checked.ok) continue;
          expect(checked.value.visible.every(Boolean), `${row.sig} names a row ${actor.name} cannot read`).toBe(true);
          const named = checked.value.ids.map((r) => r.id);
          // It finds what it should: the shared meeting's line, for the owner and for the admin alike (not a pass because it names nothing).
          expect(named, `${row.sig} finds the shared meeting's line for ${actor.name}`).toContain(sharedSegmentId);
          // And nothing of the hidden meeting: not its meeting row (title), its line, its draft result or its draft item.
          for (const hidden of [meetingId, segmentId, resultId, itemId]) expect(named, `${row.sig} names a row of the hidden meeting for ${actor.name}`).not.toContain(hidden);
        }
      }
    }
  });
});
