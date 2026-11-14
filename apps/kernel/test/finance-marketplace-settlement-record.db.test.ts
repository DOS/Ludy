// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a stored marketplace settlement (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4) on a real PostgreSQL 17, through the finance proposal path:
// - a member asks (kernel.proposal.request, `finance.marketplace_settlement.record`) with the settlement alone, finance builds ONE journal voucher from the stored lines (Dr 131 / Cr 511, the
//   reverse when the net is negative), an owner or an admin approves it, and approving records one voucher that names the settlement, with its entry;
// - the platform's party and its link are created on the platform's first posting, once even when two first postings run together, and reused by the next;
// - the entry is built again at approval: a stored proposal that differs from the settlement is refused; a settlement posts once; a reversal or a reversed settlement, a closed period and a chart
//   with no map are refused;
// - the shipped set of commands (every row of the account map is `commentary`) refuses both the request and the approval with 409 until the accountant confirms the map (#2520).
// The tests that post use a command set made with a confirmed copy of the map; the shipped map is never changed. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, createMarketplaceSettlementCommands, financeCommands, financeQueries, type MarketplacePostingMap } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A copy of the shipped map with every row confirmed, for the runtime that posts.
const confirmedMaps = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
  const c = <T extends { status: string }>(r: T): T => ({ ...r, status: 'confirmed' });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld) } };
};
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.');

