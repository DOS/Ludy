// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a stored marketplace settlement (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4) on a real PostgreSQL 17, through the finance proposal path:
// - a member asks (kernel.proposal.request, `finance.marketplace_settlement.record`) with the settlement alone, finance builds ONE journal voucher from the stored lines (Dr 131 / Cr 511, the
//   reverse when the net is negative), an owner or an admin approves it, and approving records one voucher that names the settlement, with its entry;
// - the platform's party and its link are created on the platform's first posting, once even when two first postings run together, and reused by the next;
// - the entry is built again at approval: a stored proposal that differs from the settlement is refused; a settlement posts once; a reversal or a reversed settlement, a closed period and a chart
//   with no map are refused;
// - the shipped set of commands (the map and the rows of the sales, payout and fee paths are `commentary`) refuses both the request and the approval with 409 until the accountant confirms the map (#2520).
// The tests that post use a command set made with a confirmed copy of the map; the shipped map is never changed. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, createMarketplaceSettlementCommands, financeCommands, financeQueries, type MarketplacePostingMap } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A copy of the shipped map with every row confirmed, for the runtime that posts.
const confirmedMaps = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
  const c = <T extends { status: string }>(r: T): T => ({ ...r, status: 'confirmed' });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld), vatPayable: c(base.vatPayable), pitPayable: c(base.pitPayable), pitOwnerEquity: c(base.pitOwnerEquity), feeExpense: c(base.feeExpense), accruedExpense: c(base.accruedExpense), outputVat: c(base.outputVat) } };
};
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.');

interface SeedLine {
  // The day the line's order was delivered; the first day of the period when absent, no order line (no delivery day) when null.
  delivered?: string | null;
  sales: string;
  discount?: string;
  refund?: string;
  // The tax the platform withheld on the line (a household seller's), '0' when absent.
  tax?: string;
}

