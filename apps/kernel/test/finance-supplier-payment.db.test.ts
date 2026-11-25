// SPDX-License-Identifier: AGPL-3.0-only
// A payment to a supplier approved in Ludy (#3113 S2, #3699) on a real PostgreSQL. Ludy moves no money: the request is a proposal (kernel.proposal.request), approved by an owner or an admin with
// four-eyes, and the row records the approved amount and the account the approver saw. What keeps the amount from going to another account is held by the database and judged on its clock: the
// 24-hour hold of a single owner or admin with a new account, `stale` when the supplier's account changes, `paid` only after the hold and only to the pinned account. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a
// superuser URL.
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

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const NUMBER = '0123 4567 8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';

suite('payments to a supplier (#3113 S2)', () => {
  const dbName = `ludy_test_supplier_payment_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const payments = (o: Org) =>
    rows<Payment>('SELECT id, status, payable_after, hold_reason, bank_account_id, amount::text, approved_at, stale_at, paid_at, confirmed_at FROM ludy_finance.supplier_payment WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
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

  it('writes a payment only through an approved proposal, pinning the account the approver saw; the asker never approves while another approver exists', async () => {
    const o = await org(true);
    await addAccount(o);
    const doc = await invoice(o);
    const { proposalId } = await request(o, doc);
    // Four-eyes (P10): the owner asked, the admin is the other eligible approver, so the owner cannot approve.
    expect(await refusal(approve(o, proposalId, o.owner))).toBe('FOUR_EYES_REQUIRED');
    expect(await payments(o)).toEqual([]);
    await approve(o, proposalId, o.admin as string);
    const [paid] = await payments(o);
    expect(paid).toMatchObject({ status: 'approved', amount: '110.0000', payable_after: null, hold_reason: null });
    const pinned = (await rows<{ id: string; number_hash: string }>("SELECT id, number_hash FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0];
    expect(paid?.bank_account_id).toBe(pinned?.id);
    // No number, holder or hash in the payment's audit row or in the list the screen reads.
    const listed = await query<Array<Record<string, unknown>>>(o, 'finance.supplier_payment.list', {});
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(pinned?.number_hash as string);
    expect(JSON.stringify(listed)).not.toContain('012345678901');
    expect(listed[0]).toMatchObject({ status: 'approved', last4: '8901', bankName: 'Vietcombank' });
    // A second payment for the same invoice is refused while one lives, and a member cannot ask.
    expect(await refusal(request(o, doc))).toBe('SUPPLIER_PAYMENT_EXISTS');
    expect(await refusal(request(o, await invoice(o), o.member))).toBe('FORBIDDEN');
  });

  it('refuses a raw write that no approved proposal made, as an owner of the org', async () => {
    const o = await org(false);
    await addAccount(o);
    const doc = await invoice(o);
    const account = (await rows<{ id: string; number_hash: string; hash_key_id: string }>("SELECT id, number_hash, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, o.owner, o.orgId);
      await expect(
        c.query(
          `INSERT INTO ludy_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
           VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now())`,
          [o.orgId, o.supplier, doc, account?.id, account?.number_hash, account?.hash_key_id, randomUUID(), o.owner],
        ),
      ).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await payments(o)).toEqual([]);
  });

  it('holds a single owner or admin to 24 hours for a new account, on the database clock, and never for an older one', async () => {
    const o = await org(false);
    await addAccount(o);
    const doc = await invoice(o);
    const first = await pay(o, doc);
    expect(first.hold_reason).toBe('new_account');
    const heldFor = (first.payable_after as Date).getTime() - first.approved_at.getTime();
    expect(heldFor).toBe(24 * 3_600_000);
    // Not payable before payable_after: the database refuses the move whatever the clock of the application says.
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'paid' WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow(/SUPPLIER_PAYMENT_HELD/);
    // The hold passes (the time of the row arranged as only the database owner can): the move to paid still needs the file handed over and the voucher of the settlement (S3c, finance-supplier-payment-settle
    // tests the paid move and its stamp), so it is refused until then.
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_payment SET payable_after = now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, first.id]));
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'paid' WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow(/SUPPLIER_PAYMENT_NOT_EXPORTED/);
    expect((await payments(o))[0]).toMatchObject({ status: 'approved', paid_at: null });
    // An account older than 30 days: no hold. A second org's invoice, the account's creation time set back as only the database owner can.
    const o2 = await org(false);
    await addAccount(o2);
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_bank_account SET created_at = now() - interval '40 days' WHERE org_id = $1", [o2.orgId]));
    const second = await pay(o2, await invoice(o2));
    expect(second).toMatchObject({ payable_after: null, hold_reason: null });
  });

  it('puts an approved payment to a supplier whose account changes back to needing a new request: stale is final, and the request shows the new account', async () => {
    const o = await org(false);
    const account = await addAccount(o);
    const doc = await invoice(o);
    const first = await pay(o, doc);
    // The owner replaces the account (R3): the payment approved against the old one is stale at once.
    await execute(o, 'finance.supplier_bank_account.replace', { accountId: account.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER });
    const [stale] = await payments(o);
    expect(stale).toMatchObject({ id: first.id, status: 'stale' });
    expect(stale?.stale_at).not.toBeNull();
    // Stale is final: it never goes back to approved, and never to paid.
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'approved', stale_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow();
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'paid' WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow(/SUPPLIER_PAYMENT_STATE/);
    // It can only be asked for again, as a new request that names the new account.
    const again = await pay(o, doc);
    expect(again.id).not.toBe(first.id);
    expect(again.bank_account_id).not.toBe(first.bank_account_id);
    const listed = await query<Array<{ status: string; last4: string }>>(o, 'finance.supplier_payment.list', {});
    expect(listed.map((p) => [p.status, p.last4]).sort()).toEqual([['approved', '6655'], ['stale', '8901']]);
  });

  it('refuses an approval whose account is no longer the one the request showed, and a payment to an account that changed without staling it', async () => {
    const o = await org(false);
    const account = await addAccount(o);
    const doc = await invoice(o);
    const { proposalId } = await request(o, doc);
    await execute(o, 'finance.supplier_bank_account.replace', { accountId: account.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER });
    expect(await refusal(approve(o, proposalId))).toBe('SUPPLIER_PAYMENT_CHANGED');
    expect(await payments(o)).toEqual([]);
    // The backstop of the `paid` move: an account changed in a way the stale trigger did not see (here with the trigger set aside, as an entity-limited admin's change would leave an
    // out-of-scope payment untouched) is still refused at payment: the pinned account must be the active one with the same hash.
    const o2 = await org(false);
    const first = await addAccount(o2);
    const approved = await pay(o2, await invoice(o2));
    await unguarded(async (c) => {
      await c.query("UPDATE ludy_finance.supplier_bank_account SET status = 'retired', retired_at = now() WHERE org_id = $1 AND id = $2", [o2.orgId, first.id]);
      await c.query("UPDATE ludy_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2", [o2.orgId, approved.id]);
    });
    expect((await payments(o2))[0]?.status).toBe('approved');
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'paid' WHERE org_id = $1 AND id = $2", [o2.orgId, approved.id])).rejects.toThrow(/SUPPLIER_PAYMENT_ACCOUNT_CHANGED/);
  });

  it('records that the supplier confirmed the account once, as evidence only: the hold stays', async () => {
    const o = await org(false);
    await addAccount(o);
    const first = await pay(o, await invoice(o));
    expect(await refusal(execute(o, 'finance.supplier_payment.confirm_account', { paymentId: first.id, channel: 'phone_on_file' }, o.owner, false))).toBe('STEP_UP_REQUIRED');
    expect(await refusal(execute(o, 'finance.supplier_payment.confirm_account', { paymentId: first.id, channel: 'phone_on_file' }, o.member))).toBe('FORBIDDEN');
    const confirmed = await execute<{ confirmedChannel: string; payableAfter: string | null }>(o, 'finance.supplier_payment.confirm_account', { paymentId: first.id, channel: 'phone_on_file' });
    expect(confirmed.confirmedChannel).toBe('phone_on_file');
    // The marker does not shorten the hold: payable_after is what it was.
    expect(new Date(confirmed.payableAfter as string).getTime()).toBe((first.payable_after as Date).getTime());
    expect(await refusal(execute(o, 'finance.supplier_payment.confirm_account', { paymentId: first.id, channel: 'in_person' }))).toBe('SUPPLIER_PAYMENT_ALREADY_CONFIRMED');
  });

  it('cancels an approved payment, which frees its invoice to be asked for again; a cancelled payment is final', async () => {
    const o = await org(false);
    await addAccount(o);
    const doc = await invoice(o);
    const first = await pay(o, doc);
    const cancelled = await execute<{ status: string; cancelledAt: string }>(o, 'finance.supplier_payment.cancel', { paymentId: first.id, reason: 'Trả nhầm kỳ' });
    expect(cancelled.status).toBe('cancelled');
    expect(await refusal(execute(o, 'finance.supplier_payment.cancel', { paymentId: first.id, reason: 'again' }))).toBe('SUPPLIER_PAYMENT_NOT_APPROVED');
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'approved', cancelled_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow();
    const second = await pay(o, doc);
    expect(second.id).not.toBe(first.id);
  });

  it('asks only for what can be paid: an invoice of the org with a supplier that has one active account, one request at a time', async () => {
    const o = await org(false);
    const doc = await invoice(o);
    expect(await refusal(request(o, doc))).toBe('SUPPLIER_PAYMENT_NO_ACCOUNT');
    const account = await addAccount(o);
    await execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER });
    expect(await refusal(request(o, doc))).toBe('SUPPLIER_PAYMENT_ACCOUNT_AMBIGUOUS');
    await execute(o, 'finance.supplier_bank_account.retire', { accountId: account.id });
    expect(await refusal(request(o, randomUUID()))).toBe('SUPPLIER_PAYMENT_INVOICE_NOT_FOUND');
    await request(o, doc);
    expect(await refusal(request(o, doc))).toBe('SUPPLIER_PAYMENT_PENDING');
  });

  // A payment row the database judges by its guard, written by the superuser (staff: the proposal check does not apply) so the proposal's authors are the test's to arrange.
  async function insertPayment(o: Org, doc: string, approver: string, authors: string[]): Promise<{ hold_reason: string | null; payable_after: Date | null; approved_at: Date }> {
    const account = (await rows<{ id: string; number_hash: string; hash_key_id: string }>("SELECT id, number_hash, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0];
    const proposal = randomUUID();
    await unguarded((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, id, kind, command, status, title, payload, authors, eligible_approvers)
         VALUES ($1, $2, 'finance.supplier_payment', 'finance.supplier_payment.record', 'approved', 'Chi nhà cung cấp', '{}'::jsonb, $3::jsonb, $4::uuid[])`,
        [o.orgId, proposal, JSON.stringify(authors.map((id) => ({ type: 'user', id }))), [o.owner, ...(o.admin ? [o.admin] : [])]],
      ),
    );
    const inserted = await rows<{ hold_reason: string | null; payable_after: Date | null; approved_at: Date }>(
      `INSERT INTO ludy_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
       VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason, payable_after, approved_at`,
      [o.orgId, o.supplier, doc, account?.id, account?.number_hash, account?.hash_key_id, proposal, approver],
    );
    return inserted[0] as { hold_reason: string | null; payable_after: Date | null; approved_at: Date };
  }

  it('holds a payment its approver wrote as well, however many people could approve it (N1 of the review of #3759)', async () => {
    const o = await org(true);
    await addAccount(o);
    // The owner is the requester and approves their own request (the owner override, which two people who could approve do not rule out): the hold applies as on the one-person path.
    const own = await insertPayment(o, await invoice(o), o.owner, [o.owner]);
    expect(own.hold_reason).toBe('new_account');
    expect((own.payable_after as Date).getTime() - own.approved_at.getTime()).toBe(24 * 3_600_000);
    // A second person approving the owner's request: no hold, as before.
    const other = await insertPayment(o, await invoice(o), o.admin as string, [o.owner]);
    expect(other).toMatchObject({ hold_reason: null, payable_after: null });
    // The comparison is of ids as written, whatever their case.
    const upper = await insertPayment(o, await invoice(o), o.owner, [o.owner.toUpperCase()]);
    expect(upper.hold_reason).toBe('new_account');
    // An approver among the co-authors is no more independent than the requester.
    const doc = await invoice(o);
    const proposal = randomUUID();
    await unguarded((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, id, kind, command, status, title, payload, authors, eligible_approvers, co_authors)
         VALUES ($1, $2, 'finance.supplier_payment', 'finance.supplier_payment.record', 'approved', 'Chi nhà cung cấp', '{}'::jsonb, $3::jsonb, $4::uuid[], $5::uuid[])`,
        [o.orgId, proposal, JSON.stringify([{ type: 'user', id: o.member }]), [o.owner, o.admin], [o.admin]],
      ),
    );
    const account = (await rows<{ id: string; number_hash: string; hash_key_id: string }>("SELECT id, number_hash, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0];
    const co = await rows<{ hold_reason: string | null }>(
      `INSERT INTO ludy_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
       VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason`,
      [o.orgId, o.supplier, doc, account?.id, account?.number_hash, account?.hash_key_id, proposal, o.admin],
    );
    expect(co[0]?.hold_reason).toBe('new_account');
    // An old account is never held, self-approved or not.
    const o2 = await org(true);
    await addAccount(o2);
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_bank_account SET created_at = now() - interval '40 days' WHERE org_id = $1", [o2.orgId]));
    expect(await insertPayment(o2, await invoice(o2), o2.owner, [o2.owner])).toMatchObject({ hold_reason: null, payable_after: null });
  });

  it('refuses an invoice that is voided, at the approval and at the move to paid, not only in the command (N3 of the review of #3759)', async () => {
    const o = await org(false);
    await addAccount(o);
    const voided = await invoice(o);
    // The void row stands for the reversal of the invoice's entry (the real command posts it; a row of its own, the reversal entry aside, is the test's to arrange).
    const voidInvoice = (doc: string) =>
      unguarded((c) => c.query("INSERT INTO ludy_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'sai hóa đơn')", [o.orgId, doc, randomUUID()]));
    await voidInvoice(voided);
    await expect(insertPayment(o, voided, o.owner, [o.owner])).rejects.toThrow(/SUPPLIER_PAYMENT_DOCUMENT/);
    // An approved payment whose invoice is voided afterwards is not paid, hold or no hold.
    const doc = await invoice(o);
    const first = await pay(o, doc);
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2", [o.orgId, first.id]));
    await voidInvoice(doc);
    await expect(rows("UPDATE ludy_finance.supplier_payment SET status = 'paid' WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow(/SUPPLIER_PAYMENT_DOCUMENT/);
    expect((await payments(o)).find((p) => p.id === first.id)?.status).toBe('approved');
  });

  it('stamps the time the supplier was confirmed by the database clock (N4 of the review of #3759)', async () => {
    const o = await org(false);
    await addAccount(o);
    const first = await pay(o, await invoice(o));
    await execute(o, 'finance.supplier_payment.confirm_account', { paymentId: first.id, channel: 'in_person' });
    const [row] = await rows<{ confirmed_at: Date; created_at: Date }>('SELECT confirmed_at, now() AS created_at FROM ludy_finance.supplier_payment WHERE org_id = $1 AND id = $2', [o.orgId, first.id]);
    // Set in the transaction of the command, by the database: never after the moment of this later read, and after the approval.
    expect((row as { confirmed_at: Date }).confirmed_at.getTime()).toBeLessThanOrEqual((row as { created_at: Date }).created_at.getTime());
    expect((row as { confirmed_at: Date }).confirmed_at.getTime()).toBeGreaterThanOrEqual(first.approved_at.getTime());
    // A raw write cannot move it, as before.
    await expect(rows("UPDATE ludy_finance.supplier_payment SET confirmed_at = now() - interval '2 days' WHERE org_id = $1 AND id = $2", [o.orgId, first.id])).rejects.toThrow(/SUPPLIER_PAYMENT_STATE/);
  });

  it('counts the suppliers with a payment waiting (a request not yet decided, then an approved one), as ids, a count and an amount only, and refuses to erase their bank data meanwhile', async () => {
    const o = await org(false);
    await addAccount(o);
    const doc = await invoice(o);
    const { proposalId } = await request(o, doc);
    const waiting = await query<Array<{ partyId: string; count: number; amount: string }>>(o, 'finance.signals.supplier_payments_waiting', { partyIds: [o.supplier] }, o.member);
    expect(waiting).toEqual([{ partyId: o.supplier, count: 1, amount: '110' }]);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }))).toBe('SUPPLIER_PAYMENT_WAITING');
    await approve(o, proposalId);
    expect(await query(o, 'finance.signals.supplier_payments_waiting', { partyIds: [o.supplier] }, o.member)).toEqual([{ partyId: o.supplier, count: 1, amount: '110' }]);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }))).toBe('SUPPLIER_PAYMENT_WAITING');
    expect(JSON.stringify(waiting)).not.toContain('012345678901');
  });
});
