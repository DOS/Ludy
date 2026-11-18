// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of approved supplier payments (#3113 S3, #3700) on a real PostgreSQL: `finance.supplier_payment.bank_file.get` opens the sealed holder and number of each payment's pinned account for an
// owner or an admin with a fresh second factor, after its audit row, and refuses the whole file, naming the payment, for one it cannot carry. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const NUMBER = '0123 4567 8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';

suite('the bank file of supplier payments (#3113 S3)', () => {
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
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
      if (adminUser) await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]);
    });
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thử')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, member, supplier };
  }
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true) => rt.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.query<T>(name, input, { actor: user(who), orgId: o.orgId });
  const refusal = async (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);
  const addAccount = (o: Org, number = NUMBER) =>
    execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: number });
  // A received invoice of the supplier with its own entry (a document without its entry is refused at commit), as the commands record one.
  async function invoice(o: Org, total = '110'): Promise<string> {
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', $5::numeric - 10, 10, $5)", [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`, total]);
      await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'payment test', 'finance.purchase_document', $3)", [o.orgId, entry, doc]);
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    return doc;
  }
  const request = (o: Org, doc: string, who = o.owner) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } }, who);
  const approve = (o: Org, proposalId: string, who = o.owner) => execute<{ id: string; status: string }>(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, who);
  type Payment = { id: string; status: string; payable_after: Date | null; hold_reason: string | null; bank_account_id: string; amount: string; approved_at: Date; stale_at: Date | null; paid_at: Date | null; confirmed_at: Date | null };
  const payments = (o: Org) =>
    rows<Payment>('SELECT id, status, payable_after, hold_reason, bank_account_id, amount::text, approved_at, stale_at, paid_at, confirmed_at FROM crove_finance.supplier_payment WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
  // Asks and approves one invoice end to end, as the right pair of people for the org.
  async function pay(o: Org, doc: string): Promise<Payment> {
    const { proposalId } = await request(o, doc);
    await approve(o, proposalId, o.admin ?? o.owner);
    const all = await payments(o);
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
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

  type BankFile = { currency: string; rows: Array<{ seq: string; holder: string; account: string; bank: string; amount: string; content: string }>; total: string };
  const fileOf = (o: Org, ids: string[], who = o.owner, fresh = true) => rt.query<BankFile>('finance.supplier_payment.bank_file.get', { paymentIds: ids }, { actor: user(who, fresh), orgId: o.orgId });
  const refusalOf = async (promise: Promise<unknown>) => promise.then(() => ({ code: 'accepted', paymentId: undefined as string | undefined }), (error: { code?: string; details?: { paymentId?: string } }) => ({ code: error.code, paymentId: error.details?.paymentId }));
  // The hold passed (arranged as only the database owner can), so the payment is one a file may carry.
  const released = (o: Org, id: string) => unguarded((c) => c.query('UPDATE crove_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2', [o.orgId, id]));
  const auditRows = (o: Org, command: string) => rows<{ detail: unknown; facts: unknown }>('SELECT to_jsonb(a) - \'org_id\' AS detail, to_jsonb(a) AS facts FROM crove_kernel.audit_event a WHERE a.org_id = $1 AND a.command = $2', [o.orgId, command]);
  // A second supplier of the org with its own account and a received invoice.
  async function otherSupplier(o: Org, number: string, holder: string, total = '220'): Promise<{ party: string; doc: string }> {
    const party = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thứ hai')", [o.orgId, party]));
    await execute(o, 'finance.supplier_bank_account.add', { partyId: party, bankName: 'ACB', accountHolder: holder, accountNumber: number });
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-02', $5::numeric - 20, 20, $5)", [o.orgId, doc, party, `inv-b-${doc.slice(0, 6)}`, total]);
      await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-02', 'payment test', 'finance.purchase_document', $3)", [o.orgId, entry, doc]);
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 200, 0), ($1, $2, 2, '331', 0, 200)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    return { party, doc };
  }

  it('hands over the holder and the number of each payment, sorted for the bank, with the total of the approved amounts, after an audit row that holds no value', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const first = await pay(o, await invoice(o));
    const second = await otherSupplier(o, OTHER, 'Tran Thi A Canary');
    // The second supplier's payment: asked and approved like the first (the other approver decides).
    const { proposalId } = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: second.doc } });
    await approve(o, proposalId, o.admin as string);
    const all = await payments(o);
    expect(all).toHaveLength(2);
    const file = await fileOf(o, all.map((p) => p.id));
    expect(file.currency).toBe('VND');
    expect(file.rows).toHaveLength(2);
    // Sorted by holder (Vietnamese order); sequence numbers follow.
    expect(file.rows.map((r) => r.holder)).toEqual([HOLDER, 'Tran Thi A Canary'].sort((a, b) => a.localeCompare(b, 'vi')));
    const mine = file.rows.find((r) => r.holder === HOLDER);
    expect(mine).toMatchObject({ account: '012345678901', bank: 'Vietcombank', amount: '110', content: expect.stringMatching(/^Thanh toan hoa don inv-/) });
    expect(file.rows.map((r) => r.seq)).toEqual(['1', '2']);
    // The total is the sum of the amounts frozen in the approved requests.
    expect(file.total).toBe('330');
    expect(first.id).toBeTruthy();
    // The audit row of the read is there, and it holds no holder, no number, no amount.
    const audit = await auditRows(o, 'finance.supplier_payment.bank_file.get');
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(audit);
    for (const secret of ['012345678901', HOLDER, 'Canary', OTHER, '330', '110']) expect(text).not.toContain(secret);
    // The same file twice: the same answer (the file is not stored, nothing is marked).
    expect(await fileOf(o, all.map((p) => p.id))).toEqual(file);
  });

  it('refuses without a fresh second factor, to a member and a viewer, and for a payment of another org or an unknown one, naming the payment and no file', async () => {
    const o = await org(false);
    await addAccount(o);
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    expect((await refusalOf(fileOf(o, [first.id], o.owner, false))).code).toBe('STEP_UP_REQUIRED');
    expect((await refusalOf(fileOf(o, [first.id], o.member))).code).toBe('FORBIDDEN');
    const stranger = await org(false);
    expect(await refusalOf(fileOf(stranger, [first.id], stranger.owner))).toEqual({ code: 'SUPPLIER_PAYMENT_NOT_FOUND', paymentId: first.id });
    const unknown = randomUUID();
    expect(await refusalOf(fileOf(o, [first.id, unknown]))).toEqual({ code: 'SUPPLIER_PAYMENT_NOT_FOUND', paymentId: unknown });
    // The one that stands is still a file when it is asked for alone.
    expect((await fileOf(o, [first.id])).rows).toHaveLength(1);
  });

  it('refuses a payment that is held, stale, cancelled, changed, voided, of another amount or another currency, each naming the payment', async () => {
    const o = await org(false);
    const account = await addAccount(o);
    const doc = await invoice(o);
    const first = await pay(o, doc);
    // The one-person path with a new account: held 24 hours, on the database clock.
    expect(await refusalOf(fileOf(o, [first.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_HELD', paymentId: first.id });
    await released(o, first.id);
    expect((await fileOf(o, [first.id])).rows).toHaveLength(1);
    // The account is replaced after the approval: the payment is stale and no file carries it.
    await execute(o, 'finance.supplier_bank_account.replace', { accountId: account.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER });
    expect(await refusalOf(fileOf(o, [first.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_NOT_APPROVED', paymentId: first.id });
    // Asked again with the new account: held again (the account is new), then released.
    const second = await pay(o, doc);
    await released(o, second.id);
    expect((await fileOf(o, [second.id])).rows[0]).toMatchObject({ account: OTHER });
    // Cancelled.
    await execute(o, 'finance.supplier_payment.cancel', { paymentId: second.id, reason: 'Trả nhầm kỳ' });
    expect(await refusalOf(fileOf(o, [second.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_NOT_APPROVED', paymentId: second.id });
    // The account changed in a way the stale trigger did not see (as the change of an entity-limited admin would leave a payment outside their entity): the export's own check is the backstop.
    const o2 = await org(false);
    const acc2 = await addAccount(o2);
    const third = await pay(o2, await invoice(o2));
    await released(o2, third.id);
    await unguarded((c) => c.query("UPDATE crove_finance.supplier_bank_account SET status = 'retired', retired_at = now() WHERE org_id = $1 AND id = $2", [o2.orgId, acc2.id]));
    expect((await payments(o2))[0]?.status).toBe('approved');
    expect(await refusalOf(fileOf(o2, [third.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_ACCOUNT_CHANGED', paymentId: third.id });
    // A voided invoice.
    const o3 = await org(false);
    await addAccount(o3);
    const voidedDoc = await invoice(o3);
    const fourth = await pay(o3, voidedDoc);
    await released(o3, fourth.id);
    await unguarded((c) => c.query("INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'sai hóa đơn')", [o3.orgId, voidedDoc, randomUUID()]));
    expect(await refusalOf(fileOf(o3, [fourth.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_DOCUMENT', paymentId: fourth.id });
    // An amount that is no longer the amount frozen in the approved request.
    const o4 = await org(false);
    await addAccount(o4);
    const fifth = await pay(o4, await invoice(o4));
    await released(o4, fifth.id);
    await unguarded((c) => c.query("UPDATE crove_finance.supplier_payment SET amount = 109 WHERE org_id = $1 AND id = $2", [o4.orgId, fifth.id]));
    expect(await refusalOf(fileOf(o4, [fifth.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_AMOUNT_MISMATCH', paymentId: fifth.id });
    // Two currencies in one file.
    const o5 = await org(false);
    await addAccount(o5);
    const sixth = await pay(o5, await invoice(o5));
    await released(o5, sixth.id);
    const other = await otherSupplier(o5, OTHER, 'Le Van B');
    const { proposalId } = await execute<{ proposalId: string }>(o5, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: other.doc } });
    await approve(o5, proposalId);
    const seventh = (await payments(o5)).find((p) => p.id !== sixth.id) as Payment;
    await released(o5, seventh.id);
    await unguarded((c) => c.query("UPDATE crove_finance.supplier_payment SET currency = 'USD' WHERE org_id = $1 AND id = $2", [o5.orgId, seventh.id]));
    expect((await refusalOf(fileOf(o5, [sixth.id, seventh.id]))).code).toBe('SUPPLIER_PAYMENT_CURRENCY_MIXED');
  });

  it('refuses the whole file, naming the payment, when the supplier key was shredded after the check', async () => {
    const o = await org(false);
    await addAccount(o);
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    // The owner shreds the supplier's key (what the erase command does, which refuses while a payment waits): the sealed values stay in their rows and can never be opened again.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, o.owner, o.orgId);
      await c.query('SELECT crove_kernel.subject_key_shred(ARRAY[$1]::text[])', [`supplier:${o.supplier}`]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await refusalOf(fileOf(o, [first.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_ACCOUNT_ERASED', paymentId: first.id });
  });

  it('writes the audit row of a handed-over file with a count and the currency only, for an owner or an admin', async () => {
    const o = await org(true);
    const before = (await auditRows(o, 'finance.supplier_payment.bank_file.export')).length;
    await execute(o, 'finance.supplier_payment.bank_file.export', { rows: 2, currency: 'VND' }, o.admin as string);
    const rowsAfter = await auditRows(o, 'finance.supplier_payment.bank_file.export');
    expect(rowsAfter.length).toBe(before + 1);
    const text = JSON.stringify(rowsAfter);
    expect(text).toContain('VND');
    expect(await refusal(execute(o, 'finance.supplier_payment.bank_file.export', { rows: 2, currency: 'VND' }, o.member))).toBe('FORBIDDEN');
    expect(await refusal(execute(o, 'finance.supplier_payment.bank_file.export', { rows: 0, currency: 'VND' }))).not.toBe('accepted');
  });
});
