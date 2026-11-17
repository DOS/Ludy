// SPDX-License-Identifier: AGPL-3.0-only
// A late sales invoice is declared in the period of its sale (#3535, the accountant's answer to #2506 question 4), on PostgreSQL 17 with the offline provider: the draft keeps the sale
// date apart from the invoice date; a sale older than the next working day is not issued without the person's reason, which goes to the audit; the issued invoice is counted in the
// VAT working of the period of its sale, not of its issue date; and when that period is locked or its return filed it is a supplementary item of that period and in no main total of
// either. Another org's draft with the same symbol and number changes nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { createSandboxEInvoiceProvider } from '@crove/einvoice';
import type { ExtractClient } from '@crove/extract-contract';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { runEInvoiceIssue } from '../src/einvoice-issue-job.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The seller's fake tax code (see the MST fixture guard) and the buyer's, made at run time with a valid check digit.
const SELLER_TAX_CODE = '0101234564';
const PREFIX = '010010910';
const BUYER_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

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

interface VatDoc { number: string; saleDate: string | null; issueDate: string; warnings: string[] }
interface VatView {
  period: { period: string; to: string };
  output: { documents: VatDoc[]; totals: { documents: number; vat: string } };
  supplementary: { documents: VatDoc[]; totals: { documents: number; vat: string } };
  lateSales: Array<{ number: string; saleDate: string; originalPeriod: string; supplementary: boolean }>;
  filed: unknown;
}

