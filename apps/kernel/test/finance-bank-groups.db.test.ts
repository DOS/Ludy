// SPDX-License-Identifier: AGPL-3.0-only
// The groups of open bank lines and the review page of matched lines (#2385) on a real PostgreSQL 17, through the HTTP API where a
// user would act: a clean group (one exact candidate, no warning) apart from lines to look at (two candidates, a partial
// amount, only the name), a clean voucher a proposer alone cannot approve under four-eyes (nothing posts), the same voucher
// approved by another person in one bulk approval, the matched-lines list with approver and reason, a claim of the matcher
// the server does not confirm, and an undo through the ordinary reversal. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { normalizeStatementAmount, type BankStatementRow } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-groups-2385';
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
  userId: string;
}

const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@bank-groups-2385.test`, session: randomUUID(), userId: '' });
const suite = ADMIN ? describe : describe.skip;

suite('bank match groups and the matched lines (#2385)', () => {
  const dbName = `crove_test_bank_groups_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner = account('owner');
  const adminUser = account('admin');
  const member = account('member');
  const viewer = account('viewer');
  const outsider = account('outsider');
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };
  // The fixture's seller, owed 1 980 000 on 331 once its invoice is recorded, and a customer.
  let vendor = '';
  let customer = '';
  // The lines by their bank reference.
  const lineId: Record<string, string> = {};

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });

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

  let rowNo = 1;
  const row = (date: string, moneyIn: string, moneyOut: string, reference: string, description: string): BankStatementRow => ({
    rowNo: rowNo++,
    date,
    description,
    moneyIn: normalizeStatementAmount(moneyIn),
    moneyOut: normalizeStatementAmount(moneyOut),
    balance: '',
    reference,
  });
  const approve = async (who: Account, id: string) => rpc('inbox/approve', await tokenFor(who, { mfa: true }), { acceptUnverifiedSignature: true, id, revision: 1, idempotencyKey: randomUUID() });

  async function join(who: Account, role: string, slug: string) {
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, slug);
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
  }

  beforeAll(async () => {
    extract = inProcessExtract();
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
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Ngân Hàng', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await join(adminUser, 'admin', org.slug);
    await join(member, 'member', org.slug);
    await join(viewer, 'viewer', org.slug);
    const second = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    other = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };

    // A purchase on credit from the fixture's seller (dated 2026-09-15): 1 980 000 owed to it on 331.
    const bytes = new Uint8Array(FIXTURE);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    const recorded = await approve(adminUser, String(proposal.proposalId));
    expect(recorded.status).toBe(200);
    const [doc] = await admin(async (c) => (await c.query('SELECT party_id FROM crove_finance.purchase_document WHERE id = $1', [recorded.body.documentId])).rows);
    vendor = doc.party_id;
    customer = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Công ty TNHH Thương mại Hòa Bình', '0312345670')`, [org.orgId, customer]));

    const imported = await rpc('bank/import', await tokenFor(member), {
      bankAccount: '1121',
      filename: 'sao-ke-10.xlsx',
      rows: [
        row('01/10/2026', '1.500.000', '', 'FT101', 'CTY TNHH THUONG MAI HOA BINH CK MST 0312345670'),
        row('02/10/2026', '', '1.980.000', 'FT102', 'CHUYEN KHOAN TRA TIEN HANG'),
        row('03/10/2026', '', '11.000', 'FT103', 'Phi SMS'),
        row('04/10/2026', '1.234,50', '', 'FT104', 'Lai tien gui'),
      ],
      idempotencyKey: randomUUID(),
    });
    expect(imported.status).toBe(200);
    for (const r of await admin(async (c) => (await c.query<{ id: string; bank_ref: string }>('SELECT id, bank_ref FROM crove_finance.bank_line WHERE org_id = $1', [org.orgId])).rows)) {
      lineId[r.bank_ref] = r.id;
    }
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // The invoice of the fixture's seller and its tax code, read from the books.
  async function sellerFacts() {
    return admin(async (c) => {
      const doc = (await c.query<{ invoice_number: string; invoice_series: string; total: string }>(`SELECT invoice_number, invoice_series, total::text FROM crove_finance.purchase_document WHERE org_id = $1 AND party_id = $2`, [org.orgId, vendor])).rows[0];
      const party = (await c.query<{ name: string; tax_code: string }>(`SELECT name, tax_code FROM crove_kernel.party WHERE org_id = $1 AND id = $2`, [org.orgId, vendor])).rows[0];
      return { number: String(doc?.invoice_number), series: String(doc?.invoice_series), total: Number(doc?.total), taxCode: String(party?.tax_code), name: String(party?.name) };
    });
  }
  const groups = async (who = member, slug = org.slug) => rpc('bank/matchGroups', await tokenFor(who), { bankAccount: '1121', period: '2026-11' }, slug);
  const approveMany = async (who: Account, ids: string[]) =>
    rpc('inbox/approveMany', await tokenFor(who, { mfa: true }), { items: ids.map((id) => ({ id, revision: 1 })), idempotencyKey: randomUUID() });
  const refByRef = new Map<string, string>();
  let seller: Awaited<ReturnType<typeof sellerFacts>>;

  it('sorts the open lines into a clean group and lines to look at, each with why', async () => {
    seller = await sellerFacts();
    expect(seller.total).toBe(1980000);
    const imported = await rpc('bank/import', await tokenFor(member), {
      bankAccount: '1121',
      filename: 'sao-ke-11.xlsx',
      rows: [
        // One exact candidate: the seller's tax code and its invoice, for the invoice's amount.
        row('05/11/2026', '', '1.980.000', 'GR1', `TT HD ${seller.number} MST ${seller.taxCode}`),
        // Two parties could be meant: both tax codes are in the text.
        row('06/11/2026', '', '777.000', 'GR2', `CK MST ${seller.taxCode} VA MST 0312345670`),
        // A partial payment: the party is clear, no open invoice equals the amount.
        row('07/11/2026', '', '1.000.000', 'GR3', `TT MST ${seller.taxCode} DOT 1`),
        // Only the name points at the party.
        row('08/11/2026', '', '555.000', 'GR4', `CHUYEN TIEN ${seller.name}`),
        // Nobody to suggest: stays an Inbox exception, in neither group.
        row('09/11/2026', '', '12.000', 'GR5', 'Phi SMS banking'),
      ],
      idempotencyKey: randomUUID(),
    });
    expect(imported.status).toBe(200);
    for (const r of await admin(async (c) => (await c.query<{ id: string; bank_ref: string }>(`SELECT id, bank_ref FROM crove_finance.bank_line WHERE org_id = $1 AND bank_ref LIKE 'GR%'`, [org.orgId])).rows)) {
      refByRef.set(r.bank_ref, r.id);
    }

    const answer = await groups();
    expect(answer.status).toBe(200);
    const clean = answer.body.clean as any[];
    const look = answer.body.look as any[];
    expect(clean.map((l) => l.line.reference)).toEqual(['GR1']);
    expect(clean[0]).toMatchObject({
      group: 'clean',
      why: null,
      voucher: { type: 'bank_debit', amount: '1980000', counterAccount: '331' },
      suggested: { party: { id: vendor }, invoice: { number: seller.number, series: seller.series } },
    });
    // A line with two candidates and a partial amount are never in the clean group, whatever else is true of them.
    expect(look.map((l) => [l.line.reference, l.why])).toEqual([
      ['GR2', 'several'],
      ['GR3', 'no_invoice'],
      ['GR4', 'weak'],
    ]);
    expect(answer.body.more).toBe(false);
    // Owners, admins and members ask for vouchers; a viewer does not, and another org reads nothing of this one.
    expect((await groups(viewer)).status).toBe(403);
    expect((await groups(outsider, other.slug)).body).toEqual({ clean: [], look: [], more: false });
  });

  let cleanProposal = '';

  it('keeps a batch the proposer alone approves from posting anything: four-eyes refuses it, the line stays proposed', async () => {
    // The owner asks for the clean line's voucher, marked as the matcher's suggestion, and approves it alone.
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.voucher.record',
      input: {
        type: 'bank_debit',
        date: '2026-11-05',
        cashAccount: '1121',
        partyId: vendor,
        description: `TT HD ${seller.number} MST ${seller.taxCode}`,
        lines: [{ account: '331', amount: '1980000' }],
        bankLineId: refByRef.get('GR1'),
        matchedBy: { kind: 'ly', reason: 'tax_code', invoice: { series: seller.series, number: seller.number } },
      },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    cleanProposal = String(asked.body.proposalId);
    const alone = await approveMany(owner, [cleanProposal]);
    expect(alone.status).toBe(200);
    expect(alone.body.results).toEqual([expect.objectContaining({ id: cleanProposal, outcome: 'refused', code: 'FOUR_EYES_REQUIRED' })]);
    // Nothing was posted: the line is still proposed, and the clean group no longer offers it.
    const lines = await admin(async (c) => (await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_finance.cash_voucher WHERE org_id = $1 AND bank_line_id = $2`, [org.orgId, refByRef.get('GR1')])).rows[0]?.n);
    expect(Number(lines)).toBe(0);
    expect(((await groups()).body.clean as any[]).map((l) => l.line.reference)).toEqual([]);
  });

  it('posts the clean group when another person approves it, one voucher per line, and lists it with approver and reason', async () => {
    const approved = await approveMany(adminUser, [cleanProposal]);
    expect(approved.status).toBe(200);
    expect(approved.body.results).toEqual([expect.objectContaining({ id: cleanProposal, outcome: 'approved' })]);
    const matched = await rpc('bank/matched', await tokenFor(viewer), { bankAccount: '1121', period: '2026-11' });
    expect(matched.status).toBe(200);
    expect(matched.body.items).toHaveLength(1);
    expect(matched.body.items[0]).toMatchObject({
      line: { reference: 'GR1' },
      voucher: { code: expect.stringMatching(/^BN\d{5}$/), type: 'bank_debit', amount: '1980000' },
      party: { id: vendor },
      proposalId: cleanProposal,
      approvedBy: { name: expect.any(String) },
      approvedAt: expect.any(String),
      matchedBy: { kind: 'ly', reason: 'tax_code', invoice: { number: seller.number } },
      reversal: null,
    });
    // The seller's payable is settled by the voucher: the line is matched, so it leaves both groups.
    const after = await groups();
    expect((after.body.clean as any[]).length).toBe(0);
    expect((after.body.look as any[]).map((l) => l.line.reference)).toEqual(['GR2', 'GR3', 'GR4']);
    // Another org reads nothing of it.
    expect((await rpc('bank/matched', await tokenFor(outsider), { period: '2026-11' }, other.slug)).body).toEqual({ items: [], more: false });
  });

  it('keeps a claim of the matcher honest: a voucher whose reason is not the matcher\'s is recorded as the person\'s own choice', async () => {
    // GR4 is matched by name; a request that claims the tax code reason is not the suggestion.
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.voucher.record',
      input: {
        type: 'bank_debit',
        date: '2026-11-08',
        cashAccount: '1121',
        partyId: vendor,
        description: `CHUYEN TIEN ${seller.name}`,
        lines: [{ account: '331', amount: '555000' }],
        bankLineId: refByRef.get('GR4'),
        matchedBy: { kind: 'ly', reason: 'tax_code' },
      },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const payload = await admin(async (c) => (await c.query<{ matched_by: unknown }>(`SELECT payload -> 'matchedBy' AS matched_by FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [org.orgId, asked.body.proposalId])).rows[0]?.matched_by);
    expect(payload).toEqual({ kind: 'manual' });
    // A voucher made from a line with no claim at all is the person's own choice too.
    const plain = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.voucher.record',
      input: {
        type: 'bank_debit',
        date: '2026-11-07',
        cashAccount: '1121',
        partyId: vendor,
        description: 'TT dot 1',
        lines: [{ account: '331', amount: '1000000' }],
        bankLineId: refByRef.get('GR3'),
      },
      idempotencyKey: randomUUID(),
    });
    expect(plain.status).toBe(200);
    expect(await admin(async (c) => (await c.query<{ matched_by: unknown }>(`SELECT payload -> 'matchedBy' AS matched_by FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [org.orgId, plain.body.proposalId])).rows[0]?.matched_by)).toEqual({ kind: 'manual' });
  });

  it('undoes a match through the ordinary reversal: the line opens again and the review page says reversed', async () => {
    const matched = (await rpc('bank/matched', await tokenFor(viewer), { bankAccount: '1121', period: '2026-11' })).body.items.find((i: any) => i.line.reference === 'GR1');
    expect(matched).toBeDefined();
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.journal.reverse',
      input: { entryId: matched.voucher.journalEntryId, entryDate: '2026-11-10', reason: 'Chuyển nhầm nhà cung cấp' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect((await approve(owner, String(asked.body.proposalId))).status).toBe(200);
    const after = (await rpc('bank/matched', await tokenFor(viewer), { bankAccount: '1121', period: '2026-11' })).body.items.find((i: any) => i.line.reference === 'GR1');
    expect(after).toMatchObject({ reversal: { entryDate: '2026-11-10' }, line: { state: { status: 'open' } } });
    // The line is open again and, with the invoice's payable back, is in the clean group once more.
    expect(((await groups()).body.clean as any[]).map((l) => l.line.reference)).toEqual(['GR1']);
  });

  it('never keeps two lines that pay one invoice in the clean group, nor a line for an invoice already settled', async () => {
    // A second transfer for the same invoice and amount: both lines name it, so neither is clean.
    const imported = await rpc('bank/import', await tokenFor(member), {
      bankAccount: '1121',
      filename: 'sao-ke-11b.xlsx',
      rows: [row('11/11/2026', '', '1.980.000', 'GR6', `TT LAN 2 HD ${seller.number} MST ${seller.taxCode}`)],
      idempotencyKey: randomUUID(),
    });
    expect(imported.status).toBe(200);
    const twice = (await groups()).body;
    expect(twice.clean).toEqual([]);
    expect((twice.look as any[]).filter((l) => ['GR1', 'GR6'].includes(l.line.reference)).map((l) => [l.line.reference, l.why])).toEqual([
      ['GR1', 'duplicate'],
      ['GR6', 'duplicate'],
    ]);
    // GR1 is matched again (asked for by the member, approved by the owner): the seller's payable is settled, so the second
    // transfer is no longer a clean match for an open invoice.
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.voucher.record',
      input: {
        type: 'bank_debit',
        date: '2026-11-05',
        cashAccount: '1121',
        partyId: vendor,
        description: `TT HD ${seller.number} MST ${seller.taxCode}`,
        lines: [{ account: '331', amount: '1980000' }],
        bankLineId: refByRef.get('GR1'),
      },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect((await approve(owner, String(asked.body.proposalId))).status).toBe(200);
    const settled = (await groups()).body;
    expect(settled.clean).toEqual([]);
    expect((settled.look as any[]).find((l) => l.line.reference === 'GR6')).toMatchObject({ group: 'look', why: 'no_invoice' });
  });
});
