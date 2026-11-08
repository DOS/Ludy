// SPDX-License-Identifier: AGPL-3.0-only
// The crm module's quotes (#2693, docs/plan/crm-quotes.md step Q1) on PostgreSQL 17: a draft made from a deal in one click, its lines and the totals the
// shared rule computes (checked against SQL and against an e-invoice draft's line domains), who may write, that nothing here can move a quote out of
// `draft` (the commands and the database both hold the line, tried as the runtime's own login in an org context), the revision of a sent quote, that a
// deal with a quote is kept, cross-org isolation, and that audit rows and the timeline never hold a price or a line text. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { vietnamToday, type Deal, type PipelineStage, type Quote, type QuoteDefaults, type QuotePage, type QuoteSummary } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { computeLineTotals, sumLineTotals } from '@crove/l10n-vn';
import { crmCommands, crmQueries, renderQuotePdf, type QuoteDocument } from '@crove/mod-crm';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const item = (over: Record<string, unknown> = {}): Record<string, unknown> & { kind: 'item' } => ({ kind: 'item', description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%', ...over });

suite('crm quotes on PostgreSQL (#2693)', () => {
  const dbName = `crove_test_crm_quotes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@quote.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    const adminUser = await person('admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer'), ($1, $4, 'admin')", [orgId, member, viewer, adminUser]));
    const party = (name: string) =>
      admin((c) => c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => r.rows[0]!.id));
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const newDeal = async (partyId: string, title = 'Gói kế toán năm') => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      return exec<Deal>(member, 'crm.deal.create', { partyId, title, amount: '15000000', expectedClose: '2026-12-31' });
    };
    const draft = (dealId: string) => exec<Quote>(member, 'crm.quote.save', { dealId, lines: [] });
    // The row as the database owner makes a send (Q2's step): the commands refuse everything that is not a draft.
    const send = (quoteId: string, number = 'BG-2026-0001') =>
      admin((c) => c.query("UPDATE crove_crm.quote SET status = 'sent', number = $3, sent_at = now(), sent_via = 'link' WHERE org_id = $1 AND id = $2", [orgId, quoteId, number]));
    return { orgId, owner, member, viewer, adminUser, party, exec, query, newDeal, draft, send };
  }

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('makes a draft from a deal in one click, for the deal\'s customer, valid for 14 days with no number', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const quote = await o.draft(deal.id);
    const valid = new Date(`${vietnamToday()}T00:00:00Z`);
    valid.setUTCDate(valid.getUTCDate() + 14);
    expect(quote).toMatchObject({ dealId: deal.id, dealTitle: 'Gói kế toán năm', partyId: party, partyName: 'Công ty ABC', number: null, revision: 1, revisesId: null, status: 'draft', expired: false, subtotal: '0', vatAmount: '0', total: '0', lineCount: 0, version: 1, lines: [], notes: null, terms: null });
    expect(quote.validUntil).toBe(valid.toISOString().slice(0, 10));
    expect((await o.query<QuoteSummary[]>(o.viewer, 'crm.deal.quotes', { dealId: deal.id })).map((q) => q.id)).toEqual([quote.id]);
    expect(await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id })).toEqual(quote);
    const page = await o.query<QuotePage>(o.viewer, 'crm.quote.list', { partyId: party, status: 'draft' });
    expect(page.items.map((q) => q.id)).toEqual([quote.id]);
    expect(page.next).toBeNull();
    await expect(o.exec(o.member, 'crm.quote.save', { dealId: randomUUID(), lines: [] })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
  });

  it('computes the totals with the shared rule: the same in the response, in the rows, in SQL and in the contract function', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const quote = await o.draft(deal.id);
    const lines = [
      item({ quantity: '3', unitPrice: '333.5', vatRate: '10%' }), // 1000.5 rounds half up to 1001
      item({ description: 'Giảm giá', quantity: '1', unitPrice: '1000000', discountPercent: '12.5', vatRate: '8%' }),
      item({ description: 'Miễn thuế', quantity: '1.5', unitPrice: '100001', vatRate: 'KCT' }),
      { kind: 'text' as const, description: 'Giao trong 3 ngày' },
      item({ description: 'Thuế 5', quantity: '7', unitPrice: '99.99', discountPercent: '0.5', vatRate: '5' }),
    ];
    const saved = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: quote.id, version: quote.version, validUntil: '2031-01-31', notes: '  Ghi chú  ', terms: 'Thanh toán trong 7 ngày', lines });
    const expected = lines.filter((l) => l.kind === 'item').map((l) => computeLineTotals({ quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPercent: l.discountPercent as string | undefined, vatRate: String(l.vatRate) }));
    const totals = sumLineTotals(expected);
    expect(saved).toMatchObject({ version: 2, validUntil: '2031-01-31', notes: 'Ghi chú', terms: 'Thanh toán trong 7 ngày', lineCount: 5, ...totals });
    expect(saved.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5]);
    expect(saved.lines[0]).toMatchObject({ amount: '1001', vatAmount: '100' });
    expect(saved.lines[1]).toMatchObject({ amount: '875000', vatAmount: '70000', discountPercent: '12.5', vatRate: '8%' });
    expect(saved.lines[2]).toMatchObject({ vatRate: 'KCT', vatAmount: '0' });
    expect(saved.lines[3]).toMatchObject({ kind: 'text', quantity: null, unitPrice: null, vatRate: null, amount: '0', vatAmount: '0' });
    expect(saved.lines[4]).toMatchObject({ vatRate: '5%' });

    // SQL: each line's amount is round(quantity x price x (100 - discount) / 100) (half away from zero, half up for the positive amounts here), its VAT the rate of
    // that amount, and the quote's totals the sums.
    const { rows } = await admin((c) =>
      c.query<{ line_no: number; amount: string; sql_amount: string; vat_amount: string; sql_vat: string; total_ok: boolean; sum_ok: boolean }>(
        `SELECT l.line_no, l.amount::text, pg_catalog.round(l.quantity * l.unit_price * (100 - l.discount_percent) / 100)::text AS sql_amount, l.vat_amount::text,
                pg_catalog.round(l.amount * CASE l.vat_rate WHEN 'KCT' THEN 0 ELSE pg_catalog.rtrim(l.vat_rate, '%')::numeric END / 100)::text AS sql_vat,
                q.total = q.subtotal + q.vat_amount AS total_ok,
                q.subtotal = (SELECT sum(amount) FROM crove_crm.quote_line x WHERE x.org_id = q.org_id AND x.quote_id = q.id) AND q.vat_amount = (SELECT sum(vat_amount) FROM crove_crm.quote_line x WHERE x.org_id = q.org_id AND x.quote_id = q.id) AS sum_ok
         FROM crove_crm.quote_line l JOIN crove_crm.quote q ON q.org_id = l.org_id AND q.id = l.quote_id WHERE l.org_id = $1 AND l.quote_id = $2 AND l.kind = 'item' ORDER BY l.line_no`,
        [o.orgId, quote.id],
      ),
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(Number(r.amount)).toBe(Number(r.sql_amount));
      expect(Number(r.vat_amount)).toBe(Number(r.sql_vat));
      expect(r.total_ok && r.sum_ok).toBe(true);
    }
  });

  it('keeps the quote line domains equal to the e-invoice draft line domains, so a line copies without rounding', async () => {
    const { rows } = await admin((c) =>
      c.query<{ column_name: string; line: string; draft: string }>(
        `SELECT 'quantity' AS column_name,
                (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'crove_crm.quote_line'::regclass AND a.attname = 'quantity') AS line,
                (SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod) FROM pg_type t WHERE t.oid = 'crove_finance.quantity'::regtype) AS draft
         UNION ALL
         SELECT 'unit_price',
                (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'crove_crm.quote_line'::regclass AND a.attname = 'unit_price'),
                (SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod) FROM pg_type t WHERE t.oid = 'crove_finance.unit_amount'::regtype)
         UNION ALL
         SELECT 'amount',
                (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'crove_crm.quote_line'::regclass AND a.attname = 'amount'),
                (SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod) FROM pg_type t WHERE t.oid = 'crove_finance.amount'::regtype)`,
      ),
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.line, r.column_name).toBe(r.draft);
  });

  it('refuses a line with a zero quantity or price, a rate outside the set, a discount over 100, too many lines and a total too large', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const quote = await o.draft(deal.id);
    const save = (lines: unknown[]) => o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, lines });
    await expect(save([item({ quantity: '0' })])).rejects.toMatchObject({ code: 'QUOTE_LINE_INVALID', status: 422 });
    await expect(save([item({ unitPrice: '0.00' })])).rejects.toMatchObject({ code: 'QUOTE_LINE_INVALID' });
    await expect(save([item({ discountPercent: '100.01' })])).rejects.toMatchObject({ code: 'QUOTE_LINE_INVALID' });
    await expect(save([item({ vatRate: '7%' })])).rejects.toMatchObject({ code: 'QUOTE_VAT_RATE_INVALID' });
    // A rate of 20 characters (21 once normalized) is a refusal, never a column error.
    await expect(save([item({ vatRate: 'KHAC:12.3456789012345' })])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.exec(o.owner, 'crm.quote_setting.set', { validDays: 30, defaultVat: '1'.repeat(20), defaultTerms: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save([item({ quantity: '1e3' })])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save([item({ quantity: 2 })])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save([item({ description: '   ' })])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save(Array.from({ length: 101 }, () => item()))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save([item({ quantity: '99999999999999', unitPrice: '99999999' })])).rejects.toMatchObject({ code: 'QUOTE_TOTAL_TOO_LARGE' });
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, validUntil: '2026-02-30', lines: [] })).rejects.toMatchObject({ code: 'QUOTE_DATE_INVALID' });
    // A discount of 100 gives a zero total, allowed on a draft; a 100 percent line keeps its 0 amount.
    const free = await save([item({ discountPercent: '100' })]);
    expect(free).toMatchObject({ subtotal: '0', total: '0', version: 2 });
    // Nothing was saved by the refusals.
    expect((await o.query<Quote>(o.owner, 'crm.quote.get', { quoteId: quote.id })).version).toBe(2);
  });

  it('refuses a stale version and a viewer, and only writers write', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const quote = await o.draft(deal.id);
    const saved = await o.exec<Quote>(o.owner, 'crm.quote.save', { quoteId: quote.id, version: 1, lines: [item()] });
    expect(saved.version).toBe(2);
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, lines: [] })).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409 });
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.exec(o.member, 'crm.quote.save', { lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, dealId: randomUUID(), version: 2, lines: [] })).rejects.toMatchObject({ code: 'QUOTE_DEAL_MISMATCH' });
    for (const command of ['crm.quote.save', 'crm.quote.delete_draft', 'crm.quote.revise']) {
      await expect(o.exec(o.viewer, command, command === 'crm.quote.save' ? { dealId: deal.id, lines: [] } : { quoteId: quote.id })).rejects.toMatchObject({ status: 403 });
    }
    await expect(o.exec(o.member, 'crm.quote_setting.set', { validDays: 30, defaultVat: '10%', defaultTerms: null })).rejects.toMatchObject({ status: 403 });
    // Every role reads.
    expect((await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id })).lines).toHaveLength(1);
  });

  it('deletes a draft with its lines, and a deal with a quote is kept until the quote is gone', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const quote = await o.draft(deal.id);
    await o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, lines: [item(), item({ description: 'Thêm' })] });
    await expect(o.exec(o.owner, 'crm.deal.delete', { dealId: deal.id })).rejects.toMatchObject({ code: 'DEAL_HAS_QUOTES', status: 409 });
    expect(await o.exec(o.member, 'crm.quote.delete_draft', { quoteId: quote.id })).toEqual({ quoteId: quote.id, deleted: true });
    expect((await admin((c) => c.query('SELECT 1 FROM crove_crm.quote_line WHERE org_id = $1 AND quote_id = $2', [o.orgId, quote.id]))).rowCount).toBe(0);
    await expect(o.query(o.owner, 'crm.quote.get', { quoteId: quote.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', status: 404 });
    expect(await o.exec(o.owner, 'crm.deal.delete', { dealId: deal.id })).toEqual({ dealId: deal.id, deleted: true });
  });

  it('refuses to edit, delete or revise what the commands must not: a sent quote is not edited, a draft is not revised, an accepted quote is final', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const draft = await o.draft(deal.id);
    await expect(o.exec(o.member, 'crm.quote.revise', { quoteId: draft.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_REVISABLE' });
    const saved = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: draft.id, version: 1, lines: [item()] });
    await o.send(draft.id);
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: draft.id, version: saved.version, lines: [] })).rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT', status: 409 });
    await expect(o.exec(o.member, 'crm.quote.delete_draft', { quoteId: draft.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });
    const sent = await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: draft.id });
    expect(sent).toMatchObject({ status: 'sent', number: 'BG-2026-0001', lines: saved.lines, total: saved.total });

    // A revision is a new draft with the lines copied, the next revision number, a fresh validity, and shows the number of the quote it revises.
    const revision = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: draft.id });
    expect(revision).toMatchObject({ status: 'draft', revision: 2, revisesId: draft.id, number: 'BG-2026-0001', total: saved.total, lineCount: 1, version: 1 });
    expect(revision.lines).toEqual(saved.lines);
    expect(revision.id).not.toBe(draft.id);
    await expect(o.exec(o.member, 'crm.quote.revise', { quoteId: draft.id })).rejects.toMatchObject({ code: 'QUOTE_ALREADY_REVISED', status: 409 });
    // The older row is untouched, and the revision is edited like any draft.
    expect(await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: draft.id })).toEqual(sent);
    expect((await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: revision.id, version: 1, lines: [item({ quantity: '5' })] })).version).toBe(2);
    // Deleting the draft revision frees the quote to be revised again.
    await o.exec(o.member, 'crm.quote.delete_draft', { quoteId: revision.id });
    expect((await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: draft.id })).revision).toBe(2);

    // A declined quote may be revised; an accepted one is final.
    const second = await o.draft(deal.id);
    await o.send(second.id, 'BG-2026-0002');
    await admin((c) => c.query("UPDATE crove_crm.quote SET status = 'accepted', decided_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, second.id]));
    await expect(o.exec(o.member, 'crm.quote.revise', { quoteId: second.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_REVISABLE' });
    await admin((c) => c.query("UPDATE crove_crm.quote SET status = 'declined' WHERE org_id = $1 AND id = $2", [o.orgId, second.id]));
    expect((await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: second.id })).revisesId).toBe(second.id);
  });

  it('shows a sent quote past its validity date as expired without storing it', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const quote = await o.draft(deal.id);
    await o.send(quote.id);
    expect((await o.query<Quote>(o.owner, 'crm.quote.get', { quoteId: quote.id })).expired).toBe(false);
    await admin((c) => c.query("UPDATE crove_crm.quote SET valid_until = '2020-01-01' WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]));
    expect(await o.query<Quote>(o.owner, 'crm.quote.get', { quoteId: quote.id })).toMatchObject({ status: 'sent', expired: true });
    // A draft past its date is not expired: only a sent quote is.
    const old = await o.draft(deal.id);
    await admin((c) => c.query("UPDATE crove_crm.quote SET valid_until = '2020-01-01' WHERE org_id = $1 AND id = $2", [o.orgId, old.id]));
    expect((await o.query<Quote>(o.owner, 'crm.quote.get', { quoteId: old.id })).expired).toBe(false);
  });

  it('offers the org\'s defaults, the last VAT rate and the earlier prices of the customer only', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const stranger = await o.party('Công ty khác');
    expect(await o.query<QuoteDefaults>(o.viewer, 'crm.quote.defaults', { partyId: party })).toEqual({ validDays: 14, defaultVat: '10%', defaultTerms: null, hints: [] });
    expect(await o.exec(o.adminUser, 'crm.quote_setting.set', { validDays: 30, defaultVat: '8', defaultTerms: 'Thanh toán trong 7 ngày' })).toEqual({ validDays: 30, defaultVat: '8%', defaultTerms: 'Thanh toán trong 7 ngày', phone: null, email: null, bankNote: null });
    await expect(o.exec(o.owner, 'crm.quote_setting.set', { validDays: 6, defaultVat: '10%', defaultTerms: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.exec(o.owner, 'crm.quote_setting.set', { validDays: 30, defaultVat: '77%', defaultTerms: null })).rejects.toMatchObject({ code: 'QUOTE_VAT_RATE_INVALID' });
    const deal = await o.newDeal(party);
    // A new quote takes the org's validity and default terms.
    const quote = await o.draft(deal.id);
    const valid = new Date(`${vietnamToday()}T00:00:00Z`);
    valid.setUTCDate(valid.getUTCDate() + 30);
    expect(quote).toMatchObject({ terms: 'Thanh toán trong 7 ngày', validUntil: valid.toISOString().slice(0, 10) });
    await o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, terms: null, lines: [item({ unitPrice: '1500000.5', vatRate: '5%' }), item({ description: 'gói kế toán năm', unitPrice: '1' }), item({ description: 'Tư vấn', unit: null, unitPrice: '200000', vatRate: 'KCT' })] });
    const defaults = await o.query<QuoteDefaults>(o.member, 'crm.quote.defaults', { partyId: party });
    expect(defaults.defaultVat).toBe('5%');
    expect(defaults.hints.map((h) => [h.description, h.unitPrice, h.vatRate]).sort()).toEqual([['Tư vấn', '200000', 'KCT'], ['Gói kế toán năm', '1500000.5', '5%']].sort());
    // Two descriptions that differ only in case are one hint: the earlier line of the latest quote.
    expect(defaults.hints.every((h) => h.quoteId === quote.id)).toBe(true);
    expect(await o.query<QuoteDefaults>(o.member, 'crm.quote.defaults', { partyId: stranger })).toMatchObject({ defaultVat: '8%', hints: [] });
  });

  it('isolates orgs: another org reads no quote and cannot quote a deal it does not have', async () => {
    const a = await org();
    const b = await org();
    const dealA = await a.newDeal(await a.party('Công ty ABC'));
    const quoteA = await a.draft(dealA.id);
    await expect(b.query(b.owner, 'crm.quote.get', { quoteId: quoteA.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', status: 404 });
    await expect(b.exec(b.owner, 'crm.quote.save', { dealId: dealA.id, lines: [] })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    await expect(b.exec(b.owner, 'crm.quote.save', { quoteId: quoteA.id, version: 1, lines: [] })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    await expect(b.exec(b.owner, 'crm.quote.delete_draft', { quoteId: quoteA.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    await expect(b.exec(b.owner, 'crm.quote.revise', { quoteId: quoteA.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    expect((await b.query<QuotePage>(b.owner, 'crm.quote.list', {})).items).toEqual([]);
    expect((await b.query<QuoteDefaults>(b.owner, 'crm.quote.defaults', { partyId: await b.party('X') })).hints).toEqual([]);
  });

  // The document the PDF is made from (#2695): the quote, the org as the seller, the customer as the buyer; read only, for anyone who reads quotes.
  it('gives the quote document to a viewer: the quote, the org as seller, the customer as buyer, and another org\'s quote as missing', async () => {
    const o = await org();
    await admin((c) => c.query('UPDATE crove_kernel.tenant SET address = $2, contact_email = $3 WHERE org_id = $1', [o.orgId, '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', 'ketoan@bao-gia.test']));
    const party = await o.party('Công ty TNHH Đặng Thị Hằng');
    await admin((c) => c.query('UPDATE crove_kernel.party SET address = $3, email = $4 WHERE org_id = $1 AND id = $2', [o.orgId, party, '5 Lê Lợi, Đà Nẵng', 'mua@bao-gia.test']));
    const deal = await o.newDeal(party);
    const quote = await o.exec<Quote>(o.member, 'crm.quote.save', {
      dealId: deal.id,
      lines: [item({ description: 'Dịch vụ kế toán trọn gói tháng 11' })],
    });
    const document = await o.query<QuoteDocument>(o.viewer, 'crm.quote.document', { quoteId: quote.id });
    expect(document.quote).toEqual(quote);
    expect(document.buyer).toEqual({ name: 'Công ty TNHH Đặng Thị Hằng', taxCode: null, address: '5 Lê Lợi, Đà Nẵng', phone: null, email: 'mua@bao-gia.test' });
    expect(document.seller).toMatchObject({ address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', email: 'ketoan@bao-gia.test', bankNote: null });
    expect(document.seller.name).toMatch(/^Công ty /);
    expect(document.issuedOn).toBe(vietnamToday(new Date(quote.createdAt)));
    // The same document gives the same bytes, and they are a PDF.
    const bytes = renderQuotePdf(document);
    expect(Buffer.from(bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(renderQuotePdf(document)).equals(Buffer.from(bytes))).toBe(true);
    const other = await org();
    await expect(other.query(other.viewer, 'crm.quote.document', { quoteId: quote.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', status: 404 });
  });

  it('holds the draft rule in SQL as the runtime\'s own login: only a fresh draft is inserted, the status and number are never set, a sent quote is read-only', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const quote = await o.draft(deal.id);
    await o.send(quote.id);
    const draft = await o.draft(deal.id);
    async function as<T>(user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, user, o.orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const insert = (extra: string, values: unknown[] = []) =>
      `INSERT INTO crove_crm.quote (org_id, deal_id, party_id, valid_until, created_by${extra ? `, ${extra}` : ''}) VALUES ($1, $2, $3, '2031-01-31', $4${values.map((_, i) => `, $${i + 5}`).join('')}) RETURNING id`;
    const base = [o.orgId, deal.id, party, o.member];
    // A writer inserts a fresh draft; a viewer inserts nothing.
    expect(await as(o.member, async (c) => (await c.query(insert(''), base)).rowCount)).toBe(1);
    await expect(as(o.viewer, (c) => c.query(insert(''), base))).rejects.toMatchObject({ code: '42501' });
    // A fresh draft only: not a sent quote, not one with a number, a send time, a view, a decision or a reason.
    const forged: [string, unknown[]][] = [
      ["status", ['sent']],
      ["status", ['accepted']],
      ["number", ['BG-2026-0099']],
      ["sent_at", ['2026-01-01T00:00:00Z']],
      ["sent_via", ['link']],
      ["first_viewed_at", ['2026-01-01T00:00:00Z']],
      ["decided_at", ['2026-01-01T00:00:00Z']],
      ["decline_reason", ['x']],
    ];
    for (const [column, values] of forged) {
      await expect(as(o.member, (c) => c.query(insert(column, values), [...base, ...values])), column).rejects.toMatchObject({ code: '42501' });
    }
    // The editable columns of a draft change; the status, the number, the sent and decided facts, the deal and the customer never do.
    expect(await as(o.member, async (c) => (await c.query("UPDATE crove_crm.quote SET remarks = 'x', terms = 'y', valid_until = '2031-02-01' WHERE org_id = $1 AND id = $2", [o.orgId, draft.id])).rowCount)).toBe(1);
    // The status, the number, the sent columns and the decision columns (Q4) are granted to the commands' transitions, which the guard trigger holds: a draft is not edited into a sent or decided quote.
    for (const set of ["status = 'sent'", "number = 'BG-2026-0098'", 'sent_at = now()', "sent_via = 'email'", `issuer_entity_id = '${randomUUID()}'`, "buyer_name = 'x'", 'decided_at = now()', "decline_reason = 'x'"]) {
      await expect(as(o.member, (c) => c.query(`UPDATE crove_crm.quote SET ${set} WHERE org_id = $1 AND id = $2`, [o.orgId, draft.id])), set).rejects.toMatchObject({ code: '42501' });
    }
    // The rest is never granted to a tenant role.
    for (const set of ['first_viewed_at = now()', `deal_id = '${randomUUID()}'`, `party_id = '${randomUUID()}'`, 'created_at = now()', `created_by = '${randomUUID()}'`, `revises_id = '${quote.id}'`, 'revision = 9']) {
      await expect(as(o.member, (c) => c.query(`UPDATE crove_crm.quote SET ${set} WHERE org_id = $1 AND id = $2`, [o.orgId, draft.id])), set).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    }
    // A viewer changes and deletes nothing; a sent quote is read-only to every tenant role, and its lines too.
    expect(await as(o.viewer, async (c) => (await c.query("UPDATE crove_crm.quote SET remarks = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, draft.id])).rowCount)).toBe(0);
    expect(await as(o.viewer, async (c) => (await c.query('DELETE FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [o.orgId, draft.id])).rowCount)).toBe(0);
    for (const who of [o.member, o.owner]) {
      await expect(as(who, (c) => c.query("UPDATE crove_crm.quote SET remarks = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FROZEN') });
      expect(await as(who, async (c) => (await c.query('DELETE FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [o.orgId, quote.id])).rowCount)).toBe(0);
    }
    const lineSql = (quoteId: string) => ({
      text: "INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, quantity, unit_price, vat_rate, amount, vat_amount) VALUES ($1, $2, 1, 'item', 'Dòng', 1, 100, '10%', 100, 10) RETURNING id",
      values: [o.orgId, quoteId],
    });
    expect(await as(o.member, async (c) => (await c.query(lineSql(draft.id))).rowCount)).toBe(1);
    await expect(as(o.member, (c) => c.query(lineSql(quote.id)))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.viewer, (c) => c.query(lineSql(draft.id)))).rejects.toMatchObject({ code: '42501' });
    // A line of a sent quote is neither changed nor deleted (its row reads as absent to the update and the delete).
    const sentLine = (await admin((c) => c.query<{ id: string }>(lineSql(quote.id).text, lineSql(quote.id).values))).rows[0]!.id;
    expect(await as(o.owner, async (c) => (await c.query("UPDATE crove_crm.quote_line SET description = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, sentLine])).rowCount)).toBe(0);
    expect(await as(o.owner, async (c) => (await c.query('DELETE FROM crove_crm.quote_line WHERE org_id = $1 AND id = $2', [o.orgId, sentLine])).rowCount)).toBe(0);
    // The shape of a line: an item needs a positive quantity and price, a text line has no amounts.
    await expect(admin((c) => c.query("INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, quantity, unit_price, vat_rate) VALUES ($1, $2, 2, 'item', 'x', 0, 1, '10%')", [o.orgId, draft.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(admin((c) => c.query("INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, amount) VALUES ($1, $2, 3, 'text', 'x', 5)", [o.orgId, draft.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(admin((c) => c.query("UPDATE crove_crm.quote SET total = 5 WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]))).rejects.toMatchObject({ code: '23514' });
  });

  it('holds the setting\'s role in SQL: owners and admins write it, members and viewers read it', async () => {
    const o = await org();
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 20, defaultVat: '10%', defaultTerms: null });
    async function as<T>(user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, user, o.orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    for (const who of [o.member, o.viewer, o.adminUser, o.owner]) expect(await as(who, async (c) => (await c.query('SELECT 1 FROM crove_crm.quote_setting WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
    for (const who of [o.member, o.viewer]) {
      expect(await as(who, async (c) => (await c.query('UPDATE crove_crm.quote_setting SET valid_days = 30 WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
      expect(await as(who, async (c) => (await c.query('DELETE FROM crove_crm.quote_setting WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
    }
    expect(await as(o.adminUser, async (c) => (await c.query('UPDATE crove_crm.quote_setting SET valid_days = 30 WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
    await expect(as(o.adminUser, (c) => c.query('UPDATE crove_crm.quote_setting SET created_at = now() WHERE org_id = $1', [o.orgId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('writes timeline rows and audit rows with ids and counts only, never a price or a line text', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const quote = await o.draft(deal.id);
    const saved = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: quote.id, version: 1, notes: 'Bí mật Nguyễn Văn A', terms: 'Điều khoản riêng', lines: [item({ description: 'Hàng bí mật XYZ', unitPrice: '7770001' })] });
    await o.send(quote.id);
    const revision = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: quote.id });
    await o.exec(o.member, 'crm.quote.delete_draft', { quoteId: revision.id });
    const timeline = await admin((c) => c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND record_type = 'kernel.party' AND record_id = $2 AND kind LIKE 'quote.%' ORDER BY occurred_at, id", [o.orgId, party]));
    expect(timeline.rows.map((r) => r.kind)).toEqual(['quote.created', 'quote.revised', 'quote.deleted']);
    const audit = await admin((c) => c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.quote%' AND outcome = 'ok' ORDER BY id", [o.orgId]));
    expect(audit.rows.map((r) => r.command)).toEqual(['crm.quote.save', 'crm.quote.save', 'crm.quote.revise', 'crm.quote.delete_draft']);
    const text = JSON.stringify(timeline.rows) + JSON.stringify(audit.rows);
    for (const secret of ['Bí mật', 'bí mật', 'Điều khoản', '7770001', saved.total, '1500000']) expect(text).not.toContain(secret);
  });
});