interface SeedLine {
  sales: string;
  discount?: string;
  refund?: string;
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
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    if (regime === 'tt99') {
      await withAdmin((c) =>
        c.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId]),
      );
    }
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    return { orgId, owner, admin, member, entity };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // A settlement as an importer leaves it: the row and one line per order, every amount a decimal string.
  async function seed(o: Org, platform: string, start: string, end: string, lines: SeedLine[], reversalOf: string | null = null): Promise<string> {
    const id = randomUUID();
    await withAdmin(async (c) => {
      const net = lines.reduce((n, l) => n + Number(l.sales) - Number(l.discount ?? 0) - Number(l.refund ?? 0), 0);
      await c.query('BEGIN');
      await c.query('INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7)', [o.orgId, id, platform, start, end, reversalOf ? -net : net, reversalOf]);
      for (const [i, l] of lines.entries()) {
        const orderId = randomUUID();
        await c.query('INSERT INTO crove_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, platform, `MK${randomUUID().slice(0, 12)}`]);
        await c.query(
          'INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, refund, net) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [o.orgId, randomUUID(), id, orderId, `K${i}`, l.sales, l.discount ?? '0', l.refund ?? '0', Number(l.sales) - Number(l.discount ?? 0) - Number(l.refund ?? 0)],
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
        `INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net, reversal_of)
         SELECT org_id, $3, platform, period_start, period_end, -report_net, id FROM crove_finance.channel_settlement WHERE org_id = $1 AND id = $2`,
        [o.orgId, original, id],
      );
      await c.query(
        `INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net, adjustment)
         SELECT org_id, gen_random_uuid(), $3, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net, true
         FROM crove_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2`,
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
    (await rows<{ payload: { lines: { account: string; party: { id: string } | null; debit: string; credit: string }[] } & Record<string, unknown> }>('SELECT payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.payload;
  const entryOf = (o: Org, entryId: string) =>
    rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit, party_id FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no',
      [o.orgId, entryId],
    );
  const parties = (o: Org, name: string) => rows<{ id: string; kind: string }>('SELECT id, kind FROM crove_kernel.party WHERE org_id = $1 AND name = $2', [o.orgId, name]);
  const links = (o: Org, platform: string) => rows<{ party_id: string }>('SELECT party_id FROM crove_finance.marketplace_party WHERE org_id = $1 AND legal_entity_id = $2 AND platform = $3', [o.orgId, o.entity, platform]);
  const vouchersOf = (o: Org, settlementId: string) => rows<{ id: string; proposal_id: string }>('SELECT id, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND settlement_id = $2', [o.orgId, settlementId]);

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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
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

  it('posts one voucher naming the settlement: Dr 131 (the platform) / Cr 511, the party and its link created on first use', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement);
    // Before the first posting the platform has no party: the 131 line names none, and the payload says what it posts.
    const stored = await payloadOf(o, proposalId);
    expect(stored).toMatchObject({ settlementId: settlement, platform: 'shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', date: '2026-10-15', sales: '350000', sellerDiscount: '15000', refund: '0', total: '335000', legalEntityId: o.entity });
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit, l.party])).toEqual([['131', '335000', '0', null], ['511', '0', '335000', null]]);
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);

    const done = await approve(o, proposalId);
    const [voucher] = await vouchersOf(o, settlement);
    expect(voucher).toMatchObject({ id: done.voucherId, proposal_id: proposalId });
    const [created] = await parties(o, 'Shopee');
    expect(created?.kind).toBe('organization');
    expect(await links(o, 'shopee')).toEqual([{ party_id: created?.id }]);
    const lines = await entryOf(o, done.journalEntryId);
    expect(lines.map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['131', '335000', '0', created?.id], ['511', '0', '335000', null]]);
    // The proposal moved to executed with its ledger effect (the database checks it at commit).
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('executed');
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
    const used = await rows<{ party_id: string }>(`SELECT DISTINCT l.party_id FROM crove_finance.journal_line l WHERE l.org_id = $1 AND l.account_code = '131'`, [o.orgId]);
    expect(used).toHaveLength(1);
  });

  it('posts the reverse entry when the refunds and discounts exceed the sales, the platform on the credit side', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', discount: '10000', refund: '140000' }]);
    const { proposalId } = await ask(o, settlement);
    expect((await payloadOf(o, proposalId))?.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['511', '50000', '0'], ['131', '0', '50000']]);
    const done = await approve(o, proposalId);
    const [party] = await parties(o, 'Shopee');
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['511', '50000', '0', null], ['131', '0', '50000', party?.id]]);
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
    // The database holds it too: a second voucher for the settlement is refused whatever the command does.
    await expect(rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id) VALUES ($1, '2026-10-15', 'x', $2, $3)`, [o.orgId, first.proposalId, settlement])).rejects.toMatchObject({ code: '23505' });
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
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(payload, '{lines,0,debit}', '"999000"'), '{lines,1,credit}', '"999000"'), '{total}', '"999000"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,account}', '"5111"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,0,party}', jsonb_build_object('id', $3::text, 'name', 'Shopee', 'taxCode', null)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,memo}', '"khác"') WHERE org_id = $1 AND id = $2`);
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);
    // Lines the settlement does not hold: a line added to the stored settlement after the proposal changes the rebuilt amount (the table is append-only for tenants, so a superuser adds it).
    const { proposalId } = await ask(o, settlement);
    await withAdmin(async (c) => {
      const orderId = randomUUID();
      await c.query('INSERT INTO crove_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, 'shopee', `MK${randomUUID().slice(0, 12)}`]);
      await c.query('INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, net) VALUES ($1, $2, $3, $4, $5, 1000, 1000)', [o.orgId, randomUUID(), settlement, orderId, 'KX']);
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
    // An entity on the TT99 chart has no marketplace map yet.
    const tt99 = await org('tt99');
    const there = await seed(tt99, 'shopee', '2026-10-01', '2026-10-15', TWO);
    await expect(ask(tt99, there)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND settlement_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('takes the four-eyes rule of every ledger command: the requester does not approve while another may, a member cannot approve', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement, o.admin);
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.owner)).resolves.toMatchObject({ voucherId: expect.any(String) });
  });

  it('refuses both the request and the approval with 409 while the shipped map is unconfirmed, and writes nothing', async () => {
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    // The preparer, through the proposal path.
    await expect(ask(o, settlement, o.admin, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    // The recorder: a proposal that exists (made where the map is confirmed) is not posted by the shipped set.
    const { proposalId } = await ask(o, settlement);
    await expect(approve(o, proposalId, o.owner, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(await vouchersOf(o, settlement)).toHaveLength(0);
    expect(await parties(o, 'Shopee')).toHaveLength(0);
    expect(await links(o, 'shopee')).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    // The shipped map is unchanged by all of it.
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
  });

  it('holds the one voucher per settlement and the voucher shape in the database', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', TWO);
    const { proposalId } = await ask(o, settlement);
    // A voucher naming a settlement is no closing, no count, no pay run posting, and names a proposal.
    await expect(rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, settlement_id) VALUES ($1, '2026-10-15', 'x', $2)`, [o.orgId, randomUUID()])).rejects.toBeTruthy();
    await expect(rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, closing_year) VALUES ($1, '2026-10-15', 'x', $2, $3, 2025)`, [o.orgId, proposalId, randomUUID()])).rejects.toBeTruthy();
  });
});
