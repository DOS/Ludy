// SPDX-License-Identifier: AGPL-3.0-only
// The switch of an entity's books to Circular 99, end to end (issue #1403, slice B3) on PostgreSQL 17, through the proposal path where a user acts: a purchase read after the
// switch carries its regime and chart version and posts under it; a purchase raised under TT133 is refused on the codes the two circulars define differently (211, 3386, 6421,
// 6422) once the books are TT99, and posts where it does not; a revision across the switch is refused; a reversal into the new chart of an entry on such a code is refused,
// while one dated before the switch still posts; the monthly depreciation of an asset registered before the switch is not posted into a TT99 month; and an approval that reads
// the books waits for a switch in flight and then refuses, instead of posting under the books it read before the switch committed.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@ludy/mod-finance';
import type { ExtractClient } from '@ludy/extract-contract';
import type { ParsedInvoice } from '@ludy/l10n-vn';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const PARSED = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;
const suite = ADMIN ? describe : describe.skip;

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

suite('an entity switches its books to Circular 99, end to end (#1403 slice B3)', () => {
  const dbName = `ludy_test_books_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();
  let owner = '';
  // Approves what the owner reads and edits (four-eyes: an author of a proposal does not approve it when another eligible approver exists).
  let approver = '';
  let orgId = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  // crove-extract answers the XML for real; a PDF's text is a stub, and the AI reading of it is the fixture invoice.
  const real = inProcessExtract();
  const extract: ExtractClient = {
    extract: async (kind, bytes) => (kind === 'pdf_text' ? ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 } as never) : real.extract(kind, bytes)),
  };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A legal entity of its own for each scenario: a books row is added once per entity, and an entity with entries from its first day cannot switch.
  async function newEntity(name: string): Promise<string> {
    return admin(
      async (a) =>
        (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'company', $3) RETURNING id`, [orgId, name, owner])).rows[0]?.id as string,
    );
  }
  const SWITCH_SQL = `INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2027-01-01')`;
  const switchToTt99 = (entity: string) => admin((a) => a.query(SWITCH_SQL, [orgId, entity]));

  async function ingest(bytes: Uint8Array, filename: string, legalEntityId: string) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    return rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/pdf', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId },
      { actor: asUser(owner), orgId },
    );
  }
  const pdfOf = (number: string) => new TextEncoder().encode(`%PDF-1.4 hoa don ${number} ${randomUUID()}`);
  const reading = (number: string, issueDate: string) => ({
    fromText: async () => ({ ...structuredClone(PARSED), source: 'ai' as const, number, issueDate }),
    fromImage: async () => null,
  });

  interface Detail {
    revision: number;
    payload: { regime?: string; chartVersion?: string } | null;
  }
  const detailOf = (id: string) => rt.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(owner), orgId });

  // Reads an invoice into a pending proposal of the entity, dated `issueDate`, as the worker does.
  async function propose(entity: string, number: string, issueDate: string): Promise<string> {
    const { fileId } = await ingest(pdfOf(number), `hd-${number}.pdf`, entity);
    const read = await extractAndPropose({ runtime: worker, store, extractor: reading(number, issueDate) as never, extract, today: () => '2027-02-01' }, orgId, fileId);
    return read.proposalId as string;
  }
  // Puts every line on `account` (the discount line, still waiting for one, included).
  async function classify(id: string, account: string) {
    const { revision } = await detailOf(id);
    await rt.execute(
      'kernel.proposal.edit',
      { id, revision, lineAccounts: [1, 2, 3].map((lineNo) => ({ lineNo, debitAccount: account })) },
      { actor: asUser(owner), orgId },
    );
  }
  const approve = async (id: string) => {
    const { revision } = await detailOf(id);
    return rt.execute<{ journalEntryId: string }>(
      'kernel.proposal.approve',
      { id, revision, acceptFailedChecks: true, acceptUnverifiedSignature: true },
      { actor: asMfa(approver), orgId },
    );
  };
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string });
  const documents = (entity: string) =>
    admin(async (a) => Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_finance.purchase_document WHERE org_id = $1 AND legal_entity_id = $2`, [orgId, entity])).rows[0]?.n));

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'ludy_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'owner', email: 'owner@books-e2e.test', name: null });
    approver = await upsertIdentity(db, { issuer: 'test', subject: 'approver', email: 'approver@books-e2e.test', name: null });
    ({ orgId } = await createOrg(rt, asUser(owner), 'Công ty chuyển sang Thông tư 99'));
    await admin((a) => a.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, approver]));
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('carries the regime and the chart version of a purchase read after the switch, and posts it under them', async () => {
    const entity = await newEntity('Đã chuyển TT99');
    await switchToTt99(entity);
    const id = await propose(entity, '9101', '2027-01-15');
    expect((await detailOf(id)).payload).toMatchObject({ regime: 'tt99', chartVersion: '2026.1' });
    await classify(id, '6427');
    const posted = await approve(id);
    const lines = await admin(async (a) => (await a.query<{ account_code: string }>(`SELECT account_code FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2`, [orgId, posted.journalEntryId])).rows);
    expect(lines.map((l) => l.account_code)).toContain('6427');
    expect(await documents(entity)).toBe(1);
  });

  it('leaves a purchase read under TT133 without a regime, refuses it on 6421 once the books are TT99, and posts it on accounts both charts share', async () => {
    const entity = await newEntity('Chuyển sau khi đọc hóa đơn');
    const onCharge = await propose(entity, '9201', '2027-01-15');
    const shared = await propose(entity, '9202', '2027-01-16');
    expect((await detailOf(onCharge)).payload?.regime).toBeUndefined();
    await classify(onCharge, '6421');
    await classify(shared, '6427');
    await switchToTt99(entity);
    expect(await refusal(approve(onCharge))).toMatchObject({ code: 'BOOKS_REGIME_CHANGED' });
    expect(await documents(entity)).toBe(0);
    await approve(shared);
    expect(await documents(entity)).toBe(1);
  });

  it('refuses a revision across the switch, in the proposal the person was working on', async () => {
    const entity = await newEntity('Chuyển giữa lúc sửa');
    const id = await propose(entity, '9301', '2027-01-15');
    await switchToTt99(entity);
    const { revision } = await detailOf(id);
    const error = await refusal(
      rt.execute('kernel.proposal.edit', { id, revision, lineAccounts: [1, 2, 3].map((lineNo) => ({ lineNo, debitAccount: '6427' })) }, { actor: asUser(owner), orgId }),
    );
    expect(error).toMatchObject({ code: 'BOOKS_REGIME_CHANGED' });
  });

  it('refuses a reversal into the TT99 books of an entry on 6421, and still posts one dated before the switch', async () => {
    const entity = await newEntity('Đảo bút toán qua ranh giới chuyển đổi');
    const id = await propose(entity, '9401', '2026-12-20');
    await classify(id, '6421');
    const { journalEntryId } = await approve(id);
    await switchToTt99(entity);
    const reverse = (entryDate: string) =>
      rt.execute<{ proposalId: string }>(
        'kernel.proposal.request',
        { command: 'finance.journal.reverse', input: { entryId: journalEntryId, entryDate, reason: 'Ghi nhầm' } },
        { actor: asUser(owner), orgId, idempotencyKey: randomUUID() },
      );
    expect(await refusal(reverse('2027-01-05'))).toMatchObject({ code: 'BOOKS_REGIME_CHANGED' });
    // Dated in the last days of the TT133 year, the mirror is still on TT133 accounts and posts.
    const { proposalId } = await reverse('2026-12-28');
    const posted = await approve(proposalId);
    expect(posted.journalEntryId).toEqual(expect.any(String));
  });

  it('does not post the depreciation of an asset registered under TT133 on a changed-meaning code into a TT99 month', async () => {
    const entity = await newEntity('Khấu hao qua ranh giới chuyển đổi');
    await rt.execute(
      'finance.fixed_asset.create',
      { kind: 'prepaid_cost', name: 'Bản quyền phần mềm 1 năm', cost: '12000000', assetAccount: '242', expenseAccount: '6421', startMonth: '2026-12', months: 12, legalEntityId: entity },
      { actor: asUser(owner), orgId },
    );
    const request = (month: string) =>
      rt.execute('kernel.proposal.request', { command: 'finance.depreciation.record', input: { month, legalEntityId: entity } }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    await switchToTt99(entity);
    // A month before the switch is still TT133 books and is asked for as before; the first month of TT99 names the asset and is not asked for.
    expect(await refusal(request('2026-12'))).toBeNull();
    expect(await refusal(request('2027-01'))).toMatchObject({ code: 'DEPRECIATION_BOOKS_CHANGED' });
  });

  it('waits for a switch in flight, then refuses, instead of posting under the books it read before the switch committed', async () => {
    const entity = await newEntity('Chuyển đổi đang chạy');
    const id = await propose(entity, '9601', '2027-01-15');
    await classify(id, '6421');
    // The switch holds the entity's period_lock row (legal_entity_books_guard) until it commits.
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(SWITCH_SQL, [orgId, entity]);
    try {
      let settled = false;
      const approval = refusal(approve(id)).finally(() => {
        settled = true;
      });
      // The approval is blocked at the lock of the entity's books, before it has read them.
      const waiting = async () =>
        admin(async (a) => Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%period_lock_share%'`)).rows[0]?.n));
      for (let i = 0; i < 100 && (await waiting()) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await waiting()).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      expect(await approval).toMatchObject({ code: 'BOOKS_REGIME_CHANGED' });
      expect(await documents(entity)).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });
});
