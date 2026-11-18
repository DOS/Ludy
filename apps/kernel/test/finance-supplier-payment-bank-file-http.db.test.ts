// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of supplier payments through the HTTP route as an owner reaches it (#3113 S3b-2, #3700), on a real PostgreSQL:
// - the file is the xlsx of the approved payments, `private, no-store` (its cells are checked in modules/finance/test/supplier-payment-bank-file-xlsx.test.ts);
// - before a byte is sent the payment is marked (exported_at, exported_by, export_count): a second request is refused with the payment's id and the time of the first file, until reexport=1 confirms it;
// - two requests racing for the same payment get one file and one refusal;
// - no second factor, HEAD, a wrong file name, no ids, an unknown payment and a payment of another org each refuse with no file.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-supplier-file-0123456789abcdef';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const NUMBER = '0123 4567 8901';
const HOLDER = '=Nguyen Van Canary';

class MemoryStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('missing blob');
  }
  async delete() {}
}

suite('the bank file of supplier payments over HTTP (#3113 S3b-2)', () => {
  const dbName = `crove_test_supplier_file_http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const subject = randomUUID();
  const session = randomUUID();
  let slug = '';
  let orgId = '';
  let ownerId = '';
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const token = (mfa: boolean) =>
    new SignJWT({ role: 'authenticated', email: 'owner@supplierfile.test', session_id: session, aal: mfa ? 'aal2' : 'aal1', is_anonymous: false, ...(mfa ? { amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const get = async (path: string, mfa = true, method = 'GET', org = slug) => app.request(path, { method, headers: { authorization: `Bearer ${await token(mfa)}`, 'x-crove-org': org } });
  const rows = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const exec = <O>(name: string, input: unknown) => rt.execute<O>(name, input, { actor: user(ownerId), orgId, idempotencyKey: randomUUID() });
  const url = (ids: string[], query = '') => `/api/supplier-payment-bank-file/payments.xlsx?ids=${ids.join(',')}${query}`;

  // A supplier with an account, a received invoice and one approved payment (released from the hold, as only the database owner can arrange).
  async function approvedPayment(): Promise<string> {
    const party = randomUUID();
    await rows("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp thử')", [orgId, party]);
    await exec('finance.supplier_bank_account.add', { partyId: party, bankName: 'Vietcombank', accountHolder: HOLDER, accountNumber: NUMBER });
    const doc = randomUUID();
    const entry = randomUUID();
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total) VALUES ($1, $2, $3, $4, '2026-10-01', 100, 10, 110)", [orgId, doc, party, `inv-${doc.slice(0, 8)}`]);
      await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-10-01', 'payment test', 'finance.purchase_document', $3)", [orgId, entry, doc]);
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)", [orgId, entry]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const { proposalId } = await exec<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.supplier_payment.record', input: { purchaseDocumentId: doc } });
    await exec('kernel.proposal.approve', { id: proposalId, revision: 1 });
    const id = (await rows<{ id: string }>('SELECT id FROM crove_finance.supplier_payment WHERE org_id = $1 AND purchase_document_id = $2', [orgId, doc]))[0]?.id as string;
    const c2 = new pg.Client({ connectionString: adminUrl });
    await c2.connect();
    try {
      await c2.query('BEGIN');
      await c2.query('SET LOCAL session_replication_role = replica');
      await c2.query('UPDATE crove_finance.supplier_payment SET payable_after = NULL, hold_reason = NULL WHERE org_id = $1 AND id = $2', [orgId, id]);
      await c2.query('COMMIT');
    } finally {
      await c2.end();
    }
    return id;
  }
  const markers = async (id: string) => (await rows<{ export_count: number; exported_by: string | null; exported_at: Date | null }>('SELECT export_count, exported_by, exported_at FROM crove_finance.supplier_payment WHERE org_id = $1 AND id = $2', [orgId, id]))[0];

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db = createDb(pool);
    rt = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      keyedHashRoots: [{ id: 'k-test-1', key: randomBytes(32) }],
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: rt, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    const created = await app.request('/api/rpc/org/create', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(false)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'Công ty Chi Thử', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    ownerId = (await rows<{ user_id: string }>(`SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'`, [orgId]))[0]?.user_id as string;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the workbook, marks the payment before the bytes are sent, and refuses a second file until it is confirmed', async () => {
    const id = await approvedPayment();
    expect(await markers(id)).toMatchObject({ export_count: 0, exported_by: null, exported_at: null });
    const res = await get(url([id]));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[\x20-\x7e]+\.xlsx"/);
    // A zip package (the spreadsheet), not an error body; its cells are checked in the finance workbook test.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(bytes[0] as number, bytes[1] as number)).toBe('PK');
    // Marked, as the owner, with the database clock.
    const marked = (await markers(id)) as { export_count: number; exported_by: string | null; exported_at: Date | null };
    expect(marked).toMatchObject({ export_count: 1, exported_by: ownerId });
    expect(marked?.exported_at).not.toBeNull();
    // The audit rows hold no name, number or amount.
    const audit = JSON.stringify(await rows('SELECT to_jsonb(a) AS a FROM crove_kernel.audit_event a WHERE a.org_id = $1 AND a.command LIKE $2', [orgId, 'finance.supplier_payment.bank_file.%']));
    for (const secret of ['012345678901', 'Canary', '110']) expect(audit).not.toContain(secret);
    // A second request: refused, naming the payment and the time of the first file, no bytes and no new marker.
    const again = await get(url([id]));
    expect(again.status).toBe(409);
    expect(again.headers.get('content-type')).toContain('application/json');
    const refusal = (await again.json()) as { code: string; paymentId: string; exportedAt: string };
    expect(refusal).toMatchObject({ code: 'SUPPLIER_PAYMENT_ALREADY_EXPORTED', paymentId: id });
    expect(new Date(refusal.exportedAt).getTime()).toBe((marked.exported_at as Date).getTime());
    expect((await markers(id))?.export_count).toBe(1);
    // Confirmed: a second file, counted and audited as such.
    const second = await get(url([id], '&reexport=1'));
    expect(second.status).toBe(200);
    expect((await markers(id))?.export_count).toBe(2);
    expect(JSON.stringify(await rows('SELECT to_jsonb(a) AS a FROM crove_kernel.audit_event a WHERE a.org_id = $1 AND a.command = $2', [orgId, 'finance.supplier_payment.bank_file.export']))).toMatch(/"reexport":\s*true/);
  });

  it('gives one file and one refusal to two requests racing for the same payment', async () => {
    const id = await approvedPayment();
    const [a, b] = await Promise.all([get(url([id])), get(url([id]))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await markers(id))?.export_count).toBe(1);
    await (a.status === 200 ? a : b).arrayBuffer();
  });

  it('refuses without a second factor, to HEAD, for a wrong file name, no ids, an unknown payment and a payment of another org, each with no file and no marker', async () => {
    const id = await approvedPayment();
    const noMfa = await get(url([id]), false);
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect((await get(url([id]), true, 'HEAD')).status).toBe(405);
    expect((await get(`/api/supplier-payment-bank-file/payments.csv?ids=${id}`)).status).toBe(404);
    expect((await get('/api/supplier-payment-bank-file/payments.xlsx')).status).toBe(400);
    expect((await get('/api/supplier-payment-bank-file/payments.xlsx?ids=not-an-id')).status).toBe(400);
    const unknown = randomUUID();
    const missing = await get(url([id, unknown]));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'SUPPLIER_PAYMENT_NOT_FOUND', paymentId: unknown });
    const stranger = await upsertIdentity(createDb(pool), { issuer: 'supplierfile', subject: `stranger-${randomUUID()}`, email: `s-${randomUUID()}@supplierfile.test`, name: null });
    const { orgId: otherOrg } = await createOrg(rt, { type: 'user', userId: stranger, aal: 'aal1' }, `Công ty khác ${randomUUID().slice(0, 6)}`);
    await expect(rt.query('finance.supplier_payment.bank_file.get', { paymentIds: [id] }, { actor: user(stranger), orgId: otherOrg })).rejects.toMatchObject({ code: 'SUPPLIER_PAYMENT_NOT_FOUND', status: 404 });
    expect((await markers(id))?.export_count).toBe(0);
  });
});
