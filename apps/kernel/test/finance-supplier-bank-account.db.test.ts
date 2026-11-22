// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts and the history of their changes (#3113 S1) on a real PostgreSQL: the number and the holder are sealed under the supplier's own key and never appear in the clear (a row,
// an audit fact, an answer); a change needs a fresh second factor and an owner or an admin, retires the old account and writes one history row; the keyed hash tells "the same account"; the signal read
// of rule 3 lists the suppliers changed in the last 30 days; the erasure shreds the key, so a sealed number can never be opened again. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineQuery, parseVaultKey, type QueryDef } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Plain digits no scanner takes for a secret; the tests search the whole database for them.
const NUMBER = '0123 4567 8901';
const DIGITS = '012345678901';
const LAST4 = '8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';
const PLACE = 'ludy_finance.supplier_bank_account.number_sealed';

suite('a supplier\'s bank accounts (#3113 S1)', () => {
  const dbName = `crove_test_supplier_bank_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let keyless: Runtime;
  let build: (roots: { id: string; key: Buffer }[]) => Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const hashRoot = { id: 'k-test-1', key: randomBytes(32) };
  const user = (userId: string, fresh = true) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: fresh ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) - 3600 });

  const OPEN = defineQuery({
    name: 'ts3113.open',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    access: ['owner', 'admin'],
    sensitive: true,
    handler: async (ctx, input) => ctx.open(input.sealed, PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@bank.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; supplier: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Công ty Chi ${randomUUID().slice(0, 6)}`);
    const adminUser = await identity('admin');
    const member = await identity('member');
    await admin(async (c) => {
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser, member]);
    });
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thử')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, member, supplier };
  }
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true, runtime = rt) =>
    runtime.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, who = o.owner) => rt.query<T>(name, input, { actor: user(who), orgId: o.orgId });
  const refusal = async (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);
  const add = (o: Org, over: Record<string, unknown> = {}, who = o.owner) =>
    execute<{ id: string; last4: string; status: string; bankName: string }>(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: NUMBER, ...over }, who);

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
    const register = (options: { keyedHashRoots?: { id: string; key: Buffer }[] }) =>
      new Runtime(db, { manifests: TEST_MANIFESTS, subjectVault, ...options }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, OPEN],
      });
    build = (roots) => register({ keyedHashRoots: roots });
    rt = register({ keyedHashRoots: [hashRoot] });
    keyless = register({});
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  it('adds an account: its bank and last four digits come back, and neither the number nor the holder is in any row, audit fact or answer in the clear', async () => {
    const o = await org();
    const account = await add(o);
    expect(account).toMatchObject({ last4: LAST4, status: 'active', bankName: 'Vietcombank' });
    expect(JSON.stringify(account)).not.toContain(DIGITS);
    const stored = (await rows<{ number_sealed: string; account_holder_sealed: string; number_hash: string; hash_key_id: string }>('SELECT number_sealed, account_holder_sealed, number_hash, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]))[0];
    expect(stored?.number_sealed.startsWith('crove:s1:')).toBe(true);
    expect(stored?.account_holder_sealed.startsWith('crove:s1:')).toBe(true);
    expect(stored?.number_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.hash_key_id).toBe('k-test-1');
    // The whole of the org's finance rows and audit facts: no digits, no holder.
    const dump = JSON.stringify([
      await rows('SELECT * FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]),
      await rows('SELECT * FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1', [o.orgId]),
      await rows('SELECT detail, target_id, input_sha256 FROM ludy_kernel.audit_event WHERE org_id = $1', [o.orgId]),
    ]);
    expect(dump).not.toContain(DIGITS);
    expect(dump).not.toContain(NUMBER);
    expect(dump).not.toContain(HOLDER);
    const history = await rows<{ kind: string; old_number_hash: string | null; new_number_hash: string | null; step_up_at: Date }>('SELECT kind, old_number_hash, new_number_hash, step_up_at FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1', [o.orgId]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'added', old_number_hash: null, new_number_hash: stored?.number_hash });
  });

  it('asks for a fresh second factor and an owner or an admin, and refuses a bad number, a second account with the same number and an unknown supplier', async () => {
    const o = await org();
    expect(await refusal(execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER }, o.owner, false))).toBe('STEP_UP_REQUIRED');
    expect(await refusal(add(o, {}, o.member))).toBe('FORBIDDEN');
    expect(await refusal(add(o, { accountNumber: '12ab' }))).toBe('VALIDATION');
    expect(await refusal(add(o, { accountNumber: '12 34 5a' }))).toBe('SUPPLIER_BANK_NUMBER_INVALID');
    expect(await refusal(add(o, { partyId: randomUUID() }))).toBe('SUPPLIER_NOT_FOUND');
    await add(o);
    expect(await refusal(add(o, { bankName: 'Techcombank', accountNumber: '0123-4567-8901' }))).toBe('SUPPLIER_BANK_ACCOUNT_EXISTS');
    // An admin may change it too.
    expect(await refusal(add(o, { accountNumber: OTHER }, o.admin))).toBe('accepted');
    // No second factor in the key store: refused rather than a number without its hash.
    expect(await refusal(execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: '5544332211' }, o.owner, true, keyless))).toBe('BROKER_NOT_CONFIGURED');
  });

  it('replaces an account (the old one retired, one history row) and refuses the same number, a retired account and an unknown one', async () => {
    const o = await org();
    const first = await add(o);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', { accountId: first.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: DIGITS }))).toBe('SUPPLIER_BANK_ACCOUNT_SAME');
    const second = await execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.replace', { accountId: first.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER });
    expect(second.last4).toBe('6655');
    const accounts = await rows<{ id: string; status: string; retired_at: Date | null }>('SELECT id, status, retired_at FROM ludy_finance.supplier_bank_account WHERE org_id = $1 ORDER BY created_at', [o.orgId]);
    expect(accounts.map((a) => a.status)).toEqual(['retired', 'active']);
    expect(accounts[0]?.retired_at).not.toBeNull();
    const kinds = await rows<{ kind: string }>('SELECT kind FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1 ORDER BY changed_at, id', [o.orgId]);
    expect(kinds.map((k) => k.kind)).toEqual(['added', 'replaced']);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', { accountId: first.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: '1111222233' }))).toBe('SUPPLIER_BANK_ACCOUNT_NOT_ACTIVE');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', { accountId: randomUUID(), bankName: 'ACB', accountHolder: HOLDER, accountNumber: '1111222233' }))).toBe('SUPPLIER_BANK_ACCOUNT_NOT_FOUND');
  });

  it('after a credential key rotation tells the same account by the older key, and without that key neither fails nor counts as a change by itself', async () => {
    const oldRoot = { id: 'k-old', key: randomBytes(32) };
    const newRoot = { id: 'k-new', key: randomBytes(32) };
    const o = await org();
    const first = await execute<{ id: string }>(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER }, o.owner, true, build([oldRoot]));
    expect((await rows<{ hash_key_id: string }>('SELECT hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]))[0]?.hash_key_id).toBe('k-old');
    const same = { accountId: first.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: DIGITS };
    // The older key is still kept: the same number is the same account.
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', same, o.owner, true, build([newRoot, oldRoot])))).toBe('SUPPLIER_BANK_ACCOUNT_SAME');
    // Adding the same number again is refused too: the row made under the older key is judged under that key, not under the newest one only (#3699).
    expect(await refusal(execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER }, o.owner, true, build([newRoot, oldRoot])))).toBe('SUPPLIER_BANK_ACCOUNT_EXISTS');
    // The older key is gone: the account is not told apart by hash (no error, no hard refusal), and the new row carries the newest key id.
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', same, o.owner, true, build([newRoot])))).toBe('accepted');
    expect((await rows<{ hash_key_id: string }>("SELECT hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0]?.hash_key_id).toBe('k-new');
  });

  it('retires an account once and lists accounts and history without a number or a holder', async () => {
    const o = await org();
    const account = await add(o);
    const retired = await execute<{ status: string; retiredAt: string | null }>(o, 'finance.supplier_bank_account.retire', { accountId: account.id });
    expect(retired.status).toBe('retired');
    expect(retired.retiredAt).not.toBeNull();
    expect(await refusal(execute(o, 'finance.supplier_bank_account.retire', { accountId: account.id }))).toBe('SUPPLIER_BANK_ACCOUNT_NOT_ACTIVE');
    const listed = await query<{ accounts: Array<{ last4: string; status: string }>; changes: Array<{ kind: string }> }>(o, 'finance.supplier_bank_account.list', { partyId: o.supplier });
    expect(listed.accounts.map((a) => [a.last4, a.status])).toEqual([[LAST4, 'retired']]);
    expect(listed.changes.map((c) => c.kind).sort()).toEqual(['added', 'retired']);
    expect(JSON.stringify(listed)).not.toContain(DIGITS);
    expect(JSON.stringify(listed)).not.toContain(HOLDER);
    expect(await refusal(query(o, 'finance.supplier_bank_account.list', { partyId: o.supplier }, o.member))).toBe('FORBIDDEN');
  });

  it('lists in the rule 3 signal the suppliers changed in the last 30 days with the day of the latest change, and drops an older change', async () => {
    const o = await org();
    const quiet = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp cũ')", [o.orgId, quiet]));
    await add(o);
    await add(o, { partyId: quiet });
    // A change of 40 days ago (the database owner may edit the history; no tenant role may).
    await admin((c) => c.query("UPDATE ludy_finance.supplier_bank_account_change SET changed_at = pg_catalog.now() - interval '40 days' WHERE org_id = $1 AND party_id = $2", [o.orgId, quiet]));
    const signal = await query<Array<{ partyId: string; changedOn: string }>>(o, 'finance.signals.supplier_bank_changes', {}, o.member);
    expect(signal.map((s) => s.partyId)).toEqual([o.supplier]);
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    expect(signal[0]?.changedOn).toBe(today);
    expect(JSON.stringify(signal)).not.toContain(DIGITS);
  });

  it('keeps the history append-only for a tenant role and an account to its status', async () => {
    const o = await org();
    const account = await add(o);
    // The guard trigger holds even for the database owner: only the status and its time may move, and a retired account never comes back (the grants for a tenant role are the matrix test's).
    await expect(rows('UPDATE ludy_finance.supplier_bank_account SET bank_name = $3 WHERE org_id = $1 AND id = $2', [o.orgId, account.id, 'Khác'])).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_STATE/);
    await expect(rows('UPDATE ludy_finance.supplier_bank_account SET number_hash = repeat($3, 64) WHERE org_id = $1 AND id = $2', [o.orgId, account.id, 'a'])).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_STATE/);
    // The retirement and its change row are one statement (one transaction): the deferred check at commit finds the row.
    await rows(
      `WITH u AS (UPDATE ludy_finance.supplier_bank_account SET status = 'retired', retired_at = now() WHERE org_id = $1 AND id = $2 RETURNING org_id, party_id, id, number_hash)
       INSERT INTO ludy_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, old_number_hash, step_up_at) SELECT org_id, party_id, id, 'retired', number_hash, now() FROM u`,
      [o.orgId, account.id],
    );
    await expect(rows("UPDATE ludy_finance.supplier_bank_account SET status = 'active', retired_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, account.id])).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_STATE/);
  });

  // #3699: an account is never created or retired without its change row in the same transaction, so rule 3 (which reads only the history) cannot be bypassed by a future code path.
  it('refuses, when the transaction ends, an account written or retired without its change row', async () => {
    const o = await org();
    const account = await add(o);
    const hash = (await rows<{ number_hash: string }>('SELECT number_hash FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2', [o.orgId, account.id]))[0]?.number_hash as string;
    const sealed = 'crove:s1:00000000-0000-4000-8000-000000000000:x';
    // A new account by raw SQL with no change row.
    await expect(
      rows(
        `INSERT INTO ludy_finance.supplier_bank_account (org_id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4) VALUES ($1, $2, 'Raw', $3, $3, repeat('b', 64), 'k1', '1234')`,
        [o.orgId, o.supplier, sealed],
      ),
    ).rejects.toThrow(/SUPPLIER_BANK_CHANGE_MISSING/);
    // A retirement with no change row.
    await expect(rows("UPDATE ludy_finance.supplier_bank_account SET status = 'retired', retired_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, account.id])).rejects.toThrow(/SUPPLIER_BANK_CHANGE_MISSING/);
    // A change row written by an earlier transaction does not count: the account written now still has none of its own.
    await expect(
      rows(
        `INSERT INTO ludy_finance.supplier_bank_account (org_id, id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4) VALUES ($1, $2, $3, 'Raw', $4, $4, $5, 'k1', '1234')`,
        [o.orgId, account.id, o.supplier, sealed, hash],
      ),
    ).rejects.toThrow();
    expect((await rows<{ n: string }>("SELECT count(*)::text AS n FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0]?.n).toBe('1');
  });

  it('erases a supplier for an owner only: the accounts are retired, the key is shredded and a sealed number can never be opened again', async () => {
    const o = await org();
    await add(o);
    const stored = (await rows<{ number_sealed: string }>('SELECT number_sealed FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]))[0] as { number_sealed: string };
    const subject = `supplier:${o.supplier}`;
    // Before the erasure the number opens, for a manager, in an audited sensitive read.
    expect(await query(o, 'ts3113.open', { sealed: stored.number_sealed, ref: subject })).toBe(DIGITS);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.admin))).toBe('FORBIDDEN');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, false))).toBe('STEP_UP_REQUIRED');
    const erased = await execute<{ shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier });
    expect(erased).toMatchObject({ shreddedKeys: 1, retired: 1 });
    expect((await rows<{ n: string }>("SELECT count(*)::text AS n FROM ludy_kernel.subject_key WHERE org_id = $1 AND ref = $2", [o.orgId, subject]))[0]?.n).toBe('0');
    // The sealed text stays in its row byte for byte, and reads as erased.
    expect((await rows<{ number_sealed: string }>('SELECT number_sealed FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]))[0]?.number_sealed).toBe(stored.number_sealed);
    expect(await query(o, 'ts3113.open', { sealed: stored.number_sealed, ref: subject })).toEqual({ erased: true });
    const kinds = await rows<{ kind: string }>('SELECT kind FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1', [o.orgId]);
    expect(kinds.map((k) => k.kind).sort()).toEqual(['added', 'retired']);
  });
});
