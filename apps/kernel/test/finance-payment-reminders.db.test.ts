// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488) on PostgreSQL 17: the overdue list (invoices past their due date with an amount left, the customer's 131 balance
// laid over them newest first, partial payments counted), the draft, and the send: a mail queued to the customer's email, its facts rebuilt from the
// books whatever words come with it, refused when the books moved since the draft, asked to confirm a second reminder of one level within three days,
// audited, and out of reach for a viewer. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { vietnamToday, type PaymentReminderDraft, type PaymentReminderList, type PaymentReminderSent } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { addDays, financeCommands, financeQueries, zPaymentReminderMail } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
// The invoice date that makes an invoice `late` days past its due date under the 30 day terms.
const dated = (late: number) => addDays(TODAY, -(30 + late));

suite('customer payment reminders (#2488)', () => {
  const dbName = `crove_test_payment_reminders_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; member: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Bán Hàng ${randomUUID().slice(0, 6)}`);
    const member = await identity('member');
    const viewer = await identity('viewer');
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    });
    const entity = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
    return { orgId, owner, member, viewer, entity };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const customer = async (o: Org, name: string, email: string | null) => (await execute<{ partyId: string }>(o, 'kernel.party.create', { kind: 'organization', name, ...(email ? { email } : {}) })).partyId;

  // A sales invoice with its entry (Dr 131, Cr 511), written the way finance.purchase.record writes one, in one transaction.
  async function sale(o: Org, party: string, number: string, date: string, total: string): Promise<string> {
    return admin(async (c) => {
      const doc = randomUUID();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
         VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, 'sale', $7)`,
        [o.orgId, doc, party, number, date, total, o.entity],
      );
      const entry = randomUUID();
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
        [o.orgId, entry, date, `HĐ bán ${number}`, doc, o.entity],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
         VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)`,
        [o.orgId, entry, total, party, o.entity],
      );
      await c.query('COMMIT');
      return doc;
    });
  }
  // A receipt from the customer: Dr 112, Cr 131 naming it.
  async function receipt(o: Org, party: string, date: string, amount: string): Promise<void> {
    await admin(async (c) => {
      const entry = randomUUID();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'Thu tiền khách hàng', 'finance.journal_voucher', $4, $5)`,
        [o.orgId, entry, date, randomUUID(), o.entity],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
         VALUES ($1, $2, 1, '112', $3, 0, NULL, $5), ($1, $2, 2, '131', 0, $3, $4, $5)`,
        [o.orgId, entry, amount, party, o.entity],
      );
      await c.query('COMMIT');
    });
  }
  const list = (o: Org, user = o.owner) => query<PaymentReminderList>(o, 'finance.payment_reminders.list', {}, user);
  const draft = (o: Org, partyId: string, user = o.owner) => query<PaymentReminderDraft>(o, 'finance.payment_reminder.draft', { partyId }, user);
  const mails = (o: Org, partyId: string) =>
    admin(async (c) => (await c.query<{ id: string; source: string; to_address: string; subject: string; status: string; payload: unknown }>(
      `SELECT id, source, to_address, subject, status, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2 ORDER BY created_at`,
      [o.orgId, partyId],
    )).rows);
  const sendInput = (d: PaymentReminderDraft, extra: Record<string, unknown> = {}) => ({
    partyId: d.partyId,
    level: d.level,
    total: d.total,
    subject: d.words.subject,
    greeting: d.words.greeting,
    lead: d.words.lead,
    closing: d.words.closing,
    payToId: d.payTo[0]?.id ?? null,
    ...extra,
  });

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the customers with an invoice past due and an amount left, longest overdue first, amounts exact', async () => {
    const o = await org();
    const a = await customer(o, 'Công ty An Phát', 'ketoan@anphat.test');
    const b = await customer(o, 'Công ty Bình Minh', 'bm@binhminh.test');
    const c = await customer(o, 'Công ty Cát Tường', 'ct@cattuong.test');
    // An Phát: 5 days late, nothing paid. Bình Minh: 40 days late, and one invoice not due yet. Cát Tường: not due yet only.
    await sale(o, a, '101', dated(5), '1500000.5');
    await sale(o, b, '201', dated(40), '2000000');
    await sale(o, b, '202', addDays(TODAY, -3), '700000');
    await sale(o, c, '301', addDays(TODAY, -10), '900000');
    const answer = await list(o);
    expect(answer.currency).toBe('VND');
    expect(answer.customers.map((x) => [x.name, x.level, x.invoiceCount, x.total, x.daysOverdue])).toEqual([
      ['Công ty Bình Minh', 3, 1, '2000000', 40],
      ['Công ty An Phát', 1, 1, '1500000.5', 5],
    ]);
    expect(answer.customers[0]?.lastReminder).toBeNull();
    expect(answer.more).toBe(false);
  });

  it('counts a partial payment against the oldest invoice, so the amount due is what is really left', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Đông Dương', 'dd@dongduong.test');
    await sale(o, p, '1', dated(20), '1000000');
    await sale(o, p, '2', dated(10), '2000000');
    // 1,400,000 received: invoice 1 is settled and 400,000 of invoice 2.
    await receipt(o, p, addDays(TODAY, -2), '1400000');
    const d = await draft(o, p);
    expect(d.invoices.map((i) => [i.number, i.amountDue, i.daysOverdue])).toEqual([['2', '1600000', 10]]);
    expect(d.total).toBe('1600000');
    expect(d.level).toBe(1);
    // Paid in full: the customer leaves the list.
    await receipt(o, p, TODAY, '1600000');
    expect((await list(o)).customers).toEqual([]);
    await expect(draft(o, p)).rejects.toMatchObject({ code: 'NOTHING_OVERDUE' });
  });

  it('keeps a balance no invoice covers out of the reminder', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Giang Sơn', 'gs@giangson.test');
    await admin(async (c) => {
      // An opening receivable of 3,000,000 with no invoice behind it, and one invoice of 1,000,000.
      const entry = randomUUID();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, '2026-01-01', 'Số dư đầu kỳ', 'finance.journal_voucher', $3, $4)`,
        [o.orgId, entry, randomUUID(), o.entity],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', 3000000, 0, $3, $4), ($1, $2, 2, '411', 0, 3000000, NULL, $4)`,
        [o.orgId, entry, p, o.entity],
      );
      await c.query('COMMIT');
    });
    await sale(o, p, '1', dated(3), '1000000');
    const d = await draft(o, p);
    expect(d.total).toBe('1000000');
    expect(d.other).toBe('3000000');
    expect(d.invoices).toHaveLength(1);
  });

  it('drafts the fixed words for the level, with the org bank accounts to be paid into', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Hòa Bình', 'hb@hoabinh.test');
    await sale(o, p, '7', dated(16), '2500000');
    await admin((c) => c.query(`INSERT INTO crove_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, $2, '112', '0011223344')`, [o.orgId, o.entity]));
    const d = await draft(o, p);
    expect(d).toMatchObject({ level: 2, lang: 'vi', email: 'hb@hoabinh.test', currency: 'VND', total: '2500000' });
    expect(d.words.lead).toContain('lần thứ hai');
    expect(d.words.greeting).toContain('Công ty Hòa Bình');
    expect(d.payTo).toHaveLength(1);
    expect(d.payTo[0]).toMatchObject({ number: '0011223344' });
    expect(`${d.words.greeting}${d.words.lead}${d.words.closing}`).not.toMatch(/\d/);
  });

  it('queues the mail on a person\'s send, its facts from the books whatever the words say, audited', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Khang Thịnh', 'kt@khangthinh.test');
    await sale(o, p, '11', dated(20), '3000000');
    await sale(o, p, '12', dated(8), '1234567');
    await admin((c) => c.query(`INSERT INTO crove_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, $2, '112', '9988776655')`, [o.orgId, o.entity]));
    const d = await draft(o, p);
    // The oldest invoice is 20 days late: the second notice.
    expect(d.level).toBe(2);
    // The person's words claim another amount: they are text, the facts block does not read them.
    const sent = await execute<PaymentReminderSent>(o, 'finance.payment_reminder.send', sendInput(d, { lead: 'Quý khách còn nợ 1 đồng, hạn ngày 1/1.' }), o.member);
    expect(sent).toMatchObject({ status: 'queued', level: 2 });
    const [mail] = await mails(o, p);
    expect(mail).toMatchObject({ id: sent.messageId, source: 'finance.payment_reminder.notice2', to_address: 'kt@khangthinh.test', status: 'queued' });
    const payload = zPaymentReminderMail.parse(mail?.payload);
    expect(payload.invoices.map((i) => [i.number, i.amountDue, i.daysOverdue])).toEqual([
      ['11', '3000000', 20],
      ['12', '1234567', 8],
    ]);
    expect(payload).toMatchObject({ count: 2, total: '4234567', currency: 'VND', lang: 'vi', payTo: { number: '9988776655' } });
    expect(payload.lead).toBe('Quý khách còn nợ 1 đồng, hạn ngày 1/1.');
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.payment_reminder.send' AND outcome = 'ok'`, [o.orgId])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ party_id: p, level: 2, invoices: 2, owed: '4234567', message_id: sent.messageId, status: 'queued', repeated: false });
    expect(JSON.stringify(audit[0]?.detail)).not.toContain('khangthinh');
    // The list now shows the reminder.
    const row = (await list(o)).customers.find((x) => x.partyId === p);
    expect(row?.lastReminder).toMatchObject({ level: 2 });
  });

  it('asks to confirm a second reminder of the same level within three days, and sends it when confirmed', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Lộc Phát', 'lp@locphat.test');
    await sale(o, p, '21', dated(4), '800000');
    const d = await draft(o, p);
    await execute(o, 'finance.payment_reminder.send', sendInput(d));
    await expect(execute(o, 'finance.payment_reminder.send', sendInput(d))).rejects.toMatchObject({ code: 'ALREADY_REMINDED' });
    expect(await mails(o, p)).toHaveLength(1);
    const again = await execute<PaymentReminderSent>(o, 'finance.payment_reminder.send', sendInput(d, { confirm: true }));
    expect(again.status).toBe('queued');
    expect(await mails(o, p)).toHaveLength(2);
    // Three days on, no confirmation is asked: age the first two mails.
    // (A mail row is immutable, so the superuser steps around the trigger for this one statement.)
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.mail_message SET created_at = now() - interval '4 days' WHERE org_id = $1 AND source_id = $2`, [o.orgId, p]);
    });
    const third = await execute<PaymentReminderSent>(o, 'finance.payment_reminder.send', sendInput(d));
    expect(third.status).toBe('queued');
  });

  it('refuses a send for books that moved since the draft, with nothing queued', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Mai Linh', 'ml@mailinh.test');
    await sale(o, p, '31', dated(6), '1000000');
    const d = await draft(o, p);
    await receipt(o, p, TODAY, '400000');
    await expect(execute(o, 'finance.payment_reminder.send', sendInput(d))).rejects.toMatchObject({ code: 'STALE_REMINDER' });
    // A level that is not the customer's now.
    await expect(execute(o, 'finance.payment_reminder.send', sendInput({ ...d, total: '600000' }, { level: 3 }))).rejects.toMatchObject({ code: 'STALE_REMINDER' });
    expect(await mails(o, p)).toHaveLength(0);
    const fresh = await draft(o, p);
    expect(fresh.total).toBe('600000');
    expect((await execute<PaymentReminderSent>(o, 'finance.payment_reminder.send', sendInput(fresh))).status).toBe('queued');
  });

  it('needs the customer\'s email, a chosen bank account that exists, and a role that may send', async () => {
    const o = await org();
    const noEmail = await customer(o, 'Công ty Nam Việt', null);
    const withEmail = await customer(o, 'Công ty Oanh Kiều', 'ok@oanhkieu.test');
    await sale(o, noEmail, '41', dated(3), '500000');
    await sale(o, withEmail, '51', dated(3), '600000');
    const d1 = await draft(o, noEmail);
    expect(d1.email).toBeNull();
    await expect(execute(o, 'finance.payment_reminder.send', sendInput(d1))).rejects.toMatchObject({ code: 'CUSTOMER_EMAIL_REQUIRED' });
    const d2 = await draft(o, withEmail);
    await expect(execute(o, 'finance.payment_reminder.send', sendInput(d2, { payToId: randomUUID() }))).rejects.toMatchObject({ code: 'PAY_TO_NOT_FOUND' });
    // A viewer reads the list and the draft but cannot send.
    expect((await list(o, o.viewer)).customers).toHaveLength(2);
    expect((await draft(o, withEmail, o.viewer)).total).toBe('600000');
    await expect(execute(o, 'finance.payment_reminder.send', sendInput(d2), o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await mails(o, withEmail)).toHaveLength(0);
  });

  it('keeps a suppressed address from being mailed and says so', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Phúc Lợi', 'pl@phucloi.test');
    await sale(o, p, '61', dated(3), '500000');
    await execute(o, 'kernel.mail.suppression.add', { email: 'pl@phucloi.test', scope: 'all' });
    const sent = await execute<PaymentReminderSent>(o, 'finance.payment_reminder.send', sendInput(await draft(o, p)));
    expect(sent.status).toBe('suppressed');
    // A suppressed mail is not a reminder the customer got: no confirmation is asked for the next, and the list shows none.
    expect((await list(o)).customers[0]?.lastReminder).toBeNull();
  });

  it('shows one org\'s customers to that org only', async () => {
    const a = await org();
    const b = await org();
    const p = await customer(a, 'Công ty Quang Huy', 'qh@quanghuy.test');
    await sale(a, p, '71', dated(9), '900000');
    expect((await list(a)).customers).toHaveLength(1);
    expect((await list(b)).customers).toEqual([]);
    await expect(draft(b, p)).rejects.toMatchObject({ code: 'NOTHING_OVERDUE' });
    await expect(execute(b, 'finance.payment_reminder.send', sendInput(await draft(a, p)))).rejects.toMatchObject({ code: 'NOTHING_OVERDUE' });
  });
});
