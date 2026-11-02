// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly flags on a purchase proposal (#2380) on PostgreSQL 17, through the proposal path: a vendor's first invoices raise
// nothing, a new bank account, an unusual amount and a price jump are warnings with their reasons (and no account number),
// the Inbox counts them, a flagged proposal is refused in a bulk approval item by item while a normal one is approved, and
// a person may still approve the flagged one alone. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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

interface Row {
  id: string;
  status: string;
  revision: number;
  source_file_id: string | null;
  extraction_id: string | null;
  duplicate_of: string | null;
  legal_entity_id: string;
  authors: Array<{ type: string; id: string }>;
  payload: { extractionMethod: string; sourceFileId: string; checks: Array<{ id: string; code: string; status: string }>; invoice: { number: string } };
}

suite('anomaly flags on a purchase proposal (#2380)', () => {
  const dbName = `crove_test_anomaly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();
  const users = { owner: '', admin: '', approver: '' };
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

  async function ingest(userId: string, bytes: Uint8Array, filename: string, contentType: string, legalEntityId?: string) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    return rt.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      { filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', ...(legalEntityId ? { legalEntityId } : {}) },
      { actor: asUser(userId), orgId },
    );
  }
  const pdfOf = (number: string) => new TextEncoder().encode(`%PDF-1.4 hoa don ${number} ${randomUUID()}`);

  const proposals = (number: string) =>
    admin(async (c) => (await c.query<Row>(`SELECT id, status, revision, source_file_id, extraction_id, duplicate_of, legal_entity_id, authors, payload FROM crove_kernel.proposal WHERE org_id = $1 AND payload #>> '{invoice,number}' = $2 ORDER BY created_at`, [orgId, number])).rows);
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@original-attach.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có hóa đơn bất thường'));
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')`, [orgId, users.admin, users.approver]);
    });
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

  interface Detail {
    revision: number;
    status: string;
  }
  const detailOf = (userId: string, id: string) => rt.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(userId), orgId });
  // The seller's history: five invoices of the same vendor in the books, from one bank account, each about 1 980 000.
  const reading = (number: string, change: (invoice: ParsedInvoice) => void = () => {}) => ({
    fromText: async () => {
      const invoice = { ...structuredClone(PARSED), source: 'ai' as const, number };
      change(invoice);
      return invoice;
    },
    fromImage: async () => null,
  });
  const BANK = '0011000000000';
  // The same invoice with every amount multiplied, as a vendor billing far more for the same items.
  const times = (factor: number) => (invoice: ParsedInvoice) => {
    const scale = (value: string) => String(Number(value) * factor);
    invoice.subtotal = scale(invoice.subtotal);
    invoice.vatTotal = scale(invoice.vatTotal);
    invoice.total = scale(invoice.total);
    invoice.taxBreakdown = invoice.taxBreakdown.map((t) => ({ ...t, taxableAmount: scale(t.taxableAmount), vatAmount: scale(t.vatAmount) }));
    for (const line of invoice.lines) {
      line.amount = scale(line.amount);
      if (line.unitPrice !== null) line.unitPrice = scale(line.unitPrice);
    }
  };
  const withBank = (account: string) => (invoice: ParsedInvoice) => {
    invoice.seller = { ...invoice.seller, bankAccount: account };
  };

  // Reads a PDF into a pending proposal with its discount line classified, and leaves it for a decision.
  async function propose(number: string, change: (invoice: ParsedInvoice) => void) {
    const { fileId } = await ingest(users.owner, pdfOf(number), `hd-${number}.pdf`, 'application/pdf');
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: reading(number, change) as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    const read = await detailOf(users.owner, proposalId as string);
    await rt.execute('kernel.proposal.edit', { id: proposalId, revision: read.revision, lineAccounts: [{ lineNo: 3, debitAccount: '6421' }] }, { actor: asUser(users.owner), orgId });
    return proposalId as string;
  }
  const approveOne = async (id: string) => {
    const detail = await detailOf(users.approver, id);
    return rt.execute('kernel.proposal.approve', { id, revision: detail.revision, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId });
  };
  const checksOf = (id: string) =>
    admin(async (c) => (await c.query<{ checks: Array<{ id: string; status: string; code: string; params?: Record<string, string> }> }>(`SELECT payload -> 'checks' AS checks FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]?.checks ?? []);
  const anomalies = async (id: string) => (await checksOf(id)).filter((c) => c.id.startsWith('anomaly'));

  it('raises nothing for the first invoices of a vendor, while its history builds up', async () => {
    for (let n = 1; n <= 5; n++) {
      const id = await propose(`870${n}`, withBank(BANK));
      expect(await anomalies(id), `invoice ${n}`).toEqual([]);
      await approveOne(id);
    }
    expect(await admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_finance.purchase_document WHERE org_id = $1`, [orgId])).rows[0]?.n))).toBe(5);
  });

  it('raises nothing on an invoice like the earlier ones', async () => {
    const id = await propose('8710', withBank(BANK));
    expect(await anomalies(id)).toEqual([]);
    await approveOne(id);
  });

  let flagged = '';
  let normal = '';

  it('flags a new bank account, an unusual amount and a price jump, as warnings with their reasons and no figure of an account', async () => {
    flagged = await propose('8720', (invoice) => {
      times(4)(invoice);
      withBank('0987654321')(invoice);
    });
    const flags = await anomalies(flagged);
    expect(flags.map((c) => [c.id, c.status, c.code])).toEqual([
      ['anomaly_bank', 'warn', 'anomaly_bank.changed'],
      ['anomaly_amount', 'warn', 'anomaly_amount.unusual'],
      ['anomaly_price', 'warn', 'anomaly_price.jump'],
    ]);
    expect(flags[0]?.params).toEqual({ previous: '********0000', current: '******4321' });
    expect(flags[1]?.params).toMatchObject({ direction: 'high', count: '6' });
    expect(Number(flags[1]?.params?.total)).toBe(Number(flags[1]?.params?.usual) * 4);
    expect(flags[2]?.params).toMatchObject({ percent: '300' });
    // No account number is spelled out in the stored sentences.
    expect(JSON.stringify(flags)).not.toContain('0987654321');
    expect(JSON.stringify(flags)).not.toContain(BANK);
    // Warnings only: nothing fails, so an approver may still approve it (below).
    expect((await checksOf(flagged)).filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('lists the flags on the Inbox item, and leaves a normal invoice unflagged', async () => {
    normal = await propose('8730', withBank(BANK));
    const list = await rt.query<Array<{ id: string; anomalyChecks: number; warnChecks: number }>>('kernel.inbox.list', { status: 'pending' }, { actor: asUser(users.approver), orgId });
    expect(list.find((i) => i.id === flagged)).toMatchObject({ anomalyChecks: 3, warnChecks: expect.any(Number) });
    expect(list.find((i) => i.id === normal)?.anomalyChecks).toBe(0);
  });

  it('never approves a flagged proposal in bulk, whatever the client sends, and approves its normal neighbour', async () => {
    const items = [flagged, normal].map((id) => ({ id, revision: 1 }));
    const detailFlagged = await detailOf(users.approver, flagged);
    const detailNormal = await detailOf(users.approver, normal);
    const result = await rt.execute<{ results: Array<{ id: string; outcome: string; code?: string }> }>(
      'kernel.proposal.approve_many',
      { items: [{ id: flagged, revision: detailFlagged.revision, acceptUnverifiedSignature: true }, { id: normal, revision: detailNormal.revision, acceptUnverifiedSignature: true }] },
      { actor: asMfa(users.approver), orgId },
    );
    expect(items).toHaveLength(2);
    expect(result.results.find((r) => r.id === flagged)).toMatchObject({ outcome: 'refused', code: 'BULK_NOT_ALLOWED' });
    expect(result.results.find((r) => r.id === normal)).toMatchObject({ outcome: 'approved' });
    expect((await proposals('8720'))[0]?.status).toBe('pending');
  });

  it('lets a person approve the flagged proposal on its own: the flags warn, they do not block', async () => {
    const approved = await approveOne(flagged);
    expect(approved).toMatchObject({ documentId: expect.any(String) });
    expect((await proposals('8720'))[0]?.status).toBe('executed');
  });
});
