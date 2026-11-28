// SPDX-License-Identifier: AGPL-3.0-only
// Purchase document due_date end-to-end on PostgreSQL 17 (#4395): XML extraction into purchase proposals (never
// sales), editing and clearing dueDate on pending proposals with P10 four-eyes and RBAC/tenancy guards, persisting
// onto append-only ludy_finance.purchase_document, returning dueDate in finance.documents.list/get, and enforcing DB
// check constraints and append-only immutability.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import type { ExtractClient } from '@ludy/extract-contract';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@ludy/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
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

suite('purchase payment due_date (#4395)', () => {
  const dbName = `ludy_test_due_date_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let db: Db;
  let extract: ExtractClient;
  const store = new MemoryStore();

  let orgA = '';
  let orgB = '';
  let owner = '';
  let adminUser = '';
  let viewer = '';
  let outsider = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function ingestAndPropose(orgId: string, userId: string, number: string, extraXml = '', sellerTaxCode = '0101234564') {
    const xml = FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)
      .replace('<MST>0101234564</MST>', `<MST>${sellerTaxCode}</MST>`)
      .replace('<HTTToan>TM/CK</HTTToan>', `<HTTToan>TM/CK</HTTToan>${extraXml}`);
    const bytes = new TextEncoder().encode(xml);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `hd-${number}.xml`, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(userId), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    if (!proposalId) throw new Error('expected proposal');
    const detail = await runtime.query<{ revision: number; payload: { direction?: string; invoice: { issueDate: string; dueDate?: string | null } } }>(
      'kernel.inbox.get',
      { id: proposalId },
      { actor: asUser(userId), orgId },
    );
    return { id: proposalId, detail };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const login = (u: string, p: string) => {
      const uUrl = new URL(adminUrl);
      uUrl.username = u;
      uUrl.password = p;
      return uUrl.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    db = createDb(pool);
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db);
    workerRuntime = register(createDb(workerPool));

    owner = await upsertIdentity(db, { issuer: 'test', subject: 'owner', email: 'owner@due.test', name: 'Owner' });
    adminUser = await upsertIdentity(db, { issuer: 'test', subject: 'admin', email: 'admin@due.test', name: 'Admin' });
    viewer = await upsertIdentity(db, { issuer: 'test', subject: 'viewer', email: 'viewer@due.test', name: 'Viewer' });
    outsider = await upsertIdentity(db, { issuer: 'test', subject: 'outsider', email: 'outsider@due.test', name: null });

    orgA = (await createOrg(runtime, asUser(owner), 'Cong ty Due Date A')).orgId;
    orgB = (await createOrg(runtime, asUser(outsider), 'Cong ty Due Date B')).orgId;

    const addMember = async (uid: string, email: string, role: 'admin' | 'viewer') => {
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(owner), orgId: orgA });
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(uid) });
    };
    await addMember(adminUser, 'admin@due.test', 'admin');
    await addMember(viewer, 'viewer@due.test', 'viewer');

    await runtime.execute('kernel.org.set_tax_code', { taxCode: '0101234569' }, { actor: asMfa(owner), orgId: orgA });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('propagates XML dueDate onto purchase proposals, allows pre-approval edits/clears, persists on record, and enforces append-only', async () => {
    const { id, detail } = await ingestAndPropose(orgA, owner, '9001', '<HanThanhToan>2026-10-20</HanThanhToan>');
    expect(detail.payload.invoice.dueDate).toBe('2026-10-20');

    // Viewer and outsider cannot edit.
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, dueDate: '2026-10-25' }, { actor: asUser(viewer), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, dueDate: '2026-10-25' }, { actor: asUser(outsider), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, dueDate: '2026-10-25' }, { actor: asUser(outsider), orgId: orgB }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Invalid due date (< issueDate 2026-09-15) fails with 422 INVALID_DUE_DATE.
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, dueDate: '2026-09-10' }, { actor: asUser(owner), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'INVALID_DUE_DATE', status: 422 });

    // No-op due date keeps revision unchanged.
    const same = await runtime.execute<{ revision: number; changed: boolean }>(
      'kernel.proposal.edit',
      { id, revision: 1, dueDate: '2026-10-20' },
      { actor: asUser(owner), orgId: orgA },
    );
    expect(same).toEqual({ revision: 1, changed: false });

    // Edit creates revision 2 (admin cannot approve own edit if four-eyes, or owner edits & admin approves).
    const cleared = await runtime.execute<{ revision: number; changed: boolean }>(
      'kernel.proposal.edit',
      { id, revision: 1, dueDate: null },
      { actor: asUser(owner), orgId: orgA },
    );
    expect(cleared).toEqual({ revision: 2, changed: true });
    // Clearing when already null is a no-op.
    expect(
      await runtime.execute('kernel.proposal.edit', { id, revision: 2, dueDate: null }, { actor: asUser(owner), orgId: orgA }),
    ).toEqual({ revision: 2, changed: false });

    const setNew = await runtime.execute<{ revision: number; changed: boolean }>(
      'kernel.proposal.edit',
      { id, revision: 2, dueDate: '2026-11-01' },
      { actor: asUser(owner), orgId: orgA },
    );
    expect(setNew).toEqual({ revision: 3, changed: true });

    // P10 four-eyes: owner edited revision 3, so owner cannot approve it; admin can.
    await expect(
      runtime.execute('kernel.proposal.approve', { id, revision: 3, acceptUnverifiedSignature: true }, { actor: asMfa(owner), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    const recorded = await runtime.execute<{ documentId: string }>(
      'kernel.proposal.approve',
      { id, revision: 3, acceptUnverifiedSignature: true },
      { actor: asMfa(adminUser), orgId: orgA },
    );

    const docs = await runtime.query<Array<{ id: string; dueDate?: string | null }>>('finance.documents.list', {}, { actor: asUser(owner), orgId: orgA });
    expect(docs.find((d) => d.id === recorded.documentId)?.dueDate).toBe('2026-11-01');
    const docOne = await runtime.query<{ id: string; dueDate?: string | null }>('finance.documents.get', { id: recorded.documentId }, { actor: asUser(owner), orgId: orgA });
    expect(docOne.dueDate).toBe('2026-11-01');

    // Recorded purchase_document remains strictly append-only (no UPDATE or DELETE, even by superuser), and DB check constraint holds.
    await expect(
      withAdmin((c) => c.query("UPDATE ludy_finance.purchase_document SET due_date = '2026-12-01' WHERE id = $1", [recorded.documentId])),
    ).rejects.toThrow(/append-only/);
    await expect(
      withAdmin((c) => c.query('DELETE FROM ludy_finance.purchase_document WHERE id = $1', [recorded.documentId])),
    ).rejects.toThrow(/append-only/);
    const partyId = await withAdmin(
      async (c) => (await c.query<{ party_id: string }>('SELECT party_id FROM ludy_finance.purchase_document WHERE id = $1', [recorded.documentId])).rows[0]!.party_id,
    );
    await expect(
      withAdmin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(
            "INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, due_date, subtotal, vat_amount, total) VALUES ($1, $2, 'S', 'BAD', '2026-09-15', '2026-09-01', 100, 0, 100)",
            [orgA, partyId],
          );
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK').catch(() => {});
        }
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never propagates or allows dueDate on sales proposals and leaves sale due_date null', async () => {
    const { id, detail } = await ingestAndPropose(orgA, owner, '9002', '<HanThanhToan>2026-10-20</HanThanhToan>', '0101234569');
    expect(detail.payload.direction).toBe('sale');
    expect(detail.payload.invoice.dueDate ?? null).toBeNull();

    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, dueDate: '2026-10-20' }, { actor: asUser(owner), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'DUE_DATE_PURCHASE_ONLY', status: 422 });

    const recorded = await runtime.execute<{ documentId: string }>(
      'kernel.proposal.approve',
      { id, revision: 1, acceptUnverifiedSignature: true },
      { actor: asMfa(adminUser), orgId: orgA },
    );
    const doc = await runtime.query<{ dueDate?: string | null }>('finance.documents.get', { id: recorded.documentId }, { actor: asUser(owner), orgId: orgA });
    expect(doc.dueDate ?? null).toBeNull();
  });
});
