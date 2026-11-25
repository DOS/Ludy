// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting as a text or SRT file (#4817) on a real database: a reader of the meeting gets the PUBLISHED lines and never the recorder's draft, the recorder gets their draft while one
// exists, a member who is no reader (an admin and an owner included) meets a 404 as on the transcript page, a transcript with no line is refused, text past its retention date is gone, hostile text is
// made harmless in both formats, and the audit row names the meeting and holds none of its text.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { TranscriptExport, TranscriptExportFormat } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const decode = (file: TranscriptExport): string => {
  const buf = Buffer.from(file.contentBase64, 'base64');
  expect(buf.length).toBe(file.bytes);
  return buf.toString('utf8');
};
// The text of every run of the Word file's document part, in order (the zip's central directory read back, each entry inflated).
function wordRuns(file: TranscriptExport): string[] {
  const buf = Buffer.from(file.contentBase64, 'base64');
  expect(buf.length).toBe(file.bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const packed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (buf.subarray(at + 46, at + 46 + nameLength).toString('utf8') === 'word/document.xml') {
      return [...inflateRawSync(buf.subarray(start, start + packed)).toString('utf8').matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((m) => m[1] as string);
    }
    at += 46 + nameLength;
  }
  return [];
}
const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

suite('The transcript as a file (#4817)', () => {
  const dbName = `ludy_test_transcript_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const download = (who: string, meetingId: string, format: TranscriptExportFormat) =>
    runtime.query<TranscriptExport>('meetings.transcript.download', { meetingId, format }, { actor: asUser(who), orgId });
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
    for (const key of ['owner', 'adm', 'rec', 'lan', 'other']) users[key] = await upsertIdentity(db, { issuer: 'tx-export', subject: key, email: `${key}@tx-export.test`, name: key });
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

  it('gives a reader the published lines as text and as SRT, in time order, and never the recorder\'s draft', async () => {
    const id = await meeting({ title: 'Họp giao ban', readers: ['lan'] });
    await line(id, 754, 760.5, 'Hà', 'Khách A đồng ý chiết khấu 8%', 'published');
    await line(id, 5, 9, 'Minh', 'Chào mọi người', 'published');
    await line(id, 20, 22, 'Hà', 'Dòng nháp bí mật', 'draft');
    const txt = await download('lan', id, 'txt');
    expect(txt.format).toBe('txt');
    expect(txt.mimeType).toBe('text/plain; charset=utf-8');
    expect(txt.filename).toBe('Bản ghi - Họp giao ban - 2026-11-15.txt');
    expect(txt.lines).toBe(2);
    expect(decode(txt)).toBe('[00:00:05] Minh: Chào mọi người\n[00:12:34] Hà: Khách A đồng ý chiết khấu 8%\n');
    const srt = await download('lan', id, 'srt');
    expect(srt.filename).toBe('Bản ghi - Họp giao ban - 2026-11-15.srt');
    expect(decode(srt)).toBe('1\n00:00:05,000 --> 00:00:09,000\nMinh: Chào mọi người\n\n2\n00:12:34,000 --> 00:12:40,500\nHà: Khách A đồng ý chiết khấu 8%\n\n');
    expect(decode(txt)).not.toContain('nháp bí mật');
  });

  it('gives a reader the published lines as a Word file with the .docx name and type, and never the recorder\'s draft', async () => {
    const id = await meeting({ title: 'Họp giao ban', readers: ['lan'] });
    await line(id, 754, 760.5, 'Hà', 'Khách A đồng ý chiết khấu 8%', 'published');
    await line(id, 5, 9, 'Minh', 'Chào mọi người', 'published');
    await line(id, 20, 22, 'Hà', 'Dòng nháp bí mật', 'draft');
    const docx = await download('lan', id, 'docx');
    expect(docx.format).toBe('docx');
    expect(docx.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(docx.filename).toBe('Bản ghi - Họp giao ban - 2026-11-15.docx');
    expect(docx.lines).toBe(2);
    expect(wordRuns(docx)).toEqual(['BẢN GHI LỜI CUỘC HỌP', 'Họp giao ban', 'Ngày 15/11/2026', '[00:00:05] Minh: ', 'Chào mọi người', '[00:12:34] Hà: ', 'Khách A đồng ý chiết khấu 8%']);
    expect(await refuses(download('other', id, 'docx'))).toBe('MEETING_NOT_FOUND');
  });

  it('gives the recorder their draft while one exists, and the published lines when there is none', async () => {
    const id = await meeting({ title: 'Họp nháp' });
    await line(id, 1, 3, 'Hà', 'Đã chia sẻ', 'published');
    await line(id, 2, 4, 'Hà', 'Bản nháp của tôi', 'draft');
    expect(decode(await download('rec', id, 'txt'))).toBe('[00:00:02] Hà: Bản nháp của tôi\n');
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, id]);
    expect(decode(await download('rec', id, 'txt'))).toBe('[00:00:01] Hà: Đã chia sẻ\n');
  });

  it('is a 404 for a member who is no reader, an admin and an owner included, as on the transcript page', async () => {
    const id = await meeting({ title: 'Họp riêng', readers: ['lan'] });
    await line(id, 1, 3, 'Hà', 'Chỉ người đọc thấy', 'published');
    for (const who of ['other', 'adm', 'owner']) expect(await refuses(download(who, id, 'txt'))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(download('rec', randomUUID(), 'txt'))).toBe('MEETING_NOT_FOUND');
  });

  it('refuses a transcript with no line, and a reader sees none of a draft that was never shared', async () => {
    const empty = await meeting({ title: 'Chưa có bản ghi', readers: ['lan'] });
    expect(await refuses(download('rec', empty, 'srt'))).toBe('TRANSCRIPT_EXPORT_EMPTY');
    const draftOnly = await meeting({ title: 'Chỉ có bản nháp', readers: ['lan'] });
    await line(draftOnly, 1, 3, 'Hà', 'Chưa chia sẻ', 'draft');
    expect(await refuses(download('lan', draftOnly, 'txt'))).toBe('TRANSCRIPT_EXPORT_EMPTY');
    expect(decode(await download('rec', draftOnly, 'txt'))).toContain('Chưa chia sẻ');
  });

  it('gives nothing once the text period has ended', async () => {
    const id = await meeting({ title: 'Họp cũ', readers: ['lan'], textDay: 'current_date - 1' });
    await line(id, 1, 3, 'Hà', 'Đã quá hạn lưu', 'published');
    expect(await refuses(download('lan', id, 'txt'))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(download('rec', id, 'srt'))).toBe('MEETING_NOT_FOUND');
  });

  it('makes hostile text harmless: no break inside a cue, no hidden or bidirectional character, no empty cue', async () => {
    const id = await meeting({ title: 'Họp \u202ex/y:z?', readers: ['lan'] });
    await line(id, 1, 3, 'Hà\n\n9', 'Một\n\n2\n00:00:00,000 --> 00:00:01,000\u202e giả', 'published');
    await line(id, 4, 6, 'Minh', '\u200b\u2060', 'published');
    await line(id, 7, 7, 'Minh', 'Không có đoạn cuối', 'published');
    const srt = decode(await download('lan', id, 'srt'));
    expect(srt).not.toMatch(/[\u202e\u200b\u2060]/u);
    // Two cues, numbered 1 and 2, each with one text line: the injected "cue" stays inside the first text.
    expect(srt.split('\n\n').filter((c) => c !== '')).toHaveLength(2);
    expect(srt).toContain('Hà 9: Một 2 00:00:00,000 --> 00:00:01,000 giả');
    // A line that ends where it starts is shown for two seconds.
    expect(srt).toContain('00:00:07,000 --> 00:00:09,000');
    expect((await download('lan', id, 'txt')).filename).toBe('Bản ghi - Họp x y z - 2026-11-15.txt');
  });

  it('leaves an audit row that names the meeting and holds none of its text', async () => {
    const id = await meeting({ title: 'Họp kiểm toán', readers: ['lan'] });
    await line(id, 1, 3, 'Hà', 'Zorbaxx không được vào nhật ký', 'published');
    const file = await download('lan', id, 'txt');
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.transcript.download%' AND audit_event::text LIKE $2`, [orgId, `%${id}%`]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const logged = audit.rows.map((r) => r.row).join('\n');
    expect(logged).not.toContain('Zorbaxx');
    // Nor the file's own base64 (the answer is never audited).
    expect(logged).not.toContain(file.contentBase64.slice(0, 24));
  });
});
