// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (#3770, follow-up of #3768): fail closed in ludy_finance.supplier_payment_guard()
// when a non-staff insert names a proposal that is not found or cannot be read by the writer.
// Guarantees that even when b_supplier_payment_proposal is absent or disabled:
//   - non-staff callers (ludy_app owner/admin and ludy_worker system context) fail closed with
//     42501 SUPPLIER_PAYMENT_PROPOSAL when NEW.proposal_id does not exist or belongs to another org;
//   - staff (database owner / support / migration paths per effect_proposal_staff) keep the count rule
//     alone when no proposal row exists, while still enforcing self-approval holds on real proposals.
// Part of the invariant suite: self-contained under apps/kernel/test/invariant/ (imports only packages under test and local fixtures).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { enterUser } from './fixtures/context-token.ts';
import {
  createDbClient,
  createDbPool,
  createRawPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const NUMBER = '0123 4567 8901';
const HOLDER = 'Nguyen Van Canary';

describe.skipIf(!ADMIN)('supplier_payment_guard fail-closed proposal lookup (#3770)', () => {
  const dbName = `ludy_test_supplier_pay_guard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers;
  let adminClient: pg.Client;
  let appPool: pg.Pool;
  let runtimePool: pg.Pool;
  let workerUrl = '';
  let db: Db;
  let rt: Runtime;

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const hashRoot = { id: 'k-inv-3770', key: randomBytes(32) };
  const user = (userId: string, fresh = true) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    mfaAt: fresh ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) - 3600,
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, values)).rows);

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

  const identity = (name: string) =>
    upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@inv3770.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string | null; supplier: string };
  async function org(twoApprovers: boolean): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Cong ty Guard ${randomUUID().slice(0, 6)}`);
    const adminUser = twoApprovers ? await identity('admin') : null;
    if (adminUser) {
      await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    }
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nha cung cap 3770')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, supplier };
  }

  const addAccount = (o: Org) =>
    rt.execute<{ id: string; last4: string }>(
      'finance.supplier_bank_account.add',
      { partyId: o.supplier, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: NUMBER },
      { actor: user(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );

  async function invoice(o: Org, total = '110'): Promise<string> {
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', $5::numeric - 10, 10, $5)",
        [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`, total],
      );
      await c.query(
        "INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'guard test', 'finance.purchase_document', $3)",
        [o.orgId, entry, doc],
      );
      await c.query(
        "INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)",
        [o.orgId, entry],
      );
      await c.query('COMMIT');
    });
    return doc;
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const app = new URL(adminUrl);
    app.username = dbIds.roleName('crove_app');
    app.password = 'test-app-pw';
    const worker = new URL(adminUrl);
    worker.username = dbIds.roleName('crove_worker');
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();

    adminClient = createDbClient({ connectionString: adminUrl }, dbIds);
    await adminClient.connect();
    appPool = createRawPool({ connectionString: app.toString(), max: 4 }, dbIds);
    runtimePool = createDbPool({ connectionString: app.toString(), max: 4 });

    db = createDb(runtimePool);
    const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, subjectVault, keyedHashRoots: [hashRoot] }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    await runtimePool?.end().catch(() => undefined);
    await adminClient?.end().catch(() => undefined);
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  it('refuses non-staff inserts in supplier_payment_guard when the proposal is unknown or unreadable even with b_supplier_payment_proposal disabled, while staff keeps the count rule', async () => {
    const o = await org(true);
    await addAccount(o);
    const doc1 = await invoice(o);
    const doc1Extra = await invoice(o);
    const account1 = (
      await rows<{ id: string; number_hash: string; hash_key_id: string }>(
        "SELECT id, number_hash, hash_key_id FROM crove_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'",
        [o.orgId],
      )
    )[0];
    expect(account1).toBeDefined();
    const accountId1 = account1?.id as string;
    const numberHash1 = account1?.number_hash as string;
    const hashKeyId1 = account1?.hash_key_id as string;

    const o2 = await org(false);
    await addAccount(o2);
    const doc2 = await invoice(o2);
    const account2 = (
      await rows<{ id: string; number_hash: string; hash_key_id: string }>(
        "SELECT id, number_hash, hash_key_id FROM crove_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'",
        [o2.orgId],
      )
    )[0];
    expect(account2).toBeDefined();
    const accountId2 = account2?.id as string;
    const numberHash2 = account2?.number_hash as string;
    const hashKeyId2 = account2?.hash_key_id as string;

    // Seed an approved proposal in o (readable by o's owner/admin) and one in o2 (unreadable from o's context even though o.owner is in authors).
    const ownOrgProposal = randomUUID();
    const otherOrgProposal = randomUUID();
    await unguarded(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, status, title, payload, authors, eligible_approvers, legal_entity_id)
         VALUES ($1, $2, 'finance.supplier_payment', 'finance.supplier_payment.record', 'approved', 'Chi nha cung cap', '{}'::jsonb, $3::jsonb, $4::uuid[],
                 (SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default))`,
        [o.orgId, ownOrgProposal, JSON.stringify([{ type: 'user', id: o.admin }]), [o.owner, o.admin]],
      );
      await c.query(
        `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, status, title, payload, authors, eligible_approvers, legal_entity_id)
         VALUES ($1, $2, 'finance.supplier_payment', 'finance.supplier_payment.record', 'approved', 'Chi nha cung cap', '{}'::jsonb, $3::jsonb, $4::uuid[],
                 (SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default))`,
        [o2.orgId, otherOrgProposal, JSON.stringify([{ type: 'user', id: o.owner }]), [o2.owner]],
      );
    });

    const insertAsApp = async (who: string, proposalId: string, commit = true) => {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who, o.orgId);
        const res = await c.query<{ hold_reason: string | null; payable_after: Date | null }>(
          `INSERT INTO crove_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
           VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason, payable_after`,
          [o.orgId, o.supplier, doc1, accountId1, numberHash1, hashKeyId1, proposalId, who],
        );
        if (commit) await c.query('COMMIT');
        else await c.query('ROLLBACK');
        return res.rows[0];
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };

    const insertAsWorker = async (proposalId: string) => {
      const wc = createDbClient({ connectionString: workerUrl }, dbIds);
      await wc.connect();
      try {
        await wc.query('BEGIN');
        await wc.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
        await wc.query(
          `INSERT INTO crove_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
           VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now())`,
          [o.orgId, o.supplier, doc1, accountId1, numberHash1, hashKeyId1, proposalId, o.owner],
        );
        await wc.query('COMMIT');
      } finally {
        await wc.query('ROLLBACK').catch(() => undefined);
        await wc.end();
      }
    };

    // Disable b_supplier_payment_proposal to exercise c_supplier_payment_guard (supplier_payment_guard) directly as defence in depth.
    await admin((c) => c.query('ALTER TABLE crove_finance.supplier_payment DISABLE TRIGGER b_supplier_payment_proposal'));
    try {
      // Positive control (rolled back): when the proposal IS readable in o, supplier_bank_account FOR SHARE, purchase_document, and the guard all pass.
      const readable = await insertAsApp(o.owner, ownOrgProposal, false);
      expect(readable).toEqual({ hold_reason: null, payable_after: null });

      // Non-staff owner and admin contexts fail closed when proposal_id is nonexistent or belongs to another org.
      await expect(insertAsApp(o.owner, randomUUID())).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });
      await expect(insertAsApp(o.owner, otherOrgProposal)).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });
      await expect(insertAsApp(o.admin as string, randomUUID())).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });
      await expect(insertAsApp(o.admin as string, otherOrgProposal)).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });

      // Non-staff worker system context also fails closed when proposal_id is nonexistent or unreadable.
      await expect(insertAsWorker(randomUUID())).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });
      await expect(insertAsWorker(otherOrgProposal)).rejects.toMatchObject({ code: '42501', message: 'SUPPLIER_PAYMENT_PROPOSAL' });

      // Staff (database owner) keeps the count rule alone when no proposal row exists for proposal_id:
      // 2-approver org (v_single = false) -> no hold; 1-owner org (v_single = true) -> 24h new_account hold.
      const staffMulti = await rows<{ hold_reason: string | null; payable_after: Date | null }>(
        `INSERT INTO crove_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
         VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason, payable_after`,
        [o.orgId, o.supplier, doc1, accountId1, numberHash1, hashKeyId1, randomUUID(), o.owner],
      );
      expect(staffMulti[0]).toEqual({ hold_reason: null, payable_after: null });

      const staffSingle = await rows<{ hold_reason: string | null; payable_after: Date | null; approved_at: Date }>(
        `INSERT INTO crove_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
         VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason, payable_after, approved_at`,
        [o2.orgId, o2.supplier, doc2, accountId2, numberHash2, hashKeyId2, randomUUID(), o2.owner],
      );
      expect(staffSingle[0]?.hold_reason).toBe('new_account');
      expect((staffSingle[0]?.payable_after as Date).getTime() - (staffSingle[0]?.approved_at as Date).getTime()).toBe(24 * 3_600_000);

      // Staff insert naming a real self-approved proposal in a 2-approver org still applies the N1 24h hold.
      const staffSelf = await rows<{ hold_reason: string | null; payable_after: Date | null }>(
        `INSERT INTO crove_finance.supplier_payment (org_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approved_by, approver_step_up_at)
         VALUES ($1, $2, $3, 110, 'VND', $4, $5, $6, $7, $8, now()) RETURNING hold_reason, payable_after`,
        [o.orgId, o.supplier, doc1Extra, accountId1, numberHash1, hashKeyId1, ownOrgProposal, o.admin],
      );
      expect(staffSelf[0]?.hold_reason).toBe('new_account');
      expect(staffSelf[0]?.payable_after).not.toBeNull();
    } finally {
      await admin((c) => c.query('ALTER TABLE crove_finance.supplier_payment ENABLE TRIGGER b_supplier_payment_proposal'));
    }
  });
});
