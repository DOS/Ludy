// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts and the history of their changes (#3113 S1) on a real PostgreSQL: the number and the holder are sealed under the supplier's own key and never appear in the clear (a row,
// an audit fact, an answer); a change needs a fresh second factor and an owner or an admin, retires the old account and writes one history row; the keyed hash tells "the same account"; the signal read
// of rule 3 lists the suppliers changed in the last 30 days; the erasure shreds the key, so a sealed number can never be opened again. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, keyedHash, parseVaultKey, type CommandDef, type QueryDef } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { resealSubjectKeys } from '../src/subject-key-reseal.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Plain digits no scanner takes for a secret; the tests search the whole database for them.
const NUMBER = '0123 4567 8901';
const DIGITS = '012345678901';
const LAST4 = '8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';
const PLACE = 'crove_finance.supplier_bank_account.number_sealed';

suite('a supplier\'s bank accounts (#3113 S1)', () => {
  const dbName = `ludy_test_supplier_bank_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let keyless: Runtime;
  let build: (roots: { id: string; key: Buffer }[], vault?: SubjectVault | null) => Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const vaultOf = (...roots: (typeof root)[]) => new SubjectVault(new CredentialVault(roots).deriveKeys(SUBJECT_WRAP_INFO));
  const hashRoot = { id: 'k-test-1', key: randomBytes(32) };
  const user = (userId: string, fresh = true) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: fresh ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) - 3600 });

  const OPEN = defineQuery({
    name: 'ts3113.open',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    access: ['owner', 'admin'],
    sensitive: true,
    handler: async (ctx, input) => ctx.open(input.sealed, PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;
  const CHECK_HASH = defineCommand({
    name: 'ts3113.check_hash',
    input: z.object({ ref: z.string(), value: z.string() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner', 'admin'],
    writes: [],
    handler: async (ctx, input) => ({ hash: await ctx.subjectHash(input.ref, 'supplier_bank_account.number', input.value, { create: false }) }),
  }) as CommandDef<unknown, unknown>;

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
  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true, runtime = rt, idempotencyKey = randomUUID()) =>
    runtime.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey });
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
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    db = createDb(pool);
    const subjectVault = vaultOf(root);
    const register = (options: { keyedHashRoots?: { id: string; key: Buffer }[]; subjectVault?: SubjectVault | null }) =>
      new Runtime(db, { manifests: TEST_MANIFESTS, subjectVault, ...options }).register({
        commands: [...kernelCommands, ...financeCommands, CHECK_HASH],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, OPEN],
      });
    build = (roots, vault = subjectVault) => register({ keyedHashRoots: roots, subjectVault: vault });
    rt = register({ keyedHashRoots: [hashRoot] });
    keyless = register({ subjectVault: null });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
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
    expect(stored?.number_sealed.startsWith('ludy:s1:')).toBe(true);
    expect(stored?.account_holder_sealed.startsWith('ludy:s1:')).toBe(true);
    expect(stored?.number_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.hash_key_id).toBe('subject:v1');
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
    // sealedInput keeps accountNumber and accountHolder out of audit_event.input_sha256: two adds differing only in those fields produce the same input hash.
    const o2 = await org();
    await add(o2, { partyId: o2.supplier, accountHolder: 'Other Holder', accountNumber: '7777888899' });
    await add(o2, { partyId: o2.supplier, accountHolder: 'Third Holder', accountNumber: '6666555544' });
    const inputHashes = await rows<{ input_sha256: string }>(
      "SELECT input_sha256 FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.supplier_bank_account.add' ORDER BY id",
      [o2.orgId],
    );
    expect(inputHashes).toHaveLength(2);
    expect(inputHashes[0]?.input_sha256).toBe(inputHashes[1]?.input_sha256);
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

  it('keeps comparing the same number after a credential key rotation even with the older key gone (#3751)', async () => {
    const oldVaultRoot = parseVaultKey(randomBytes(32).toString('base64'));
    const newVaultRoot = parseVaultKey(randomBytes(32).toString('base64'));
    const o = await org();
    const first = await execute<{ id: string }>(
      o,
      'finance.supplier_bank_account.add',
      { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER },
      o.owner,
      true,
      build([], vaultOf(oldVaultRoot)),
    );
    const beforeHash = (await rows<{ number_hash: string; hash_key_id: string }>('SELECT number_hash, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1', [o.orgId]))[0];
    expect(beforeHash?.hash_key_id).toBe('subject:v1');
    // Rotate credential key and run the subject-key reseal pass, then drop the older key completely.
    const workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(newVaultRoot, oldVaultRoot) }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });
    await resealSubjectKeys({ runtime: workerRt, workerDb: createDb(workerPool) });
    const afterRt = build([], vaultOf(newVaultRoot));
    const same = { accountId: first.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: DIGITS };
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', same, o.owner, true, afterRt))).toBe('SUPPLIER_BANK_ACCOUNT_SAME');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER }, o.owner, true, afterRt))).toBe(
      'SUPPLIER_BANK_ACCOUNT_EXISTS',
    );
  });

  it('keeps working for existing legacy keyed-hash rows while their credential key is kept, and upgrades cleanly on replace (#3751)', async () => {
    const oldRoot = { id: 'k-old', key: randomBytes(32) };
    const newRoot = { id: 'k-new', key: randomBytes(32) };
    const o = await org();
    const legacyHash = keyedHash(oldRoot.key, o.orgId, 'supplier_bank_account.number', DIGITS);
    const accountId = randomUUID();
    const sealed = 'ludy:s1:00000000-0000-4000-8000-000000000000:legacy';
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account (org_id, id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4)
         VALUES ($1, $2, $3, 'ACB', $4, $4, $5, 'k-old', $6)`,
        [o.orgId, accountId, o.supplier, sealed, legacyHash, LAST4],
      );
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, new_number_hash, step_up_at)
         VALUES ($1, $2, $3, 'added', $4, now())`,
        [o.orgId, o.supplier, accountId, legacyHash],
      );
      await c.query('COMMIT');
    });
    const same = { accountId, bankName: 'ACB', accountHolder: HOLDER, accountNumber: DIGITS };
    // The older credential key is still kept: legacy comparison still recognizes the same number.
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', same, o.owner, true, build([newRoot, oldRoot])))).toBe('SUPPLIER_BANK_ACCOUNT_SAME');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: NUMBER }, o.owner, true, build([newRoot, oldRoot])))).toBe(
      'SUPPLIER_BANK_ACCOUNT_EXISTS',
    );
    // Once the older key is gone, replace does not fail and upgrades the new active row to subject:v1.
    expect(await refusal(execute(o, 'finance.supplier_bank_account.replace', same, o.owner, true, build([newRoot])))).toBe('accepted');
    expect((await rows<{ hash_key_id: string }>("SELECT hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND status = 'active'", [o.orgId]))[0]?.hash_key_id).toBe('subject:v1');
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

  it('erases a supplier for an owner only: the accounts are retired, the key is shredded, hashes and last4 are tombstoned, and numbers cannot be opened or tested', async () => {
    const o = await org();
    await add(o);
    const stored = (
      await rows<{ number_sealed: string; account_holder_sealed: string; number_hash: string; last4: string }>(
        'SELECT number_sealed, account_holder_sealed, number_hash, last4 FROM ludy_finance.supplier_bank_account WHERE org_id = $1',
        [o.orgId],
      )
    )[0] as {
      number_sealed: string;
      account_holder_sealed: string;
      number_hash: string;
      last4: string;
    };
    const subject = `supplier:${o.supplier}`;
    // Before the erasure the number opens, for a manager, in an audited sensitive read, and the subject hash matches.
    expect(await query(o, 'ts3113.open', { sealed: stored.number_sealed, ref: subject })).toBe(DIGITS);
    expect(await execute<{ hash: string | null }>(o, 'ts3113.check_hash', { ref: subject, value: DIGITS })).toEqual({ hash: stored.number_hash });
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.admin))).toBe('FORBIDDEN');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, false))).toBe('STEP_UP_REQUIRED');
    const erased = await execute<{ shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier });
    expect(erased).toMatchObject({ shreddedKeys: 1, retired: 1 });
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.subject_key WHERE org_id = $1 AND ref = $2', [o.orgId, subject]))[0]?.n).toBe('0');
    // Sealed blobs stay in their row byte for byte, while number_hash and last4 are wiped with tombstones so no trailing digits or hashes survive.
    const afterAccount = (
      await rows<{ number_sealed: string; account_holder_sealed: string; number_hash: string; last4: string; status: string }>(
        'SELECT number_sealed, account_holder_sealed, number_hash, last4, status FROM ludy_finance.supplier_bank_account WHERE org_id = $1',
        [o.orgId],
      )
    )[0];
    expect(afterAccount).toEqual({
      number_sealed: stored.number_sealed,
      account_holder_sealed: stored.account_holder_sealed,
      number_hash: 'erased',
      last4: '****',
      status: 'retired',
    });
    expect(await query(o, 'ts3113.open', { sealed: stored.number_sealed, ref: subject })).toEqual({ erased: true });
    expect(await execute<{ hash: string | null }>(o, 'ts3113.check_hash', { ref: subject, value: DIGITS })).toEqual({ hash: null });
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.subject_key WHERE org_id = $1 AND ref = $2', [o.orgId, subject]))[0]?.n).toBe('0');
    const history = await rows<{ kind: string; old_number_hash: string | null; new_number_hash: string | null }>(
      'SELECT kind, old_number_hash, new_number_hash FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1 ORDER BY changed_at, id',
      [o.orgId],
    );
    expect(history).toEqual([
      { kind: 'added', old_number_hash: null, new_number_hash: 'erased' },
      { kind: 'retired', old_number_hash: 'erased', new_number_hash: null },
    ]);
    const listed = await query<{ accounts: Array<{ bankName: string; status: string; last4: string }>; changes: Array<{ kind: string }> }>(o, 'finance.supplier_bank_account.list', { partyId: o.supplier });
    expect(listed.accounts.map((a) => [a.status, a.last4])).toEqual([['retired', '****']]);
    const accountFieldsDump = JSON.stringify(listed.accounts.map(({ bankName, status, last4 }) => ({ bankName, status, last4 })));
    expect(accountFieldsDump).not.toContain(LAST4);
    expect(accountFieldsDump).not.toContain(DIGITS);
    expect(accountFieldsDump).not.toContain(HOLDER);
    // Even adding the same digits again uses a fresh random subject key and produces an unrelated hash.
    const readded = await add(o);
    expect(readded.last4).toBe(LAST4);
    const readdedHash = (await rows<{ number_hash: string }>('SELECT number_hash FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2', [o.orgId, readded.id]))[0]?.number_hash;
    expect(readdedHash).not.toBe(stored.number_hash);
    expect(readdedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets the owner erase a supplier while Finance is switched off, while refusing every other supplier bank command and read (#3744)', async () => {
    const o = await org();
    const account = await add(o);
    const stored = (
      await rows<{ number_sealed: string; account_holder_sealed: string; number_hash: string }>(
        'SELECT number_sealed, account_holder_sealed, number_hash FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, account.id],
      )
    )[0] as {
      number_sealed: string;
      account_holder_sealed: string;
      number_hash: string;
    };
    const subject = `supplier:${o.supplier}`;
    expect(await execute<{ hash: string | null }>(o, 'ts3113.check_hash', { ref: subject, value: DIGITS })).toEqual({ hash: stored.number_hash });

    // Switch Finance off for the org via the per-org app gate (ADR-0053).
    await execute(o, 'kernel.org.set_app', { module: 'finance', enabled: false });
    const moduleOff = { code: 'MODULE_OFF', status: 404, details: { module: 'finance' } };

    // Every other supplier bank command and query is refused while Finance is off.
    await expect(add(o, { accountNumber: OTHER })).rejects.toMatchObject(moduleOff);
    await expect(execute(o, 'finance.supplier_bank_account.replace', { accountId: account.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER })).rejects.toMatchObject(moduleOff);
    await expect(execute(o, 'finance.supplier_bank_account.retire', { accountId: account.id })).rejects.toMatchObject(moduleOff);
    await expect(query(o, 'finance.supplier_bank_account.list', { partyId: o.supplier })).rejects.toMatchObject(moduleOff);
    await expect(query(o, 'finance.signals.supplier_bank_changes', {}, o.member)).rejects.toMatchObject(moduleOff);

    // Erasure still requires an owner with a fresh second factor (R3).
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.admin))).toBe('FORBIDDEN');
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, false))).toBe('STEP_UP_REQUIRED');

    // Owner with fresh second factor erases while Finance is off: retires active accounts, shreds the subject key, and tombstones hashes and last4.
    const erased = await execute<{ partyId: string; shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier });
    expect(erased).toEqual({ partyId: o.supplier, shreddedKeys: 1, retired: 1 });

    const accountRow = (
      await rows<{ status: string; retired_at: Date | null; number_sealed: string; account_holder_sealed: string; number_hash: string; last4: string }>(
        'SELECT status, retired_at, number_sealed, account_holder_sealed, number_hash, last4 FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, account.id],
      )
    )[0];
    expect(accountRow?.status).toBe('retired');
    expect(accountRow?.retired_at).not.toBeNull();
    expect(accountRow?.number_sealed).toBe(stored.number_sealed);
    expect(accountRow?.account_holder_sealed).toBe(stored.account_holder_sealed);
    expect(accountRow?.number_hash).toBe('erased');
    expect(accountRow?.last4).toBe('****');
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.subject_key WHERE org_id = $1 AND ref = $2', [o.orgId, subject]))[0]?.n).toBe('0');
    expect(await query(o, 'ts3113.open', { sealed: stored.number_sealed, ref: subject })).toEqual({ erased: true });
    expect(await execute<{ hash: string | null }>(o, 'ts3113.check_hash', { ref: subject, value: DIGITS })).toEqual({ hash: null });
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.subject_key WHERE org_id = $1 AND ref = $2', [o.orgId, subject]))[0]?.n).toBe('0');
    const history = await rows<{ kind: string; old_number_hash: string | null; new_number_hash: string | null }>(
      'SELECT kind, old_number_hash, new_number_hash FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1 ORDER BY changed_at, id',
      [o.orgId],
    );
    expect(history).toEqual([
      { kind: 'added', old_number_hash: null, new_number_hash: 'erased' },
      { kind: 'retired', old_number_hash: 'erased', new_number_hash: null },
    ]);
    const eraseAudits = await rows<{ outcome: string; detail: Record<string, unknown> }>("SELECT outcome, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.supplier_bank_account.erase' AND outcome = 'ok'", [o.orgId]);
    expect(eraseAudits).toHaveLength(1);
    expect(eraseAudits[0]?.detail).toMatchObject({ partyId: o.supplier, shreddedKeys: 1, retired: 1 });

    // Switching Finance back on lets managers read the retired history again; the erased key and tombstones remain intact.
    await execute(o, 'kernel.org.set_app', { module: 'finance', enabled: true });
    const listed = await query<{ accounts: Array<{ id: string; status: string; last4: string }>; changes: Array<{ kind: string }> }>(o, 'finance.supplier_bank_account.list', { partyId: o.supplier });
    expect(listed.accounts.map((a) => [a.id, a.status, a.last4])).toEqual([[account.id, 'retired', '****']]);
    expect(listed.changes.map((c) => c.kind).sort()).toEqual(['added', 'retired']);
  });

  it('wipes legacy keyed-hash accounts (active and already retired), replaced/retired change rows, and finished payments even while legacy keys stay active (#3738)', async () => {
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
    async function invoice(o: Org, total = '110'): Promise<string> {
      const doc = randomUUID();
      const entry = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          "INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', $5::numeric - 10, 10, $5)",
          [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`, total],
        );
        await c.query(
          "INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'erase test', 'finance.purchase_document', $3)",
          [o.orgId, entry, doc],
        );
        await c.query("INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
        await c.query('COMMIT');
      });
      return doc;
    }

    const oldRoot = { id: 'k-old', key: randomBytes(32) };
    const legacyRt = build([root, oldRoot]);
    const o = await org();
    const otherSupplier = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp không xóa')", [o.orgId, otherSupplier]));
    const otherAccount = await add(o, { partyId: otherSupplier, bankName: 'Techcombank', accountNumber: '5544332211' });

    const legacyHash1 = keyedHash(oldRoot.key, o.orgId, 'supplier_bank_account.number', DIGITS);
    const legacyHash2 = keyedHash(oldRoot.key, o.orgId, 'supplier_bank_account.number', OTHER);
    const retiredId = randomUUID();
    const activeId = randomUUID();
    const sealed1 = 'ludy:s1:00000000-0000-4000-8000-000000000001:legacy1';
    const sealed2 = 'ludy:s1:00000000-0000-4000-8000-000000000002:legacy2';

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account (org_id, id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4)
         VALUES ($1, $2, $3, 'ACB', $4, $4, $5, 'k-old', $6)`,
        [o.orgId, retiredId, o.supplier, sealed1, legacyHash1, LAST4],
      );
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, new_number_hash, step_up_at)
         VALUES ($1, $2, $3, 'added', $4, now())`,
        [o.orgId, o.supplier, retiredId, legacyHash1],
      );
      await c.query('COMMIT');
    });

    // While retiredId is still active under k-old, record and approve a payment on it so replacing it naturally marks that payment stale.
    const docStale = await invoice(o);
    const reqStale = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: docStale } }, o.owner, true, legacyRt);
    await execute(o, 'kernel.proposal.approve', { id: reqStale.proposalId, revision: 1 }, o.admin, true, legacyRt);

    // Replace retiredId with a second legacy k-old account in one transaction (matching real replace history).
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("UPDATE ludy_finance.supplier_bank_account SET status = 'retired', retired_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, retiredId]);
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account (org_id, id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4)
         VALUES ($1, $2, $3, 'BIDV', $4, $4, $5, 'k-old', '6655')`,
        [o.orgId, activeId, o.supplier, sealed2, legacyHash2],
      );
      await c.query(
        `INSERT INTO ludy_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, old_number_hash, new_number_hash, step_up_at)
         VALUES ($1, $2, $3, 'replaced', $4, $5, now())`,
        [o.orgId, o.supplier, activeId, legacyHash1, legacyHash2],
      );
      await c.query('COMMIT');
    });

    // Create a paid payment and an approved payment on activeId; while approved payment waits, erase must refuse SUPPLIER_PAYMENT_WAITING.
    const docPaid = await invoice(o);
    const reqPaid = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: docPaid } }, o.owner, true, legacyRt);
    const approvePaidKey = randomUUID();
    const approvePaidInput = { id: reqPaid.proposalId, revision: 1 };
    await execute(o, 'kernel.proposal.approve', approvePaidInput, o.admin, true, legacyRt, approvePaidKey);
    const paidRow = (await rows<{ id: string }>("SELECT id FROM ludy_finance.supplier_payment WHERE org_id = $1 AND purchase_document_id = $2", [o.orgId, docPaid]))[0]!;
    await unguarded((c) => c.query("UPDATE ludy_finance.supplier_payment SET status = 'paid', paid_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, paidRow.id]));

    const docCancelled = await invoice(o);
    const reqCancelled = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: docCancelled } }, o.owner, true, legacyRt);
    await execute(o, 'kernel.proposal.approve', { id: reqCancelled.proposalId, revision: 1 }, o.admin, true, legacyRt);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, true, legacyRt))).toBe('SUPPLIER_PAYMENT_WAITING');
    const cancelledRow = (await rows<{ id: string }>("SELECT id FROM ludy_finance.supplier_payment WHERE org_id = $1 AND purchase_document_id = $2", [o.orgId, docCancelled]))[0]!;
    const cancelKey = randomUUID();
    const cancelInput = { paymentId: cancelledRow.id, reason: 'Hủy trước khi xóa' };
    await execute(o, 'finance.supplier_payment.cancel', cancelInput, o.owner, true, legacyRt, cancelKey);

    // A pending record proposal must also block erase without modifying any row.
    const docPending = await invoice(o);
    const reqPending = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: docPending } }, o.owner, true, legacyRt);
    expect(await refusal(execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, true, legacyRt))).toBe('SUPPLIER_PAYMENT_WAITING');
    await execute(o, 'kernel.proposal.reject', { id: reqPending.proposalId, revision: 1, reason: 'Từ chối trước khi xóa' }, o.admin, true, legacyRt);

    // Before erase, oldRoot is live and matches activeId.
    expect(
      await refusal(execute(o, 'finance.supplier_bank_account.replace', { accountId: activeId, bankName: 'BIDV', accountHolder: HOLDER, accountNumber: OTHER }, o.owner, true, legacyRt)),
    ).toBe('SUPPLIER_BANK_ACCOUNT_SAME');

    // Erase on legacyRt (while oldRoot is still present!): active + previously-retired legacy accounts, all changes, and stale/cancelled/paid payments are wiped.
    const erased = await execute<{ partyId: string; shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, true, legacyRt);
    expect(erased).toEqual({ partyId: o.supplier, shreddedKeys: 0, retired: 1 });

    const bankRows = await rows<{ id: string; status: string; number_hash: string; last4: string; number_sealed: string; hash_key_id: string }>(
      'SELECT id, status, number_hash, last4, number_sealed, hash_key_id FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND party_id = $2 ORDER BY created_at, id',
      [o.orgId, o.supplier],
    );
    expect(bankRows).toEqual([
      { id: retiredId, status: 'retired', number_hash: 'erased', last4: '****', number_sealed: sealed1, hash_key_id: 'k-old' },
      { id: activeId, status: 'retired', number_hash: 'erased', last4: '****', number_sealed: sealed2, hash_key_id: 'k-old' },
    ]);

    const changeRows = await rows<{ kind: string; old_number_hash: string | null; new_number_hash: string | null }>(
      'SELECT kind, old_number_hash, new_number_hash FROM ludy_finance.supplier_bank_account_change WHERE org_id = $1 AND party_id = $2 ORDER BY changed_at, id',
      [o.orgId, o.supplier],
    );
    expect(changeRows).toEqual([
      { kind: 'added', old_number_hash: null, new_number_hash: 'erased' },
      { kind: 'replaced', old_number_hash: 'erased', new_number_hash: 'erased' },
      { kind: 'retired', old_number_hash: 'erased', new_number_hash: null },
    ]);

    const paymentRows = await rows<{ status: string; number_hash: string }>(
      'SELECT status, number_hash FROM ludy_finance.supplier_payment WHERE org_id = $1 AND party_id = $2 ORDER BY status',
      [o.orgId, o.supplier],
    );
    expect(paymentRows).toEqual([
      { status: 'cancelled', number_hash: 'erased' },
      { status: 'paid', number_hash: 'erased' },
      { status: 'stale', number_hash: 'erased' },
    ]);

    // Terminal finance.supplier_payment.record proposals in ludy_kernel.proposal must also have payload.last4 and result.last4 wiped to '****'.
    const proposalRows = await rows<{ status: string; payload_last4: string | null; result_last4: string | null }>(
      `SELECT status, payload ->> 'last4' AS payload_last4, result ->> 'last4' AS result_last4
       FROM ludy_kernel.proposal
       WHERE org_id = $1 AND command = 'finance.supplier_payment.record'
       ORDER BY status, id`,
      [o.orgId],
    );
    expect(proposalRows).toEqual([
      { status: 'executed', payload_last4: '****', result_last4: '****' },
      { status: 'executed', payload_last4: '****', result_last4: '****' },
      { status: 'executed', payload_last4: '****', result_last4: '****' },
      { status: 'rejected', payload_last4: '****', result_last4: null },
    ]);

    // Replaying cached idempotency keys after erase returns last4: '****' rather than pre-erase digits.
    const replayedApprove = await execute<{ last4: string }>(o, 'kernel.proposal.approve', approvePaidInput, o.admin, true, legacyRt, approvePaidKey);
    expect(replayedApprove.last4).toBe('****');
    const replayedCancel = await execute<{ last4: string }>(o, 'finance.supplier_payment.cancel', cancelInput, o.owner, true, legacyRt, cancelKey);
    expect(replayedCancel.last4).toBe('****');
    const cachedKeys = await rows<{ command: string; last4: string | null }>(
      `SELECT command, response -> 'value' ->> 'last4' AS last4
       FROM ludy_kernel.idempotency_key
       WHERE org_id = $1
         AND response -> 'value' ? 'last4'
         AND pg_catalog.lower(response -> 'value' ->> 'partyId') = pg_catalog.lower($2::text)`,
      [o.orgId, o.supplier],
    );
    expect(cachedKeys.length).toBeGreaterThanOrEqual(2);
    expect(cachedKeys.every((k) => k.last4 === '****')).toBe(true);
    const otherCached = await rows<{ last4: string | null }>(
      `SELECT response -> 'value' ->> 'last4' AS last4
       FROM ludy_kernel.idempotency_key
       WHERE org_id = $1
         AND pg_catalog.lower(response -> 'value' ->> 'partyId') = pg_catalog.lower($2::text)`,
      [o.orgId, otherSupplier],
    );
    expect(otherCached.map((k) => k.last4)).toEqual(['2211']);

    // List endpoints succeed with last4 masked as '****' and never leak the old digests or trailing digits.
    const listedAccounts = await query<{ accounts: Array<{ id: string; last4: string; status: string }> }>(o, 'finance.supplier_bank_account.list', { partyId: o.supplier });
    expect(listedAccounts.accounts.map((a) => [a.id, a.status, a.last4])).toEqual([
      [activeId, 'retired', '****'],
      [retiredId, 'retired', '****'],
    ]);
    const listedPayments = await query<Array<{ status: string; last4: string }>>(o, 'finance.supplier_payment.list', {});
    expect(listedPayments.map((p) => [p.status, p.last4]).sort()).toEqual([
      ['cancelled', '****'],
      ['paid', '****'],
      ['stale', '****'],
    ]);

    // Dump check on the erased supplier's rows (excluding random UUIDs): neither legacy hashes nor trailing digits remain anywhere.
    const erasedDump = JSON.stringify({
      accounts: bankRows.map(({ status, number_hash, last4, hash_key_id }) => ({ status, number_hash, last4, hash_key_id })),
      changeRows,
      paymentRows,
      proposalRows,
      cachedKeys,
      listedAccounts: listedAccounts.accounts.map(({ last4, status }) => ({ last4, status })),
      listedPayments: listedPayments.map(({ status, last4 }) => ({ status, last4 })),
    });
    expect(erasedDump).not.toContain(legacyHash1);
    expect(erasedDump).not.toContain(legacyHash2);
    expect(erasedDump).not.toContain(LAST4);
    expect(erasedDump).not.toContain('6655');

    // Another supplier in the same org keeps its account intact.
    const otherStored = (
      await rows<{ status: string; number_hash: string; last4: string }>(
        'SELECT status, number_hash, last4 FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, otherAccount.id],
      )
    )[0];
    expect(otherStored?.status).toBe('active');
    expect(otherStored?.last4).toBe('2211');
    expect(otherStored?.number_hash).toMatch(/^[0-9a-f]{64}$/);

    // Repeat erase is idempotent, and adding the same digits again succeeds under a fresh subject:v1 key.
    expect(await execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner, true, legacyRt)).toEqual({
      partyId: o.supplier,
      shreddedKeys: 0,
      retired: 0,
    });
    const readded = await add(o, { accountNumber: OTHER });
    expect(readded.last4).toBe('6655');
  });

  it('scrubs cached last4 copies from add, replace, retire, and supplier_payment.prepare idempotency replays on erase (#3738)', async () => {
    const o = await org();
    const otherSupplier = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp khác')", [o.orgId, otherSupplier]));
    const otherAddKey = randomUUID();
    const otherAddInput = { partyId: otherSupplier, bankName: 'TPBank', accountHolder: HOLDER, accountNumber: '1122334455' };
    await execute(o, 'finance.supplier_bank_account.add', otherAddInput, o.owner, true, rt, otherAddKey);

    const addKey = randomUUID();
    const addInput = { partyId: o.supplier, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: NUMBER };
    const added = await execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.add', addInput, o.owner, true, rt, addKey);
    expect(added.last4).toBe(LAST4);

    const replaceKey = randomUUID();
    const replaceInput = { accountId: added.id, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER };
    const replaced = await execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.replace', replaceInput, o.owner, true, rt, replaceKey);
    expect(replaced.last4).toBe('6655');

    // Direct finance.supplier_payment.prepare call stores last4 at response.value.payload.last4.
    const doc = randomUUID();
    const entry = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', 100, 10, 110)",
        [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`],
      );
      await c.query(
        "INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'prepare replay test', 'finance.purchase_document', $3)",
        [o.orgId, entry, doc],
      );
      await c.query("INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
      await c.query('COMMIT');
    });
    const prepareKey = randomUUID();
    const prepareInput = { purchaseDocumentId: doc };
    const prepared = await execute<{ payload: { last4: string } }>(o, 'finance.supplier_payment.prepare', prepareInput, o.owner, true, rt, prepareKey);
    expect(prepared.payload.last4).toBe('6655');

    const retireKey = randomUUID();
    const retireInput = { accountId: replaced.id };
    const retired = await execute<{ id: string; last4: string }>(o, 'finance.supplier_bank_account.retire', retireInput, o.owner, true, rt, retireKey);
    expect(retired.last4).toBe('6655');

    await execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner);

    expect((await execute<{ last4: string }>(o, 'finance.supplier_bank_account.add', addInput, o.owner, true, rt, addKey)).last4).toBe('****');
    expect((await execute<{ last4: string }>(o, 'finance.supplier_bank_account.replace', replaceInput, o.owner, true, rt, replaceKey)).last4).toBe('****');
    expect((await execute<{ payload: { last4: string } }>(o, 'finance.supplier_payment.prepare', prepareInput, o.owner, true, rt, prepareKey)).payload.last4).toBe('****');
    expect((await execute<{ last4: string }>(o, 'finance.supplier_bank_account.retire', retireInput, o.owner, true, rt, retireKey)).last4).toBe('****');
    // Unrelated supplier's cached idempotency replay keeps its last4.
    expect((await execute<{ last4: string }>(o, 'finance.supplier_bank_account.add', otherAddInput, o.owner, true, rt, otherAddKey)).last4).toBe('4455');
  });

  it('serializes concurrent supplier_payment.prepare and proposal.resubmit against supplier_bank_account.erase without deadlocks (#3738)', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const o = await org();
      const account = await add(o);
      const doc = randomUUID();
      const entry = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          "INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', 100, 10, 110)",
          [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`],
        );
        await c.query(
          "INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'concurrent race test', 'finance.purchase_document', $3)",
          [o.orgId, entry, doc],
        );
        await c.query("INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
        await c.query('COMMIT');
      });

      const runReq = () => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } }, o.owner);
      const runErase = () => execute<{ partyId: string; shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner);
      const [reqResult, eraseResult] =
        attempt % 2 === 0
          ? await Promise.allSettled([runReq(), runErase()])
          : await (async () => {
              const [e, r] = await Promise.allSettled([runErase(), runReq()]);
              return [r, e] as const;
            })();

      expect(reqResult.status === 'fulfilled').not.toBe(eraseResult.status === 'fulfilled');
      const [stored] = await rows<{ status: string; number_hash: string; last4: string }>(
        'SELECT status, number_hash, last4 FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, account.id],
      );
      const pendingProposals = await rows<{ id: string }>(
        "SELECT id FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.supplier_payment.record' AND status = 'pending'",
        [o.orgId],
      );

      if (eraseResult.status === 'fulfilled') {
        expect((reqResult as PromiseRejectedResult).reason).toMatchObject({ code: 'SUPPLIER_PAYMENT_NO_ACCOUNT' });
        expect(pendingProposals).toHaveLength(0);
        expect(stored).toEqual({ status: 'retired', number_hash: 'erased', last4: '****' });
      } else {
        expect((eraseResult as PromiseRejectedResult).reason).toMatchObject({ code: 'SUPPLIER_PAYMENT_WAITING' });
        expect(pendingProposals).toHaveLength(1);
        expect(stored?.status).toBe('active');
        expect(stored?.last4).toBe(LAST4);
        expect(stored?.number_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    // Concurrent kernel.proposal.resubmit of an expired payment proposal vs erase also serializes cleanly without deadlock.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const o = await org();
      const account = await add(o);
      const doc = randomUUID();
      const entry = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          "INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', 100, 10, 110)",
          [o.orgId, doc, o.supplier, `inv-${doc.slice(0, 8)}`],
        );
        await c.query(
          "INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'concurrent resubmit race', 'finance.purchase_document', $3)",
          [o.orgId, entry, doc],
        );
        await c.query("INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [o.orgId, entry]);
        await c.query('COMMIT');
      });
      const expiredReq = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } }, o.owner);
      await admin((c) => c.query("UPDATE ludy_kernel.proposal SET status = 'expired', decided_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, expiredReq.proposalId]));

      const runResubmit = () => execute<{ proposalId: string }>(o, 'kernel.proposal.resubmit', { id: expiredReq.proposalId }, o.owner);
      const runErase = () => execute<{ partyId: string; shreddedKeys: number; retired: number }>(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner);
      const [resubmitResult, eraseResult] =
        attempt % 2 === 0
          ? await Promise.allSettled([runResubmit(), runErase()])
          : await (async () => {
              const [e, r] = await Promise.allSettled([runErase(), runResubmit()]);
              return [r, e] as const;
            })();

      expect(resubmitResult.status === 'fulfilled').not.toBe(eraseResult.status === 'fulfilled');
      const [stored] = await rows<{ status: string; number_hash: string; last4: string }>(
        'SELECT status, number_hash, last4 FROM ludy_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, account.id],
      );
      if (eraseResult.status === 'fulfilled') {
        expect((resubmitResult as PromiseRejectedResult).reason).toMatchObject({ code: 'SUPPLIER_PAYMENT_NO_ACCOUNT' });
        expect(stored).toEqual({ status: 'retired', number_hash: 'erased', last4: '****' });
        const [oldRow] = await rows<{ last4: string | null }>("SELECT payload ->> 'last4' AS last4 FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2", [
          o.orgId,
          expiredReq.proposalId,
        ]);
        expect(oldRow?.last4).toBe('****');
      } else {
        expect((eraseResult as PromiseRejectedResult).reason).toMatchObject({ code: 'SUPPLIER_PAYMENT_WAITING' });
        expect(stored?.status).toBe('active');
        expect(stored?.last4).toBe(LAST4);
      }
    }
  });
});
