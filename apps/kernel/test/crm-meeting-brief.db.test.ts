// SPDX-License-Identifier: AGPL-3.0-only
// Dy's brief before a booking linked to a deal on PostgreSQL 17 (#3115, docs/plan/calendar.md "Deal links as built"): crm.booking.meeting_brief_source gives the facts of a confirmed, upcoming
// booking that has a deal (the deal, its open next step, its latest sent quote with the exact total, the customer's latest words) under the booking's own reader rule and the member's own row-level
// security: a member who may not read the conversation (a private email) gets the brief without its messages, a booking the member does not host is not found, a viewer is refused; it writes and audits
// nothing. The API side then asks the model outside any transaction: with AI off no call is made and the facts stand alone; while the org keeps customers' words from the model it is given none;
// words with a figure the facts do not hold are refused. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxReader, type MeetingBriefGenerator } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type EventType, type PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, type MeetingBriefSource } from '@crove/mod-crm';
import { bookingRequest } from '../src/booking-page.ts';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { meetingBriefAi, prepareMeetingBrief } from '../src/crm-meeting-brief-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };

// A day a few days ahead that is not a Vietnamese public holiday, in Vietnam time.
function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('the meeting brief of a booking linked to a deal on PostgreSQL (#3115)', () => {
  const dbName = `crove_test_crm_meeting_brief_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
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
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const register = (db: Db) =>
    new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  const person = (name: string) => upsertIdentity(createDb(appPool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@brief.test`, name: null });

  // An org with an owner, a host (who leads the type and holds no direct-message permission), another member who hosts nothing and a viewer; a pipeline; one 30-minute type bookable all day.
  async function org() {
    const owner = await person('owner');
    const host = await person('host');
    const other = await person('other');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, host, other, viewer]),
    );
    const slug = (await rows<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))[0]?.slug as string;
    await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(host), orgId });
    await app.execute<EventType>(
      'crm.event_type.create',
      { slug: 'tu-van', title: 'Tư vấn thuế', description: null, durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 60, dailyLimit: null, locationKind: 'video', locationValue: 'https://meet.example.test/x', hostUserId: host },
      { actor: asUser(host), orgId },
    );
    const exec = <T>(user: string, command: string, input: unknown) => app.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => app.query<T>(command, input, { actor: asUser(user), orgId });
    await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
    const party = async (name: string) => (await rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]))[0]!.id;
    const deal = (partyId: string, title = 'Gói kế toán năm') => exec<{ id: string }>(owner, 'crm.deal.create', { partyId, title, amount: '15000000', expectedClose: null });
    // A booking of the type on the given day, requested through the public page and confirmed by the worker.
    const book = async (day: string, minute: number): Promise<string> => {
      const request = await bookingRequest(app, slug, 'tu-van', { startsAt: at(day, minute), name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: '0901234567', note: null, timeZone: VN });
      if (!request) throw new Error('no request');
      const id = (await rows<{ id: string }>("SELECT id FROM crove_crm.booking WHERE org_id = $1 AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1", [orgId]))[0]!.id;
      expect(await worker.execute<{ status: string }>('crm.booking.confirm', { bookingId: id }, { actor: SYSTEM, orgId })).toMatchObject({ status: 'confirmed' });
      return id;
    };
    const link = (bookingId: string, dealId: string) => exec(host, 'crm.booking.link_deal', { bookingId, dealId });
    // A quote as a person makes it (two lines, so the total has a VAT part), then sent as the database owner makes a send.
    const sentQuote = async (dealId: string, sentDaysAgo: number, validIn: number, number: string) => {
      const draft = await exec<{ id: string }>(owner, 'crm.quote.save', { dealId, lines: [{ kind: 'item', description: 'Phần mềm', unit: 'gói', quantity: '3', unitPrice: '1234567', vatRate: '8%' }, { kind: 'item', description: 'Hỗ trợ', unit: 'tháng', quantity: '2', unitPrice: '55000', vatRate: '10%' }] });
      await rows(
        "UPDATE crove_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [orgId, draft.id, number, sentDaysAgo, validIn],
      );
      const total = (await rows<{ total: string }>('SELECT total::text AS total FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [orgId, draft.id]))[0]?.total as string;
      return { id: draft.id, number, total };
    };
    const age = (dealId: string, days: number) => rows('UPDATE crove_crm.deal SET updated_at = now() - make_interval(days => $3) WHERE org_id = $1 AND id = $2', [orgId, dealId, days]);
    // The customer's private mail (linked to the party as a person links it), and a comment on a page that every member reads.
    const mail = async (partyId: string, text: string) => {
      const id = randomUUID();
      await worker.execute('kernel.conversation.email_ingest', { events: [{ kind: 'email', threadId: `<${id}@mau.test>`, messageId: `<${id}@mau.test>`, direction: 'in', contact: { id: 'khach@mau.test', name: 'Khách' }, text, at: new Date().toISOString(), verified: true }] }, { actor: SYSTEM, orgId });
      await rows('UPDATE crove_kernel.conversation SET party_id = $2 WHERE org_id = $1 AND party_id IS NULL', [orgId, partyId]);
    };
    const comment = async (partyId: string, text: string) => {
      const connectionId = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Trang Chính', $4)", [orgId, connectionId, `acct-${randomUUID().slice(0, 6)}`, owner]);
      const threadId = `t-${randomUUID().slice(0, 8)}`;
      await worker.execute(
        'kernel.conversation.ingest',
        { connectionId, events: [{ kind: 'comment_thread', threadId, postId: 'post-1', messageId: `msg-${threadId}`, direction: 'in', contact: { id: 'cust-1', name: 'Khách thử' }, text, at: new Date().toISOString() }] },
        { actor: SYSTEM, orgId },
      );
      await rows('UPDATE crove_kernel.conversation SET party_id = $3 WHERE org_id = $1 AND external_thread_id = $2', [orgId, threadId, partyId]);
    };
    const source = (user: string, bookingId: string) => query<MeetingBriefSource>(user, 'crm.booking.meeting_brief_source', { bookingId });
    return { orgId, owner, host, other, viewer, exec, party, deal, book, link, sentQuote, age, mail, comment, source };
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('builds the facts from the books: the deal, its open next step, the latest sent quote with its exact total, and the customer\'s words', async () => {
    const o = await org();
    const day = bookableDay();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    // A quote sent today (the quote rule raises nothing for it) on a deal that nobody touched for 30 days: the stale rule raises the next step.
    await o.age(deal.id, 30);
    const quote = await o.sentQuote(deal.id, 0, 20, 'BG-2026-0042');
    await o.age(deal.id, 30);
    await worker.execute('crm.next_step.raise', {}, { actor: SYSTEM, orgId: o.orgId });
    const booking = await o.book(day, 540);
    await o.link(booking, deal.id);
    await o.comment(party, 'Chị cần thêm 3 tài khoản nữa nhé');

    const got = await o.source(o.host, booking);
    expect(got).toMatchObject({
      bookingId: booking,
      dealId: deal.id,
      wordsAllowed: true,
      meeting: { title: 'Tư vấn thuế', startsOn: day, startsTime: '09:00', timeZone: VN, guestName: 'Nguyễn Văn Khách' },
      deal: { title: 'Gói kế toán năm', status: 'open', amount: '15000000', expectedClose: null, contactName: 'Công ty Hoa Mai' },
      quote: { label: 'BG-2026-0042', total: quote.total, status: 'sent', expired: false },
      messages: ['Chị cần thêm 3 tài khoản nữa nhé'],
    });
    expect(got.deal.stage).not.toBe('');
    expect(got.nextSteps.map((s) => s.reason)).toEqual(['no_activity']);
    // The facts hold no email, phone or note of the guest.
    expect(JSON.stringify(got)).not.toMatch(/khach@example\.test|0901234567/);
    // The same facts for an owner (who reads every booking).
    expect(await o.source(o.owner, booking)).toEqual(got);
  });

  it('gives a member without access to the conversation the brief without its messages, and an owner the same brief with them', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    const booking = await o.book(bookableDay(), 600);
    await o.link(booking, deal.id);
    // A private email: owners, admins and holders of the direct-message permission read it; the host, a plain member, does not.
    await o.mail(party, 'Tin riêng: bên chị chỉ có ngân sách nhỏ');
    const owner = await o.source(o.owner, booking);
    const host = await o.source(o.host, booking);
    expect(owner.messages).toEqual(['Tin riêng: bên chị chỉ có ngân sách nhỏ']);
    expect(host.messages).toEqual([]);
    expect(JSON.stringify(host)).not.toContain('ngân sách nhỏ');
    // The rest of the facts are the same for both.
    expect({ ...host, messages: [] }).toEqual({ ...owner, messages: [] });
    // A comment on a page every member reads is read by the host too.
    await o.comment(party, 'Chị muốn gặp sớm một chút');
    expect((await o.source(o.host, booking)).messages).toEqual(['Chị muốn gặp sớm một chút']);
    expect((await o.source(o.owner, booking)).messages).toEqual(['Tin riêng: bên chị chỉ có ngân sách nhỏ', 'Chị muốn gặp sớm một chút']);
  });

  it('reads under the booking\'s own rule: another member, a viewer and another org get nothing; no deal, or a cancelled booking, has no brief', async () => {
    const o = await org();
    const other = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    const booking = await o.book(bookableDay(), 660);
    await expect(o.source(o.host, booking)).rejects.toMatchObject({ code: 'BOOKING_NO_DEAL' });
    await o.link(booking, deal.id);
    // A member who neither hosts nor holds the booking does not find it; a viewer reads no booking; another org's owner never finds it.
    await expect(o.source(o.other, booking)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    await expect(o.source(o.viewer, booking)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(other.source(other.owner, booking)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    expect((await o.source(o.owner, booking)).bookingId).toBe(booking);
    await o.exec(o.host, 'crm.booking.cancel', { bookingId: booking });
    await expect(o.source(o.host, booking)).rejects.toMatchObject({ code: 'BOOKING_NOT_UPCOMING' });
  });

  it('writes and audits nothing, and sends nothing', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    const booking = await o.book(bookableDay(), 720);
    await o.link(booking, deal.id);
    const count = async () => ({
      audits: (await rows<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.booking.meeting_brief_source'", [o.orgId]))[0]?.n,
      mail: (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.mail_message WHERE org_id = $1', [o.orgId]))[0]?.n,
      messages: (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId]))[0]?.n,
      deal: (await rows<{ updated_at: string }>('SELECT updated_at::text FROM crove_crm.deal WHERE org_id = $1 AND id = $2', [o.orgId, deal.id]))[0]?.updated_at,
    });
    const before = await count();
    await o.source(o.host, booking);
    await o.source(o.owner, booking);
    expect(await count()).toEqual(before);
    expect(before.audits).toBe('0');
  });

  it('asks the model outside the transaction with the facts, and only while it is on: AI off makes no call and leaves the facts list alone', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    const quote = await o.sentQuote(deal.id, 2, 20, 'BG-2026-0077');
    const booking = await o.book(bookableDay(), 780);
    await o.link(booking, deal.id);
    await o.comment(party, 'Chị cần thêm 3 tài khoản nữa nhé');
    const facts = await o.source(o.host, booking);

    const budget = () => new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 });
    // AI off: no reader, so no call exists to be made; the answer is the facts and no prose.
    expect(await prepareMeetingBrief(meetingBriefAi(null, budget()), o.orgId, o.host, facts)).toMatchObject({
      ai: 'off',
      summary: null,
      points: [],
      bookingId: booking,
      deal: { title: 'Gói kế toán năm' },
      quote: { label: 'BG-2026-0077', total: quote.total },
      messages: ['Chị cần thêm 3 tài khoản nữa nhé'],
    });

    // AI on: the model is told the facts (the exact total in dong, the customer's words) and its figures are the books' own.
    const asked: Array<Parameters<MeetingBriefGenerator>[0]> = [];
    const answer = { summary: 'Cơ hội "Gói kế toán năm" của Công ty Hoa Mai có giá trị 15.000.000 đồng.', points: ['Hỏi khách đã xem báo giá BG-2026-0077 chưa.', 'Xác nhận khách cần thêm 3 tài khoản.'] };
    const meetingBrief: MeetingBriefGenerator = async (args) => {
      asked.push(args);
      return { output: answer, usage: { inputTokens: 5, outputTokens: 5 } };
    };
    const used = await prepareMeetingBrief(meetingBriefAi(new InboxReader(CONFIG, { meetingBrief }), budget()), o.orgId, o.host, facts);
    expect(used).toMatchObject({ ai: 'used', summary: answer.summary, points: answer.points });
    expect(asked).toHaveLength(1);
    const told = `${asked[0]?.system}\n${asked[0]?.prompt}`;
    expect(told).toContain('BG-2026-0077');
    expect(told).toContain('15.000.000 đồng');
    expect(told).toContain('Chị cần thêm 3 tài khoản nữa nhé');
    // None of the guest's contact details reach the model.
    expect(told).not.toMatch(/khach@example\.test|0901234567/);

    // A figure the facts do not hold: the words are refused and the answer is the facts alone.
    const tampered: MeetingBriefGenerator = async () => ({ output: { summary: 'Giá trị 99.000.000 đồng.', points: ['Hỏi khách.', 'Chốt sớm.'] }, usage: { inputTokens: 5, outputTokens: 5 } });
    const refused = await prepareMeetingBrief(meetingBriefAi(new InboxReader(CONFIG, { meetingBrief: tampered }), budget()), o.orgId, o.host, facts);
    expect(refused).toMatchObject({ ai: 'failed', summary: null, points: [], quote: { total: quote.total } });
  });

  it('keeps the customer\'s words from the model while the org\'s switch for AI on them is off, though the member still reads them in the facts', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    const booking = await o.book(bookableDay(), 840);
    await o.link(booking, deal.id);
    await o.comment(party, 'Chị cần thêm 3 tài khoản nữa nhé');
    await o.exec(o.owner, 'kernel.conversation.auto_draft_set', { autoDraft: false });
    const facts = await o.source(o.host, booking);
    expect(facts).toMatchObject({ wordsAllowed: false, messages: ['Chị cần thêm 3 tài khoản nữa nhé'] });
    const asked: Array<Parameters<MeetingBriefGenerator>[0]> = [];
    const meetingBrief: MeetingBriefGenerator = async (args) => {
      asked.push(args);
      return { output: { summary: 'Cơ hội đang mở.', points: ['Hỏi khách cần gì.', 'Xác nhận nhu cầu.'] }, usage: { inputTokens: 5, outputTokens: 5 } };
    };
    const got = await prepareMeetingBrief(meetingBriefAi(new InboxReader(CONFIG, { meetingBrief }), new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 })), o.orgId, o.host, facts);
    expect(got.ai).toBe('used');
    expect(got.messages).toEqual(['Chị cần thêm 3 tài khoản nữa nhé']);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).not.toContain('3 tài khoản');
    expect(asked[0]?.prompt).toContain('No customer message is available.');
  });
});
