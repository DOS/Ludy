// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic pre-meeting contact facts and private per-member drafts on PostgreSQL 17 (#4991 PM1):
// - crm.contact.meeting_facts: matches up to 3 contacts case-folded by email (preserving dots) for agenda, booking, or meeting;
//   returns open deals, latest sent quote, finance invoice summary, and newest 5 inbound messages under caller RLS; AI-free; writes/audits nothing;
//   omits contact emails, phones, addresses, tax codes, and bank accounts; respects le_scope partial view; refuses viewer, agent, system, and cross-org callers.
// - meetings.brief_draft.{list,save,remove,put_to_notes}: strictly private per member (R1); cascades on party delete; erased cleanly by kernel.personal_data.erase;
//   explicit second click copies draft into meeting notes only for recorder with zero external send.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  SIGNAL_PARTIAL_VIEW_CODE,
  type EventType,
  type MeetingBriefDraftListOutput,
  type MeetingFactsOutput,
  type PartyInvoiceSummaryOutput,
  type PersonalDataErasure,
  type PipelineStage,
} from '@ludy/kernel-contract';
import { isVietnamHoliday, zonedDate, zonedInstant } from '@ludy/kernel-contract';
import { Runtime, defineQuery } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { addDays, financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { bookingRequest } from '../src/booking-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.meeting_facts' };

const rawDraftRowsQuery = defineQuery({
  name: 'test.brief_draft.raw_rows',
  input: z.object({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx): Promise<number> =>
    (await ctx.trx.selectFrom('ludy_meetings.meeting_brief_draft').select('id').where('org_id', '=', ctx.orgId).execute()).length,
});

const systemDraftRowsQuery = defineQuery({
  name: 'test.brief_draft.system_rows',
  input: z.object({}),
  access: 'system',
  handler: async (ctx): Promise<number> =>
    (await ctx.trx.selectFrom('ludy_meetings.meeting_brief_draft').select('id').where('org_id', '=', ctx.orgId).execute()).length,
});

function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}

