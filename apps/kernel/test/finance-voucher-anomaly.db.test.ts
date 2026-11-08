// SPDX-License-Identifier: AGPL-3.0-only
// The unusual-amount flag on a payment voucher (issue #2419) on a real PostgreSQL 17, through the HTTP API: a payment far
// above or below what a party is usually paid carries one warning when it is asked for, a normal one, a party with fewer
// than five earlier payments, a receipt and a voucher with no party carry none, a reversed payment is not part of the
// history, the Inbox shows the warning on the voucher, and a flagged voucher is never approved in bulk but approves alone.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-voucher-anomaly-2419';
const ISSUER = 'crove-auth';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
}

const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@voucher-anomaly-2419.test`, session: randomUUID() });
const suite = ADMIN ? describe : describe.skip;

suite('unusual payment amounts (#2419)', () => {
  const dbName = `crove_test_voucher_anomaly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const owner = account('owner');
  const adminUser = account('admin');
  const member = account('member');
  let org = { slug: '', orgId: '' };
  // The party paid often, one paid once, and a party of the other kind of voucher.
  const often = randomUUID();
  const rarely = randomUUID();

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const ask = async (input: Record<string, unknown>) => {
    const asked = await rpc('inbox/request', await tokenFor(member), { command: 'finance.voucher.record', input, idempotencyKey: randomUUID() });
    expect(asked.status).toBe(200);
    return String(asked.body.proposalId);
  };
  const approve = async (id: string) => rpc('inbox/approve', await tokenFor(adminUser, { mfa: true }), { id, revision: 1, idempotencyKey: randomUUID() });
  const pay = (partyId: string | null, amount: string, extra: Record<string, unknown> = {}) => ({
    type: 'cash_payment',
    date: '2026-09-20',
    cashAccount: '1111',
    ...(partyId ? { partyId } : {}),
    description: 'Trả tiền hàng tháng',
    lines: [{ account: partyId ? '331' : '6422', amount }],
    ...extra,
  });
  const detailOf = async (id: string) => (await rpc('inbox/get', await tokenFor(owner), { id })).body;
  const flagsOf = async (id: string) => ((await detailOf(id)).voucher.checks ?? []) as Array<{ id: string; status: string; code: string; params: Record<string, string> }>;

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, adminUser, member]) expect((await rpc('me/get', await tokenFor(who), undefined, null)).status).toBe(200);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Chi Tiền', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    for (const [who, role] of [[adminUser, 'admin'], [member, 'member']] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, org.slug);
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Công ty Cung Cấp Đều', '0312345675'), ($1, $3, 'Công ty Thỉnh Thoảng', NULL)`, [org.orgId, often, rarely]);
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('raises nothing while a party has fewer than five earlier payments, whatever the amount', async () => {
    for (const amount of ['1000000', '1000000', '1000000', '1000000']) {
      const id = await ask(pay(often, amount));
      expect(await flagsOf(id)).toEqual([]);
      expect((await approve(id)).status).toBe(200);
    }
    // The fifth is asked for with four earlier ones: a huge amount still raises nothing.
    const fifth = await ask(pay(often, '90000000'));
    expect(await flagsOf(fifth)).toEqual([]);
    expect((await approve(fifth)).status).toBe(200);
    // The sixth has five earlier payments; they are 1, 1, 1, 1 and 90 million, so its median is 1 million.
    const sixth = await ask(pay(often, '1100000'));
    expect(await flagsOf(sixth)).toEqual([]);
    expect((await approve(sixth)).status).toBe(200);
  });

  let high = '';
  let low = '';
  let normal = '';

  it('flags a payment at least three times, or at most a third of, the usual, with the rule in the sentence and no flag on a normal one', async () => {
    high = await ask(pay(often, '4000000'));
    const flags = await flagsOf(high);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ id: 'anomaly_amount', status: 'warn', code: 'anomaly_amount.unusual', params: { subject: 'payment', direction: 'high', total: '4000000', usual: '1000000', count: '6' } });
    low = await ask(pay(often, '300000'));
    expect((await flagsOf(low))[0]).toMatchObject({ code: 'anomaly_amount.unusual', params: { subject: 'payment', direction: 'low', total: '300000' } });
    // 2 900 000 is just under three times, 340 000 just over a third.
    expect(await flagsOf(await ask(pay(often, '2900000')))).toEqual([]);
    normal = await ask(pay(often, '1200000'));
    expect(await flagsOf(normal)).toEqual([]);
    const sentence = ((await detailOf(high)).voucher.checks[0].message as string);
    expect(sentence).toContain('cao gấp 4.0 lần');
    expect(sentence).not.toMatch(/\bLy\b/);
  });

  it('flags no receipt, no voucher without a party and no party with fewer payments, and a bank debit counts as a payment', async () => {
    expect(await flagsOf(await ask({ type: 'cash_receipt', date: '2026-09-20', cashAccount: '1111', partyId: often, description: 'Khách trả lại', lines: [{ account: '131', amount: '90000000' }] }))).toEqual([]);
    expect(await flagsOf(await ask(pay(null, '90000000')))).toEqual([]);
    const once = await ask(pay(rarely, '1000'));
    expect((await approve(once)).status).toBe(200);
    expect(await flagsOf(await ask(pay(rarely, '90000000')))).toEqual([]);
    // A bank debit to the party is asked for against the same payments.
    const debit = await ask({ type: 'bank_debit', date: '2026-09-21', cashAccount: '1121', partyId: often, description: 'Chuyển khoản', lines: [{ account: '331', amount: '5000000' }] });
    expect((await flagsOf(debit))[0]).toMatchObject({ code: 'anomaly_amount.unusual', params: { direction: 'high' } });
  });

  it('shows the warning on the voucher and in the Inbox list, and leaves a normal voucher without one', async () => {
    const list = (await rpc('inbox/list', await tokenFor(owner), { status: 'pending' })).body as Array<{ id: string; anomalyChecks: number; warnChecks: number; failedChecks: number }>;
    expect(list.find((i) => i.id === high)).toMatchObject({ anomalyChecks: 1, warnChecks: 1, failedChecks: 0 });
    expect(list.find((i) => i.id === normal)).toMatchObject({ anomalyChecks: 0, warnChecks: 0 });
    expect(await detailOf(high)).toMatchObject({ anomalyChecks: 1, warnChecks: 1, voucher: { type: 'cash_payment', total: '4000000' } });
  });

  it('never approves a flagged voucher in bulk, whatever the id case, and approves its normal neighbour', async () => {
    const result = await rpc('inbox/approveMany', await tokenFor(adminUser, { mfa: true }), {
      items: [
        { id: high.toUpperCase(), revision: 1 },
        { id: normal, revision: 1 },
        { id: low, revision: 1 },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(result.status).toBe(200);
    const byId = new Map((result.body.results as Array<{ id: string; outcome: string; code?: string }>).map((r) => [r.id.toLowerCase(), r]));
    expect(byId.get(high)).toMatchObject({ outcome: 'refused', code: 'BULK_NOT_ALLOWED' });
    expect(byId.get(low)).toMatchObject({ outcome: 'refused', code: 'BULK_NOT_ALLOWED' });
    expect(byId.get(normal)).toMatchObject({ outcome: 'approved' });
    expect((await detailOf(high)).status).toBe('pending');
  });

  it('approves a flagged voucher on its own: the warning does not block', async () => {
    const approved = await approve(high);
    expect(approved).toMatchObject({ status: 200, body: { voucherId: expect.any(String) } });
    expect((await detailOf(high)).status).toBe('executed');
  });

  it('counts bank debits as payments in the history and leaves receipts out of it', async () => {
    // A party paid twice a month: five bank debits of 500 000 and a receipt of 80 million from it.
    const twice = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Chuyển Khoản')`, [org.orgId, twice]);
    });
    for (let n = 0; n < 5; n++) {
      const id = await ask({ type: 'bank_debit', date: '2026-09-22', cashAccount: '1121', partyId: twice, description: 'Chuyển khoản tháng', lines: [{ account: '331', amount: '500000' }] });
      expect((await approve(id)).status).toBe(200);
    }
    const receipt = await ask({ type: 'cash_receipt', date: '2026-09-22', cashAccount: '1111', partyId: twice, description: 'Hoàn tiền', lines: [{ account: '131', amount: '80000000' }] });
    expect((await approve(receipt)).status).toBe(200);
    // Five bank debits make the history: 1 500 000 is exactly three times their median, and the receipt is not part of it.
    expect((await flagsOf(await ask(pay(twice, '1500000'))))[0]).toMatchObject({ code: 'anomaly_amount.unusual', params: { usual: '500000', count: '5', direction: 'high' } });
    expect(await flagsOf(await ask(pay(twice, '1400000')))).toEqual([]);
  });

  it('judges a payment only against the payments of its own legal entity', async () => {
    const branch = await rpc('legalEntities/create', await tokenFor(owner, { mfa: true }), { name: 'Chi nhánh Đà Nẵng', kind: 'branch', taxCode: null, parentId: null });
    expect(branch.status).toBe(200);
    // The owner reads every entity. Payments to the party were all made in the default entity (the history above): the
    // same large amount is flagged there and not in the branch, whose books hold no payment to the party yet.
    expect(await flagsOf(await ask(pay(often, '90000000')))).toHaveLength(1);
    expect(await flagsOf(await ask(pay(often, '90000000', { legalEntityId: String(branch.body.id) })))).toEqual([]);
  });

  it('leaves a reversed payment out of the history', async () => {
    // The payments in force are 1, 1, 1, 1, 90, 1.1, 1.2 and 4 million: the median is 1.05 million, so 3.15 million is the
    // threshold. Reversing the 90 million payment leaves seven, with a median of 1 million: the threshold is 3 million.
    expect(await flagsOf(await ask(pay(often, '3100000')))).toEqual([]);
    expect(await flagsOf(await ask(pay(often, '3200000')))).toHaveLength(1);
    const [big] = await admin(
      async (c) =>
        (await c.query(`SELECT j.id FROM crove_finance.journal_entry j JOIN crove_finance.cash_voucher v ON v.id = j.source_id AND v.org_id = j.org_id WHERE v.amount = 90000000 AND j.reverses_entry_id IS NULL`)).rows,
    );
    const reversal = await rpc('inbox/request', await tokenFor(member), { command: 'finance.journal.reverse', input: { entryId: big.id, entryDate: '2026-09-30', reason: 'Chi nhầm' }, idempotencyKey: randomUUID() });
    expect(reversal.status).toBe(200);
    expect((await approve(String(reversal.body.proposalId))).status).toBe(200);
    expect(await flagsOf(await ask(pay(often, '3100000')))).toHaveLength(1);
    expect(await flagsOf(await ask(pay(often, '2990000')))).toEqual([]);
  });
});
