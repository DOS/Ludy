// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly flags on a purchase proposal (#2380) on PostgreSQL 17, through the proposal path: a vendor's first invoices raise
// nothing, a new bank account, an unusual amount and a price jump are warnings with their reasons (and no account number),
// the Inbox counts them, a flagged proposal is refused in a bulk approval item by item while a normal one is approved, and
// a person may still approve the flagged one alone. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own
// database.
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
const fixture = (name: string) => readFileSync(new URL(`../../extract/test/fixtures/${name}`, import.meta.url), 'utf8');
const BASIC_XML = fixture('einvoice-basic.xml');
const REPLACEMENT_XML = fixture('einvoice-replacement.xml');
const ADJUSTMENT_XML = fixture('einvoice-adjustment.xml');
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
  const dbName = `ludy_test_anomaly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    admin(async (c) => (await c.query<Row>(`SELECT id, status, revision, source_file_id, extraction_id, duplicate_of, legal_entity_id, authors, payload FROM ludy_kernel.proposal WHERE org_id = $1 AND payload #>> '{invoice,number}' = $2 ORDER BY created_at`, [orgId, number])).rows);
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
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@original-attach.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có hóa đơn bất thường'));
    await admin(async (c) => {
      await c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')`, [orgId, users.admin, users.approver]);
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
    admin(async (c) => (await c.query<{ checks: Array<{ id: string; status: string; code: string; params?: Record<string, string> }> }>(`SELECT payload -> 'checks' AS checks FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]?.checks ?? []);
  const anomalies = async (id: string) => (await checksOf(id)).filter((c) => c.id.startsWith('anomaly'));

  it('raises nothing for the first invoices of a vendor, while its history builds up', async () => {
    for (let n = 1; n <= 5; n++) {
      const id = await propose(`870${n}`, withBank(BANK));
      expect(await anomalies(id), `invoice ${n}`).toEqual([]);
      await approveOne(id);
    }
    expect(await admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_finance.purchase_document WHERE org_id = $1`, [orgId])).rows[0]?.n))).toBe(5);
  });

  it('raises nothing on an invoice like the earlier ones', async () => {
    const id = await propose('8710', withBank(BANK));
    expect(await anomalies(id)).toEqual([]);
    await approveOne(id);
  });

  it('does not judge the amount of a foreign-currency invoice that still waits for its rate against history in dong', async () => {
    // The same invoice in dollars: 1/5000 of the dong amounts, so judged against 1 980 000 dong it would read as far too low.
    const id = await propose('8715', (invoice) => {
      const scale = (value: string) => (Number(value) / 5000).toFixed(2);
      invoice.currency = 'USD';
      invoice.subtotal = scale(invoice.subtotal);
      invoice.vatTotal = scale(invoice.vatTotal);
      invoice.total = scale(invoice.total);
      invoice.taxBreakdown = invoice.taxBreakdown.map((t) => ({ ...t, taxableAmount: scale(t.taxableAmount), vatAmount: scale(t.vatAmount) }));
      for (const line of invoice.lines) {
        line.amount = scale(line.amount);
        if (line.unitPrice !== null) line.unitPrice = scale(line.unitPrice);
      }
      withBank(BANK)(invoice);
    });
    expect(await anomalies(id)).toEqual([]);
  });

  it('reads an invoice whose bank account is longer than the proposal keeps, with no flag and no account stored', async () => {
    const id = await propose('8716', withBank(`${BANK}; ${'9'.repeat(300)}`));
    expect(await anomalies(id)).toEqual([]);
    const stored = await admin(async (c) => (await c.query<{ account: string | null }>(`SELECT payload #>> '{seller,bankAccount}' AS account FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]?.account ?? null);
    expect(stored).toBeNull();
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
    const detailFlagged = await detailOf(users.approver, flagged);
    const detailNormal = await detailOf(users.approver, normal);
    const result = await rt.execute<{ results: Array<{ id: string; outcome: string; code?: string }> }>(
      'kernel.proposal.approve_many',
      { items: [{ id: flagged, revision: detailFlagged.revision, acceptUnverifiedSignature: true }, { id: normal, revision: detailNormal.revision, acceptUnverifiedSignature: true }] },
      { actor: asMfa(users.approver), orgId },
    );
    expect(result.results.find((r) => r.id === flagged)).toMatchObject({ outcome: 'refused', code: 'BULK_NOT_ALLOWED' });
    expect(result.results.find((r) => r.id === normal)).toMatchObject({ outcome: 'approved' });
    expect((await proposals('8720'))[0]?.status).toBe('pending');
  });

  it('refuses the flagged proposal in bulk when its id is sent in upper case', async () => {
    const detail = await detailOf(users.approver, flagged);
    const upper = flagged.toUpperCase();
    const result = await rt.execute<{ results: Array<{ id: string; outcome: string; code?: string }> }>(
      'kernel.proposal.approve_many',
      { items: [{ id: upper, revision: detail.revision, acceptUnverifiedSignature: true }] },
      { actor: asMfa(users.approver), orgId },
    );
    expect(result.results).toEqual([{ id: upper, outcome: 'refused', code: 'BULK_NOT_ALLOWED', rule: null }]);
    expect((await proposals('8720'))[0]?.status).toBe('pending');
  });

  it('lets a person approve the flagged proposal on its own: the flags warn, they do not block', async () => {
    const approved = await approveOne(flagged);
    expect(approved).toMatchObject({ documentId: expect.any(String) });
    expect((await proposals('8720'))[0]?.status).toBe('executed');
  });

  it('compares an account read from a photo with the history but never adds it to the history (#2426)', async () => {
    const PHOTO = '0555 666 777 888';
    // A photo of an invoice naming an account the vendor never used: warned against the history (the PDF and XML ones), then booked by a person.
    const { fileId } = await ingest(users.owner, new TextEncoder().encode(`photo ${randomUUID()}`), 'hd-8740.png', 'image/png');
    const photoReader = {
      fromText: async () => null,
      fromImage: async () => {
        const invoice = { ...structuredClone(PARSED), source: 'ai' as const, number: '8740' };
        withBank(PHOTO)(invoice);
        return invoice;
      },
    };
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: photoReader as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    expect((await anomalies(proposalId as string)).map((c) => c.id)).toContain('anomaly_bank');
    const read = await detailOf(users.owner, proposalId as string);
    await rt.execute('kernel.proposal.edit', { id: proposalId, revision: read.revision, lineAccounts: [{ lineNo: 3, debitAccount: '6421' }] }, { actor: asUser(users.owner), orgId });
    await approveOne(proposalId as string);
    // Its account is now on a booked document, yet the next invoice naming it is still a change: only an XML or a PDF read, whose account was checked against the text, makes history.
    const next = await propose('8741', withBank(PHOTO));
    expect((await anomalies(next)).map((c) => c.id)).toContain('anomaly_bank');
  });

  describe('correction invoices and non-correction history (#2425)', () => {
    let testOrgId = '';

    beforeAll(async () => {
      ({ orgId: testOrgId } = await createOrg(rt, asUser(users.owner), 'Công ty hóa đơn điều chỉnh'));
      await admin(async (c) => {
        await c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')`, [testOrgId, users.admin, users.approver]);
      });
    });

    const xmlWith = (
      base: string,
      opts: { number: string; date: string; bank: string; relatedNumber?: string; relatedDate?: string; body?: string },
    ) => {
      let out = base
        .replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${opts.number}</SHDon>`)
        .replace(/<NLap>[\d-]+<\/NLap>/, `<NLap>${opts.date}</NLap>`)
        .replace('</NBan>', `<STKNHang>${opts.bank}</STKNHang></NBan>`);
      if (opts.relatedNumber) out = out.replace(/<SHDCLQuan>\d+<\/SHDCLQuan>/, `<SHDCLQuan>${opts.relatedNumber}</SHDCLQuan>`);
      if (opts.relatedDate) out = out.replace(/<NLHDCLQuan>[\d-]+<\/NLHDCLQuan>/, `<NLHDCLQuan>${opts.relatedDate}</NLHDCLQuan>`);
      if (opts.body) out = out.replace(/<DSHHDVu>[\s\S]*<\/TToan>/, opts.body);
      return out;
    };

    const proposeXml = async (xml: string, number: string) => {
      const bytes = new TextEncoder().encode(xml);
      const sha256 = sha256Hex(bytes);
      const storageKey = fileKey(testOrgId, sha256);
      const generation = await store.put(storageKey, bytes);
      const { fileId } = await rt.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: `hd-${number}.xml`, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
        { actor: asUser(users.owner), orgId: testOrgId },
      );
      const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, testOrgId, fileId);
      return proposalId as string;
    };

    const approveXml = async (id: string) => {
      const detail = await rt.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(users.approver), orgId: testOrgId });
      return rt.execute('kernel.proposal.approve', { id, revision: detail.revision, acceptFailedChecks: true, acceptUnverifiedSignature: true }, { actor: asMfa(users.approver), orgId: testOrgId });
    };

    const anomaliesXml = async (id: string) =>
      (
        await admin(
          async (c) =>
            (
              await c.query<{ checks: Array<{ id: string; status: string; code: string; params?: Record<string, string> }> }>(
                `SELECT payload -> 'checks' AS checks FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2`,
                [testOrgId, id],
              )
            ).rows[0]?.checks ?? [],
        )
      ).filter((c) => c.id.startsWith('anomaly'));

    const positiveAdjBody =
      '<DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Điều chỉnh tăng phí quảng cáo Facebook</THHDVu><DVTinh>Gói</DVTinh><SLuong>2</SLuong><DGia>100000</DGia><ThTien>200000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu><TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>200000</ThTien><TThue>20000</TThue></LTSuat></THTTLTSuat><TgTCThue>200000</TgTCThue><TgTThue>20000</TgTThue><TgTTTBSo>220000</TgTTTBSo></TToan>';
    const smallPriceJumpBody =
      '<DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Phí quảng cáo Facebook</THHDVu><DVTinh>Gói</DVTinh><SLuong>0.2</SLuong><DGia>700000</DGia><ThTien>140000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu><TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>140000</ThTien><TThue>14000</TThue></LTSuat></THTTLTSuat><TgTCThue>140000</TgTCThue><TgTThue>14000</TgTThue><TgTTTBSo>154000</TgTTTBSo></TToan>';
    const smallReplacementBody =
      '<DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Cước dịch vụ thay thế</THHDVu><DVTinh>Gói</DVTinh><SLuong>1</SLuong><DGia>200000</DGia><ThTien>200000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu><TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>200000</ThTien><TThue>20000</TThue></LTSuat></THTTLTSuat><TgTCThue>200000</TgTCThue><TgTThue>20000</TgTThue><TgTTTBSo>220000</TgTTTBSo></TToan>';
    const highNormalBody =
      '<DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><MHHDVu>INT-01</MHHDVu><THHDVu>Cước dịch vụ internet tháng 9/2026</THHDVu><DVTinh>Tháng</DVTinh><SLuong>3</SLuong><DGia>1000000</DGia><ThTien>3000000</ThTien><TSuat>10%</TSuat></HHDVu><HHDVu><TChat>1</TChat><STT>2</STT><THHDVu>Phí quảng cáo Facebook</THHDVu><DVTinh>Gói</DVTinh><SLuong>6</SLuong><DGia>500000</DGia><ThTien>3000000</ThTien><TSuat>10%</TSuat></HHDVu><HHDVu><TChat>3</TChat><STT>3</STT><THHDVu>Chiết khấu thương mại</THHDVu><ThTien>600000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu><TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>5400000</ThTien><TThue>540000</TThue></LTSuat></THTTLTSuat><TgTCThue>5400000</TgTCThue><TgTThue>540000</TgTThue><TgTTTBSo>5940000</TgTTTBSo></TToan>';
    const lowNormalBody =
      '<DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Phí quảng cáo Facebook</THHDVu><DVTinh>Gói</DVTinh><SLuong>1</SLuong><DGia>500000</DGia><ThTien>500000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu><TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>500000</ThTien><TThue>50000</TThue></LTSuat></THTTLTSuat><TgTCThue>500000</TgTCThue><TgTThue>50000</TgTThue><TgTTTBSo>550000</TgTTTBSo></TToan>';

    it('does not count adjustments toward the 5-invoice amount history threshold (#2425)', async () => {
      // Four regular invoices (1,980,000 each) plus two small positive adjustments (220,000 each): six documents in force, yet only four non-correction totals.
      for (const n of ['9001', '9002', '9003', '9004']) {
        await approveXml(await proposeXml(xmlWith(BASIC_XML, { number: n, date: '2026-09-15', bank: BANK }), n));
      }
      for (const n of ['9031', '9032']) {
        await approveXml(
          await proposeXml(
            xmlWith(ADJUSTMENT_XML, { number: n, date: '2026-09-16', bank: BANK, relatedNumber: '9004', relatedDate: '2026-09-15', body: positiveAdjBody }),
            n,
          ),
        );
      }
      const beforeFive = await proposeXml(xmlWith(BASIC_XML, { number: '9040', date: '2026-09-17', bank: BANK, body: highNormalBody }), '9040');
      expect(await anomaliesXml(beforeFive)).toEqual([]);
    });

    it('skips the amount check on adjustment and replacement invoices while keeping bank and price checks (#2425)', async () => {
      // Two more regular invoices so 9001..9006 reach six non-correction invoices.
      for (const n of ['9005', '9006']) {
        await approveXml(await proposeXml(xmlWith(BASIC_XML, { number: n, date: '2026-09-15', bank: BANK }), n));
      }

      // A small positive adjustment or replacement with invoice.related set skips anomaly_amount while bank and price checks still fire.
      const adjProposal = await proposeXml(
        xmlWith(ADJUSTMENT_XML, { number: '9008', date: '2026-09-20', bank: '0987654321', relatedNumber: '9005', relatedDate: '2026-09-15', body: smallPriceJumpBody }),
        '9008',
      );
      expect((await anomaliesXml(adjProposal)).map((c) => [c.id, c.code])).toEqual([
        ['anomaly_bank', 'anomaly_bank.changed'],
        ['anomaly_price', 'anomaly_price.jump'],
      ]);
      const repProposal = await proposeXml(
        xmlWith(REPLACEMENT_XML, { number: '9009', date: '2026-09-20', bank: '0987654321', relatedNumber: '9005', relatedDate: '2026-09-15', body: smallPriceJumpBody }),
        '9009',
      );
      expect((await anomaliesXml(repProposal)).map((c) => [c.id, c.code])).toEqual([
        ['anomaly_bank', 'anomaly_bank.changed'],
        ['anomaly_price', 'anomaly_price.jump'],
      ]);
    });

    it('excludes adjustment and replacement documents from normal history totals even past the 12-doc window (#2425)', async () => {
      // Book one small replacement (voids 9006, leaving 5 regular invoices 9001..9005) and six more small adjustments so 9 newest in-force docs are corrections.
      await approveXml(
        await proposeXml(
          xmlWith(REPLACEMENT_XML, { number: '9007', date: '2026-09-20', bank: BANK, relatedNumber: '9006', relatedDate: '2026-09-15', body: smallReplacementBody }),
          '9007',
        ),
      );
      for (const n of ['9011', '9012', '9013', '9014', '9015', '9016']) {
        await approveXml(
          await proposeXml(
            xmlWith(ADJUSTMENT_XML, { number: n, date: '2026-09-20', bank: BANK, relatedNumber: '9005', relatedDate: '2026-09-15', body: positiveAdjBody }),
            n,
          ),
        );
      }

      // Normal invoice at 1,980,000 raises nothing; genuine high (5,940,000) and low (550,000) still judge against the 5 regular invoices (usual 1,980,000).
      const usualNormal = await proposeXml(xmlWith(BASIC_XML, { number: '9020', date: '2026-09-25', bank: BANK }), '9020');
      expect(await anomaliesXml(usualNormal)).toEqual([]);

      const highNormal = await proposeXml(xmlWith(BASIC_XML, { number: '9021', date: '2026-09-25', bank: BANK, body: highNormalBody }), '9021');
      expect(await anomaliesXml(highNormal)).toMatchObject([
        { id: 'anomaly_amount', status: 'warn', code: 'anomaly_amount.unusual', params: { direction: 'high', usual: '1980000', count: '5', total: '5940000' } },
      ]);

      const lowNormal = await proposeXml(xmlWith(BASIC_XML, { number: '9022', date: '2026-09-25', bank: BANK, body: lowNormalBody }), '9022');
      expect(await anomaliesXml(lowNormal)).toMatchObject([
        { id: 'anomaly_amount', status: 'warn', code: 'anomaly_amount.unusual', params: { direction: 'low', usual: '1980000', count: '5', total: '550000' } },
      ]);
    });
  });
});