const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('pre-meeting contact facts and private brief drafts on PostgreSQL (#4991 PM1)', () => {
  const dbName = `ludy_test_crm_meeting_facts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

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
    new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...financeCommands, ...meetingsCommands],
      queries: [
        ...kernelQueries({ inboundDomain: null }),
        ...crmQueries,
        ...financeQueries,
        ...meetingsQueries,
        rawDraftRowsQuery,
        systemDraftRowsQuery,
      ],
    });
  const person = (name: string) =>
    upsertIdentity(createDb(appPool), {
      issuer: 'test',
      subject: randomUUID(),
      email: `${name}-${randomUUID().slice(0, 8)}@facts.test`,
      name: null,
    });

  async function org() {
    const owner = await person('owner');
    const host = await person('host');
    const other = await person('other');
    const branchMember = await person('branch');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]!.id;
    const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]!.id;
    await admin((c) =>
      c.query(
        "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')",
        [orgId, host, other, branchMember, viewer],
      ),
    );
    await rows(
      "INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)",
      [orgId, branchMember, branch, owner],
    );
    const slug = (await rows<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]))[0]!.slug;
    const exec = <T>(user: string, command: string, input: unknown) => app.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => app.query<T>(command, input, { actor: asUser(user), orgId });

    await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
    const stages = await rows<{ id: string; kind: string }>('SELECT id, kind FROM ludy_crm.pipeline_stage WHERE org_id = $1', [orgId]);
    const wonStageId = stages.find((s) => s.kind === 'won')!.id;

    await app.execute(
      'kernel.calendar.hours.save',
      { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) },
      { actor: asUser(host), orgId },
    );
    await app.execute<EventType>(
      'crm.event_type.create',
      {
        slug: 'tu-van',
        title: 'Tư vấn hợp đồng',
        description: null,
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: 0,
        horizonDays: 60,
        dailyLimit: null,
        locationKind: 'video',
        locationValue: 'https://meet.example.test/y',
        hostUserId: host,
      },
      { actor: asUser(host), orgId },
    );

    const party = async (name: string, opts: { email?: string; phone?: string; taxCode?: string; duplicateOf?: string } = {}) => {
      const id = (
        await rows<{ id: string }>(
          "INSERT INTO ludy_kernel.party (org_id, name, kind, email, phone, tax_code, address, duplicate_of) VALUES ($1, $2, 'organization', $3, $4, $5, '123 Lê Lợi, Q1', $6) RETURNING id",
          [orgId, name, opts.email ?? null, opts.phone ?? null, opts.taxCode ?? null, opts.duplicateOf ?? null],
        )
      )[0]!.id;
      return id;
    };

    const deal = (partyId: string, title: string, amount = '25000000', expectedClose: string | null = null) =>
      exec<{ id: string }>(owner, 'crm.deal.create', { partyId, title, amount, expectedClose });

    const sentQuote = async (dealId: string, sentDaysAgo: number, validIn: number, number: string) => {
      const draft = await exec<{ id: string }>(owner, 'crm.quote.save', {
        dealId,
        lines: [
          { kind: 'item', description: 'Phần mềm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '8%' },
        ],
      });
      await rows(
        "UPDATE ludy_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [orgId, draft.id, number, sentDaysAgo, validIn],
      );
      const total = (await rows<{ total: string }>('SELECT total::text AS total FROM ludy_crm.quote WHERE org_id = $1 AND id = $2', [orgId, draft.id]))[0]!.total;
      return { id: draft.id, number, total };
    };

    const sale = async (partyId: string, number: string, date: string, total: string, legalEntity: string = entity): Promise<string> => {
      return admin(async (c) => {
        const doc = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, 'sale', $7)`,
          [orgId, doc, partyId, number, date, total, legalEntity],
        );
        const entry = randomUUID();
        await c.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
          [orgId, entry, date, `HĐ bán ${number}`, doc, legalEntity],
        );
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)`,
          [orgId, entry, total, partyId, legalEntity],
        );
        await c.query('COMMIT');
        return doc;
      });
    };

    const voidSale = async (docId: string, date: string, legalEntity: string = entity): Promise<void> => {
      await admin(async (c) => {
        const revEntry = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'Hủy hóa đơn', 'finance.purchase_document_void', $4, $5)`,
          [orgId, revEntry, date, docId, legalEntity],
        );
        await c.query(
          `INSERT INTO ludy_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason, legal_entity_id) VALUES ($1, $2, $3, 'Sai số liệu', $4)`,
          [orgId, docId, revEntry, legalEntity],
        );
        await c.query('COMMIT');
      });
    };

    const receipt = async (partyId: string, date: string, amount: string, legalEntity: string = entity): Promise<string> => {
      return admin(async (c) => {
        const entry = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'Thu tiền khách hàng', 'finance.journal_voucher', $4, $5)`,
          [orgId, entry, date, randomUUID(), legalEntity],
        );
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '112', $3, 0, NULL, $5), ($1, $2, 2, '131', 0, $3, $4, $5)`,
          [orgId, entry, amount, partyId, legalEntity],
        );
        await c.query('COMMIT');
        return entry;
      });
    };

    const reverseReceipt = async (entryId: string, date: string, legalEntity: string = entity): Promise<void> => {
      await admin(async (c) => {
        const rev = randomUUID();
        await c.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, reverses_entry_id, legal_entity_id) VALUES ($1, $2, $3, 'Đảo phiếu thu', 'finance.journal_voucher', $4, $5, $6)`,
          [orgId, rev, date, randomUUID(), entryId, legalEntity],
        );
      });
    };

    const mail = async (partyId: string, text: string, minutesAgo = 10) => {
      const id = randomUUID();
      await worker.execute(
        'kernel.conversation.email_ingest',
        {
          events: [
            {
              kind: 'email',
              threadId: `<${id}@mau.test>`,
              messageId: `<${id}@mau.test>`,
              direction: 'in',
              contact: { id: 'khach@mau.test', name: 'Khách' },
              text,
              at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
              verified: true,
            },
          ],
        },
        { actor: SYSTEM, orgId },
      );
      await rows('UPDATE ludy_kernel.conversation SET party_id = $2 WHERE org_id = $1 AND party_id IS NULL', [orgId, partyId]);
    };

    const comment = async (partyId: string, text: string, minutesAgo = 5) => {
      const connectionId = randomUUID();
      await rows(
        "INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Trang Chính', $4)",
        [orgId, connectionId, `acct-${randomUUID().slice(0, 6)}`, owner],
      );
      const threadId = `t-${randomUUID().slice(0, 8)}`;
      await worker.execute(
        'kernel.conversation.ingest',
        {
          connectionId,
          events: [
            {
              kind: 'comment_thread',
              threadId,
              postId: 'post-1',
              messageId: `msg-${threadId}`,
              direction: 'in',
              contact: { id: 'cust-1', name: 'Khách thử' },
              text,
              at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
            },
          ],
        },
        { actor: SYSTEM, orgId },
      );
      await rows('UPDATE ludy_kernel.conversation SET party_id = $3 WHERE org_id = $1 AND external_thread_id = $2', [orgId, threadId, partyId]);
    };

    const agendaConnection = async (userId: string) => {
      const connId = randomUUID();
      await rows(
        'INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes) VALUES ($1, $2, $3, $4, $5, $5, $6)',
        [orgId, connId, userId, 'google', `${userId}@gmail.test`, ['https://www.googleapis.com/auth/calendar.freebusy', GOOGLE_CALENDAR_EVENTS_READ_SCOPE]],
      );
      await exec(userId, 'meetings.agenda.set_read_events', { connectionId: connId, enabled: true });
      return connId;
    };

    const replaceAgenda = async (connectionId: string, externalId: string, attendeeEmails: string[]) => {
      const start = new Date(Date.now() + 60 * 60_000).toISOString();
      const end = new Date(Date.now() + 120 * 60_000).toISOString();
      await worker.execute(
        'meetings.agenda.replace',
        {
          connectionId,
          from: new Date(Date.now() - 30 * 60_000).toISOString(),
          events: [
            {
              id: externalId,
              title: 'Họp định kỳ với khách',
              startsAt: start,
              endsAt: end,
              timeZone: VN,
              joinUrl: 'https://meet.google.com/abc-defg-hij',
              invitees: attendeeEmails.length + 1,
              attendeeEmails,
              series: null,
            },
          ],
        },
        { actor: SYSTEM, orgId },
      );
      return (
        await rows<{ id: string }>(
          'SELECT id FROM ludy_meetings.calendar_agenda WHERE org_id = $1 AND connection_id = $2 AND external_id = $3',
          [orgId, connectionId, externalId],
        )
      )[0]!.id;
    };

    const book = async (day: string, minute: number, visitorEmail = 'hoa.mai@khach.test'): Promise<string> => {
      const req = await bookingRequest(app, slug, 'tu-van', {
        startsAt: at(day, minute),
        name: 'Chị Mai',
        email: visitorEmail,
        phone: '0900000001',
        note: null,
        timeZone: VN,
      });
      if (!req) throw new Error('bookingRequest failed');
      const id = (
        await rows<{ id: string }>("SELECT id FROM ludy_crm.booking WHERE org_id = $1 AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1", [orgId])
      )[0]!.id;
      await worker.execute('crm.booking.confirm', { bookingId: id }, { actor: SYSTEM, orgId });
      return id;
    };

    return {
      orgId,
      owner,
      host,
      other,
      branchMember,
      viewer,
      entity,
      branch,
      wonStageId,
      exec,
      query,
      party,
      deal,
      sentQuote,
      sale,
      voidSale,
      receipt,
      reverseReceipt,
      mail,
      comment,
      agendaConnection,
      replaceAgenda,
      book,
    };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
  }, 300_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('matches up to 3 contacts by case-folded attendee email (preserving dots), resolves duplicates, returns open deals, quote, finance summary, and up to 5 RLS messages with zero PII or audit writes', async () => {
    const o = await org();
    const today = zonedDate(VN, Date.now());
    const inv1Date = addDays(today, -45);
    const inv2Date = addDays(today, -10);
    const voidDate = addDays(today, -40);
    const paidDate = addDays(today, -3);
    const reversedPaidDate = addDays(today, -1);

    const hoaMai = await o.party('A Hoa Mai', { email: 'Hoa.Mai@Khach.Test', phone: '0901234567', taxCode: '0301234567' });
    const hoaMaiDup = await o.party('A Hoa Mai (trùng)', { email: 'hoa.mai.dup@khach.test', duplicateOf: hoaMai });
    const dotLess = await o.party('No Dots Contact', { email: 'hoamai@khach.test' });
    const p2 = await o.party('B Công ty Nam', { email: 'nam@khach.test' });
    const p3 = await o.party('C Công ty Lan', { email: 'lan@khach.test' });
    const p4 = await o.party('D Công ty Minh', { email: 'minh@khach.test' });
    expect(dotLess).toBeTruthy();

    const openDeal = await o.deal(hoaMai, 'Gói tư vấn năm', '25000000', addDays(today, 14));
    const zeroDeal = await o.deal(hoaMaiDup, 'Cơ hội chưa có giá trị', '0', null);
    const wonDeal = await o.deal(hoaMai, 'Cơ hội đã thắng', '9000000');
    await o.exec(o.owner, 'crm.deal.move', { dealId: wonDeal.id, stageId: o.wonStageId });
    expect(zeroDeal.id).toBeTruthy();

    const quote = await o.sentQuote(openDeal.id, 2, 15, 'BG-2026-0101');
    await o.exec(o.owner, 'crm.quote.save', {
      dealId: openDeal.id,
      lines: [{ kind: 'item', description: 'Nháp chưa gửi', unit: 'gói', quantity: '1', unitPrice: '9999999', vatRate: '0%' }],
    });

    // Accepted quote past valid_until must stay expired: false (#4991).
    const p2Deal = await o.deal(p2, 'Deal đã nhận báo giá', '8000000');
    const p2Quote = await o.sentQuote(p2Deal.id, 40, -10, 'BG-2026-0099');
    await rows("UPDATE ludy_crm.quote SET status = 'accepted' WHERE org_id = $1 AND id = $2", [o.orgId, p2Quote.id]);

    await o.sale(hoaMai, '101', inv1Date, '2000000');
    await o.sale(hoaMaiDup, '102', inv2Date, '1000000');
    const voidDoc = await o.sale(hoaMai, '103', voidDate, '9000000');
    await o.voidSale(voidDoc, addDays(today, -5));
    await o.receipt(hoaMai, paidDate, '500000');
    const revReceipt = await o.receipt(hoaMai, reversedPaidDate, '100000');
    await o.reverseReceipt(revReceipt, today);

    // 6 public messages (newest 5 returned in chronological order), 1 hidden comment (must be excluded), plus 1 private email message.
    for (let i = 1; i <= 6; i++) {
      await o.comment(hoaMai, `Tin công khai số ${i}`, 30 - i);
    }
    await o.comment(hoaMai, 'Tin ẩn bị kiểm duyệt', 1);
    await rows("UPDATE ludy_kernel.conversation_message SET hidden_at = now() WHERE org_id = $1 AND body = 'Tin ẩn bị kiểm duyệt'", [o.orgId]);
    await o.mail(hoaMai, 'Thư riêng chỉ chủ sở hữu thấy', 1);

    // Turn AI off to confirm PM1 works cleanly with zero AI enabled.
    await o.exec(o.owner, 'kernel.conversation.auto_draft_set', { autoDraft: false });

    const connId = await o.agendaConnection(o.host);
    // Include case-mixed HOA.MAI@KHACH.TEST, dot-variant mismatch test, p2, p3, p4 (4 matches -> cap at 3).
    const agendaId = await o.replaceAgenda(connId, 'ext-evt-1', [
      'HOA.MAI@KHACH.TEST',
      'hoa.mai.dup@khach.test',
      'nam@khach.test',
      'lan@khach.test',
      'minh@khach.test',
      'unknown@khach.test',
    ]);

    // Verify stored agenda row holds hashed values only, never raw email text.
    const stored = await rows<{ attendee_email_hashes: string[] }>(
      'SELECT attendee_email_hashes FROM ludy_meetings.calendar_agenda WHERE org_id = $1 AND id = $2',
      [o.orgId, agendaId],
    );
    expect(stored[0]?.attendee_email_hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(stored[0]?.attendee_email_hashes.join(',')).not.toContain('khach.test');

    const hostFacts = await o.query<MeetingFactsOutput>(o.host, 'crm.contact.meeting_facts', {
      targetKind: 'agenda',
      targetId: agendaId,
    });
    expect(hostFacts.wordsAllowed).toBe(false);
    expect(hostFacts.contacts).toHaveLength(3);
    expect(hostFacts.contacts.map((c) => c.partyId)).toEqual([hoaMai, p2, p3]);
    expect(hostFacts.contacts.some((c) => c.partyId === p4 || c.partyId === dotLess)).toBe(false);

    const hoaMaiFacts = hostFacts.contacts[0]!;
    expect(hoaMaiFacts.deals).toHaveLength(2);
    expect(hoaMaiFacts.deals.map((d) => d.title).sort()).toEqual(['Cơ hội chưa có giá trị', 'Gói tư vấn năm']);
    expect(hoaMaiFacts.deals.find((d) => d.dealId === zeroDeal.id)?.amount).toBeNull();
    expect(hoaMaiFacts.deals.find((d) => d.dealId === openDeal.id)?.amount).toBe('25000000');
    expect(hoaMaiFacts.latestQuote).toMatchObject({
      quoteId: quote.id,
      label: 'BG-2026-0101',
      total: quote.total,
      status: 'sent',
      expired: false,
    });
    expect(hoaMaiFacts.invoices).toEqual({
      openCount: 2,
      overdueAmount: '1500000',
      lastInvoiceDate: inv2Date,
      lastPaidDate: paidDate,
    });
    // Plain member cannot read private email; sees newest 5 public comments in chronological order.
    expect(hoaMaiFacts.messages).toEqual([
      'Tin công khai số 2',
      'Tin công khai số 3',
      'Tin công khai số 4',
      'Tin công khai số 5',
      'Tin công khai số 6',
    ]);

    // Accepted quote past valid_until reports expired: false and preserves status: 'accepted'.
    expect(hostFacts.contacts[1]?.latestQuote).toMatchObject({
      quoteId: p2Quote.id,
      label: 'BG-2026-0099',
      status: 'accepted',
      expired: false,
    });

    // Serialized output leaks no email, phone, tax code, address, hidden message, or bank account.
    const serialized = JSON.stringify(hostFacts);
    expect(serialized).not.toMatch(/hoa\.mai@khach\.test|0901234567|0301234567|123 Lê Lợi|Thư riêng|Tin ẩn bị kiểm duyệt/i);

    // Query wrote zero audit rows and sent zero mail.
    const auditCount = (
      await rows<{ n: string }>(
        "SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('crm.contact.meeting_facts', 'finance.party.invoice_summary', 'meetings.agenda.attendee_hashes')",
        [o.orgId],
      )
    )[0]?.n;
    expect(auditCount).toBe('0');
  });

  it('supports booking and meeting targets (including private email RLS for owner), enforces partial le_scope, and blocks viewer/agent/system/foreign org', async () => {
    const o = await org();
    const foreign = await org();
    const hoaMai = await o.party('Công ty Hoa Mai', { email: 'hoa.mai@khach.test', phone: '0900000001' });
    await o.deal(hoaMai, 'Deal booking', '12000000');
    await o.sale(hoaMai, '201', addDays(zonedDate(VN, Date.now()), -40), '1200000');
    await o.mail(hoaMai, 'Email mật của giám đốc', 2);

    const bookingId = await o.book(bookableDay(), 600, 'HOA.MAI@Khach.Test');
    const hostBookingFacts = await o.query<MeetingFactsOutput>(o.host, 'crm.contact.meeting_facts', {
      targetKind: 'booking',
      targetId: bookingId,
    });
    expect(hostBookingFacts.contacts[0]).toMatchObject({
      partyId: hoaMai,
      messages: [],
      invoices: { openCount: 1, overdueAmount: '1200000' },
    });

    const ownerBookingFacts = await o.query<MeetingFactsOutput>(o.owner, 'crm.contact.meeting_facts', {
      targetKind: 'booking',
      targetId: bookingId,
    });
    expect(ownerBookingFacts.contacts[0]?.messages).toEqual(['Email mật của giám đốc']);

    // Unhosted member, viewer, agent, system, and cross-org callers are denied cleanly.
    await expect(
      o.query(o.other, 'crm.contact.meeting_facts', { targetKind: 'booking', targetId: bookingId }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });
    await expect(
      o.query(o.viewer, 'crm.contact.meeting_facts', { targetKind: 'booking', targetId: bookingId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      app.query(
        'crm.contact.meeting_facts',
        { targetKind: 'booking', targetId: bookingId },
        { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      worker.query('crm.contact.meeting_facts', { targetKind: 'booking', targetId: bookingId }, { actor: SYSTEM, orgId: o.orgId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      foreign.query(foreign.owner, 'crm.contact.meeting_facts', { targetKind: 'booking', targetId: bookingId }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });

    // Branch-scoped accountant is refused direct finance summary with SIGNAL_PARTIAL_VIEW, and meeting_facts falls back to invoices: null cleanly.
    await expect(
      o.query<PartyInvoiceSummaryOutput>(o.branchMember, 'finance.party.invoice_summary', { partyIds: [hoaMai] }),
    ).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    const branchConn = await o.agendaConnection(o.branchMember);
    const branchAgenda = await o.replaceAgenda(branchConn, 'ext-branch-1', ['hoa.mai@khach.test']);
    const branchFacts = await o.query<MeetingFactsOutput>(o.branchMember, 'crm.contact.meeting_facts', {
      targetKind: 'agenda',
      targetId: branchAgenda,
    });
    expect(branchFacts.contacts[0]).toMatchObject({ partyId: hoaMai, invoices: null });
    expect(branchFacts.contacts[0]?.deals).toHaveLength(1);

    // Recorded meeting via calendar_agenda link AND via meeting_link.calendar_event_id.
    const hostConn = await o.agendaConnection(o.host);
    const hostAgenda = await o.replaceAgenda(hostConn, 'ext-meet-1', ['hoa.mai@khach.test']);
    const created = await o.exec<{ meetingId: string }>(o.host, 'meetings.meeting.create', {
      title: 'Họp với Hoa Mai',
      consentMethod: 'told_at_start',
      visibility: 'attendees',
      language: 'vi',
      keepVideo: false,
    });
    await o.exec(o.host, 'meetings.agenda.link', { agendaId: hostAgenda, meetingId: created.meetingId });
    const meetingFacts = await o.query<MeetingFactsOutput>(o.host, 'crm.contact.meeting_facts', {
      targetKind: 'meeting',
      targetId: created.meetingId,
    });
    expect(meetingFacts.contacts[0]?.partyId).toBe(hoaMai);

    // Link-only meeting resolution via ludy_meetings.meeting_link.calendar_event_id referencing booking's ludy_kernel.calendar_event.
    const bookingCalendarEventId = (
      await rows<{ calendar_event_id: string }>('SELECT calendar_event_id FROM ludy_crm.booking WHERE org_id = $1 AND id = $2', [o.orgId, bookingId])
    )[0]!.calendar_event_id;
    const linkOnlyMeeting = await o.exec<{ meetingId: string }>(o.host, 'meetings.meeting.create', {
      title: 'Họp link qua booking',
      consentMethod: 'told_at_start',
      visibility: 'attendees',
      language: 'vi',
      keepVideo: false,
    });
    await rows(
      'INSERT INTO ludy_meetings.meeting_link (org_id, meeting_id, calendar_event_id, created_by) VALUES ($1, $2, $3, $4)',
      [o.orgId, linkOnlyMeeting.meetingId, bookingCalendarEventId, o.host],
    );
    const linkFacts = await o.query<MeetingFactsOutput>(o.host, 'crm.contact.meeting_facts', {
      targetKind: 'meeting',
      targetId: linkOnlyMeeting.meetingId,
    });
    expect(linkFacts.contacts[0]?.partyId).toBe(hoaMai);
  });

  it('keeps private per-member drafts strictly isolated, transfers explicitly to recorder notes only, cascades on contact delete, and erases via personal_data.erase', async () => {
    const o = await org();
    const hoaMai = await o.party('Công ty Hoa Mai', { email: 'hoa.mai@khach.test' });
    const secondParty = await o.party('Công ty Khác', { email: 'khac@khach.test' });

    const connId = await o.agendaConnection(o.host);
    const agendaId = await o.replaceAgenda(connId, 'ext-draft-1', ['hoa.mai@khach.test', 'khac@khach.test']);
    const created = await o.exec<{ meetingId: string }>(o.host, 'meetings.meeting.create', {
      title: 'Họp nháp',
      consentMethod: 'told_at_start',
      visibility: 'org',
      language: 'vi',
      keepVideo: false,
    });
    await o.exec(o.host, 'meetings.agenda.link', { agendaId, meetingId: created.meetingId });

    // Host saves private draft for Hoa Mai on the agenda event.
    const saved = await o.exec<{ draft: { id: string; body: string } }>(o.host, 'meetings.brief_draft.save', {
      targetKind: 'agenda',
      targetId: agendaId,
      partyId: hoaMai,
      body: 'Ghi chú riêng cho Hoa Mai: hỏi về báo giá mới',
    });
    expect(saved.draft.body).toContain('Hoa Mai');

    // Invisible to owner, admin/other member, viewer, agent, and system via both RPC and raw app SQL.
    for (const user of [o.owner, o.other]) {
      const list = await o.query<MeetingBriefDraftListOutput>(user, 'meetings.brief_draft.list', {
        targetKind: 'meeting',
        targetId: created.meetingId,
      });
      expect(list.drafts).toEqual([]);
    }
    await expect(
      o.query(o.viewer, 'meetings.brief_draft.list', { targetKind: 'meeting', targetId: created.meetingId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      app.query(
        'meetings.brief_draft.list',
        { targetKind: 'meeting', targetId: created.meetingId },
        { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      worker.query('meetings.brief_draft.list', { targetKind: 'meeting', targetId: created.meetingId }, { actor: SYSTEM, orgId: o.orgId }),
    ).rejects.toMatchObject({ status: 403 });

    // Direct sealed-context SQL RLS check across roles: author reads own row while owner/other/viewer/system read zero.
    const cAdminCount = await rows<{ count: string }>(
      'SELECT count(*)::text AS count FROM ludy_meetings.meeting_brief_draft WHERE org_id = $1',
      [o.orgId],
    );
    expect(cAdminCount[0]?.count).toBe('1');
    expect(await app.query<number>('test.brief_draft.raw_rows', {}, { actor: asUser(o.host), orgId: o.orgId })).toBe(1);
    expect(await app.query<number>('test.brief_draft.raw_rows', {}, { actor: asUser(o.owner), orgId: o.orgId })).toBe(0);
    expect(await app.query<number>('test.brief_draft.raw_rows', {}, { actor: asUser(o.other), orgId: o.orgId })).toBe(0);
    expect(await app.query<number>('test.brief_draft.raw_rows', {}, { actor: asUser(o.viewer), orgId: o.orgId })).toBe(0);
    expect(await worker.query<number>('test.brief_draft.system_rows', {}, { actor: SYSTEM, orgId: o.orgId })).toBe(0);

    // Host sees the linked agenda draft when querying the recorded meeting.
    const hostList = await o.query<MeetingBriefDraftListOutput>(o.host, 'meetings.brief_draft.list', {
      targetKind: 'meeting',
      targetId: created.meetingId,
    });
    expect(hostList.drafts).toHaveLength(1);
    expect(hostList.drafts[0]).toMatchObject({ partyId: hoaMai, targetKind: 'agenda', targetId: agendaId });

    // Non-recorder cannot put draft into meeting notes; recorder can, idempotently, with zero external send.
    await expect(
      o.exec(o.owner, 'meetings.brief_draft.put_to_notes', {
        targetKind: 'agenda',
        targetId: agendaId,
        partyId: hoaMai,
        meetingId: created.meetingId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await o.exec(o.host, 'meetings.results.notes_save', { meetingId: created.meetingId, body: 'Ghi chú sẵn có' });
    const put1 = await o.exec<{ length: number; truncated: boolean }>(o.host, 'meetings.brief_draft.put_to_notes', {
      targetKind: 'agenda',
      targetId: agendaId,
      partyId: hoaMai,
      meetingId: created.meetingId,
    });
    expect(put1.truncated).toBe(false);
    // Repeat click is idempotent and does not duplicate the text.
    await o.exec(o.host, 'meetings.brief_draft.put_to_notes', {
      targetKind: 'agenda',
      targetId: agendaId,
      partyId: hoaMai,
      meetingId: created.meetingId,
    });
    const noteRow = await rows<{ body: string }>(
      'SELECT body FROM ludy_meetings.meeting_note WHERE org_id = $1 AND meeting_id = $2',
      [o.orgId, created.meetingId],
    );
    expect(noteRow[0]?.body).toBe('Ghi chú sẵn có\n\nGhi chú riêng cho Hoa Mai: hỏi về báo giá mới');
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.mail_message WHERE org_id = $1', [o.orgId]))[0]?.n).toBe('0');

    // Second draft containing personal email text; first draft deleted via party cascade, second erased via personal_data.erase.
    await o.exec(o.host, 'meetings.brief_draft.save', {
      targetKind: 'meeting',
      targetId: created.meetingId,
      partyId: secondParty,
      body: 'Khách nhắn qua email xoa.ngay@example.vn cần hủy dữ liệu',
    });
    await o.exec(o.host, 'meetings.brief_draft.save', {
      targetKind: 'meeting',
      targetId: created.meetingId,
      partyId: hoaMai,
      body: 'Bản nháp riêng gắn với Hoa Mai không chứa email trong chữ',
    });

    // Save an unrelated draft on secondParty that does NOT match xoa.ngay@example.vn so we also assert aggregate kept count.
    const keptDraftConn = await o.agendaConnection(o.other);
    const otherAgenda = await o.replaceAgenda(keptDraftConn, 'ext-kept-1', ['khac@khach.test']);
    await o.exec(o.other, 'meetings.brief_draft.save', {
      targetKind: 'agenda',
      targetId: otherAgenda,
      partyId: secondParty,
      body: 'Ghi chú nội bộ hoàn toàn bình thường',
    });

    // Erase by matched party email (`hoa.mai@khach.test`) -> erases both the agenda and meeting drafts linked to hoaMai by party_id!
    const eraseByParty = await app.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'hoa.mai@khach.test' },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(eraseByParty.erased.find((e) => e.column === 'ludy_meetings.meeting_brief_draft.body')?.rows).toBe(2);

    // Erase by free text (`xoa.ngay@example.vn`) -> erases the body-matching draft while keeping the unrelated draft (counted anonymously in kept).
    const eraseByBody = await app.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'xoa.ngay@example.vn' },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(eraseByBody.erased.find((e) => e.column === 'ludy_meetings.meeting_brief_draft.body')?.rows).toBe(1);
    expect(eraseByBody.kept.find((k) => k.column === 'ludy_meetings.meeting_brief_draft.body')?.rows).toBe(1);

    // Contact ON DELETE CASCADE removes remaining drafts for that party immediately.
    await rows('DELETE FROM ludy_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, secondParty]);
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_meetings.meeting_brief_draft WHERE org_id = $1', [o.orgId]))[0]?.n).toBe('0');
  });
});
