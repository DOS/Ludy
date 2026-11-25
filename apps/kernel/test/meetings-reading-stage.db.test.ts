// SPDX-License-Identifier: AGPL-3.0-only
// Which lines Ask Vy about a meeting and the link suggestion read (#4910, points 2 and 3), on a real database: the recorder's working draft while one exists, else the published lines (the rule
// of the transcript page, the file and the search), so a recorder who re-transcribed is not answered from the text shared before, nor given a suggestion from the shared text and the newer draft
// read together; any other reader is given the published lines; and a member who is no reader gets nothing.
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

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

suite('The stage of the lines Ask Vy and the link suggestion read (#4910)', () => {
  const dbName = `ludy_test_reading_stage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const askLines = (who: string, meetingId: string) => runtime.query<{ lines: Array<{ text: string; stage: string }> }>('meetings.ask.lines', { question: 'Gamma Alpha khách', meetingId }, { actor: asUser(who), orgId });
  const suggest = (who: string, meetingId: string) => runtime.query<{ parties: Array<{ name: string }> }>('meetings.link.suggest', { meetingId }, { actor: asUser(who), orgId });
  const party = (name: string) => sqlAdmin("INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization')", [orgId, name]);
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

  async function meeting(spec: { title: string; readers?: string[]; textDay?: string }): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, summary_template)
       VALUES ($1, $2, $4, 'vi', '2026-11-14T17:30:00Z', '2026-11-14T18:30:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, ${spec.textDay ?? 'current_date + 365'}, 'general')`,
      [orgId, id, users.rec, spec.title],
    );
    for (const reader of spec.readers ?? []) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const line = (meetingId: string, start: number, end: number, who: string, text: string, stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7)`, [orgId, meetingId, start, end, who, text, stage]);

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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'adm', 'rec', 'lan', 'other']) users[key] = await upsertIdentity(db, { issuer: 'rd-stage', subject: key, email: `${key}@rd-stage.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Bản Ghi')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.adm, users.rec, users.lan, users.other]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('Ask Vy about one meeting: the recorder with a newer draft is given the draft, a reader the published lines, and the recorder with no draft the published lines', async () => {
    const id = await meeting({ title: 'Họp bán hàng', readers: ['lan'] });
    await line(id, 0, 5, 'Hà', 'Alpha khách cũ đã chia sẻ', 'published');
    await line(id, 0, 5, 'Hà', 'Gamma khách mới bản nháp', 'draft');
    expect((await askLines('rec', id)).lines.map((l) => l.text)).toEqual(['Gamma khách mới bản nháp']);
    expect((await askLines('lan', id)).lines.map((l) => l.text)).toEqual(['Alpha khách cũ đã chia sẻ']);
    // A member who is no reader is given no line (row security shows them none), whatever stage exists.
    expect((await askLines('other', id)).lines).toEqual([]);
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, id]);
    expect((await askLines('rec', id)).lines.map((l) => l.text)).toEqual(['Alpha khách cũ đã chia sẻ']);
  });

  it('the link suggestion reads one stage: the draft while one exists (never the shared text beside it), else the published lines, and only the recorder gets it', async () => {
    await party('Công ty Alpha Beta');
    await party('Công ty Gamma Delta');
    const id = await meeting({ title: 'Họp với khách', readers: ['lan'] });
    await line(id, 0, 5, 'Hà', 'Chúng ta nói về Công ty Alpha Beta', 'published');
    await line(id, 0, 5, 'Hà', 'Chúng ta nói về Công ty Gamma Delta', 'draft');
    // The recorder's newer draft names Gamma Delta only: the shared text that names Alpha Beta is not read with it.
    expect((await suggest('rec', id)).parties.map((p) => p.name)).toEqual(['Công ty Gamma Delta']);
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, id]);
    expect((await suggest('rec', id)).parties.map((p) => p.name)).toEqual(['Công ty Alpha Beta']);
    // A reader, an admin and an owner are not the recorder.
    for (const who of ['lan', 'adm', 'owner']) expect(await refuses(suggest(who, id)), who).not.toBeNull();
  });
});
