// SPDX-License-Identifier: AGPL-3.0-only
// The seller's original XML that arrives after its invoice was posted from a PDF (#2320, the posted half of #2269; plan
// docs/plan/einvoice-lookup.md section 7) on PostgreSQL 17: it is attached to the posted proposal as evidence, never read
// into a second proposal and never posted again; the entry and the document are not touched; a difference in the amounts is
// a warning a person sees, not a correction; reading the attached file again is refused; and the cases that stay as they
// were (another legal entity, the invoice with two matches). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
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
import { enterUser } from './context-token.ts';
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

suite('the original XML after the posting on PostgreSQL (#2320)', () => {
  const dbName = `crove_test_original_attach_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@original-attach.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có hóa đơn gốc đến sau khi ghi sổ'));
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

  interface Original {
    fileId: string;
    filename: string;
    differs: boolean;
    signature: { status: string } | null;
  }
  interface Detail {
    revision: number;
    status: string;
    originals: Original[];
    canReextract: boolean;
  }
  const detailOf = (userId: string, id: string) => rt.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(userId), orgId });
  const runOf = (fileId: string) =>
    admin(async (c) =>
      (await c.query<{ original_of_proposal_id: string | null; original_differs: boolean | null; status: string; method: string }>(
        'SELECT original_of_proposal_id, original_differs, status, method FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2 ORDER BY version',
        [orgId, fileId],
      )).rows,
    );
  // The books as they stand: the invoice's document and the totals of every entry of the org (nothing else posts here
  // while a test runs), so a second posting or any change would show.
  const ledger = (number: string) =>
    admin(async (c) => ({
      documents: (
        await c.query<{ id: string; source_file_id: string; proposal_id: string; subtotal: string; vat_amount: string; total: string }>(
          `SELECT id, source_file_id, proposal_id, subtotal::text, vat_amount::text, total::text FROM crove_finance.purchase_document WHERE org_id = $1 AND invoice_number = $2 ORDER BY id`,
          [orgId, number],
        )
      ).rows,
      entries: (await c.query<{ entries: string; debit: string }>(`SELECT (SELECT count(*) FROM crove_finance.journal_entry WHERE org_id = $1)::text AS entries, (SELECT coalesce(sum(debit), 0) FROM crove_finance.journal_line WHERE org_id = $1)::text AS debit`, [orgId])).rows[0],
    }));
  const documentCount = (number: string) =>
    admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_finance.purchase_document WHERE org_id = $1 AND invoice_number = $2`, [orgId, number])).rows[0]?.n));

  // Reads and approves the PDF of an invoice: the posting an original comes after.
  async function postPdf(number: string, by = users.owner, legalEntityId?: string, reading = reader(number), exchangeRate?: string) {
    const { fileId } = await ingest(by, pdfOf(number), `hd-${number}.pdf`, 'application/pdf', legalEntityId);
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: reading as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    // A fresh org has no rule for the discount line: the person who uploaded it picks its account, a third person approves.
    const read = await detailOf(users.owner, proposalId as string);
    await rt.execute('kernel.proposal.edit', { id: proposalId, revision: read.revision, lineAccounts: [{ lineNo: 3, debitAccount: '6421' }], ...(exchangeRate ? { exchangeRate } : {}) }, { actor: asUser(by), orgId });
    const detail = await detailOf(users.approver, proposalId as string);
    await rt.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId });
    return { fileId, proposalId: proposalId as string };
  }

  it('attaches the original to the posted proposal: no second proposal, no second posting, the books untouched', async () => {
    const pdf = await postPdf('6001');
    const before = await ledger('6001');
    expect(before.documents).toHaveLength(1);

    const xml = await readXml('6001');
    // Nothing of its own: the run is the evidence of the posted proposal.
    expect(xml.proposalId).toBeNull();
    const all = await proposals('6001');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: pdf.proposalId, status: 'executed', duplicate_of: null });
    expect(await runOf(xml.fileId)).toEqual([{ original_of_proposal_id: pdf.proposalId, original_differs: false, status: 'done', method: 'einvoice_xml' }]);
    // The entry and the document are exactly as they were (the document still names the PDF as its source).
    expect(await ledger('6001')).toEqual(before);
    expect(before.documents[0]?.source_file_id).toBe(pdf.fileId);
    expect(await activityKinds(pdf.proposalId)).toContain('proposal.original_attached');
    // Both files show the one proposal, executed; the original cannot be read again.
    expect(await fileStatus(users.owner, pdf.fileId)).toMatchObject({ status: 'proposed', proposalId: pdf.proposalId });
    expect(await fileStatus(users.admin, xml.fileId)).toMatchObject({ status: 'proposed', proposalId: pdf.proposalId });
    const files = await rt.query<Array<{ id: string; canReextract: boolean }>>('kernel.files.recent', {}, { actor: asUser(users.owner), orgId });
    expect(files.find((f) => f.id === xml.fileId)?.canReextract).toBe(false);
    await expect(rt.execute('kernel.file.reextract', { fileId: xml.fileId }, { actor: asUser(users.owner), orgId })).rejects.toMatchObject({ code: 'PROPOSAL_DECIDED' });
    // The posted proposal's screen lists the original, its signature result and that its amounts match.
    const detail = await detailOf(users.owner, pdf.proposalId);
    expect(detail.originals).toEqual([expect.objectContaining({ fileId: xml.fileId, filename: 'hd-6001.xml', differs: false })]);
    expect(detail.originals[0]?.signature).not.toBeNull();
  });

  it('warns a person when the original amounts are not the posted ones, and changes nothing in the books', async () => {
    // The PDF was read with a total the seller did not issue (a smaller discount); the original has the real one.
    const wrong = (number: string) => ({
      fromText: async () => {
        // A smaller discount, consistently: subtotal 1900000, VAT 190000, total 2090000 (the original says 1980000).
        const invoice = { ...structuredClone(PARSED), source: 'ai' as const, number, subtotal: '1900000', vatTotal: '190000', total: '2090000' };
        const discount = invoice.lines.find((l) => l.nature === 'discount');
        if (discount) discount.amount = '100000';
        invoice.taxBreakdown = [{ rate: '10%', taxableAmount: '1900000', vatAmount: '190000' }];
        return invoice;
      },
      fromImage: async () => null,
    });
    const pdf = await postPdf('6002', users.owner, undefined, wrong('6002'));
    const before = await ledger('6002');
    const xml = await readXml('6002');
    expect(xml.proposalId).toBeNull();
    expect(await proposals('6002')).toHaveLength(1);
    expect((await runOf(xml.fileId))[0]).toMatchObject({ original_of_proposal_id: pdf.proposalId, original_differs: true });
    // Never corrected by itself: the entry and the document are as posted.
    expect(await ledger('6002')).toEqual(before);
    expect(before.documents[0]?.total).toMatch(/^2090000(\.0+)?$/);
    expect((await detailOf(users.owner, pdf.proposalId)).originals[0]).toMatchObject({ fileId: xml.fileId, differs: true });
    const activity = await admin(async (c) => (await c.query<{ summary: string }>(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'proposal.original_attached'`, [orgId, pdf.proposalId])).rows);
    expect(activity[0]?.summary).toContain('KHÁC');
  });

  it('keeps every original that comes: a second XML of the invoice is attached too', async () => {
    const pdf = await postPdf('6003');
    const first = await readXml('6003');
    // The same invoice in other bytes (another file): attached as well, newest first.
    const bytes = new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>6003</SHDon>') + '\n<!-- again -->');
    const { fileId } = await ingest(users.admin, bytes, 'hd-6003-b.xml', 'application/xml');
    const second = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    expect(second.proposalId).toBeNull();
    expect(await proposals('6003')).toHaveLength(1);
    expect((await detailOf(users.owner, pdf.proposalId)).originals.map((o) => o.fileId)).toEqual([fileId, first.fileId]);
    expect(await documentCount('6003')).toBe(1);
  });

  it('attaches only inside the same legal entity: an original uploaded for another entity is flagged as before', async () => {
    const pdf = await postPdf('6004', users.owner, branch);
    // The original was uploaded for the default entity: a proposal stays in its entity, so the original is a second
    // proposal there, flagged as the duplicate it is.
    const xml = await readXml('6004', users.admin);
    expect(xml.proposalId).not.toBeNull();
    expect(xml.proposalId).not.toBe(pdf.proposalId);
    const all = await proposals('6004');
    expect(all).toHaveLength(2);
    expect((all.find((p) => p.id === xml.proposalId) as Row).payload.checks.map((c) => c.code)).toContain('duplicate.found');
    expect((await runOf(xml.fileId))[0]).toMatchObject({ original_of_proposal_id: null, original_differs: null });
    expect((await detailOf(users.owner, pdf.proposalId)).originals).toEqual([]);
  });

  it('flags the original instead when the invoice has more than one match', async () => {
    // Two PDFs of one invoice, both read; the first posted. The XML finds two proposals of the invoice, so it is not
    // attached to either: it is a flagged proposal for a person to sort out.
    const pdf = await postPdf('6005');
    const { fileId } = await ingest(users.owner, pdfOf('6005'), 'hd-6005-b.pdf', 'application/pdf');
    const second = await extractAndPropose({ runtime: worker, store, extractor: reader('6005') as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    expect(second.proposalId).not.toBe(pdf.proposalId);
    const xml = await readXml('6005');
    expect(xml.proposalId).not.toBeNull();
    expect((await runOf(xml.fileId))[0]).toMatchObject({ original_of_proposal_id: null });
    expect(await documentCount('6005')).toBe(1);
  });

  it('refuses a run whose shape says it is the original of a proposal but is not a finished XML reading', async () => {
    const pdf = await postPdf('6006');
    const { fileId } = await ingest(users.owner, pdfOf('6006b'), 'hd-6006b.pdf', 'application/pdf');
    // The database itself refuses the shape: an original is an e-invoice XML run that is done, and the two columns go together.
    await expect(
      admin((c) =>
        c.query(`INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, original_of_proposal_id, original_differs, completed_at) VALUES ($1, $2, 'pdf_text_ai', 'done', $3, false, now())`, [orgId, fileId, pdf.proposalId]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin((c) => c.query(`INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, original_of_proposal_id, completed_at) VALUES ($1, $2, 'einvoice_xml', 'done', $3, now())`, [orgId, fileId, pdf.proposalId])),
    ).rejects.toMatchObject({ code: '23514' });
    // And it must name a proposal of the same org.
    await expect(
      admin((c) =>
        c.query(`INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, original_of_proposal_id, original_differs, completed_at) VALUES ($1, $2, 'einvoice_xml', 'done', $3, false, now())`, [orgId, fileId, randomUUID()]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('compares a foreign-currency invoice in its own currency: another rate in dong is not a difference', async () => {
    const thousandth = (v: string) => String(Number(v) / 1000);
    // The invoice in USD, 1/1000 of the fixture's amounts; a person entered 24500 on the PDF reading, the original says 25000.
    const usdReading = (number: string) => ({
      fromText: async () => {
        const invoice = { ...structuredClone(PARSED), source: 'ai' as const, number, currency: 'USD' };
        invoice.subtotal = thousandth(invoice.subtotal);
        invoice.vatTotal = thousandth(invoice.vatTotal);
        invoice.total = thousandth(invoice.total);
        for (const l of invoice.lines) {
          l.amount = thousandth(l.amount);
          if (l.unitPrice) l.unitPrice = thousandth(l.unitPrice);
        }
        invoice.taxBreakdown = invoice.taxBreakdown.map((t) => ({ ...t, taxableAmount: thousandth(t.taxableAmount), vatAmount: thousandth(t.vatAmount) }));
        return invoice;
      },
      fromImage: async () => null,
    });
    const pdf = await postPdf('6008', users.owner, undefined, usdReading('6008'), '24500');
    const before = await ledger('6008');
    const usdXml = FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>6008</SHDon>')
      .replace('<DVTTe>VND</DVTTe>', '<DVTTe>USD</DVTTe>')
      .replace('<TGia>1</TGia>', '<TGia>25000</TGia>')
      .replace(/<DGia>(\d+)<\/DGia>/g, (_m, v: string) => `<DGia>${thousandth(v)}</DGia>`)
      .replace(/<ThTien>(\d+)<\/ThTien>/g, (_m, v: string) => `<ThTien>${thousandth(v)}</ThTien>`)
      .replace(/<(TThue|TgTCThue|TgTThue|TgTTTBSo)>(\d+)<\/\1>/g, (_m, tag: string, v: string) => `<${tag}>${thousandth(v)}</${tag}>`);
    const { fileId } = await ingest(users.admin, new TextEncoder().encode(usdXml), 'hd-6008.xml', 'application/xml');
    const read = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    expect(read.proposalId).toBeNull();
    expect((await runOf(fileId))[0]).toMatchObject({ original_of_proposal_id: pdf.proposalId, original_differs: false });
    expect(await ledger('6008')).toEqual(before);
  });

  it('flags the original instead of attaching it when the original has a failing check', async () => {
    const pdf = await postPdf('6009');
    // The totals do not add up: a check fails, so the file is not the invoice's evidence but a flagged proposal.
    const broken = FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>6009</SHDon>').replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1990000</TgTTTBSo>');
    const { fileId } = await ingest(users.admin, new TextEncoder().encode(broken), 'hd-6009.xml', 'application/xml');
    const read = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    expect((await runOf(fileId))[0]).toMatchObject({ original_of_proposal_id: null });
    expect(await documentCount('6009')).toBe(1);
    expect((await detailOf(users.owner, pdf.proposalId)).originals).toEqual([]);
    // Whatever the reader made of it, it is not attached and nothing is posted twice.
    expect(read.proposalId === null || read.proposalId !== pdf.proposalId).toBe(true);
  });

  it('lets only the system context insert a run that names a proposal: a member context cannot fake the evidence', async () => {
    const pdf = await postPdf('6010');
    const { fileId } = await ingest(users.owner, pdfOf('6010b'), 'hd-6010b.pdf', 'application/pdf');
    const insert = `INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, original_of_proposal_id, original_differs, completed_at) VALUES ($1, $2, 'einvoice_xml', 'done', $3, false, now())`;
    // A user context of the tenant role (owner and an admin) is refused by the guard, whatever its role in the org.
    for (const userId of [users.owner, users.admin]) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, userId, orgId);
        await expect(c.query(insert, [orgId, fileId, pdf.proposalId])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EXTRACTION_ORIGINAL_SYSTEM_ONLY') });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    // The system context (the worker) may.
    const system = await workerPool.connect();
    try {
      await system.query('BEGIN');
      await system.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      await expect(system.query(insert, [orgId, fileId, pdf.proposalId])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await system.query('ROLLBACK');
      system.release();
    }
  });

  it('never changes the attachment once the run is finished', async () => {
    const pdf = await postPdf('6007');
    const xml = await readXml('6007');
    await expect(
      admin((c) => c.query(`UPDATE crove_kernel.extraction SET original_differs = true WHERE org_id = $1 AND file_id = $2`, [orgId, xml.fileId])),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await runOf(xml.fileId))[0]).toMatchObject({ original_of_proposal_id: pdf.proposalId, original_differs: false });
  });
});