suite('the posting of a marketplace settlement on PostgreSQL (#2516)', () => {
  const dbName = `crove_test_mkt_record_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let rtShipped: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => withAdmin(async (c) => (await c.query<T>(sql, params)).rows);

  // An org with an owner, an admin (who asks) and a member.
  async function org(regime: 'tt133' | 'tt99' = 'tt133') {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'mktrecord', subject: `${name}-${tag}`, email: `${name}-${tag}@mkt.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `Đối soát sàn ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    if (regime === 'tt99') {
      await withAdmin((c) =>
        c.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId]),
      );
    }
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    // Method `none` from the start: these tests are about posting, not about VAT, so a sale posts VAT-inclusive revenue as before (#4303 S3b; the VAT split has its own test).
    await withAdmin((c) => c.query("INSERT INTO ludy_finance.marketplace_vat_rate (org_id, legal_entity_id, effective_from, method) VALUES ($1, $2, '2000-01-01', 'none')", [orgId, entity]));
    return { orgId, owner, admin, member, entity };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // A settlement as an importer leaves it: the row and one line per order, every amount a decimal string.
  async function seed(o: Org, platform: string, start: string, end: string, lines: SeedLine[], reversalOf: string | null = null): Promise<string> {
    const id = randomUUID();
    await withAdmin(async (c) => {
      const net = lines.reduce((n, l) => n + Number(l.sales) - Number(l.discount ?? 0) - Number(l.refund ?? 0) - Number(l.tax ?? 0), 0);
      await c.query('BEGIN');
      await c.query('INSERT INTO ludy_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7)', [o.orgId, id, platform, start, end, reversalOf ? -net : net, reversalOf]);
      for (const [i, l] of lines.entries()) {
        const orderId = randomUUID();
        await c.query('INSERT INTO ludy_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, platform, `MK${randomUUID().slice(0, 12)}`]);
        if (l.delivered !== null) await c.query("INSERT INTO ludy_finance.channel_order_line (org_id, order_id, line_key, quantity, stage, delivered_at) VALUES ($1, $2, 'L1', 1, 'completed', $3)", [o.orgId, orderId, l.delivered ?? start]);
        await c.query(
          'INSERT INTO ludy_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, refund, tax_withheld, net) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [o.orgId, randomUUID(), id, orderId, `K${i}`, l.sales, l.discount ?? '0', l.refund ?? '0', l.tax ?? '0', Number(l.sales) - Number(l.discount ?? 0) - Number(l.refund ?? 0) - Number(l.tax ?? 0)],
        );
      }
      await c.query('COMMIT');
    });
    return id;
  }
  // A reversal of a settlement: its own row and a mirror of every line, marked as adjustments, in one transaction.
  async function reverse(o: Org, original: string): Promise<string> {
    const id = randomUUID();
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ludy_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net, reversal_of)
         SELECT org_id, $3, platform, period_start, period_end, -report_net, id FROM ludy_finance.channel_settlement WHERE org_id = $1 AND id = $2`,
        [o.orgId, original, id],
      );
      await c.query(
        `INSERT INTO ludy_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net, adjustment)
         SELECT org_id, gen_random_uuid(), $3, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net, true
         FROM ludy_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2`,
        [o.orgId, original, id],
      );
      await c.query('COMMIT');
    });
    return id;
  }

  const ask = (o: Org, settlementId: string, user = o.admin, runtime = rt) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.marketplace_settlement.record', input: { settlementId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function approve(o: Org, proposalId: string, user = o.owner, runtime = rt) {
    const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return runtime.execute<{ voucherId: string; journalEntryId: string; code: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  }
  const payloadOf = async (o: Org, proposalId: string) =>
    (await rows<{ payload: { lines: { account: string; party: { id: string } | null; debit: string; credit: string }[] } & Record<string, unknown> }>('SELECT payload FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.payload;
  const entryOf = (o: Org, entryId: string) =>
    rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit, party_id FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no',
      [o.orgId, entryId],
    );
  const parties = (o: Org, name: string) => rows<{ id: string; kind: string }>('SELECT id, kind FROM ludy_kernel.party WHERE org_id = $1 AND name = $2', [o.orgId, name]);
  const links = (o: Org, platform: string) => rows<{ party_id: string }>('SELECT party_id FROM ludy_finance.marketplace_party WHERE org_id = $1 AND legal_entity_id = $2 AND platform = $3', [o.orgId, o.entity, platform]);
  const vouchersOf = (o: Org, settlementId: string) => rows<{ id: string; proposal_id: string }>('SELECT id, proposal_id FROM ludy_finance.journal_voucher WHERE org_id = $1 AND settlement_id = $2', [o.orgId, settlementId]);

  const TWO: SeedLine[] = [{ sales: '100000', discount: '5000' }, { sales: '250000', discount: '10000' }];

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 6 });
    const base = { queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    // The runtime that posts registers the marketplace commands over a confirmed map; the other, the shipped set.
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => notMarketplace(c.name)), ...createMarketplaceSettlementCommands({ maps: confirmedMaps() }).commands],
      ...base,
    });
    rtShipped = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], ...base });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('posts one voucher naming the settlement: Dr 131 (the platform) / Cr 5111, the party and its link created on first use', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement);
    // Before the first posting the platform has no party: the 131 line names none, and the payload says what it posts.
    const stored = await payloadOf(o, proposalId);
    expect(stored).toMatchObject({ settlementId: settlement, platform: 'shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', date: '2026-10-15', sales: '350000', sellerDiscount: '15000', refund: '0', total: '335000', legalEntityId: o.entity });
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit, l.party])).toEqual([['131', '335000', '0', null], ['5111', '0', '335000', null]]);
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);

    const done = await approve(o, proposalId);
    const [voucher] = await vouchersOf(o, settlement);
    expect(voucher).toMatchObject({ id: done.voucherId, proposal_id: proposalId });
    const [created] = await parties(o, 'Shopee');
    expect(created?.kind).toBe('organization');
    expect(await links(o, 'shopee')).toEqual([{ party_id: created?.id }]);
    const lines = await entryOf(o, done.journalEntryId);
    expect(lines.map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['131', '335000', '0', created?.id], ['5111', '0', '335000', null]]);
    // The proposal moved to executed with its ledger effect (the database checks it at commit).
    expect((await rows<{ status: string }>('SELECT status FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('executed');
  });

  it("reuses the platform's party for its next settlement, named on the proposal from the start", async () => {
    const o = await org();
    const first = await seed(o, 'tiktok_shop', '2026-10-01', '2026-10-15', TWO);
    await approve(o, (await ask(o, first)).proposalId);
    const [party] = await parties(o, 'TikTok Shop');
    const second = await seed(o, 'tiktok_shop', '2026-10-16', '2026-10-31', [{ sales: '40000' }]);
    const { proposalId } = await ask(o, second);
    expect((await payloadOf(o, proposalId))?.lines[0]?.party).toMatchObject({ id: party?.id, name: 'TikTok Shop' });
    const done = await approve(o, proposalId);
    expect(await parties(o, 'TikTok Shop')).toHaveLength(1);
    expect(await links(o, 'tiktok_shop')).toHaveLength(1);
    expect((await entryOf(o, done.journalEntryId))[0]).toMatchObject({ account_code: '131', party_id: party?.id });
    // Another platform has its own party.
    const other = await seed(o, 'lazada', '2026-10-01', '2026-10-15', [{ sales: '70000' }]);
    await approve(o, (await ask(o, other)).proposalId);
    expect((await parties(o, 'Lazada'))[0]?.id).not.toBe(party?.id);
  });

  it('ends with one party and one link when two first postings of a platform run together', async () => {
    const o = await org();
    const a = await seed(o, 'lazada', '2026-10-01', '2026-10-15', [{ sales: '100000' }]);
    const b = await seed(o, 'lazada', '2026-10-16', '2026-10-31', [{ sales: '200000' }]);
    const [pa, pb] = [(await ask(o, a)).proposalId, (await ask(o, b)).proposalId];
    const results = await Promise.allSettled([approve(o, pa), approve(o, pb)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await parties(o, 'Lazada')).toHaveLength(1);
    expect(await links(o, 'lazada')).toHaveLength(1);
    const used = await rows<{ party_id: string }>(`SELECT DISTINCT l.party_id FROM ludy_finance.journal_line l WHERE l.org_id = $1 AND l.account_code = '131'`, [o.orgId]);
    expect(used).toHaveLength(1);
  });

  it('posts the reverse entry when the refunds and discounts exceed the sales, the platform on the credit side', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', discount: '10000', refund: '140000' }]);
    const { proposalId } = await ask(o, settlement);
    expect((await payloadOf(o, proposalId))?.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['5111', '50000', '0'], ['131', '0', '50000']]);
    const done = await approve(o, proposalId);
    const [party] = await parties(o, 'Shopee');
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['5111', '50000', '0', null], ['131', '0', '50000', party?.id]]);
  });

  it('posts a settlement once: a second request and a second approval of a pending one are refused', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const first = await ask(o, settlement);
    const second = await ask(o, settlement, o.member);
    await approve(o, first.proposalId);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_POSTED', status: 409 });
    await expect(approve(o, second.proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_POSTED', status: 409 });
    expect(await vouchersOf(o, settlement)).toHaveLength(1);
    // The database holds it too: a second voucher for the settlement and the month is refused whatever the command does.
    await expect(rows(`INSERT INTO ludy_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, settlement_month) VALUES ($1, '2026-10-15', 'x', $2, $3, '2026-10-01')`, [o.orgId, first.proposalId, settlement])).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a stored proposal that differs from the settlement, however it got there', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const tamper = async (sql: string, ...extra: unknown[]) => {
      const { proposalId } = await ask(o, settlement);
      await rows(sql, [o.orgId, proposalId, ...extra]);
      await expect(approve(o, proposalId), sql).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_MISMATCH', status: 422 });
      await rt.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    };
    // Larger amounts (balanced, so only the rebuild catches it), other accounts, another settlement's id, another entity, a party the link does not hold.
    await tamper(`UPDATE ludy_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(payload, '{lines,0,debit}', '"999000"'), '{lines,1,credit}', '"999000"'), '{total}', '"999000"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE ludy_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,account}', '"511"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE ludy_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE ludy_kernel.proposal SET payload = jsonb_set(payload, '{lines,0,party}', jsonb_build_object('id', $3::text, 'name', 'Shopee', 'taxCode', null)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE ludy_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,memo}', '"khác"') WHERE org_id = $1 AND id = $2`);
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);
    // Lines the settlement does not hold: a line added to the stored settlement after the proposal changes the rebuilt amount (the table is append-only for tenants, so a superuser adds it).
    const { proposalId } = await ask(o, settlement);
    await withAdmin(async (c) => {
      const orderId = randomUUID();
      await c.query('INSERT INTO ludy_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, 'shopee', `MK${randomUUID().slice(0, 12)}`]);
      await c.query("INSERT INTO ludy_finance.channel_order_line (org_id, order_id, line_key, quantity, stage, delivered_at) VALUES ($1, $2, 'L1', 1, 'completed', $3)", [o.orgId, orderId, '2026-10-02']);
      await c.query('INSERT INTO ludy_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, net) VALUES ($1, $2, $3, $4, $5, 1000, 1000)', [o.orgId, randomUUID(), settlement, orderId, 'KX']);
    });
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_MISMATCH' });
  });

  it('refuses a closed period, at the request and at the approval of a proposal made before the lock', async () => {
    const o = await org();
    const early = await seed(o, 'shopee', '2026-09-01', '2026-09-15', TWO);
    const late = await seed(o, 'shopee', '2026-09-16', '2026-09-30', TWO);
    const pending = await ask(o, late);
    await rt.execute('finance.period.lock', { month: '2026-09' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(ask(o, early)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    expect(await vouchersOf(o, late)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);
  });

  it('refuses a reversal, a reversed settlement, a zero net, an amount that is not whole dong, a missing settlement and a chart with no map', async () => {
    const o = await org();
    const original = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const reversal = await reverse(o, original);
    await expect(ask(o, original)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422, details: { reason: 'REVERSED' } });
    await expect(ask(o, reversal)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422, details: { reason: 'REVERSAL' } });
    const zero = await seed(o, 'lazada', '2026-10-01', '2026-10-15', [{ sales: '5000', discount: '5000' }]);
    await expect(ask(o, zero)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    const fraction = await seed(o, 'tiktok_shop', '2026-10-01', '2026-10-15', [{ sales: '1000.5' }]);
    await expect(ask(o, fraction)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    await expect(ask(o, randomUUID())).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_FOUND', status: 404 });
    // A settlement of another org is not found either.
    const stranger = await org();
    await expect(ask(stranger, original)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_FOUND' });
    // An entity on the TT99 chart: the map set injected here holds only the confirmed TT133 one, so it is refused as unknown (the shipped TT99 map exists but is commentary, #3711 slice 4).
    const tt99 = await org('tt99');
    const there = await seed(tt99, 'shopee', '2026-10-01', '2026-10-15', TWO);
    await expect(ask(tt99, there)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
    expect(await rows('SELECT 1 FROM ludy_finance.journal_voucher WHERE org_id = $1 AND settlement_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('takes the four-eyes rule of every ledger command: the requester does not approve while another may, a member cannot approve', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement, o.admin);
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.owner)).resolves.toMatchObject({ voucherId: expect.any(String) });
  });

  it('posts the sales path on the shipped map (#4303 S3b) and still refuses, at the request and the approval, a settlement that carries a household\'s withheld tax (that path is unconfirmed), writing nothing', async () => {
    // The sales path is applied on the shipped map; the household tax rows are not.
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('confirmed');
    expect(MARKETPLACE_POSTING_MAPS.tt133?.vatPayable.status).toBe('commentary');
    const o = await org();
    const sales = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const asked = await ask(o, sales, o.admin, rtShipped);
    await approve(o, asked.proposalId, o.owner, rtShipped);
    expect(await vouchersOf(o, sales)).toHaveLength(1);
    // A household with the platform's withheld tax: the request and the approval of a proposal made elsewhere are refused as unconfirmed.
    const h = await org();
    await household(h, ['goods']);
    const taxed = await seed(h, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', tax: '1500' }]);
    await expect(ask(h, taxed, h.admin, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    const { proposalId } = await ask(h, taxed);
    await expect(approve(h, proposalId, h.owner, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(await vouchersOf(h, taxed)).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [h.orgId, proposalId]))[0]?.status).toBe('pending');
    // The shipped map is unchanged by all of it.
    expect(MARKETPLACE_POSTING_MAPS.tt133?.vatPayable.status).toBe('commentary');
  });

  it('posts a settlement as one voucher per month of delivery, all by ONE proposal: the sale in the month it was delivered, a refund in the settlement\'s own month', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [
      { sales: '100000', discount: '10000', delivered: '2026-09-28' },
      { sales: '200000', delivered: '2026-10-02', refund: '30000' },
      { sales: '50000', delivered: '2026-10-09' },
    ]);
    // One proposal for the settlement: September (the sale of the first line) and October (the other two, less the refund of the second, dated on the settlement's last day).
    const { proposalId } = await ask(o, settlement);
    const stored = (await rows<{ payload: { date: string; total: string; sales: string; refund: string; months: { month: string; date: string; total: string }[]; lines: { account: string; memo: string }[] } }>('SELECT payload FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.payload;
    expect(stored).toMatchObject({ date: '2026-10-15', total: '310000', sales: '350000', refund: '30000', months: [{ month: '2026-09', date: '2026-09-30', total: '90000' }, { month: '2026-10', date: '2026-10-15', total: '220000' }] });
    // Every month's entry is on the proposal, each line's memo naming its month.
    expect(stored?.lines).toHaveLength(4);
    expect(stored?.lines.map((l) => l.memo.slice(-7))).toEqual(['2026-09', '2026-09', '2026-10', '2026-10']);
    await approve(o, proposalId);
    const vouchers = await rows<{ settlement_month: string; voucher_date: string; proposal_id: string }>('SELECT settlement_month::text, voucher_date::text, proposal_id FROM ludy_finance.journal_voucher WHERE org_id = $1 AND settlement_id = $2 ORDER BY settlement_month', [o.orgId, settlement]);
    expect(vouchers).toEqual([
      { settlement_month: '2026-09-01', voucher_date: '2026-09-30', proposal_id: proposalId },
      { settlement_month: '2026-10-01', voucher_date: '2026-10-15', proposal_id: proposalId },
    ]);
    // The settlement is posted in full: a second request is refused, and a closed month refuses the whole settlement, nothing partial.
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_POSTED', status: 409 });
  });

  it('refuses the whole settlement when any month is in a closed period, and posts none of them', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-09-28' }, { sales: '200000', delivered: '2026-10-02' }]);
    const { proposalId } = await ask(o, settlement);
    await rt.execute('finance.period.lock', { month: '2026-09' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
  });

  it('waits for the delivery day: a sale with none makes the whole settlement wait, and nothing is dated by a guess', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-10-02' }, { sales: '50000', delivered: null }, { sales: '20000', delivered: '2026-11-03' }]);
    // Two lines wait: one has no order line at all, and one was delivered after the settlement's last day.
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_WAITING_DELIVERY', status: 422, details: { lines: 2 } });
    // A line refunded at least as much as it sold needs no day.
    const refunded = await seed(o, 'shopee', '2026-10-16', '2026-10-31', [{ sales: '100000', discount: '10000', refund: '95000', delivered: null }]);
    const { proposalId } = await ask(o, refunded);
    await approve(o, proposalId);
    expect(await vouchersOf(o, refunded)).toHaveLength(1);
  });

  // A household seller: the default entity of the org is made a household with the given trades, and the rates of its trade are confirmed for the test (the shipped rows are commentary).
  async function household(o: Org, trades: string[], rateStatus: 'confirmed' | 'commentary' = 'confirmed') {
    await withAdmin(async (c) => {
      await c.query("UPDATE ludy_kernel.legal_entity SET kind = 'household' WHERE org_id = $1 AND id = $2", [o.orgId, o.entity]);
      await c.query("INSERT INTO ludy_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', 2, 'percentage', $3::text[])", [o.orgId, o.entity, trades]);
      await c.query("UPDATE ludy_finance.household_trade_rate SET status = $1 WHERE trade = 'goods'", [rateStatus]);
    });
    const rate = (await rows<{ vat_percent: string; pit_percent: string }>("SELECT vat_percent, pit_percent FROM ludy_finance.household_trade_rate WHERE trade = 'goods' AND effective_from <= '2026-10-15' ORDER BY effective_from DESC LIMIT 1", []))[0];
    return { vat: Number(rate?.vat_percent), pit: Number(rate?.pit_percent) };
  }
  type Stored = { total: string; taxWithheld?: string; taxEstimate?: { withheld: string; expected: string; difference: string }; lines: { account: string; debit: string; credit: string }[] };
  const proposalOf = async (id: string) => (await rows<{ payload: Stored }>('SELECT payload FROM ludy_kernel.proposal WHERE id = $1', [id]))[0]?.payload as Stored;

  it('credits the tax a platform withheld from a household to 3331 and 3335 in the month of the sale, split by the rate pair of its one trade, and nets to zero', async () => {
    const o = await org();
    const r = await household(o, ['goods']);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [
      { sales: '1000000', delivered: '2026-09-28', tax: '15000' },
      { sales: '2000000', delivered: '2026-10-02', tax: '30000' },
    ]);
    const { proposalId } = await ask(o, settlement);
    const stored = await proposalOf(proposalId);
    const credit = (a: string) => stored.lines.filter((l) => l.account === a).reduce((n, l) => n + Number(l.credit), 0);
    const debit = (a: string) => stored.lines.filter((l) => l.account === a).reduce((n, l) => n + Number(l.debit), 0);
    const vat = Math.round((45000 * r.vat) / (r.vat + r.pit));
    // Both months carry their own tax lines; the two parts add up to what was withheld.
    expect(credit('3331')).toBe(vat);
    expect(credit('3335')).toBe(45000 - vat);
    expect(debit('4212')).toBe(45000 - vat);
    expect(debit('5111')).toBe(vat);
    // The split is an estimate: the tax lines say so, and the proposal carries what the household's rate pair would take from the 3000000 of revenue beside what the platform withheld.
    const expected = Math.round((3000000 * (r.vat + r.pit)) / 100);
    expect(stored.taxEstimate).toEqual({ withheld: '45000', expected: String(expected), difference: String(45000 - expected) });
    expect(stored.lines.filter((l) => ['3331', '3335', '4212'].includes(l.account)).every((l) => (l as { memo?: string }).memo?.includes('ước tính'))).toBe(true);
    await approve(o, proposalId);
    // Posted: the org holds only this settlement's entries, so the ledger totals by account are exactly the proposal's, and the tax accounts net to what the payout will debit.
    const posted = Object.fromEntries(
      (await rows<{ account: string; d: string; c: string }>('SELECT account_code AS account, sum(debit)::bigint::text AS d, sum(credit)::bigint::text AS c FROM ludy_finance.journal_line WHERE org_id = $1 GROUP BY 1', [o.orgId])).map((l) => [l.account, [Number(l.d), Number(l.c)]]),
    );
    expect(posted).toEqual({ '131': [3000000, 0], '5111': [vat, 3000000], '3331': [0, vat], '4212': [45000 - vat, 0], '3335': [0, 45000 - vat] });
  });

  it('refuses a household whose rate row is not confirmed, or whose profile has no single trade, and posts nothing', async () => {
    const o = await org();
    await household(o, ['goods'], 'commentary');
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1000000', delivered: '2026-10-02', tax: '15000' }]);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_TAX_RATE_UNCONFIRMED', status: 409 });
    const o2 = await org();
    await household(o2, ['goods', 'services']);
    const s2 = await seed(o2, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1000000', delivered: '2026-10-02', tax: '15000' }]);
    await expect(ask(o2, s2)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    expect(await rows('SELECT 1 FROM ludy_finance.journal_voucher WHERE org_id = ANY($1)', [[o.orgId, o2.orgId]])).toHaveLength(0);
  });

  it('refuses a household settlement whose withheld total is not whole dong, and posts nothing', async () => {
    const o = await org();
    await household(o, ['goods']);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1000000', delivered: '2026-10-02', tax: '15000.5' }]);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    expect(await rows('SELECT 1 FROM ludy_finance.journal_voucher WHERE org_id = $1', [o.orgId])).toHaveLength(0);
  });

  it('refuses an entity of kind household that has no profile in force, rather than treating it as a company', async () => {
    const o = await org();
    await withAdmin((c) => c.query("UPDATE ludy_kernel.legal_entity SET kind = 'household' WHERE org_id = $1 AND id = $2", [o.orgId, o.entity]));
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1000000', delivered: '2026-10-02', tax: '15000' }]);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
  });

  it('posts no tax line for a seller that is no household, whatever the lines say was withheld', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1000000', delivered: '2026-10-02', tax: '15000' }]);
    const stored = await proposalOf((await ask(o, settlement)).proposalId);
    expect(stored.lines.map((l) => l.account)).toEqual(['131', '5111']);
  });

  it('holds the month in the database: the first day of a month, one voucher per settlement and month, and a month only on a settlement voucher', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement);
    await approve(o, proposalId);
    const insert = (settlementId: string | null, month: string | null) =>
      rows(`INSERT INTO ludy_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, settlement_month) VALUES ($1, '2026-10-15', 'x', $2, $3, $4)`, [o.orgId, proposalId, settlementId, month]);
    await expect(insert(settlement, '2026-10-02')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null, '2026-10-01')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(settlement, '2026-10-01')).rejects.toMatchObject({ code: '23505' });
  });

  it('holds the one voucher per settlement and the voucher shape in the database', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement);
    // A voucher naming a settlement is no closing, no count, no pay run posting, and names a proposal.
    await expect(rows(`INSERT INTO ludy_finance.journal_voucher (org_id, voucher_date, description, settlement_id) VALUES ($1, '2026-10-15', 'x', $2)`, [o.orgId, randomUUID()])).rejects.toBeTruthy();
    await expect(rows(`INSERT INTO ludy_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, closing_year) VALUES ($1, '2026-10-15', 'x', $2, $3, 2025)`, [o.orgId, proposalId, randomUUID()])).rejects.toBeTruthy();
  });
  // Output VAT of the sales (#4303 S3b, research rule 1): the rate comes from ludy_finance.marketplace_vat_rate through marketplaceVatRateAt, on the delivery day of each line.
  async function setRate(o: Org, rows: Array<{ from: string; method: 'deduction' | 'none'; percent: string | null }>, replaceAll = false) {
    await withAdmin(async (c) => {
      if (replaceAll) await c.query('DELETE FROM ludy_finance.marketplace_vat_rate WHERE org_id = $1', [o.orgId]);
      for (const r of rows) await c.query('INSERT INTO ludy_finance.marketplace_vat_rate (org_id, legal_entity_id, effective_from, method, vat_percent) VALUES ($1, $2, $3, $4, $5)', [o.orgId, o.entity, r.from, r.method, r.percent]);
    });
  }

  it('splits the sales into revenue and 33311 at the rate in force on each delivery day, rounded once, and posts one balanced voucher per month', async () => {
    const o = await org();
    // 8% until the end of 2026 and 10% from 2027 (data, set by a person); one sale delivered in each of two months, in one settlement.
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '8' }, { from: '2027-01-01', method: 'deduction', percent: '10' }], true);
    const settlement = await seed(o, 'shopee', '2026-12-20', '2027-01-10', [
      { sales: '1080000', discount: '0', delivered: '2026-12-28' },
      { sales: '1100000', discount: '0', delivered: '2027-01-03' },
    ]);
    const { proposalId } = await ask(o, settlement);
    const stored = await payloadOf(o, proposalId);
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['131', '1080000', '0'], ['5111', '0', '1000000'], ['33311', '0', '80000'],
      ['131', '1100000', '0'], ['5111', '0', '1000000'], ['33311', '0', '100000'],
    ]);
    const done = await approve(o, proposalId);
    expect(done.voucherId).toBeTruthy();
    const posted = await rows<{ account_code: string; debit: string; credit: string }>(
      `SELECT l.account_code, sum(l.debit)::bigint::text AS debit, sum(l.credit)::bigint::text AS credit FROM ludy_finance.journal_line l JOIN ludy_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
       JOIN ludy_finance.journal_voucher v ON v.org_id = e.org_id AND v.id = e.source_id AND e.source_type = 'finance.journal_voucher' WHERE v.org_id = $1 AND v.settlement_id = $2 GROUP BY l.account_code ORDER BY l.account_code`,
      [o.orgId, settlement],
    );
    expect(posted.map((r) => [r.account_code, r.debit, r.credit])).toEqual([['131', '2180000', '0'], ['33311', '0', '180000'], ['5111', '0', '2000000']]);
  });

  it('holds a settlement back with words when a delivery day has no rate row, shows what it waits for on the Sàn read, and posts once the row is entered', async () => {
    const o = await org();
    // No row at all: the settlement waits (nothing is guessed), at the request and in the list.
    await setRate(o, [], true);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1080000', discount: '0', delivered: '2026-10-05' }]);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE', status: 422, details: { dates: ['2026-10-05'] } });
    const wait = await rt.query<{ settlements: Array<{ months: string[]; waitingVatMonths: string[]; proposalId: string | null }> }>('finance.marketplace.worklist', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(wait.settlements[0]).toMatchObject({ months: ['2026-10'], waitingVatMonths: ['2026-10'], proposalId: null });
    // A row that starts AFTER the delivery day still does not cover it.
    await setRate(o, [{ from: '2026-10-06', method: 'deduction', percent: '8' }]);
    await expect(ask(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE', status: 422 });
    // A row from the start of the year covers it; the list stops waiting and the proposal is made.
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '8' }]);
    const { proposalId } = await ask(o, settlement);
    expect((await payloadOf(o, proposalId))?.lines.map((l) => [l.account, l.credit])).toEqual([['131', '0'], ['5111', '1000000'], ['33311', '80000']]);
    const after = await rt.query<{ settlements: Array<{ waitingVatMonths: string[] }> }>('finance.marketplace.worklist', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(after.settlements[0]?.waitingVatMonths).toEqual([]);
  });

  it('adds no VAT line for method none, and a wrong row is corrected by a later entry for the same date, the latest entry winning', async () => {
    const o = await org();
    await setRate(o, [{ from: '2026-01-01', method: 'none', percent: null }], true);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1080000', discount: '0', delivered: '2026-10-05' }]);
    expect((await payloadOf(o, (await ask(o, settlement)).proposalId))?.lines.map((l) => l.account)).toEqual(['131', '5111']);
    // The first entry of the date said 80 by mistake; entering the date again corrects it.
    const other = await org();
    await setRate(other, [{ from: '2026-01-01', method: 'deduction', percent: '80' }], true);
    await setRate(other, [{ from: '2026-01-01', method: 'deduction', percent: '8' }]);
    const again = await seed(other, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1080000', discount: '0', delivered: '2026-10-05' }]);
    expect((await payloadOf(other, (await ask(other, again)).proposalId))?.lines.map((l) => [l.account, l.credit])).toEqual([['131', '0'], ['5111', '1000000'], ['33311', '80000']]);
  });

  it('refuses the approval of a proposal whose rate was corrected after it was made (MARKETPLACE_SETTLEMENT_MISMATCH), writes nothing, and asking again gives the new split', async () => {
    const o = await org();
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '8' }], true);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1080000', discount: '0', delivered: '2026-10-05' }]);
    const { proposalId } = await ask(o, settlement);
    // The person finds the rate wrong and enters the date again: the later entry is in force from now on.
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '10' }]);
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_MISMATCH', status: 422 });
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM ludy_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    // A new request is built with the corrected rate: 1080000 x 10 / 110 = 98182 of VAT.
    const again = await ask(o, settlement, o.owner);
    expect((await payloadOf(o, again.proposalId))?.lines.map((l) => [l.account, l.credit])).toEqual([['131', '0'], ['5111', '981818'], ['33311', '98182']]);
  });

  it('posts a month whose net is zero but whose VAT is not (pieces at different rates), and lists no settlement that has nothing to post', async () => {
    const o = await org();
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '8' }, { from: '2027-01-01', method: 'deduction', percent: '10' }], true);
    // A sale of 1080000 delivered in 2026-12 at 8% with 108000 of it refunded (the refund falls in 2027-01 and takes the 8% of its sale), and a sale of 108000 delivered in 2027-01 at 10%.
    const settlement = await seed(o, 'shopee', '2026-12-20', '2027-01-15', [
      { sales: '1080000', discount: '0', refund: '108000', delivered: '2026-12-28' },
      { sales: '108000', discount: '0', delivered: '2027-01-05' },
    ]);
    const { proposalId } = await ask(o, settlement);
    const stored = await payloadOf(o, proposalId);
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['131', '1080000', '0'], ['5111', '0', '1000000'], ['33311', '0', '80000'],
      ['5111', '1818', '0'], ['33311', '0', '1818'],
    ]);
    await approve(o, proposalId);
    expect(await vouchersOf(o, settlement)).toHaveLength(2);
    // A settlement that sold and refunded the same amount at one rate (method none) has nothing to post: it is not listed and is refused with the net-zero reason.
    const quiet = await org();
    const cancelled = await seed(quiet, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '10000', discount: '0', refund: '10000', delivered: '2026-10-05' }]);
    await expect(ask(quiet, cancelled)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    const list = await rt.query<{ settlements: unknown[] }>('finance.marketplace.worklist', {}, { actor: asUser(quiet.owner), orgId: quiet.orgId });
    expect(list.settlements).toEqual([]);
  });

  it('takes a refund of the sale at the sale\'s rate: Dr 131 net, Cr 5111 and 33311 net of the refund (TT133)', async () => {
    const o = await org();
    await setRate(o, [{ from: '2026-01-01', method: 'deduction', percent: '8' }], true);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '1080000', discount: '0', refund: '108000', delivered: '2026-10-05' }]);
    const lines = (await payloadOf(o, (await ask(o, settlement)).proposalId))?.lines.map((l) => [l.account, l.debit, l.credit]);
    expect(lines).toEqual([['131', '972000', '0'], ['5111', '0', '900000'], ['33311', '0', '72000']]);
  });
});
