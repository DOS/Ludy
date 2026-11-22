// SPDX-License-Identifier: AGPL-3.0-only
// The received invoices that can be asked for payment (#3113 S4b, #3701), `finance.supplier_payment.payable`, on a real PostgreSQL: an invoice is listed while it is a purchase that is not voided, has an
// amount, has no approved or paid payment and no request waiting for approval (the conditions of finance.supplier_payment.record); each row says whether the supplier has one active account, none or
// several, and the day of a change of its account inside 30 days; owners and admins only; at most 100, oldest first, with `more` when some were left out. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SUPPLIER_PAYABLE_MAX, zSupplierPayableList, type SupplierPayableList } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const NUMBER = '0123 4567 8901';
const HOLDER = 'Nguyen Van Canary';

suite('the received invoices that can be asked for payment (#3113 S4b)', () => {
  const dbName = `crove_test_payable_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; supplier: string };
  // An owner and an admin (four-eyes: the asker never approves), a member and a viewer.
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Công ty Chi ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = [await identity('admin'), await identity('member'), await identity('viewer')];
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]);
    const supplier = await party(orgId, 'Nhà cung cấp thử');
    return { orgId, owner, admin: adminUser, member, viewer, supplier };
  }
  const party = (orgId: string, name: string) => rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', $2) RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.execute<T>(name, input, { actor: user(who), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.query<T>(name, input, { actor: user(who), orgId: o.orgId });
  const addAccount = (o: Org, partyId = o.supplier, number = NUMBER) => execute<{ id: string }>(o, 'finance.supplier_bank_account.add', { partyId, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: number });
  // A received invoice of the supplier with its own entry, as the commands record one.
  async function invoice(o: Org, partyId = o.supplier, total = '110', opts: { direction?: 'purchase' | 'sale'; date?: string } = {}): Promise<string> {
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total, direction) VALUES ($1, $2, $3, $4, $6::date, $5::numeric - 10, 10, $5, $7)", [o.orgId, doc, partyId, `inv-${doc.slice(0, 8)}`, total, opts.date ?? '2026-10-01', opts.direction ?? 'purchase']);
      await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'rule 3 test', 'finance.purchase_document', $3)", [o.orgId, entry, doc]);
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    return doc;
  }
  const ask = (o: Org, doc: string) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } });
  const approve = (o: Org, proposalId: string) => execute(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, o.admin);
  const payable = async (o: Org, who = o.owner): Promise<SupplierPayableList> => zSupplierPayableList.parse(await query<unknown>(o, 'finance.supplier_payment.payable', {}, who));

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

  it('lists a received invoice with its supplier, number, day and amount, the account state and a recent change, and nothing about a bank', async () => {
    const o = await org();
    await addAccount(o);
    const doc = await invoice(o);
    const answer = await payable(o);
    expect(answer.more).toBe(false);
    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({ purchaseDocumentId: doc, partyId: o.supplier, partyName: 'Nhà cung cấp thử', amount: '110', currency: 'VND', account: 'ready' });
    expect(answer.items[0]?.invoiceNumber).toMatch(/^inv-/);
    // The account was added today: a change inside the window.
    expect(answer.items[0]?.accountChangedOn).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    expect(JSON.stringify(answer)).not.toContain(HOLDER);
    expect(JSON.stringify(answer)).not.toContain('0123');
    // A change older than 30 days is not shown.
    await rows("UPDATE crove_finance.supplier_bank_account_change SET changed_at = now() - interval '31 days' WHERE org_id = $1", [o.orgId]);
    expect((await payable(o)).items[0]?.accountChangedOn).toBeNull();
  });

  it('leaves out an invoice with a request waiting or an approved payment, lists it again when the payment is cancelled, and leaves out a sale', async () => {
    const o = await org();
    await addAccount(o);
    const doc = await invoice(o);
    await invoice(o, o.supplier, '110', { direction: 'sale' });
    expect((await payable(o)).items.map((i) => i.purchaseDocumentId)).toEqual([doc]);
    const { proposalId } = await ask(o, doc);
    expect((await payable(o)).items).toEqual([]);
    await approve(o, proposalId);
    expect((await payable(o)).items).toEqual([]);
    const [payment] = await rows<{ id: string }>('SELECT id FROM crove_finance.supplier_payment WHERE org_id = $1', [o.orgId]);
    await execute(o, 'finance.supplier_payment.cancel', { paymentId: payment?.id, reason: 'test' });
    expect((await payable(o)).items.map((i) => i.purchaseDocumentId)).toEqual([doc]);
  });

  it('says a supplier has no account yet, because the request would be refused', async () => {
    const o = await org();
    await invoice(o);
    const [row] = (await payable(o)).items;
    expect(row).toMatchObject({ account: 'none', accountChangedOn: null });
  });

  it('is for owners and admins only, and lists the oldest invoice first', async () => {
    const o = await org();
    await addAccount(o);
    const newer = await invoice(o, o.supplier, '300');
    const older = await invoice(o, o.supplier, '200', { date: '2026-09-01' });
    expect((await payable(o, o.admin)).items.map((i) => i.purchaseDocumentId)).toEqual([older, newer]);
    for (const who of [o.member, o.viewer]) {
      const error = await payable(o, who).then(() => 'answered', (e: { code?: string }) => e.code);
      expect(error).toBe('FORBIDDEN');
    }
    // A member cannot ask for the payment either, through the ordinary request that the button uses.
    const doc = (await payable(o)).items[0]?.purchaseDocumentId;
    const asked = await execute(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } }, o.member).then(() => 'accepted', (e: { code?: string }) => e.code);
    expect(asked).not.toBe('accepted');
  });

  it('shows at most 100, oldest first, and says when more were left out', async () => {
    const o = await org();
    await addAccount(o);
    for (let i = 0; i < SUPPLIER_PAYABLE_MAX + 1; i += 1) await invoice(o);
    const answer = await payable(o);
    expect(answer.items).toHaveLength(SUPPLIER_PAYABLE_MAX);
    expect(answer.more).toBe(true);
  }, 120_000);
});