// The month before this one in Vietnam (where the invoice date `today()` is read), the day the sale was made on in it (a day no next-working-day rule can cover), and the periods.
const thisMonth = today().slice(0, 7);
const prevMonth = (() => {
  const [y, m] = thisMonth.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const SALE_DATE = `${prevMonth}-15`;

suite('a late sales invoice is declared in the period of its sale (#3535)', () => {
  const dbName = `crove_test_late_sale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const broker = {} as CredentialBroker;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  // A row the guards would refuse, written as the database owner with the triggers off (a test fixture: a second issued draft that cannot be made through the offline provider).
  const fixture = (text: string, values: unknown[]) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(text, values);
      await c.query('COMMIT');
    });
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@job.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; entityId: string; seriesId: string };
  async function org(options: { connection: boolean } = { connection: true }): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hóa Đơn ${randomUUID().slice(0, 6)}`);
    const adminUser = await identity('admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    // The org's tax code is its default entity's (kernel.org.set_tax_code keeps the two the same).
    await execute({ orgId, owner }, 'kernel.org.set_tax_code', { taxCode: SELLER_TAX_CODE });
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id ?? '';
    if (options.connection) {
      const channel = randomUUID();
      await admin(async (c) => {
        await c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, channel, 'einvoice_sandbox', `acct-${channel.slice(0, 8)}`, 'Hóa đơn thử', owner]);
        await c.query(`INSERT INTO crove_finance.einvoice_connection (org_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, 'einvoice_sandbox', $3)`, [orgId, channel, SELLER_TAX_CODE]);
      });
    }
    const o = { orgId, owner, admin: adminUser, entityId: entity, seriesId: '' };
    const synced = await execute<{ series: Array<{ id: string }> }>(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' });
    o.seriesId = synced.series[0]?.id ?? '';
    return o;
  }
  const execute = <T>(o: { orgId: string; owner: string }, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const vat = (o: Org, period: string) => rt.query<VatView>('finance.vat.period', { period }, { actor: asUser(o.owner), orgId: o.orgId });
  const form = (o: Org, extra: Record<string, unknown> = {}) => ({
    draftId: null,
    legalEntityId: null,
    date: today(),
    saleDate: SALE_DATE,
    lateReason: null,
    seriesId: o.seriesId,
    buyer: { kind: 'business', partyId: null, taxCode: BUYER_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
    lines: [
      { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', vatRate: '10%' },
      // 5%, a rate valid on any date: 8% by sale date would be refused once the month of SALE_DATE is outside its period (#3680).
      { description: 'Hàng B', unit: null, quantity: '1.5', unitPrice: '33333', vatRate: '5%' },
    ],
    ...extra,
  });
  const asked = async (o: Org, draftId: string) => {
    const { proposalId } = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId } });
    await execute(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, o.admin);
  };
  // A late draft with its reason, approved and issued by the offline provider, and its XML read into a recorded sale of the org.
  async function lateSale(o: Org): Promise<{ draftId: string; documentId: string; number: string }> {
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o, { lateReason: 'Quên lập hóa đơn, phát hiện khi đối chiếu cuối tháng' }));
    await asked(o, draft.id);
    const { provider } = createSandboxEInvoiceProvider();
    expect(await runEInvoiceIssue({ runtime: worker, broker, store, providers: { sandbox: provider } }, { orgId: o.orgId, draftId: draft.id })).toEqual({ action: 'issue', state: 'issued' });
    const row = (await rows<{ signed_file_id: string; issued_number: string }>('SELECT signed_file_id, issued_number FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, draft.id]))[0] as { signed_file_id: string; issued_number: string };
    const read = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => today() }, o.orgId, row.signed_file_id);
    const approved = await rt.execute<{ documentId: string }>('kernel.proposal.approve', { acceptUnverifiedSignature: true, id: String(read.proposalId), revision: 1 }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    return { draftId: draft.id, documentId: approved.documentId, number: String(Number(row.issued_number)) };
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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    rt = register(db);
    worker = register(createDb(workerPool));
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

  it('keeps the sale date apart from the invoice date, and refuses a late sale without a reason', async () => {
    const o = await org();
    const noReason = await execute<{ id: string; saleDate: string; lateSale: boolean; issues: Array<{ field: string; code: string }> }>(o, 'finance.einvoice_draft.save', form(o));
    expect(noReason).toMatchObject({ saleDate: SALE_DATE, date: today(), lateSale: true });
    expect(noReason.issues).toEqual([{ field: 'lateReason', code: 'LATE_REASON_REQUIRED' }]);
    await expect(execute(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId: noReason.id } })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_INVALID' });
    // With the reason the same draft has no issue; the reason is stored, the sale date too.
    const withReason = await execute<{ id: string; lateReason: string; issues: unknown[] }>(o, 'finance.einvoice_draft.save', form(o, { draftId: noReason.id, lateReason: 'Quên lập hóa đơn' }));
    expect(withReason).toMatchObject({ id: noReason.id, lateReason: 'Quên lập hóa đơn', issues: [] });
    // A sale of the invoice's own day has no sale date of its own, and a reason sent with it is dropped.
    const sameDay = await execute<{ saleDate: string | null; lateReason: string | null; lateSale: boolean }>(o, 'finance.einvoice_draft.save', form(o, { saleDate: today(), lateReason: 'không cần' }));
    expect(sameDay).toMatchObject({ saleDate: null, lateReason: null, lateSale: false });
    // The database holds the rule too: a sale after its invoice, or a reason with no sale date.
    await expect(admin((c) => c.query("UPDATE crove_finance.einvoice_draft SET sale_date = invoice_date + 1 WHERE org_id = $1 AND id = $2", [o.orgId, noReason.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(admin((c) => c.query("UPDATE crove_finance.einvoice_draft SET late_reason = 'x', sale_date = NULL WHERE org_id = $1 AND id = $2", [o.orgId, noReason.id]))).rejects.toMatchObject({ code: '23514' });
  });

  it('audits the sale date and the reason at the approval, and freezes both once the draft is sent', async () => {
    const o = await org();
    const sale = await lateSale(o);
    const audit = await rows<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.einvoice.issue' AND outcome = 'ok'`, [o.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ draftId: sale.draftId, saleDate: SALE_DATE, lateReason: { redacted: 'pii' } });
    // Once the draft has left draft, neither column changes, by any writer.
    await expect(admin((c) => c.query("UPDATE crove_finance.einvoice_draft SET sale_date = $3 WHERE org_id = $1 AND id = $2", [o.orgId, sale.draftId, `${prevMonth}-01`]))).rejects.toThrow();
    await expect(admin((c) => c.query("UPDATE crove_finance.einvoice_draft SET late_reason = 'đổi' WHERE org_id = $1 AND id = $2", [o.orgId, sale.draftId]))).rejects.toThrow();
  });

  it('counts the invoice in the period of its sale, not of its issue date', async () => {
    const o = await org();
    const sale = await lateSale(o);
    const original = await vat(o, prevMonth);
    expect(original.output.documents).toEqual([expect.objectContaining({ number: sale.number, saleDate: SALE_DATE, issueDate: today(), warnings: expect.arrayContaining(['late_sale']) })]);
    expect(original.output.totals.documents).toBe(1);
    expect(original.supplementary.documents).toEqual([]);
    const issued = await vat(o, thisMonth);
    expect(issued.output.documents).toEqual([]);
    expect(issued.output.totals.documents).toBe(0);
    expect(issued.lateSales).toEqual([expect.objectContaining({ number: sale.number, saleDate: SALE_DATE, originalPeriod: prevMonth, supplementary: false })]);
    // A quarter holds the same sale when the sale month and the issue month fall in it, and names the quarter of the sale otherwise.
    const quarter = (month: string) => `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`;
    expect((await vat(o, quarter(prevMonth))).output.documents.some((d) => d.number === sale.number)).toBe(true);
  });

  // Whether the period was declared before the invoice was recorded decides everything (#3535): an invoice in the figures that were filed or locked stays in them; one recorded after
  // is a supplementary item. `declare` closes the period of the sale the way the test names.
  const closers = {
    locked: (o: Org) => execute(o, 'finance.period.lock', { month: prevMonth }),
    filed: (o: Org) => execute(o, 'finance.vat.return_mark', { period: prevMonth, done: true }),
  } as const;
  for (const [how, close] of Object.entries(closers) as Array<[keyof typeof closers, (typeof closers)[keyof typeof closers]]>) {
    it(`keeps an invoice recorded before its period was ${how} in that period's figures, not as a supplementary item`, async () => {
      const o = await org();
      const sale = await lateSale(o);
      await close(o);
      const original = await vat(o, prevMonth);
      // It was in what was declared: the period still shows it and the working still matches.
      expect(original.output.documents.map((d) => d.number)).toEqual([sale.number]);
      expect(original.output.totals.documents).toBe(1);
      expect(original.supplementary.documents).toEqual([]);
      expect(original.supplementary.totals.documents).toBe(0);
      const issued = await vat(o, thisMonth);
      expect(issued.output.documents).toEqual([]);
      expect(issued.supplementary.documents).toEqual([]);
      // The issue period names it with its original period, and does not say a supplementary return is needed for what was already declared.
      expect(issued.lateSales).toEqual([expect.objectContaining({ number: sale.number, originalPeriod: prevMonth, supplementary: false })]);
    });

    it(`shows an invoice recorded after its period was ${how} as a supplementary item, in no main total`, async () => {
      const o = await org();
      await close(o);
      const sale = await lateSale(o);
      const original = await vat(o, prevMonth);
      expect(original.output.documents).toEqual([]);
      expect(original.output.totals.documents).toBe(0);
      expect(original.supplementary.documents).toEqual([expect.objectContaining({ number: sale.number, saleDate: SALE_DATE })]);
      expect(original.supplementary.totals.documents).toBe(1);
      expect(Number(original.supplementary.totals.vat)).toBeGreaterThan(0);
      const issued = await vat(o, thisMonth);
      expect(issued.output.documents).toEqual([]);
      expect(issued.supplementary.documents).toEqual([]);
      expect(issued.lateSales).toEqual([expect.objectContaining({ number: sale.number, originalPeriod: prevMonth, supplementary: true })]);
      if (how === 'locked') {
        // Nothing reopened the month.
        const lock = (await rows<{ locked_through: string }>('SELECT locked_through::text FROM crove_finance.period_lock WHERE org_id = $1', [o.orgId]))[0];
        expect(lock?.locked_through?.slice(0, 7)).toBe(prevMonth);
      } else {
        expect((await vat(o, prevMonth)).filed).not.toBeNull();
      }
    });
  }

  // The period is declared at the EARLIER of its lock and its filing (#3535): an invoice recorded after the first of the two is a supplementary item, one recorded before both stays.
  const both = {
    'locked, then filed': async (o: Org) => {
      await closers.locked(o);
      await closers.filed(o);
    },
    'filed, then locked': async (o: Org) => {
      await closers.filed(o);
      await closers.locked(o);
    },
  } as const;
  for (const [order, close] of Object.entries(both) as Array<[keyof typeof both, (typeof both)[keyof typeof both]]>) {
    it(`treats an invoice recorded between the two as supplementary, the period being ${order}`, async () => {
      const o = await org();
      const first = order === 'locked, then filed' ? closers.locked : closers.filed;
      const second = order === 'locked, then filed' ? closers.filed : closers.locked;
      await first(o);
      const sale = await lateSale(o);
      await second(o);
      const original = await vat(o, prevMonth);
      expect(original.output.documents).toEqual([]);
      expect(original.supplementary.documents.map((d) => d.number)).toEqual([sale.number]);
      expect((await vat(o, thisMonth)).lateSales).toEqual([expect.objectContaining({ number: sale.number, supplementary: true })]);
    });

    it(`keeps an invoice recorded before both in the period's figures, the period being ${order}`, async () => {
      const o = await org();
      const sale = await lateSale(o);
      await close(o);
      const original = await vat(o, prevMonth);
      expect(original.output.documents.map((d) => d.number)).toEqual([sale.number]);
      expect(original.supplementary.documents).toEqual([]);
      expect((await vat(o, thisMonth)).lateSales).toEqual([expect.objectContaining({ number: sale.number, supplementary: false })]);
    });
  }

  it('sees the return of a quarterly filer, filed under the quarter, as the declaration of a month in it', async () => {
    const o = await org();
    const quarter = `${prevMonth.slice(0, 4)}-Q${Math.ceil(Number(prevMonth.slice(5)) / 3)}`;
    // The return of the quarter is marked filed (a fixture row when the quarter has not ended, which the command would refuse), then the sale is recorded.
    await fixture(
      `INSERT INTO crove_finance.vat_return_filed (org_id, legal_entity_id, period, status, source, carried_in_amount, deductible_amount, carried_out_amount, marked_by)
       VALUES ($1::uuid, $2::uuid, $3, 'filed', 'entered', 0, 0, 0, $4::uuid)`,
      [o.orgId, o.entityId, quarter, o.owner],
    );
    const sale = await lateSale(o);
    const original = await vat(o, prevMonth);
    expect(original.output.documents).toEqual([]);
    expect(original.supplementary.documents.map((d) => d.number)).toEqual([sale.number]);
    expect((await vat(o, thisMonth)).lateSales).toEqual([expect.objectContaining({ number: sale.number, originalPeriod: prevMonth, supplementary: true })]);
  });

  it('gives no sale date to an invoice whose earliest matching draft has none, whatever a later draft says', async () => {
    const o = await org();
    const sale = await lateSale(o);
    // An earlier issued draft of the same entity with the same symbol and number under another template number, and no sale date of its own.
    const seriesRow = (await rows<{ symbol: string }>('SELECT symbol FROM crove_finance.einvoice_series WHERE org_id = $1 AND id = $2', [o.orgId, o.seriesId]))[0] as { symbol: string };
    const other = randomUUID();
    await fixture(
      `INSERT INTO crove_finance.einvoice_series (org_id, id, legal_entity_id, provider, template_no, symbol, description) SELECT org_id, $3, legal_entity_id, provider, '9', symbol, 'mẫu khác' FROM crove_finance.einvoice_series WHERE org_id = $1 AND id = $2`,
      [o.orgId, o.seriesId, other],
    );
    await fixture(
      `INSERT INTO crove_finance.einvoice_draft (org_id, legal_entity_id, state, series_id, invoice_date, currency, buyer_kind, subtotal, vat_amount, total, provider_ref, issued_number, issued_at, submitted_at)
       SELECT org_id, legal_entity_id, 'issued', $3, invoice_date, currency, buyer_kind, subtotal, vat_amount, total, 'ref-earlier', issued_number, issued_at - interval '1 hour', submitted_at - interval '1 hour'
       FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2`,
      [o.orgId, sale.draftId, other],
    );
    expect(seriesRow.symbol).toMatch(/^C/);
    // The earlier draft answers and has no sale date: the invoice is of its issue month, not of the sale month the later draft names.
    expect((await vat(o, prevMonth)).output.documents).toEqual([]);
    const issued = await vat(o, thisMonth);
    expect(issued.output.documents).toEqual([expect.objectContaining({ number: sale.number, saleDate: null })]);
    expect(issued.lateSales).toEqual([]);
  });

  it('does not move an invoice by another org\'s draft with the same symbol and number', async () => {
    const a = await org();
    const b = await org();
    const saleA = await lateSale(a);
    // The second org issues its own late sale with the same symbol and number (the offline provider numbers from 1 in each), on another sale date.
    const draftB = await execute<{ id: string }>(b, 'finance.einvoice_draft.save', form(b, { saleDate: `${prevMonth}-03`, lateReason: 'Quên lập hóa đơn' }));
    await asked(b, draftB.id);
    const { provider } = createSandboxEInvoiceProvider();
    await runEInvoiceIssue({ runtime: worker, broker, store, providers: { sandbox: provider } }, { orgId: b.orgId, draftId: draftB.id });
    expect((await vat(a, prevMonth)).output.documents).toEqual([expect.objectContaining({ number: saleA.number, saleDate: SALE_DATE })]);
    // The other org sees none of org A's invoices, and an org with no draft sees none of either.
    expect((await vat(b, prevMonth)).output.documents.map((d) => d.saleDate)).not.toContain(SALE_DATE);
    const c = await org();
    expect((await vat(c, prevMonth)).output.documents).toEqual([]);
  });
});
