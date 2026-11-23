// SPDX-License-Identifier: AGPL-3.0-only
// The settlement of an approved supplier payment by its bank statement line (#3113 S3c, #3700) on a real PostgreSQL: `finance.supplier_payment.settle.prepare` and `.record` (a ledger proposal) record a
// bank voucher (Dr 331 / Cr the bank) that names the payment and move it to `paid` in one approved step. The conditions of the Accounting PO: the line's amount and the file's day, the beneficiary
// account compared by keyed hash, a voucher unique per payment and not reversible while the payment is paid, and the database guards behind each. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const NUMBER = '0123 4567 8901';
const HOLDER = 'Nguyen Van Canary';

suite('the settlement of a supplier payment by its bank line (#3113 S3c)', () => {
  const dbName = `crove_test_supplier_payment_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const hashRoot = { id: 'k-test-1', key: randomBytes(32) };
  const user = (userId: string, fresh = true) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: fresh ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) - 3600 });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  // The superuser with the table's triggers set aside, for what a test must arrange that no command could (an old account, a payable_after in the past, a change that skips the stale trigger).
  const unguarded = <T>(fn: (c: pg.Client) => Promise<T>) =>
    admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL session_replication_role = replica');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@pay.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string | null; member: string; supplier: string };
  // `twoApprovers`: an owner and an admin (four-eyes applies: the asker never approves); otherwise the owner alone (a single owner or admin: the one-person path and the hold).
  async function org(twoApprovers: boolean): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Công ty Chi ${randomUUID().slice(0, 6)}`);
    const member = await identity('member');
    const adminUser = twoApprovers ? await identity('admin') : null;
    await admin(async (c) => {
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
      if (adminUser) await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]);
    });
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thử')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, member, supplier };
  }
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true) => rt.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey: randomUUID() });
  const addAccount = (o: Org, number = NUMBER) =>
    execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: number });
  // A received invoice of the supplier with its own entry (a document without its entry is refused at commit), as the commands record one.
  async function invoice(o: Org, total = '110'): Promise<string> {
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', $5::numeric - 10, 10, $5)", [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`, total]);
      await c.query("INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'payment test', 'finance.purchase_document', $3)", [o.orgId, entry, doc]);
      await c.query("INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    return doc;
  }
  const request = (o: Org, doc: string, who = o.owner) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } }, who);
  const approve = (o: Org, proposalId: string, who = o.owner) => execute<{ id: string; status: string }>(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, who);
  type Payment = { id: string; status: string; payable_after: Date | null; hold_reason: string | null; bank_account_id: string; amount: string; approved_at: Date; stale_at: Date | null; paid_at: Date | null; confirmed_at: Date | null };
  const payments = (o: Org, doc: string | null = null) =>
    rows<Payment>('SELECT id, status, payable_after, hold_reason, bank_account_id, amount::text, approved_at, stale_at, paid_at, confirmed_at FROM ludy_finance.supplier_payment WHERE org_id = $1 AND ($2::uuid IS NULL OR purchase_document_id = $2) ORDER BY created_at, id', [o.orgId, doc]);
  // Asks and approves one invoice end to end, as the right pair of people for the org.
  async function pay(o: Org, doc: string): Promise<Payment> {
    const { proposalId } = await request(o, doc);
    await approve(o, proposalId, o.admin ?? o.owner);
    const all = await payments(o, doc);
    return all.find((p) => p.status === 'approved') as Payment;
  }

  beforeAll(async () => {
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`CREATE DATABASE ${dbName}`);
    await rootClient.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, subjectVault, keyedHashRoots: [hashRoot] }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  // The payment as the file hands it over: the hold passed (as only the database owner can arrange) and one file made.
  const ready = async (o: Org): Promise<Payment> => {
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    return first;
  };
  const released = (o: Org, id: string) => unguarded((c) => c.query('UPDATE ludy_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2', [o.orgId, id]));
  const exportFile = (o: Org, ids: string[]) => execute(o, 'finance.supplier_payment.bank_file.export', { paymentIds: ids, rows: ids.length, currency: 'VND' });
  // Vietnam's day, the way the guard judges the file's day.
  const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const bankLine = async (o: Org, amount: string, date = today(), counterparty: string | null = null): Promise<string> => {
    const [line] = await rows<{ id: string }>(
      `INSERT INTO ludy_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount, bank_ref, counterparty_account) VALUES ($1, '1121', $2, 1, $3, 'Chuyen khoan NCC', $4, $5, $6) RETURNING id`,
      [o.orgId, randomUUID(), date, amount, `FT${randomUUID().slice(0, 8)}`, counterparty],
    );
    return line?.id as string;
  };
  // The Vietnam day of the first file, as the database stored it: a line made after the export is dated from it, so a test run across midnight does not depend on the clock.
  const fileDay = async (o: Org, id: string) =>
    (await rows<{ day: string }>("SELECT (first_exported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day FROM ludy_finance.supplier_payment WHERE org_id = $1 AND id = $2", [o.orgId, id]))[0]?.day as string;
  const SETTLE = 'finance.supplier_payment.settle.record';
  const ask = (o: Org, paymentId: string, bankLineId: string, who = o.owner) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: SETTLE, input: { paymentId, bankLineId } }, who);
  const status = async (o: Org, id: string) => (await rows<{ status: string; paid_at: Date | null }>('SELECT status, paid_at FROM ludy_finance.supplier_payment WHERE org_id = $1 AND id = $2', [o.orgId, id]))[0];
  const codeOf = (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);

  it('records the transfer as a bank voucher that names the payment and pays it, in one approved step', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    await exportFile(o, [payment.id]);
    const line = await bankLine(o, '-110', await fileDay(o, payment.id));
    const { proposalId } = await ask(o, payment.id, line);
    // The request is the voucher the server builds from the payment and the line: Dr 331 with the supplier, Cr the bank, the invoice in the words.
    const [stored] = await rows<{ payload: { type: string; cashAccount: string; lines: Array<{ account: string; amount: string }>; party: { id: string }; description: string; supplierPayment: { paymentId: string } } }>(
      'SELECT payload FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2',
      [o.orgId, proposalId],
    );
    expect(stored?.payload).toMatchObject({ type: 'bank_debit', cashAccount: '1121', lines: [{ account: '331', amount: '110' }], party: { id: o.supplier }, supplierPayment: { paymentId: payment.id } });
    expect(stored?.payload.description).toMatch(/^Thanh toan hoa don inv-/);
    // Nothing is paid before the approval.
    expect((await status(o, payment.id))?.status).toBe('approved');
    await approve(o, proposalId, o.admin as string);
    const after = await status(o, payment.id);
    expect(after?.status).toBe('paid');
    expect(after?.paid_at).not.toBeNull();
    const [voucher] = await rows<{ id: string; supplier_payment_id: string; bank_line_id: string; voucher_type: string; amount: string }>('SELECT id, supplier_payment_id, bank_line_id, voucher_type, amount::text FROM ludy_finance.cash_voucher WHERE org_id = $1 AND supplier_payment_id = $2', [o.orgId, payment.id]);
    expect(voucher).toMatchObject({ bank_line_id: line, voucher_type: 'bank_debit' });
    expect(Number(voucher?.amount)).toBe(110);
    const entry = await rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      "SELECT l.account_code, l.debit::text, l.credit::text, l.party_id FROM ludy_finance.journal_line l JOIN ludy_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id WHERE e.org_id = $1 AND e.source_type = 'finance.cash_voucher' AND e.source_id = $2 ORDER BY l.line_no",
      [o.orgId, voucher?.id],
    );
    expect(entry.map((l) => [l.account_code, Number(l.debit), Number(l.credit), l.party_id])).toEqual([['331', 110, 0, o.supplier], ['1121', 0, 110, null]]);
    // A second settlement of the paid payment, and a second payment's voucher on the same line, are refused.
    expect(await codeOf(ask(o, payment.id, await bankLine(o, '-110', await fileDay(o, payment.id))))).toBe('SUPPLIER_PAYMENT_NOT_APPROVED');
  });

  it('refuses a payment that was never exported, a line of another amount, a line dated before the file and money in', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    const line = await bankLine(o, '-110');
    expect(await codeOf(ask(o, payment.id, line))).toBe('SUPPLIER_PAYMENT_NOT_EXPORTED');
    await exportFile(o, [payment.id]);
    const day = await fileDay(o, payment.id);
    expect(await codeOf(ask(o, payment.id, await bankLine(o, '-111', day)))).toBe('SUPPLIER_PAYMENT_LINE_MISMATCH');
    expect(await codeOf(ask(o, payment.id, await bankLine(o, '110', day)))).toBe('SUPPLIER_PAYMENT_LINE_MISMATCH');
    expect(await codeOf(ask(o, payment.id, await bankLine(o, '-110', '2026-01-02')))).toBe('SUPPLIER_PAYMENT_LINE_BEFORE_FILE');
    // The file's own day is fine and a line is asked for again after the refusals (none left a proposal or a voucher).
    expect(await codeOf(ask(o, payment.id, await bankLine(o, '-110', day)))).toBe('accepted');
    expect(await rows('SELECT 1 FROM ludy_finance.cash_voucher WHERE org_id = $1 AND supplier_payment_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('refuses a line whose beneficiary account is not the approved one, and settles one that is, or that carries no whole number', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    await exportFile(o, [payment.id]);
    const day = await fileDay(o, payment.id);
    const wrong = await bankLine(o, '-110', day, '9988776655');
    expect(await codeOf(ask(o, payment.id, wrong))).toBe('SUPPLIER_PAYMENT_ACCOUNT_MISMATCH');
    expect(await rows('SELECT 1 FROM ludy_kernel.proposal WHERE org_id = $1 AND command = $2', [o.orgId, SETTLE])).toHaveLength(0);
    // The right number (the statement keeps digits only, so the file's spaces are gone): the same account.
    const right = await bankLine(o, '-110', day, '012345678901');
    // A line with no number says nothing either way and is settled on the amount and the file.
    const none = await bankLine(o, '-110', day);
    expect(await codeOf(ask(o, payment.id, none))).toBe('accepted');
    const [open] = await rows<{ id: string }>('SELECT id FROM ludy_kernel.proposal WHERE org_id = $1 AND command = $2', [o.orgId, SETTLE]);
    expect(await codeOf(execute(o, 'kernel.proposal.reject', { id: open?.id, reason: 'test' }, o.admin as string))).toBe('accepted');
    const second = await ask(o, payment.id, right);
    await approve(o, second.proposalId, o.admin as string);
    expect((await status(o, payment.id))?.status).toBe('paid');
  });

  it('keeps the rules in the database: paid needs a file and a voucher, a voucher of a payment is unique, and its entry cannot be reversed while paid', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    const touch = (set: string) => admin((c) => c.query(`UPDATE ludy_finance.supplier_payment SET ${set} WHERE org_id = $1 AND id = $2`, [o.orgId, payment.id]));
    await expect(touch("status = 'paid'")).rejects.toThrow(/SUPPLIER_PAYMENT_NOT_EXPORTED/);
    await exportFile(o, [payment.id]);
    await expect(touch("status = 'paid'")).rejects.toThrow(/SUPPLIER_PAYMENT_NO_VOUCHER/);
    // The reversal trigger and the unique index are in the catalog.
    const catalog = await rows<{ n: string }>("SELECT tgname AS n FROM pg_trigger WHERE tgname IN ('b_supplier_payment_reversal', 'b_cash_voucher_tag_command') UNION ALL SELECT indexname FROM pg_indexes WHERE indexname = 'cash_voucher_supplier_payment_uq'");
    expect(catalog.map((r) => r.n).sort()).toEqual(['b_cash_voucher_tag_command', 'b_supplier_payment_reversal', 'cash_voucher_supplier_payment_uq']);
    // A voucher that names a payment is a bank debit made from a line by a proposal: one with no proposal fails the table's own check (named, so another failure cannot pass for it). The tag trigger that
    // ties the proposal to the settlement command is exercised by the approved settlement in the first test, which inserts through it.
    const line = await bankLine(o, '-110', await fileDay(o, payment.id));
    await expect(
      admin((c) => c.query("INSERT INTO ludy_finance.cash_voucher (org_id, voucher_type, voucher_date, cash_account, description, amount, bank_line_id, legal_entity_id, supplier_payment_id) SELECT $1, 'bank_debit', '2026-11-18', '1121', 'x', 110, $2, legal_entity_id, $3 FROM ludy_finance.supplier_payment WHERE id = $3", [o.orgId, line, payment.id])),
    ).rejects.toThrow(/cash_voucher_supplier_payment/);
  });

  it('refuses to reverse the voucher of a paid payment, when the reversal is asked for', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    await exportFile(o, [payment.id]);
    const { proposalId } = await ask(o, payment.id, await bankLine(o, '-110', await fileDay(o, payment.id)));
    await approve(o, proposalId, o.admin as string);
    const [entry] = await rows<{ id: string }>("SELECT e.id FROM ludy_finance.journal_entry e JOIN ludy_finance.cash_voucher v ON v.org_id = e.org_id AND v.id = e.source_id WHERE e.org_id = $1 AND e.source_type = 'finance.cash_voucher' AND v.supplier_payment_id = $2", [o.orgId, payment.id]);
    const code = await codeOf(execute(o, 'kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: entry?.id, entryDate: today(), reason: 'sai' } }));
    expect(code).toBe('SUPPLIER_PAYMENT_PAID');
  });

  it('offers the payment to the open money-out line of its amount, and nothing for another amount, money in or a settled line', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    const second = await ready(o);
    const line = await bankLine(o, '-110');
    const matchOf = (id: string) => rt.query<{ candidates: Array<{ paymentId: string; partyName: string; amount: string }> }>('finance.bank.supplier_match', { bankLineId: id }, { actor: user(o.owner), orgId: o.orgId });
    // Not exported yet: not offered.
    expect((await matchOf(line)).candidates).toEqual([]);
    await exportFile(o, [payment.id]);
    const day = await fileDay(o, payment.id);
    const early = await bankLine(o, '-110', day);
    expect((await matchOf(early)).candidates).toMatchObject([{ paymentId: payment.id, amount: '110' }]);
    expect((await matchOf(await bankLine(o, '-111', day))).candidates).toEqual([]);
    expect((await matchOf(await bankLine(o, '110', day))).candidates).toEqual([]);
    // A second exported payment of the same amount is offered too; the settlement asked for one holds its whole line (not offered to the other payment), while another open line still offers the other.
    await exportFile(o, [second.id]);
    // Dated on the later of the two file days, so a run across Vietnam midnight offers both.
    const openDay = [day, await fileDay(o, second.id)].sort().at(-1) as string;
    const open = await bankLine(o, '-110', openDay);
    expect((await matchOf(open)).candidates.map((c) => c.paymentId).sort()).toEqual([payment.id, second.id].sort());
    await ask(o, payment.id, open);
    expect((await matchOf(open)).candidates).toEqual([]);
    const another = await bankLine(o, '-110', await fileDay(o, second.id));
    expect((await matchOf(another)).candidates.map((c) => c.paymentId)).toEqual([second.id]);
    // An ordinary voucher for the held line is refused too, so the settlement cannot be starved by the other approval.
    const held = await codeOf(execute(o, 'kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_debit', date: openDay, cashAccount: '1121', partyId: o.supplier, description: 'x', lines: [{ account: '331', amount: '110' }], bankLineId: open } }));
    expect(held).toBe('BANK_LINE_PROPOSED');
    expect(await codeOf(rt.query('finance.bank.supplier_match', { bankLineId: open }, { actor: user(o.member), orgId: o.orgId }))).toBe('FORBIDDEN');
  });

  it('judges the line against the first file: a second file moves the export time but not the first one', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    await exportFile(o, [payment.id]);
    const times = () => rows<{ first: Date; last: Date }>('SELECT first_exported_at AS first, exported_at AS last FROM ludy_finance.supplier_payment WHERE org_id = $1 AND id = $2', [o.orgId, payment.id]).then((r) => r[0]);
    const before = await times();
    await execute(o, 'finance.supplier_payment.bank_file.export', { paymentIds: [payment.id], rows: 1, currency: 'VND', reexport: true });
    const after = await times();
    expect(after?.first.getTime()).toBe(before?.first.getTime());
    expect((after?.last.getTime() ?? 0) > (before?.last.getTime() ?? 0)).toBe(true);
    // The first file was handed over two days ago and a second one now: a line of the first day is still this payment's transfer, and a line of the day before the first file is not.
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_payment SET first_exported_at = first_exported_at - interval '2 days' WHERE org_id = $1 AND id = $2", [o.orgId, payment.id]));
    const firstDay = await fileDay(o, payment.id);
    const matchOf = (id: string) => rt.query<{ candidates: Array<{ paymentId: string }> }>('finance.bank.supplier_match', { bankLineId: id }, { actor: user(o.owner), orgId: o.orgId });
    expect((await matchOf(await bankLine(o, '-110', firstDay))).candidates.map((c) => c.paymentId)).toEqual([payment.id]);
    const dayBefore = new Date(new Date(`${firstDay}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    expect((await matchOf(await bankLine(o, '-110', dayBefore))).candidates).toEqual([]);
  });
  it('lets the upgrade fill first_exported_at of a payment handed over before the column existed, whatever its status', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const payment = await ready(o);
    await exportFile(o, [payment.id]);
    // The legacy state: a file was handed over, the first day was not recorded. The migration's own statement runs with the guard of the table in force (the guard before it rejected the move).
    const exportedDay = (await rows<{ day: string }>("SELECT (exported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day FROM ludy_finance.supplier_payment WHERE org_id = $1 AND id = $2", [o.orgId, payment.id]))[0]?.day;
    await unguarded((c) => c.query('UPDATE ludy_finance.supplier_payment SET first_exported_at = NULL WHERE org_id = $1 AND id = $2', [o.orgId, payment.id]));
    await admin((c) => c.query('UPDATE ludy_finance.supplier_payment SET first_exported_at = exported_at WHERE org_id = $1 AND id = $2 AND first_exported_at IS NULL AND exported_at IS NOT NULL', [o.orgId, payment.id]));
    expect(await fileDay(o, payment.id)).toBe(exportedDay);
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_payment SET status = 'cancelled', cancelled_at = now(), first_exported_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, payment.id]));
    await admin((c) => c.query('UPDATE ludy_finance.supplier_payment SET first_exported_at = exported_at WHERE org_id = $1 AND id = $2 AND first_exported_at IS NULL AND exported_at IS NOT NULL', [o.orgId, payment.id]));
    expect(await fileDay(o, payment.id)).toBe(exportedDay);
  });
});
