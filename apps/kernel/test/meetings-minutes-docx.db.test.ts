// SPDX-License-Identifier: AGPL-3.0-only
// The published biên bản as a Word file (#4774) on a real database: the file holds the PUBLISHED rows only (never the recorder's draft summary or draft items), a reader of the meeting gets it and no one
// else does (a member who is no reader, an admin and an owner who are no readers all meet a 404, as on the minutes page), nothing published is refused, a text that is past its retention date is gone, the
// template's headings come from the built-in template or the meeting's own copy, names are display names (never an email address), and the audit row names the meeting and holds no text.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MINUTES_DOCX_MIME, sectionsToText, type MinutesDocx, type TranslationSource } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The parts of a .docx read back: the zip's central directory, each entry inflated.
function parts(file: MinutesDocx): Map<string, string> {
  const buf = Buffer.from(file.contentBase64, 'base64');
  expect(buf.length).toBe(file.bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const out = new Map<string, string>();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const packed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'), inflateRawSync(buf.subarray(start, start + packed)).toString('utf8'));
    at += 46 + nameLength;
  }
  return out;
}
// What a reader of the Word file sees: the text of every run, in order.
const wordText = (file: MinutesDocx): string[] => [...(parts(file).get('word/document.xml') ?? '').matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((m) => (m[1] as string).replace(/&apos;/gu, "'"));

suite('The published minutes as a Word file (#4774)', () => {
  const dbName = `ludy_test_minutes_docx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', adm: 'Quản Trị Viên', rec: 'Anh Người Ghi', lan: 'Chị Lan Đọc', other: 'Bạn Không Đọc' };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const download = (who: string, meetingId: string, place?: string, language?: 'vi' | 'en') =>
    runtime.query<MinutesDocx>(
      'meetings.minutes_docx.download',
      { meetingId, ...(place === undefined ? {} : { place }), ...(language === undefined ? {} : { language }) },
      { actor: asUser(who), orgId },
    );
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

  async function meeting(spec: { title: string; readers?: string[]; visibility?: 'attendees' | 'org'; textDay?: string; template?: string; language?: 'vi' | 'en' }): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, summary_template)
       VALUES ($1, $2, $4, $7, '2026-11-14T07:00:00Z', '2026-11-14T08:30:00Z', 5400, $3, $5, 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, ${spec.textDay ?? 'current_date + 365'}, $6)`,
      [orgId, id, users.rec, spec.title, spec.visibility ?? 'attendees', spec.template ?? 'general', spec.language ?? 'vi'],
    );
    for (const reader of spec.readers ?? []) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const result = (meetingId: string, stage: 'draft' | 'published', summary: string, decisions: string[]) =>
    sqlAdmin(`INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)`, [orgId, meetingId, summary, JSON.stringify(decisions), stage]);
  const item = (meetingId: string, title: string, stage: 'draft' | 'published', owner: string | null = null, due: string | null = null) =>
    sqlAdmin(
      `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', $6::date, $7, 'suggested', NULL, false, 10)`,
      [orgId, randomUUID(), meetingId, title, owner === null ? null : users[owner], due, stage],
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'docx', subject: key, email: `${key}@docx.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Biên Bản')).orgId;
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

  it('holds the published rows only, for the recorder as for a reader, and never the draft', async () => {
    const id = await meeting({ title: 'Họp giao ban tuần', readers: ['lan'] });
    await result(id, 'published', 'Đã chốt giá gói kế toán.\n\nHẹn khách ký thứ sáu.', ['Giữ giá cũ']);
    await result(id, 'draft', 'Bản nháp bí mật chưa chia sẻ', ['Quyết định nháp bí mật']);
    await item(id, 'Gửi báo giá bản cuối', 'published', 'lan', '2026-11-20');
    await item(id, 'Việc nháp bí mật', 'draft', 'rec', '2026-11-21');

    for (const who of ['rec', 'lan']) {
      const file = await download(who, id, 'Phòng họp tầng 3');
      expect(file.mimeType).toBe(MINUTES_DOCX_MIME);
      expect(file.filename).toBe('Biên bản họp - Họp giao ban tuần - 2026-11-14.docx');
      const text = wordText(file);
      expect(text).toEqual(
        expect.arrayContaining([
          'CÔNG TY BIÊN BẢN',
          'V/v: Họp giao ban tuần',
          'Từ 14:00 đến 15:30, ngày 14 tháng 11 năm 2026',
          'Phòng họp tầng 3',
          '• Anh Người Ghi (Người ghi biên bản)',
          '• Chị Lan Đọc',
          'Đã chốt giá gói kế toán.',
          'Hẹn khách ký thứ sáu.',
          '• Giữ giá cũ',
          'Gửi báo giá bản cuối',
          'Chị Lan Đọc',
          '20/11/2026',
        ]),
      );
      const all = text.join('\n') + '\n' + [...parts(file).values()].join('\n');
      for (const secret of ['bí mật', 'nháp', '@docx.test']) expect(all, `${who} ${secret}`).not.toContain(secret);
    }
  });

  it('is a 404 for everyone who does not read the meeting, an owner and an admin included, and for a meeting past its text date', async () => {
    const id = await meeting({ title: 'Họp kín', readers: ['lan'] });
    await result(id, 'published', 'Nội dung kín', ['Kết luận kín']);
    for (const who of ['other', 'adm', 'owner']) await expect(download(who, id), who).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    expect((await download('lan', id)).bytes).toBeGreaterThan(0);
    // The meeting is shared with the whole org: any member reads it, and so downloads it.
    const open = await meeting({ title: 'Họp cả công ty', visibility: 'org' });
    await result(open, 'published', 'Thông báo chung', []);
    for (const who of ['other', 'adm', 'owner']) expect(wordText(await download(who, open)), who).toContain('Thông báo chung');
    // A meeting whose text period ended is gone for every reader.
    const gone = await meeting({ title: 'Họp đã hết hạn', readers: ['lan'], textDay: 'current_date - 1' });
    await result(gone, 'published', 'Hết hạn', []);
    await expect(download('lan', gone)).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    await expect(download('rec', randomUUID())).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
  });

  it('refuses a meeting with nothing published, a draft alone included', async () => {
    const empty = await meeting({ title: 'Chưa chia sẻ', readers: ['lan'] });
    await expect(download('rec', empty)).rejects.toMatchObject({ code: 'MINUTES_NOT_PUBLISHED' });
    await result(empty, 'draft', 'Chỉ có bản nháp', ['Nháp']);
    await item(empty, 'Việc nháp', 'draft');
    await expect(download('rec', empty)).rejects.toMatchObject({ code: 'MINUTES_NOT_PUBLISHED' });
    // A reader of the meeting meets the same refusal.
    await expect(download('lan', empty)).rejects.toMatchObject({ code: 'MINUTES_NOT_PUBLISHED' });
    // Only published items are enough to download.
    await item(empty, 'Việc đã chia sẻ', 'published');
    expect(wordText(await download('rec', empty))).toContain('Việc đã chia sẻ');
  });

  it('lays out the content under the headings of the meeting\'s template, built in or its own copy, and a text outside the template whole', async () => {
    const briefing = await meeting({ title: 'Giao ban', template: 'briefing' });
    await result(briefing, 'published', sectionsToText('briefing', [{ key: 'progress', text: 'Xong 12 đơn.' }, { key: 'plan', text: 'Ra mắt gói mới.' }]), ['Chốt kế hoạch']);
    const text = wordText(await download('rec', briefing));
    expect(text).toEqual(expect.arrayContaining(['1. Kết quả công việc kỳ trước', 'Xong 12 đơn.', '2. Kế hoạch kỳ tới', 'Ra mắt gói mới.']));
    expect(text).not.toContain('Vướng mắc, tồn tại');

    const custom = await meeting({ title: 'Họp theo mẫu của công ty' });
    const sections = [{ key: 's1', title: 'Tiến độ dự án', hint: '' }, { key: 's2', title: 'Rủi ro', hint: '' }];
    await sqlAdmin(
      `UPDATE ludy_meetings.meeting SET summary_template = 'custom', minutes_template_name = 'Mẫu dự án', minutes_template_sections = $2::jsonb, minutes_template_hash = pg_catalog.md5(($2::jsonb)::text) WHERE org_id = $1 AND id = $3`,
      [orgId, JSON.stringify(sections), custom],
    );
    await result(custom, 'published', 'Tiến độ dự án\nĐúng hạn.\n\nRủi ro\nThiếu nhân sự.', []);
    expect(wordText(await download('rec', custom))).toEqual(expect.arrayContaining(['1. Tiến độ dự án', 'Đúng hạn.', '2. Rủi ro', 'Thiếu nhân sự.']));
    // The template changed since: the text is not in its form and is shown whole, as it was shared.
    const stale = await meeting({ title: 'Mẫu đã đổi', template: 'briefing' });
    await result(stale, 'published', 'Một đoạn văn không theo mẫu nào.', []);
    const staleText = wordText(await download('rec', stale));
    expect(staleText).toContain('Một đoạn văn không theo mẫu nào.');
    expect(staleText.some((t) => /^\d+\. /u.test(t))).toBe(false);
  });

  it('shows no content for the bare dash a decisions-only run stores, as the page does, and keeps a long display name whole', async () => {
    const id = await meeting({ title: 'Họp chỉ có kết luận', template: 'briefing', readers: ['lan'] });
    await result(id, 'published', '-', ['Kết luận duy nhất']);
    const long = `Nguyễn ${'Văn '.repeat(30)}Lan`;
    await sqlAdmin(`UPDATE ludy_kernel.user_account SET display_name = $2 WHERE id = $1`, [users.lan, long]);
    try {
      const text = wordText(await download('rec', id));
      expect(text).toContain('Chưa có nội dung được chia sẻ.');
      expect(text).toContain('• Kết luận duy nhất');
      expect(text).not.toContain('-');
      expect(text).toContain(`• ${long.replace(/\s+/gu, ' ').trim()}`);
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.user_account SET display_name = $2 WHERE id = $1`, [users.lan, NAMES.lan]);
    }
  });

  it('writes a dotted line for a place nobody typed, a member with no display name as "Thành viên", and an email address nowhere', async () => {
    const id = await meeting({ title: 'Họp không địa điểm', readers: ['lan'] });
    await result(id, 'published', 'Nội dung', []);
    await item(id, 'Việc của người không tên', 'published', 'lan');
    await sqlAdmin(`UPDATE ludy_kernel.user_account SET display_name = NULL WHERE id = $1`, [users.lan]);
    try {
      const file = await download('rec', id);
      const text = wordText(file);
      expect(text).toContain('………………………………');
      expect(text).toContain('• Thành viên');
      expect(JSON.stringify([...parts(file).values()])).not.toContain('@docx.test');
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.user_account SET display_name = $2 WHERE id = $1`, [users.lan, NAMES.lan]);
    }
  });

  it('leaves an audit row that names the meeting and holds none of its text', async () => {
    const id = await meeting({ title: 'Họp để kiểm toán', readers: ['lan'] });
    await result(id, 'published', 'Nội dung rất riêng của cuộc họp kiểm toán', ['Kết luận rất riêng']);
    await download('lan', id, 'Địa điểm rất riêng');
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.minutes_docx.download%' AND audit_event::text LIKE $2`, [orgId, `%${id}%`]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const text = audit.rows.map((r) => r.row).join('\n');
    for (const secret of ['rất riêng', 'Họp để kiểm toán']) expect(text, secret).not.toContain(secret);
  });

  it('downloads a published second-language version as .docx with localized chrome, fails closed when missing or unpublished, and isolates non-readers (#5225)', async () => {
    const id = await meeting({ title: 'Họp song ngữ', readers: ['lan'] });
    await result(id, 'published', 'Chốt báo giá 1.250.000 cho khách A.', ['Giữ giá cũ cho khách A']);
    await item(id, 'Gửi báo giá cho khách A', 'published', 'lan', '2026-11-20');
    await item(id, 'Việc nháp bí mật', 'draft', 'rec', '2026-11-21');

    // Missing version fails closed with 404 MINUTES_VERSION_NOT_FOUND, while non-readers get MEETING_NOT_FOUND.
    await expect(download('lan', id, undefined, 'en')).rejects.toMatchObject({ code: 'MINUTES_VERSION_NOT_FOUND' });
    for (const who of ['other', 'adm', 'owner']) {
      await expect(download(who, id, undefined, 'en'), who).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    }

    // Draft-only meeting returns MINUTES_NOT_PUBLISHED even when language is requested.
    const draftOnly = await meeting({ title: 'Nháp song ngữ', readers: ['lan'] });
    await result(draftOnly, 'draft', 'Chỉ có nháp', []);
    await expect(download('rec', draftOnly, undefined, 'en')).rejects.toMatchObject({ code: 'MINUTES_NOT_PUBLISHED' });

    // Publish English version under recorder and download as reader.
    const src = await query<TranslationSource>('rec', 'meetings.translation.source', { meetingId: id, stage: 'published', to: 'en' });
    const itemSeg = src.segments.find((s) => s.key.startsWith('item:'));
    expect(itemSeg).toBeDefined();
    await exec('rec', 'meetings.minutes_version.publish', {
      meetingId: id,
      language: 'en',
      hash: src.hash,
      segments: [
        { key: 'summary', text: 'Quote of 1,250,000 agreed for customer A.' },
        { key: 'decision:0', text: 'Keep the old price for customer A' },
        { key: itemSeg!.key, text: 'Send the quote to customer A' },
      ],
    });

    const enFile = await download('lan', id, 'Room 301', 'en');
    expect(enFile.filename).toBe('Meeting minutes - Họp song ngữ - 2026-11-14.docx');
    const enParts = parts(enFile);
    expect(enParts.get('word/styles.xml')).toContain('w:val="en-US"');
    const enText = wordText(enFile);
    expect(enText).toEqual(
      expect.arrayContaining([
        'MEETING MINUTES',
        'Re: Họp song ngữ',
        'From 14:00 to 15:30, 14/11/2026',
        'Room 301',
        '• Anh Người Ghi (Minute taker)',
        'I. MEETING SUMMARY',
        'Quote of 1,250,000 agreed for customer A.',
        'II. DECISIONS',
        '• Keep the old price for customer A',
        'III. ACTION ITEMS',
        'Task',
        'Assignee',
        'Due date',
        'Send the quote to customer A',
        'Chị Lan Đọc',
        '20/11/2026',
        'MINUTE TAKER',
      ]),
    );
    const enJoined = enText.join('\n');
    for (const leaked of ['Chốt báo giá', 'Giữ giá cũ', 'Gửi báo giá', 'Việc nháp', '@docx.test']) {
      expect(enJoined).not.toContain(leaked);
    }

    // Default download still returns the original Vietnamese document.
    expect(wordText(await download('lan', id))).toEqual(expect.arrayContaining(['BIÊN BẢN CUỘC HỌP', 'Chốt báo giá 1.250.000 cho khách A.']));

    // Republishing original drops stale minutes_version, so EN .docx fails closed again.
    await exec('rec', 'meetings.summary.save', { meetingId: id, summary: 'Bản gốc mới.', decisions: [] });
    await exec('rec', 'meetings.result.publish', { meetingId: id, confirmed: true });
    await expect(download('lan', id, undefined, 'en')).rejects.toMatchObject({ code: 'MINUTES_VERSION_NOT_FOUND' });

    // An English original meeting renders English chrome by default and supports a published Vietnamese version.
    const enMeeting = await meeting({ title: 'English Board Sync', readers: ['lan'], language: 'en' });
    await result(enMeeting, 'published', 'Agreed on Q2 hiring plan.', ['Approve 2 roles']);
    expect(wordText(await download('lan', enMeeting))).toEqual(expect.arrayContaining(['MEETING MINUTES', 'Agreed on Q2 hiring plan.']));
    const viSrc = await query<TranslationSource>('rec', 'meetings.translation.source', { meetingId: enMeeting, stage: 'published', to: 'vi' });
    await exec('rec', 'meetings.minutes_version.publish', {
      meetingId: enMeeting,
      language: 'vi',
      hash: viSrc.hash,
      segments: [
        { key: 'summary', text: 'Thống nhất kế hoạch tuyển dụng quý 2.' },
        { key: 'decision:0', text: 'Duyệt tuyển 2 vị trí' },
      ],
    });
    const viFile = await download('lan', enMeeting, undefined, 'vi');
    expect(parts(viFile).get('word/styles.xml')).toContain('w:val="vi-VN"');
    expect(wordText(viFile)).toEqual(expect.arrayContaining(['BIÊN BẢN CUỘC HỌP', 'Thống nhất kế hoạch tuyển dụng quý 2.', '• Duyệt tuyển 2 vị trí']));
  });
});
