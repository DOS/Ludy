// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of approved supplier payments (#3113 S3, #3700) on a real PostgreSQL: `finance.supplier_payment.bank_file.get` opens the sealed holder and number of each payment's pinned account for an
// owner or an admin with a fresh second factor, after its audit row, and refuses the whole file, naming the payment, for one it cannot carry. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const NUMBER = '0123 4567 8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';

// The keys and the leaf values of a JSON value, so an amount is looked for as a value or a key and never as digits inside a random id or a timestamp.
function keysAndLeaves(value: unknown, keys: string[] = [], leaves: unknown[] = []): { keys: string[]; leaves: unknown[] } {
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      keysAndLeaves(inner, keys, leaves);
    }
  } else {
    leaves.push(value);
  }
  return { keys, leaves };
}
const expectNoAmount = (value: unknown, amounts: readonly string[]) => {
  const { keys, leaves } = keysAndLeaves(value);
  for (const amount of amounts) expect(leaves).not.toContain(amount);
  for (const amount of amounts) expect(leaves).not.toContain(Number(amount));
  expect(keys.filter((k) => ['amount', 'total'].includes(k))).toEqual([]);
};

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
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
      if (adminUser) await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]);
    });
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thử')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, member, supplier };
  }
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true) => rt.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey: randomUUID() });
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

  type BankFile = { currency: string; rows: Array<{ seq: string; holder: string; account: string; bank: string; amount: string; content: string }>; total: string };
  const fileOf = (o: Org, ids: string[], who = o.owner, fresh = true) => rt.query<BankFile>('finance.supplier_payment.bank_file.get', { paymentIds: ids }, { actor: user(who, fresh), orgId: o.orgId });
  const refusalOf = async (promise: Promise<unknown>) => promise.then(() => ({ code: 'accepted', paymentId: undefined as string | undefined }), (error: { code?: string; details?: { paymentId?: string } }) => ({ code: error.code, paymentId: error.details?.paymentId }));
  // The hold passed (arranged as only the database owner can), so the payment is one a file may carry.
  const released = (o: Org, id: string) => unguarded((c) => c.query('UPDATE crove_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2', [o.orgId, id]));
  const auditRows = (o: Org, command: string) => rows<{ detail: unknown; facts: unknown }>('SELECT to_jsonb(a) - \'org_id\' AS detail, to_jsonb(a) AS facts FROM ludy_kernel.audit_event a WHERE a.org_id = $1 AND a.command = $2', [o.orgId, command]);
  // A second supplier of the org with its own account and a received invoice.
  async function otherSupplier(o: Org, number: string, holder: string, total = '220'): Promise<{ party: string; doc: string }> {
    const party = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thứ hai')", [o.orgId, party]));
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
    for (const secret of ['012345678901', HOLDER, 'Canary', OTHER]) expect(text).not.toContain(secret);
    // The amounts are short digit strings, so a substring check would match inside a random id or a timestamp (".110Z"): walk the leaf values and the keys instead (#3779).
    const leaves: unknown[] = [];
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      } else leaves.push(value);
    };
    walk(audit);
    expect(leaves.length).toBeGreaterThan(0);
    for (const amount of ['330', '110', 330, 110]) expect(leaves).not.toContain(amount);
    for (const key of ['amount', 'total']) expect(keys).not.toContain(key);
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
      await c.query('SELECT ludy_kernel.subject_key_shred(ARRAY[$1]::text[])', [`supplier:${o.supplier}`]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await refusalOf(fileOf(o, [first.id]))).toEqual({ code: 'SUPPLIER_PAYMENT_ACCOUNT_ERASED', paymentId: first.id });
  });

  const exportOf = (o: Org, ids: string[], extra: { reexport?: boolean } = {}, who: string = o.owner) =>
    execute(o, 'finance.supplier_payment.bank_file.export', { paymentIds: ids, rows: ids.length, currency: 'VND', ...extra }, who);
  const markers = (o: Org, id: string) => rows<{ exported_at: Date | null; exported_by: string | null; export_count: number }>('SELECT exported_at, exported_by, export_count FROM crove_finance.supplier_payment WHERE org_id = $1 AND id = $2', [o.orgId, id]).then((r) => r[0]);

  it('marks each payment and writes the audit row of a handed-over file in one step, with a count and the currency only, for an owner or an admin', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    expect(await markers(o, first.id)).toMatchObject({ exported_at: null, exported_by: null, export_count: 0 });
    const before = (await auditRows(o, 'finance.supplier_payment.bank_file.export')).length;
    await exportOf(o, [first.id], {}, o.admin as string);
    const rowsAfter = await auditRows(o, 'finance.supplier_payment.bank_file.export');
    expect(rowsAfter.length).toBe(before + 1);
    const text = JSON.stringify(rowsAfter);
    expect(text).toContain('VND');
    for (const secret of ['012345678901', HOLDER]) expect(text).not.toContain(secret);
    expectNoAmount(rowsAfter, ['110']);
    const marked = await markers(o, first.id);
    expect(marked?.export_count).toBe(1);
    expect(marked?.exported_by).toBe(o.admin);
    expect(marked?.exported_at).not.toBeNull();
    expect(await refusal(exportOf(o, [first.id], { reexport: true }, o.member))).toBe('FORBIDDEN');
    expect(await refusal(execute(o, 'finance.supplier_payment.bank_file.export', { paymentIds: [first.id], rows: 0, currency: 'VND' }))).not.toBe('accepted');
  });

  it('refuses a second file for a payment already handed over unless the caller confirms it, and says so in the audit row', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    await exportOf(o, [first.id]);
    const firstAt = (await markers(o, first.id))?.exported_at as Date;
    // The query names the payment and the time of the first file.
    const asked = await fileOf(o, [first.id]).then(
      () => null,
      (error: { code?: string; details?: { paymentId?: string; exportedAt?: string } }) => error,
    );
    expect(asked?.code).toBe('SUPPLIER_PAYMENT_ALREADY_EXPORTED');
    expect(asked?.details?.paymentId).toBe(first.id);
    expect(new Date(asked?.details?.exportedAt as string).getTime()).toBe(firstAt.getTime());
    // The command refuses too (a request that skipped the query): the refusal is audited as a denied row, but no hand-over row (the ones that carry the currency) is written and the count stays.
    const handed = async () => (await auditRows(o, 'finance.supplier_payment.bank_file.export')).filter((r) => JSON.stringify(r).includes('"currency"')).length;
    const rowsBefore = await handed();
    expect(await refusal(exportOf(o, [first.id]))).toBe('SUPPLIER_PAYMENT_ALREADY_EXPORTED');
    expect(await handed()).toBe(rowsBefore);
    expect((await markers(o, first.id))?.export_count).toBe(1);
    // Confirmed: the file is made, the count grows and the audit row says it was a second file.
    const again = await rt.query<BankFile>('finance.supplier_payment.bank_file.get', { paymentIds: [first.id], reexport: true }, { actor: user(o.owner), orgId: o.orgId });
    expect(again.rows).toHaveLength(1);
    await exportOf(o, [first.id], { reexport: true });
    expect((await markers(o, first.id))?.export_count).toBe(2);
    expect(await handed()).toBe(rowsBefore + 1);
    const audit = (await auditRows(o, 'finance.supplier_payment.bank_file.export')).filter((r) => JSON.stringify(r).includes('"currency"'));
    // One row says it was the first file, one that it was confirmed again, and both name the payment (its id only).
    const details = audit.map((r) => (r.facts as { detail: { rows: number; currency: string; reexport: boolean; paymentIds: string[]; again: string[] } }).detail);
    expect(details.map((d) => d.paymentIds)).toEqual([[first.id], [first.id]]);
    expect(details.find((d) => !d.reexport)?.again).toEqual([]);
    expect(details.find((d) => d.reexport)).toMatchObject({ rows: 1, currency: 'VND', again: [first.id] });
  });

  it('lets only one of two racing requests hand a payment over for the first time, and refuses a payment that is no longer approved', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const first = await pay(o, await invoice(o));
    await released(o, first.id);
    const results = await Promise.all([refusal(exportOf(o, [first.id])), refusal(exportOf(o, [first.id]))]);
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'SUPPLIER_PAYMENT_ALREADY_EXPORTED')).toHaveLength(1);
    expect((await markers(o, first.id))?.export_count).toBe(1);
    // A payment that was cancelled is not marked, even with the confirmation.
    await execute(o, 'finance.supplier_payment.cancel', { paymentId: first.id, reason: 'test' });
    expect(await refusal(exportOf(o, [first.id], { reexport: true }))).toBe('SUPPLIER_PAYMENT_NOT_APPROVED');
    expect((await markers(o, first.id))?.export_count).toBe(1);
  });

  it('keeps the marker in the database: the count grows by one, the time is the database clock, and nothing else moves it', async () => {
    const o = await org(true);
    await addAccount(o, NUMBER);
    const first = await pay(o, await invoice(o));
    const touch = (set: string) => admin((c) => c.query(`UPDATE crove_finance.supplier_payment SET ${set} WHERE org_id = $1 AND id = $2`, [o.orgId, first.id]));
    await expect(touch('export_count = 5')).rejects.toThrow(/SUPPLIER_PAYMENT_STATE|supplier_payment_export_ck/);
    await expect(touch("exported_at = '2020-01-01'")).rejects.toThrow(/SUPPLIER_PAYMENT_STATE|supplier_payment_export_ck/);
    await expect(touch(`export_count = 1`)).rejects.toThrow(/SUPPLIER_PAYMENT_STATE/);
    await touch(`export_count = 1, exported_by = '${o.owner}', exported_at = '2020-01-01'`);
    const marked = await markers(o, first.id);
    expect(marked?.export_count).toBe(1);
    // Stamped by the database clock, never by what the writer sent.
    expect((marked as { exported_at: Date }).exported_at.getFullYear()).toBeGreaterThanOrEqual(2026);
    await expect(touch('export_count = 3')).rejects.toThrow(/SUPPLIER_PAYMENT_STATE/);
    await expect(touch('export_count = 0')).rejects.toThrow(/SUPPLIER_PAYMENT_STATE|supplier_payment_export_ck/);
  });

  it('refuses the hand-over without a fresh second factor, for a held payment and for a payment whose invoice was voided after the read', async () => {
    const o = await org(false);
    await addAccount(o, NUMBER);
    const held = await pay(o, await invoice(o));
    // Still in its 24 hour hold (a new account, one owner): the command refuses it even though a caller skipped the query.
    expect(await refusal(exportOf(o, [held.id]))).toBe('SUPPLIER_PAYMENT_HELD');
    await released(o, held.id);
    expect(await refusal(execute(o, 'finance.supplier_payment.bank_file.export', { paymentIds: [held.id], rows: 1, currency: 'VND' }, o.owner, false))).toBe('STEP_UP_REQUIRED');
    expect((await markers(o, held.id))?.export_count).toBe(0);
    await unguarded((c) => c.query("INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, voided_by, reason) SELECT org_id, purchase_document_id, gen_random_uuid(), $3, 'test' FROM crove_finance.supplier_payment WHERE org_id = $1 AND id = $2", [o.orgId, held.id, o.owner]));
    expect(await refusal(exportOf(o, [held.id]))).toBe('SUPPLIER_PAYMENT_DOCUMENT');
    expect((await markers(o, held.id))?.export_count).toBe(0);
  });
});
