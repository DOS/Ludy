// SPDX-License-Identifier: AGPL-3.0-only
// The seller's original XML that arrives while the same invoice's PDF reading is still pending (#2269, plan
// docs/plan/einvoice-lookup.md section 7) on PostgreSQL 17: the XML revises that proposal instead of becoming its duplicate
// (one pending proposal, revision 2 from the XML, the XML's uploader among its authors, both files showing it), reading the
// PDF again does not put the weaker reading back, the posting names the XML as its source file and happens once; and the
// cases that stay as they were: a PDF proposal already posted, one in another legal entity, one rejected, and the same XML
// twice. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
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

suite('the original XML after the PDF on PostgreSQL (#2269)', () => {
  const dbName = `crove_test_xml_after_pdf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();
  const users = { owner: '', admin: '', approver: '' };
  let orgId = '';
  let branch = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  // crove-extract answers the XML for real; a PDF's text is a stub, and the AI reading of it is the fixture invoice.
  const real = inProcessExtract();
  const extract: ExtractClient = {
    extract: async (kind, bytes) => (kind === 'pdf_text' ? ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 } as never) : real.extract(kind, bytes)),
  };
  const reader = (number: string) => ({
    fromText: async () => ({ ...structuredClone(PARSED), source: 'ai' as const, number }),
    fromImage: async () => null,
  });

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
  const xmlOf = (number: string) => new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));
  const pdfOf = (number: string) => new TextEncoder().encode(`%PDF-1.4 hoa don ${number} ${randomUUID()}`);

  // Reads the PDF as the AI would (a proposal), as `by`.
  async function readPdf(number: string, by = users.owner, legalEntityId?: string) {
    const { fileId } = await ingest(by, pdfOf(number), `hd-${number}.pdf`, 'application/pdf', legalEntityId);
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: reader(number) as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    return { fileId, proposalId: proposalId as string };
  }
  async function readXml(number: string, by = users.admin, legalEntityId?: string) {
    const { fileId } = await ingest(by, xmlOf(number), `hd-${number}.xml`, 'application/xml', legalEntityId);
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    return { fileId, proposalId: proposalId as string };
  }
  const proposals = (number: string) =>
    admin(async (c) => (await c.query<Row>(`SELECT id, status, revision, source_file_id, extraction_id, duplicate_of, legal_entity_id, authors, payload FROM crove_kernel.proposal WHERE org_id = $1 AND payload #>> '{invoice,number}' = $2 ORDER BY created_at`, [orgId, number])).rows);
  const fileStatus = async (userId: string, fileId: string) =>
    (await rt.query<Array<{ id: string; status: string; proposalId: string | null }>>('kernel.files.recent', {}, { actor: asUser(userId), orgId })).find((f) => f.id === fileId);
  const activityKinds = (proposalId: string) =>
    admin(async (c) => (await c.query<{ kind: string }>(`SELECT kind FROM crove_kernel.activity WHERE org_id = $1 AND record_type = 'kernel.proposal' AND record_id = $2 ORDER BY occurred_at`, [orgId, proposalId])).rows.map((r) => r.kind));

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
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@xml-after-pdf.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có hóa đơn gốc đến sau'));
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')`, [orgId, users.admin, users.approver]);
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id as string;
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

  it('revises the pending PDF proposal from the XML: one proposal, revision 2, no duplicate flag, the uploaders as authors', async () => {
    const pdf = await readPdf('5001');
    const before = (await proposals('5001'))[0] as Row;
    expect(before).toMatchObject({ status: 'pending', revision: 1, source_file_id: pdf.fileId });
    expect(before.payload.extractionMethod).toBe('pdf_text_ai');

    const xml = await readXml('5001');
    // The same proposal, not a second one.
    expect(xml.proposalId).toBe(pdf.proposalId);
    const after = await proposals('5001');
    expect(after).toHaveLength(1);
    const [proposal] = after as [Row];
    expect(proposal).toMatchObject({ status: 'pending', revision: 2, duplicate_of: null, source_file_id: pdf.fileId });
    expect(proposal.payload.extractionMethod).toBe('einvoice_xml');
    expect(proposal.payload.checks.map((c) => c.code)).not.toContain('duplicate.found');
    // The signature check of the original is on it: the point of fetching the XML.
    expect(proposal.payload.checks.some((c) => c.id === 'signature')).toBe(true);
    // The XML is the document's source file once it is posted, and its run is the proposal's current reading.
    const xmlRun = await admin(async (c) => (await c.query<{ file_id: string }>('SELECT file_id FROM crove_kernel.extraction WHERE org_id = $1 AND id = $2', [orgId, proposal.extraction_id])).rows[0]);
    expect(xmlRun?.file_id).toBe(xml.fileId);
    expect(proposal.payload.sourceFileId).toBe(xml.fileId);
    // P10: who uploaded the original is an author, besides who uploaded the PDF and the readers.
    const authorIds = proposal.authors.map((a) => a.id);
    expect(authorIds).toEqual(expect.arrayContaining([users.owner, users.admin]));
    expect(await activityKinds(proposal.id)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.original_received']));
    // Both files show the one proposal.
    for (const [user, file] of [[users.owner, pdf.fileId], [users.admin, xml.fileId]] as const) {
      expect(await fileStatus(user, file), file).toMatchObject({ status: 'proposed', proposalId: proposal.id });
    }
  });

  it('makes a decision taken on the PDF reading stale: the approver who saw revision 1 must look again', async () => {
    const pdf = await readPdf('5008');
    const seen = await rt.query<{ revision: number }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.approver), orgId });
    expect(seen.revision).toBe(1);
    await readXml('5008');
    await expect(
      rt.execute('kernel.proposal.approve', { id: pdf.proposalId, revision: seen.revision, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(rt.execute('kernel.proposal.reject', { id: pdf.proposalId, reason: 'x' }, { actor: asUser(users.approver), orgId })).resolves.toEqual({ ok: true });
    expect(((await proposals('5008')) as Row[])[0]).toMatchObject({ status: 'rejected', revision: 2 });
  });

  it('does not let a re-reading of the PDF put the weaker reading back, and re-reads the XML instead', async () => {
    const pdf = await readPdf('5002');
    await readXml('5002');
    await expect(rt.execute('kernel.file.reextract', { fileId: pdf.fileId }, { actor: asUser(users.owner), orgId })).rejects.toMatchObject({ code: 'READ_FROM_ORIGINAL' });
    const [proposal] = (await proposals('5002')) as [Row];
    expect(proposal).toMatchObject({ revision: 2 });
    expect(proposal.payload.extractionMethod).toBe('einvoice_xml');
  });

  it('holds decisions while the original is read again, offers the re-read of the original and not the PDF one, and revises the proposal from it', async () => {
    const pdf = await readPdf('5009');
    const xml = await readXml('5009');
    // After the upgrade only the original can be read again: the proposal's own reading is the XML's.
    const detail = () => rt.query<{ canReextract: boolean; extraction: { inFlight: boolean } | null; revision: number }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.owner), orgId });
    expect((await detail()).canReextract).toBe(false);
    const rows = await rt.query<Array<{ id: string; canReextract: boolean }>>('kernel.files.recent', {}, { actor: asUser(users.owner), orgId });
    expect(rows.find((f) => f.id === pdf.fileId)?.canReextract).toBe(false);
    expect(rows.find((f) => f.id === xml.fileId)?.canReextract).toBe(true);
    // The re-read of the original is in flight: the proposal it will revise can be neither rejected nor edited nor approved.
    const asked = await rt.execute<{ version: number }>('kernel.file.reextract', { fileId: xml.fileId }, { actor: asUser(users.owner), orgId });
    expect((await detail()).extraction?.inFlight).toBe(true);
    await expect(rt.execute('kernel.proposal.reject', { id: pdf.proposalId, reason: 'x' }, { actor: asUser(users.approver), orgId })).rejects.toMatchObject({ code: 'EXTRACTION_PENDING' });
    const seen = (await detail()).revision;
    await expect(
      rt.execute('kernel.proposal.approve', { id: pdf.proposalId, revision: seen, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_PENDING' });
    // It finishes: the same proposal, revision 3, from the original again; no second proposal.
    const done = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, xml.fileId, asked.version);
    expect(done.proposalId).toBe(pdf.proposalId);
    const all = await proposals('5009');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'pending', revision: 3 });
    expect(all[0]?.payload.extractionMethod).toBe('einvoice_xml');
  });

  it('leaves the revision alone when a re-read of the PDF that was already running finishes after the original took its place', async () => {
    const pdf = await readPdf('5011');
    const asked = await rt.execute<{ version: number }>('kernel.file.reextract', { fileId: pdf.fileId }, { actor: asUser(users.owner), orgId });
    // The original arrives while the PDF is being read again.
    await readXml('5011');
    expect(((await proposals('5011')) as Row[])[0]).toMatchObject({ revision: 2 });
    await extractAndPropose({ runtime: worker, store, extractor: reader('5011') as never, extract, today: () => '2026-10-13' }, orgId, pdf.fileId, asked.version);
    const [proposal] = (await proposals('5011')) as [Row];
    expect(await proposals('5011')).toHaveLength(1);
    expect(proposal).toMatchObject({ status: 'pending', revision: 2 });
    expect(proposal.payload.extractionMethod).toBe('einvoice_xml');
  });

  it('reports the run of the original while it is read again, and allows the PDF to be read again once the proposal is decided', async () => {
    const pdf = await readPdf('5012');
    const xml = await readXml('5012');
    const asked = await rt.execute<{ version: number }>('kernel.file.reextract', { fileId: xml.fileId }, { actor: asUser(users.owner), orgId });
    const during = await rt.query<{ extraction: { version: number; inFlight: boolean } | null }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.owner), orgId });
    // The XML's second run (version 2), not the PDF's first.
    expect(during.extraction).toMatchObject({ version: asked.version, inFlight: true });
    await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, xml.fileId, asked.version);
    await rt.execute('kernel.proposal.reject', { id: pdf.proposalId, reason: 'x' }, { actor: asUser(users.approver), orgId });
    const after = await rt.query<{ canReextract: boolean }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.owner), orgId });
    expect(after.canReextract).toBe(true);
  });

  it('flags the original instead of replacing what a person chose on the PDF reading', async () => {
    const pdf = await readPdf('5010');
    const seen = await rt.query<{ revision: number }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.owner), orgId });
    // The account the person picks for line 1: the other of the two the reading could have chosen, so the edit changes something.
    const first = ((await proposals('5010'))[0] as unknown as { payload: { lines: Array<{ debitAccount: string }> } }).payload.lines[0]?.debitAccount;
    const picked = first === '6421' ? '6422' : '6421';
    await rt.execute('kernel.proposal.edit', { id: pdf.proposalId, revision: seen.revision, lineAccounts: [{ lineNo: 1, debitAccount: picked }] }, { actor: asUser(users.owner), orgId });
    const xml = await readXml('5010');
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    const all = await proposals('5010');
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.id === pdf.proposalId)).toMatchObject({ status: 'pending', revision: 2 });
    expect((all.find((p) => p.id === xml.proposalId) as Row).payload.checks.map((c) => c.code)).toContain('duplicate.found');
  });

  it('posts the revised proposal once, naming the XML as the source file of the document', async () => {
    const pdf = await readPdf('5003');
    const xml = await readXml('5003');
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.approver), orgId });
    // The uploaders are authors: a third person approves (P10).
    const done = await rt.execute<{ journalEntryId: string; documentId: string }>('kernel.proposal.approve', { id: pdf.proposalId, revision: detail.revision, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId });
    expect(done.journalEntryId).toEqual(expect.any(String));
    const documents = await admin(async (c) => (await c.query<{ source_file_id: string }>(`SELECT source_file_id FROM crove_finance.purchase_document WHERE org_id = $1 AND invoice_number = '5003'`, [orgId])).rows);
    expect(documents).toEqual([{ source_file_id: xml.fileId }]);
    expect(await fileStatus(users.owner, pdf.fileId)).toMatchObject({ status: 'proposed' });
  });

  it('keeps a posted PDF invoice as it was: the XML after it is a duplicate, flagged, and nothing is posted twice', async () => {
    const pdf = await readPdf('5004');
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: pdf.proposalId }, { actor: asUser(users.approver), orgId });
    await rt.execute('kernel.proposal.approve', { id: pdf.proposalId, revision: detail.revision, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId });
    const xml = await readXml('5004');
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    const all = await proposals('5004');
    expect(all).toHaveLength(2);
    const second = all.find((p) => p.id === xml.proposalId) as Row;
    expect(second.duplicate_of).toBe(pdf.proposalId);
    expect(second.payload.checks.map((c) => c.code)).toContain('duplicate.found');
    expect(all.find((p) => p.id === pdf.proposalId)).toMatchObject({ status: 'executed', revision: 1 });
  });

  it('leaves a PDF proposal of another legal entity alone', async () => {
    const pdf = await readPdf('5005', users.owner, branch);
    const xml = await readXml('5005', users.admin);
    // The original was uploaded for the default entity: a proposal stays in its entity, so this is a second proposal, flagged.
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    const all = await proposals('5005');
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.id === pdf.proposalId)).toMatchObject({ revision: 1, status: 'pending' });
    expect((all.find((p) => p.id === xml.proposalId) as Row).payload.checks.map((c) => c.code)).toContain('duplicate.found');
  });

  it('keeps the original flagged when the invoice has another pending proposal besides the PDF reading', async () => {
    const pdf = await readPdf('5013');
    // A second reading of the same invoice from another PDF (flagged as a duplicate of the first), then the original.
    const other = await readPdf('5013');
    expect(other.proposalId).not.toBe(pdf.proposalId);
    const xml = await readXml('5013');
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    expect(xml.proposalId).not.toBe(other.proposalId);
    expect(((await proposals('5013')) as Row[]).filter((p) => p.payload.extractionMethod === 'pdf_text_ai').map((p) => p.revision)).toEqual([1, 1]);
  });

  it('does not revise a rejected PDF proposal: the XML is a new proposal, not a duplicate', async () => {
    const pdf = await readPdf('5006');
    await rt.execute('kernel.proposal.reject', { id: pdf.proposalId, reason: 'đọc sai' }, { actor: asUser(users.approver), orgId });
    const xml = await readXml('5006');
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    const all = await proposals('5006');
    expect(all).toHaveLength(2);
    expect((all.find((p) => p.id === xml.proposalId) as Row)).toMatchObject({ status: 'pending', revision: 1, duplicate_of: null });
  });

  it('keeps the same XML twice a duplicate file: nothing is revised twice', async () => {
    const pdf = await readPdf('5007');
    const first = await readXml('5007');
    expect(first.proposalId).toBe(pdf.proposalId);
    // The same bytes again are the same file (kernel.file.ingest deduplicates by content hash).
    const again = await ingest(users.admin, xmlOf('5007'), 'hd-5007-again.xml', 'application/xml');
    expect(again.duplicate).toBe(true);
    expect(((await proposals('5007')) as Row[])[0]).toMatchObject({ revision: 2 });
  });
});
