// Replacement and adjustment e-invoices (issue #916), on PostgreSQL 17, from the XML through crove-extract to the
// books: the proposal names the original and says whether it is in the books; approving a replacement reverses the
// original's entry and voids its document in the same transaction, so cost, input VAT and the payable count once; an
// adjustment is recorded with its signed difference and linked to the original, which stays in force; a correction
// whose original is not in the books is recorded alone, with a warning. The database refuses a link to a document of
// another invoice. The same holds when the org is the seller. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
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
const fixture = (name: string) => readFileSync(new URL(`../../extract/test/fixtures/${name}`, import.meta.url), 'utf8');
const BASIC = fixture('einvoice-basic.xml');
const REPLACEMENT = fixture('einvoice-replacement.xml');
const ADJUSTMENT = fixture('einvoice-adjustment.xml');

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

const suite = ADMIN ? describe : describe.skip;

suite('replacement and adjustment invoices (#916)', () => {
  const dbName = `ludy_test_corrections_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  let orgId = '';
  let owner = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function read(xml: string) {
    const bytes = new TextEncoder().encode(xml);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    return String(proposalId);
  }

  const detail = (id: string) =>
    runtime.query<{ payload: { invoice: { related?: unknown }; checks: Array<{ id: string; status: string; code?: string }> } }>('kernel.inbox.get', { id }, { actor: asUser(owner), orgId });

  const approve = (id: string) =>
    runtime.execute<{ documentId: string; journalEntryId: string; correctsDocumentId?: string; voidedDocumentId?: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id, revision: 1 },
      { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() },
    );

  // The fixture invoice under another number and date, and the original a correction names.
  const numbered = (xml: string, number: string, date: string, original?: string) => {
    const out = xml.replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${number}</SHDon>`).replace(/<NLap>[\d-]+<\/NLap>/, `<NLap>${date}</NLap>`);
    return original ? out.replace(/<SHDCLQuan>\d+<\/SHDCLQuan>/, `<SHDCLQuan>${original}</SHDCLQuan>`) : out;
  };

  type VatDoc = { number: string; correction: { kind: string; series: string; number: string; basis: string } | null };
  const vatWorking = (period: string) =>
    runtime.query<{ input: { documents: VatDoc[] }; output: { available: boolean; documents: VatDoc[] } }>('finance.vat.period', { period }, { actor: asUser(owner), orgId });

  // The org's balance of an account (debit minus credit) over every entry.
  const balance = async (account: string) =>
    Number(
      (
        await admin((c) =>
          c.query<{ net: string }>(`SELECT coalesce(sum(debit - credit), 0)::text AS net FROM ludy_finance.journal_line WHERE org_id = $1 AND account_code = $2`, [orgId, account]),
        )
      ).rows[0]?.net,
    );

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    runtime = register(createDb(pool));
    workerRuntime = register(createDb(workerPool));
    owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@corrections.test`, name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), `Org ${randomUUID().slice(0, 6)}`));
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

  let original = '';
  let replacement = '';

  it('replaces an invoice in the books: the original is reversed and voided, so the payable counts once', async () => {
    const first = await approve(await read(numbered(BASIC, '8001', '2026-09-15')));
    original = first.documentId;
    expect(await balance('331')).toBe(-1980000);

    const proposal = await read(numbered(REPLACEMENT, '8002', '2026-09-20', '8001'));
    const asked = await detail(proposal);
    expect(asked.payload.invoice.related).toEqual({
      kind: 'replacement',
      template: '1',
      series: 'C26TAB',
      number: '8001',
      issueDate: '2026-09-15',
      documentId: original,
    });
    expect(asked.payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', status: 'pass', code: 'related.replaces' })]));

    const recorded = await approve(proposal);
    replacement = recorded.documentId;
    expect(recorded).toMatchObject({ correctsDocumentId: original, voidedDocumentId: original });
    // The original's 1,980,000 is reversed and the replacement's booked: one payable, not two.
    expect(await balance('331')).toBe(-1980000);
    expect(await balance('1331')).toBe(180000);
    const rows = await admin((c) =>
      c.query(
        `SELECT d.invoice_number, d.correction_kind, d.corrects_document_id, d.corrected_series, d.corrected_number, d.corrected_date::text,
                EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id) AS voided
           FROM ludy_finance.purchase_document d WHERE d.org_id = $1 ORDER BY d.invoice_number`,
        [orgId],
      ),
    );
    expect(rows.rows).toEqual([
      { invoice_number: '8001', correction_kind: null, corrects_document_id: null, corrected_series: null, corrected_number: null, corrected_date: null, voided: true },
      {
        invoice_number: '8002',
        correction_kind: 'replacement',
        corrects_document_id: original,
        corrected_series: 'C26TAB',
        corrected_number: '8001',
        corrected_date: '2026-09-15',
        voided: false,
      },
    ]);
    // The reversal is dated the replacement's day.
    const reversal = await admin((c) =>
      c.query<{ entry_date: string }>(`SELECT entry_date::text FROM ludy_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2`, [orgId, first.journalEntryId]),
    );
    expect(reversal.rows).toEqual([{ entry_date: '2026-09-20' }]);
  });

  it('records an adjustment with its signed difference, linked to the original, which stays in force', async () => {
    const proposal = await read(numbered(ADJUSTMENT, '8003', '2026-10-05', '8002'));
    expect((await detail(proposal)).payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', code: 'related.adjusts' })]));
    const recorded = await approve(proposal);
    expect(recorded.correctsDocumentId).toBe(replacement);
    expect(recorded.voidedDocumentId).toBeUndefined();
    // 1,980,000 less the 220,000 adjustment.
    expect(await balance('331')).toBe(-1760000);
    expect(await balance('1331')).toBe(160000);
    const voided = await admin((c) =>
      c.query(`SELECT 1 FROM ludy_finance.purchase_document_void WHERE org_id = $1 AND document_id = $2`, [orgId, replacement]),
    );
    expect(voided.rows).toEqual([]);
    // The VAT working says what it adjusts, and that, as every purchase, it counts by its posting date (#916).
    const working = await vatWorking('2026-10');
    expect(working.input.documents.find((d) => d.number === '8003')).toMatchObject({ correction: { kind: 'adjustment', series: 'C26TAB', number: '8002', basis: 'posting_date' } });
  });

  it('records a correction whose original is not in the books alone, with a warning', async () => {
    const proposal = await read(numbered(REPLACEMENT, '8004', '2026-09-25', '7777'));
    const asked = await detail(proposal);
    expect(asked.payload.invoice.related).toMatchObject({ number: '7777', documentId: null });
    expect(asked.payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', status: 'warn', code: 'related.replaces_missing' })]));
    const recorded = await approve(proposal);
    expect(recorded.correctsDocumentId).toBeUndefined();
    const row = await admin((c) =>
      c.query(`SELECT correction_kind, corrects_document_id, corrected_number FROM ludy_finance.purchase_document WHERE org_id = $1 AND id = $2`, [orgId, recorded.documentId]),
    );
    expect(row.rows).toEqual([{ correction_kind: 'replacement', corrects_document_id: null, corrected_number: '7777' }]);
  });

  it('shows the links both ways on the documents list and in the journal', async () => {
    type Doc = { id: string; number: string; corrects: unknown; correctedBy: unknown[] };
    const docs = await runtime.query<Doc[]>('finance.documents.list', {}, { actor: asUser(owner), orgId });
    const byNumber = new Map(docs.map((d) => [d.number, d]));
    expect(byNumber.get('8001')).toMatchObject({ corrects: null, correctedBy: [{ kind: 'replacement', documentId: replacement, series: 'C26TAB', number: '8002' }] });
    expect(byNumber.get('8002')).toMatchObject({
      corrects: { kind: 'replacement', series: 'C26TAB', number: '8001', documentId: original },
      correctedBy: [{ kind: 'adjustment', series: 'C26TAB', number: '8003' }],
    });
    expect(byNumber.get('8003')).toMatchObject({ corrects: { kind: 'adjustment', number: '8002', documentId: replacement }, correctedBy: [] });
    expect(byNumber.get('8004')).toMatchObject({ corrects: { kind: 'replacement', number: '7777', documentId: null } });

    const journal = await runtime.query<Array<{ document?: { number: string; corrects?: unknown; correctedBy?: unknown[] } }>>(
      'finance.journal.list',
      {},
      { actor: asUser(owner), orgId },
    );
    const entry = journal.find((e) => e.document?.number === '8002');
    expect(entry?.document).toMatchObject({ corrects: { kind: 'replacement', number: '8001' }, correctedBy: [{ kind: 'adjustment', number: '8003' }] });
  });

  it('refuses a link to a document of another invoice, or an adjustment of a voided one', async () => {
    const insert = (kind: string, corrects: string, number: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO ludy_finance.purchase_document
             (org_id, direction, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total,
              correction_kind, corrects_document_id, corrected_series, corrected_number)
           SELECT org_id, direction, party_id, 'C26TAB', $4, '2026-10-10', 0, 0, 0, $2, $3, 'C26TAB', $5
             FROM ludy_finance.purchase_document WHERE org_id = $1 AND id = $3`,
          [orgId, kind, corrects, `X${randomUUID().slice(0, 6)}`, number],
        ),
      );
    // The reference names 9999, the linked document is 8002.
    await expect(insert('adjustment', replacement, '9999')).rejects.toThrow(/may correct only the document of the invoice it names/);
    // 8001 is voided: an adjustment cannot link to it, and a second replacement cannot take its place.
    await expect(insert('adjustment', original, '8001')).rejects.toThrow(/a replacement corrects a voided document, an adjustment one in force/);
    await expect(insert('replacement', original, '8001')).rejects.toThrow(/purchase_document_replacement_uq/);
  });

  // The same corrections when the org is the seller: the fixtures' seller is 0101234564, so the org with that tax code reads them as sales (Dr 131, Cr 511, Cr 3331).
  it('corrects a sale the same way: a replacement reverses and voids the original, an adjustment is linked with its signed difference, and the VAT working says so', async () => {
    const purchaseOrg = orgId;
    ({ orgId } = await createOrg(runtime, asUser(owner), `Org ${randomUUID().slice(0, 6)}`));
    try {
      await runtime.execute('kernel.org.set_tax_code', { taxCode: '0101234564' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
      const first = await approve(await read(numbered(BASIC, '9001', '2026-09-15')));
      expect(await balance('131')).toBe(1980000);
      expect(await balance('3331')).toBe(-180000);

      const proposal = await read(numbered(REPLACEMENT, '9002', '2026-09-20', '9001'));
      expect((await detail(proposal)).payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', status: 'pass', code: 'related.replaces' })]));
      const replaced = await approve(proposal);
      expect(replaced).toMatchObject({ correctsDocumentId: first.documentId, voidedDocumentId: first.documentId });
      // One receivable and one output VAT, not two.
      expect(await balance('131')).toBe(1980000);
      expect(await balance('3331')).toBe(-180000);

      const adjusted = await approve(await read(numbered(ADJUSTMENT, '9003', '2026-10-05', '9002')));
      expect(adjusted.correctsDocumentId).toBe(replaced.documentId);
      expect(adjusted.voidedDocumentId).toBeUndefined();
      // 1,980,000 less the 220,000 adjustment, and the output VAT 180,000 less 20,000.
      expect(await balance('131')).toBe(1760000);
      expect(await balance('3331')).toBe(-160000);

      const docs = await runtime.query<Array<{ number: string; direction: string; corrects: unknown; correctedBy: unknown[] }>>('finance.documents.list', {}, { actor: asUser(owner), orgId });
      const byNumber = new Map(docs.map((d) => [d.number, d]));
      expect(byNumber.get('9001')).toMatchObject({ direction: 'sale', corrects: null, correctedBy: [{ kind: 'replacement', number: '9002' }] });
      expect(byNumber.get('9003')).toMatchObject({ direction: 'sale', corrects: { kind: 'adjustment', number: '9002', documentId: replaced.documentId } });

      // The output side of the VAT working: the adjustment of October says what it adjusts, and the replacement of September what it replaces; the voided original is not listed.
      const october = await vatWorking('2026-10');
      expect(october.output.available).toBe(true);
      expect(october.output.documents.find((d) => d.number === '9003')?.correction).toEqual({ kind: 'adjustment', series: 'C26TAB', number: '9002', basis: 'issue_date' });
      const september = await vatWorking('2026-09');
      expect(september.output.documents.map((d) => d.number)).toEqual(['9002']);
      expect(september.output.documents[0]?.correction).toEqual({ kind: 'replacement', series: 'C26TAB', number: '9001', basis: 'issue_date' });
    } finally {
      orgId = purchaseOrg;
    }
  });

  // Under Circular 99 the revenue an adjustment takes back is a deduction: Dr 521 (the previewed journal and the posted one agree), the output VAT stays on 3331, and 511 keeps what the sale credited (#3712 slice 4).
  it('debits an adjustment of a sale to 521 under Circular 99, in the preview and in the entry, and keeps 511 as the sale credited it', async () => {
    const purchaseOrg = orgId;
    ({ orgId } = await createOrg(runtime, asUser(owner), `Org ${randomUUID().slice(0, 6)}`));
    try {
      await runtime.execute('kernel.org.set_tax_code', { taxCode: '0101234564' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
      await admin((c) =>
        c.query(
          "INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default",
          [orgId],
        ),
      );
      await approve(await read(numbered(BASIC, '9101', '2026-09-15')));
      expect(await balance('511')).toBe(-1800000);
      expect(await balance('521')).toBe(0);
      const adjustment = await read(numbered(ADJUSTMENT, '9103', '2026-10-05', '9101'));
      const shown = await runtime.query<{ payload: { journal: Array<{ accountCode: string; debit: string; credit: string }> } }>('kernel.inbox.get', { id: adjustment }, { actor: asUser(owner), orgId });
      expect(shown.payload.journal.find((j) => j.accountCode === '521')).toMatchObject({ debit: '200000', credit: '0' });
      expect(shown.payload.journal.some((j) => j.accountCode === '511')).toBe(false);
      const adjusted = await approve(adjustment);
      expect(adjusted.correctsDocumentId).toBeDefined();
      // The sale still credits 511 for 1,800,000; the 200,000 it was reduced by is on 521, and the output VAT of 180,000 less 20,000 is on 3331, so the receivable is 1,760,000.
      expect(await balance('511')).toBe(-1800000);
      expect(await balance('521')).toBe(200000);
      expect(await balance('3331')).toBe(-160000);
      expect(await balance('131')).toBe(1760000);
    } finally {
      orgId = purchaseOrg;
    }
  });

  // The regime follows the books row in force on the invoice's ISSUE date, not today's: an adjustment dated before the Circular 99 books began is posted the Circular 133 way, in the preview and in the entry.
  it('reads the regime on the issue date: an adjustment dated before the Circular 99 books begin stays on 511, as previewed', async () => {
    const purchaseOrg = orgId;
    ({ orgId } = await createOrg(runtime, asUser(owner), `Org ${randomUUID().slice(0, 6)}`));
    try {
      await runtime.execute('kernel.org.set_tax_code', { taxCode: '0101234564' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
      await admin((c) =>
        c.query(
          "INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, r.regime, '2026.1', r.since::date FROM ludy_kernel.legal_entity, (VALUES ('tt133', '2025-01-01'), ('tt99', '2026-01-01')) AS r(regime, since) WHERE org_id = $1 AND is_default",
          [orgId],
        ),
      );
      await approve(await read(numbered(BASIC, '9201', '2025-11-15')));
      const adjustment = await read(numbered(ADJUSTMENT, '9203', '2025-12-20', '9201'));
      const shown = await runtime.query<{ payload: { regime?: string; journal: Array<{ accountCode: string; debit: string; credit: string }> } }>('kernel.inbox.get', { id: adjustment }, { actor: asUser(owner), orgId });
      expect(shown.payload.regime).toBe('tt133');
      expect(shown.payload.journal.find((j) => j.accountCode === '511')).toMatchObject({ debit: '200000', credit: '0' });
      expect(shown.payload.journal.some((j) => j.accountCode === '521')).toBe(false);
      await approve(adjustment);
      expect(await balance('511')).toBe(-1600000);
      expect(await balance('521')).toBe(0);
    } finally {
      orgId = purchaseOrg;
    }
  });
});
