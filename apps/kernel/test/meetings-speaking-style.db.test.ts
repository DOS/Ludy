// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke (#4919) on a real database: a reader of the meeting gets figures from the PUBLISHED lines and never from the recorder's draft, the recorder gets figures from their draft while one
// exists, a member who is no reader (an admin and an owner included) meets a 404 as on the transcript page, text past its retention date is gone, the answer is numbers and words of the fixed filler list
// and never a line, and the audit row names the meeting and holds none of its text.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { SpeakingStyle } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

suite('How each speaker spoke (#4919)', () => {
  const dbName = `ludy_test_speaking_style_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const style = (who: string, meetingId: string) => runtime.query<SpeakingStyle>('meetings.speaking_style.get', { meetingId }, { actor: asUser(who), orgId });
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
    for (const key of ['owner', 'adm', 'rec', 'lan', 'other']) users[key] = await upsertIdentity(db, { issuer: 'spk-style', subject: key, email: `${key}@spk-style.test`, name: key });
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

  it('gives a reader figures from the published lines only, never from the recorder\'s draft', async () => {
    const id = await meeting({ title: 'Họp giao ban', readers: ['lan'] });
    // Hà: 20 s, 39 words with one "ờ" and one "you know"; Minh: 4 s. A draft line of Hà that would change every figure.
    await line(id, 0, 10, 'Hà', `ờ ${'lời '.repeat(18)}`, 'published');
    await line(id, 10, 14, 'Minh', 'Đồng ý chị Hà', 'published');
    await line(id, 14, 24, 'Hà', `you know ${'lời '.repeat(18)}`, 'published');
    await line(id, 30, 40, 'Hà', 'um um um um um um um um um um', 'draft');
    const result = await style('lan', id);
    expect(result).toMatchObject({ meetingId: id, stage: 'published' });
    expect(result.speakers.map((s) => s.speaker)).toEqual(['Hà', 'Minh']);
    expect(result.speakers[0]).toMatchObject({ speaker: 'Hà', seconds: 20, words: 39, wordsPerMinute: 117, fillerWords: 3, longestStretchSeconds: 10 });
    expect(result.speakers[0]?.fillerTop).toEqual([
      { word: 'you know', count: 1 },
      { word: 'ờ', count: 1 },
    ]);
    // Minh talked 4 seconds: no pace.
    expect(result.speakers[1]).toMatchObject({ speaker: 'Minh', words: 4, wordsPerMinute: null, fillerWords: 0, fillerTop: [] });
    // The draft's "um" never reached the reader's figures.
    expect(JSON.stringify(result)).not.toContain('"um"');
  });

  it('gives the recorder figures from their draft while one exists, and from the published lines when there is none', async () => {
    const id = await meeting({ title: 'Họp nháp' });
    await line(id, 0, 12, 'Hà', 'một hai ba bốn năm sáu', 'published');
    await line(id, 0, 12, 'Hà', 'um um um um um um', 'draft');
    const draft = await style('rec', id);
    expect(draft.stage).toBe('draft');
    expect(draft.speakers[0]).toMatchObject({ speaker: 'Hà', words: 6, fillerWords: 6 });
    expect(draft.speakers[0]?.fillerTop).toEqual([{ word: 'um', count: 6 }]);
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, id]);
    const published = await style('rec', id);
    expect(published.stage).toBe('published');
    expect(published.speakers[0]).toMatchObject({ words: 6, fillerWords: 0, fillerTop: [] });
  });

  it('is a 404 for a member who is no reader, an admin and an owner included, as on the transcript page', async () => {
    const id = await meeting({ title: 'Họp riêng', readers: ['lan'] });
    await line(id, 1, 3, 'Hà', 'Chỉ người đọc thấy', 'published');
    for (const who of ['other', 'adm', 'owner']) expect(await refuses(style(who, id)), who).toBe('MEETING_NOT_FOUND');
    expect(await refuses(style('rec', randomUUID()))).toBe('MEETING_NOT_FOUND');
    // The reader and the recorder get an answer.
    expect((await style('lan', id)).speakers).toHaveLength(1);
    expect((await style('rec', id)).speakers).toHaveLength(1);
  });

  it('gives no speaker for a meeting with no line, for a draft nobody shared (to a reader) and for lines that count for nothing', async () => {
    const empty = await meeting({ title: 'Chưa có bản ghi', readers: ['lan'] });
    expect((await style('rec', empty)).speakers).toEqual([]);
    const draftOnly = await meeting({ title: 'Chỉ có bản nháp', readers: ['lan'] });
    await line(draftOnly, 1, 3, 'Hà', 'Chưa chia sẻ', 'draft');
    expect((await style('lan', draftOnly)).speakers).toEqual([]);
    expect((await style('rec', draftOnly)).speakers).toHaveLength(1);
    const nothing = await meeting({ title: 'Dòng không có độ dài', readers: ['lan'] });
    await line(nothing, 5, 5, 'Hà', 'ờ ừm', 'published');
    expect((await style('lan', nothing)).speakers).toEqual([]);
  });

  it('gives nothing once the text period has ended', async () => {
    const id = await meeting({ title: 'Họp cũ', readers: ['lan'], textDay: 'current_date - 1' });
    await line(id, 1, 3, 'Hà', 'Đã quá hạn lưu', 'published');
    expect(await refuses(style('lan', id))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(style('rec', id))).toBe('MEETING_NOT_FOUND');
  });

  it('answers with numbers and words of the fixed list only, never a line of the transcript', async () => {
    const id = await meeting({ title: 'Họp kín', readers: ['lan'] });
    await line(id, 0, 30, 'Hà', 'Zorbaxx khach.hang@example.com ờ ừm kiểu như là', 'published');
    const all = JSON.stringify(await style('lan', id));
    expect(all).not.toContain('Zorbaxx');
    expect(all).not.toContain('khach.hang');
    expect(all).toContain('kiểu như');
  });

  it('leaves an audit row that names the meeting and holds none of its text', async () => {
    const id = await meeting({ title: 'Họp kiểm toán', readers: ['lan'] });
    await line(id, 1, 30, 'Hà', 'Zorbaxx không được vào nhật ký ờ', 'published');
    await style('lan', id);
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.speaking_style.get%' AND audit_event::text LIKE $2`, [orgId, `%${id}%`]);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.map((r) => r.row).join('\n')).not.toContain('Zorbaxx');
  });
});
