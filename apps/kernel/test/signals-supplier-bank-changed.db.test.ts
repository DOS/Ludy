// SPDX-License-Identifier: AGPL-3.0-only
// Rule 3 of V5 end to end (#3113 S4, #3701), on a real PostgreSQL: a supplier's bank account changed while a payment waits. The kernel's rule `kernel.signals.supplier_bank_changed` joins two finance reads,
// `finance.signals.supplier_bank_changes` (suppliers whose account changed in the last 30 days) and `finance.signals.supplier_payments_waiting` (asked with those suppliers: how many payments wait and
// their total, an approved payment not yet paid or a payment asked for and not yet approved). It flags with severity `block` when both hold, stays quiet when no payment waits or the change is older than
// the window, and says it could not check (never an empty "all clear") when the caller sees only part of the books. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE, zFinanceSupplierPaymentsWaitingSignals } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const NUMBER = '0123 4567 8901';
const HOLDER = 'Nguyen Van Canary';
const RULE = 'kernel.signals.supplier_bank_changed';

type Item = { id: string; kind: string; severity: string; count?: number; amount?: string; currency?: string; title: { key: string; params?: Record<string, unknown> } };

suite('rule 3: a supplier bank account changed while a payment waits (#3113 S4)', () => {
  const dbName = `crove_test_rule3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const hashRoot = { id: 'k-test-1', key: randomBytes(32) };
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@rule3.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; branchMember: string; supplier: string };
  // An owner and an admin (four-eyes: the asker never approves), a member, a viewer and a member limited to a branch (a partial view of the books).
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Công ty Chi ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer, branchMember] = [await identity('admin'), await identity('member'), await identity('viewer'), await identity('branch')];
    const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')", [orgId, adminUser, member, viewer, branchMember]);
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const supplier = await party(orgId, 'Nhà cung cấp thử');
    return { orgId, owner, admin: adminUser, member, viewer, branchMember, supplier };
  }
  const party = (orgId: string, name: string) => rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', $2) RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.execute<T>(name, input, { actor: user(who), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.query<T>(name, input, { actor: user(who), orgId: o.orgId });
  const addAccount = (o: Org, partyId = o.supplier, number = NUMBER) => execute<{ id: string }>(o, 'finance.supplier_bank_account.add', { partyId, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: number });
  // A received invoice of the supplier with its own entry, as the commands record one.
  async function invoice(o: Org, partyId = o.supplier, total = '110'): Promise<string> {
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', $5::numeric - 10, 10, $5)", [o.orgId, doc, partyId, `inv-${doc.slice(0, 8)}`, total]);
      await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'rule 3 test', 'finance.purchase_document', $3)", [o.orgId, entry, doc]);
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    return doc;
  }
  const ask = (o: Org, doc: string) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } });
  const approve = (o: Org, proposalId: string) => execute(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, o.admin);
  const rule = (o: Org, who = o.owner) => query<Item[]>(o, RULE, {}, who);
  const waiting = (o: Org, partyIds: string[], who = o.owner) => query<unknown>(o, 'finance.signals.supplier_payments_waiting', { partyIds }, who);

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

  it('blocks when the account changed and a payment waits for approval, then when it is approved and not paid, never with a number or a name', async () => {
    const o = await org();
    await addAccount(o);
    // The account was added today and nothing waits: quiet, and the rule could look.
    expect(await rule(o)).toEqual([]);
    const { proposalId } = await ask(o, await invoice(o));
    const [flag] = await rule(o);
    // A real flag for the supplier, not the "could not check" item (which is what ludy_signals reports as `unchecked`).
    expect(flag?.id).not.toBe('signal:supplier-bank-changed:unchecked');
    expect(flag).toMatchObject({ id: `signal:supplier-bank-changed:${o.supplier}`, kind: 'flag', severity: 'block', count: 1, amount: '110', currency: 'VND', title: { key: 'signals.supplierBankChanged', params: { days: 0, count: 1 } } });
    expect(JSON.stringify(flag)).not.toContain(HOLDER);
    expect(JSON.stringify(flag)).not.toContain('0123');
    // Approved and not yet paid still waits.
    await approve(o, proposalId);
    expect((await rule(o))[0]).toMatchObject({ severity: 'block', count: 1, amount: '110' });
    // A second invoice of the same supplier adds to the same flag (one item per supplier).
    await ask(o, await invoice(o, o.supplier, '200'));
    const items = await rule(o);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 2, amount: '310' });
  });

  it('asks the payments read per supplier: the contract shape, the asked suppliers only, no other supplier\'s payment', async () => {
    const o = await org();
    const other = await party(o.orgId, 'Nhà cung cấp khác');
    await addAccount(o);
    await addAccount(o, other, '5544332211');
    await ask(o, await invoice(o));
    const answer = zFinanceSupplierPaymentsWaitingSignals.parse(await waiting(o, [o.supplier, other]));
    expect(answer).toEqual([{ partyId: o.supplier, count: 1, amount: '110' }]);
    expect(await waiting(o, [other])).toEqual([]);
  });

  it('counts a supplier and its duplicate as one: one row for the kept party when both are asked, one row for the asked one when only a duplicate is', async () => {
    const o = await org();
    const duplicate = await party(o.orgId, 'Nhà cung cấp trùng');
    await rows('UPDATE ludy_kernel.party SET duplicate_of = $2 WHERE org_id = $1 AND id = $3', [o.orgId, o.supplier, duplicate]);
    await addAccount(o);
    await addAccount(o, duplicate, '5544332211');
    await ask(o, await invoice(o));
    await ask(o, await invoice(o, duplicate, '200'));
    expect(await waiting(o, [duplicate, o.supplier])).toEqual([{ partyId: o.supplier, count: 2, amount: '310' }]);
    expect(await waiting(o, [duplicate])).toEqual([{ partyId: duplicate, count: 2, amount: '310' }]);
  });

  it('keeps a pending amount of the largest size the request allows (16 integer digits) instead of reading it as 0', async () => {
    const o = await org();
    await addAccount(o);
    await ask(o, await invoice(o, o.supplier, '1000000000000000'));
    expect(await waiting(o, [o.supplier])).toEqual([{ partyId: o.supplier, count: 1, amount: '1000000000000000' }]);
  });

  it('is quiet when nothing waits, when the waiting payment is another supplier\'s, and when the change is older than 30 days', async () => {
    const o = await org();
    const other = await party(o.orgId, 'Nhà cung cấp khác');
    await addAccount(o);
    await addAccount(o, other, '5544332211');
    // Another supplier has a payment waiting; this supplier changed its account but has none.
    await ask(o, await invoice(o, other));
    const items = await rule(o);
    expect(items.map((i) => i.id)).toEqual([`signal:supplier-bank-changed:${other}`]);
    // The change of the second supplier is 31 days old: outside the window, so it no longer flags.
    await rows("UPDATE crove_finance.supplier_bank_account_change SET changed_at = now() - interval '31 days' WHERE org_id = $1 AND party_id = $2", [o.orgId, other]);
    expect(await rule(o)).toEqual([]);
  });

  it('says it could not check for a caller who sees only part of the books, never an empty answer, and refuses the payments read with SIGNAL_PARTIAL_VIEW', async () => {
    const o = await org();
    await addAccount(o);
    await ask(o, await invoice(o));
    const refusal = await waiting(o, [o.supplier], o.branchMember).then(() => 'answered', (error: { code?: string }) => error.code);
    expect(refusal).toBe(SIGNAL_PARTIAL_VIEW_CODE);
    const items = await rule(o, o.branchMember);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'signal:supplier-bank-changed:unchecked', severity: 'warn', count: 1, title: { key: 'signals.supplierBankChangedUnchecked' } });
    // A viewer and a member who see the whole org get the same flag as the owner.
    for (const who of [o.member, o.viewer]) expect((await rule(o, who))[0]).toMatchObject({ severity: 'block', count: 1 });
  });
});
