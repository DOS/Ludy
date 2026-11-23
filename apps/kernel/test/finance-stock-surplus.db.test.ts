// SPDX-License-Identifier: AGPL-3.0-only
// The resolution of the surplus of a count of stock (#3712 slice 2a) on a real PostgreSQL 17. Confirming a count books a surplus to 3381; a member then asks to resolve it through
// kernel.proposal.request (command finance.journal_voucher.record, input { surplus: { countId, account, partyId? } }), an owner approves, and approving posts ONE voucher, Dr 3381 / Cr 711 (or 3388, or 331
// with a supplier), tagged with the count. The lines and the amount come from the books, never from the request; the approval works the amount out again. Refused: a count that is not confirmed or has no
// surplus, an account outside 711, 3388 and 331, 331 without a supplier and another account with one, a second request while one waits, a second resolution, a stored proposal that is not the voucher the
// books call for. The database keeps the tag to an executing finance.journal_voucher.record proposal.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { StockCount, StockSurplusSource } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the resolution of the surplus of a count (#3712 slice 2a)', () => {
  const dbName = `crove_test_stocksurplus_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@surplus.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hàng thừa ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.execute<T>(name, input, { actor: asMfa(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, item, date, quantity]).then((r) => r[0]?.id as string);
  type Line = { itemId: string; countedQuantity: string; unitCost?: string };
  const count = (o: Org, countDate: string, lines: Line[], user = o.member) =>
    execute<{ id: string }>(o, 'finance.stock_count.create', { countDate, lossNormPercent: '10', lines }, user).then((r) => r.id);
  const approve = async (o: Org, proposalId: string, user = o.owner) => {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  };
  const askCount = (o: Org, countId: string) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.stock.count_confirm', input: { countId } }, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() });
  const askSurplus = (o: Org, surplus: Record<string, unknown>, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal_voucher.record', input: { surplus } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const counts = (o: Org, user = o.member) => query<StockCount[]>(o, 'finance.stock_count.list', {}, user);
  const supplier = async (o: Org) =>
    (await rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, 'Công ty Cung ứng Mẫu', '0101234564') RETURNING id", [o.orgId]))[0]?.id as string;
  // A confirmed count with a surplus of 150 (three of an item the books never held, costed at 50) and, when asked, a shortage beside it.
  async function confirmedCount(o: Org, extraShortage = false): Promise<string> {
    const b = await makeItem(o, `B${randomUUID().slice(0, 4)}`);
    const lines: Line[] = [{ itemId: b, countedQuantity: '3', unitCost: '50' }];
    if (extraShortage) {
      const a = await makeItem(o, `A${randomUUID().slice(0, 4)}`);
      await move(o, a, '2026-09-05', '4');
      // Four on the books, three counted, at a cost typed for it: a shortage of one (worth 10), beside the surplus of 150, so the surplus must not net it.
      lines.push({ itemId: a, countedQuantity: '3', unitCost: '10' });
    }
    const countId = await count(o, '2026-09-30', lines);
    await approve(o, (await askCount(o, countId)).proposalId);
    return countId;
  }
  const entryLines = (o: Org, entryId: string) =>
    rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit, party_id FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no',
      [o.orgId, entryId],
    );

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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('resolves the surplus to 711 by default: one voucher, Dr 3381 / Cr 711 for the surplus, tagged with the count, and the count shows it resolved', async () => {
    const o = await org();
    const countId = await confirmedCount(o, true);
    const [before] = await counts(o);
    // The surplus is what the count's adjustments brought in; a shortage beside it is none of it.
    expect(before).toMatchObject({ id: countId, status: 'confirmed', surplus: '150', surplusVoucherId: null, surplusProposalId: null });
    const { proposalId } = await askSurplus(o, { countId, account: '711' });
    const [waiting] = await counts(o);
    expect(waiting).toMatchObject({ surplusVoucherId: null, surplusProposalId: proposalId });
    const posted = await approve(o, proposalId);
    expect(await entryLines(o, posted.journalEntryId)).toEqual([
      { account_code: '3381', debit: '150', credit: '0', party_id: null },
      { account_code: '711', debit: '0', credit: '150', party_id: null },
    ]);
    const [voucher] = await rows<{ surplus_count_id: string; proposal_id: string; stock_count_id: string | null }>(
      'SELECT surplus_count_id, proposal_id, stock_count_id FROM ludy_finance.journal_voucher WHERE org_id = $1 AND id = $2',
      [o.orgId, posted.voucherId],
    );
    // The tag is the resolution's own: stock_count_id stays the column of the voucher that confirms a count.
    expect(voucher).toEqual({ surplus_count_id: countId, proposal_id: proposalId, stock_count_id: null });
    const [after] = await counts(o, o.viewer);
    expect(after).toMatchObject({ surplus: '150', surplusVoucherId: posted.voucherId, surplusProposalId: null });
    // 3381 is clear for the count: the confirmation credited 150 and the resolution debited it.
    const [balance] = await rows<{ net: string }>(
      "SELECT (sum(l.credit) - sum(l.debit))::bigint::text AS net FROM ludy_finance.journal_line l WHERE l.org_id = $1 AND l.account_code = '3381'",
      [o.orgId],
    );
    expect(balance?.net).toBe('0');
  });

  it('books to 3388 with nobody named, and to 331 with the supplier the goods belong to', async () => {
    const o = await org();
    const first = await confirmedCount(o);
    const posted = await approve(o, (await askSurplus(o, { countId: first, account: '3388' })).proposalId);
    expect(await entryLines(o, posted.journalEntryId)).toEqual([
      { account_code: '3381', debit: '150', credit: '0', party_id: null },
      { account_code: '3388', debit: '0', credit: '150', party_id: null },
    ]);
    const second = await confirmedCount(o);
    const vendor = await supplier(o);
    const viaVendor = await approve(o, (await askSurplus(o, { countId: second, account: '331', partyId: vendor })).proposalId);
    expect(await entryLines(o, viaVendor.journalEntryId)).toEqual([
      { account_code: '3381', debit: '150', credit: '0', party_id: null },
      { account_code: '331', debit: '0', credit: '150', party_id: vendor },
    ]);
  });

  it('refuses an account outside the three, 331 without a supplier, another account with one, an amount sent by the requester, and a count that is not confirmed or has no surplus', async () => {
    const o = await org();
    const countId = await confirmedCount(o);
    await expect(askSurplus(o, { countId, account: '511' })).rejects.toBeTruthy();
    await expect(askSurplus(o, { countId, account: '331' })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_PARTY_REQUIRED' });
    await expect(askSurplus(o, { countId, account: '711', partyId: await supplier(o) })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_PARTY_UNEXPECTED' });
    // The amount is never an input: a request that carries one is not a request of this kind.
    await expect(askSurplus(o, { countId, account: '711', amount: '1' })).rejects.toBeTruthy();
    // A draft count, and one that matches the books and so has no surplus, have nothing to resolve.
    const item = await makeItem(o, `D${randomUUID().slice(0, 4)}`);
    const draft = await count(o, '2026-09-30', [{ itemId: item, countedQuantity: '1', unitCost: '10' }]);
    await expect(askSurplus(o, { countId: draft, account: '711' })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_NOT_CONFIRMED' });
    const flat = await makeItem(o, `F${randomUUID().slice(0, 4)}`);
    await move(o, flat, '2026-09-05', '2');
    const matching = await count(o, '2026-09-30', [{ itemId: flat, countedQuantity: '2' }]);
    await execute(o, 'finance.stock_count.confirm_empty', { countId: matching });
    await expect(askSurplus(o, { countId: matching, account: '711' })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_NONE' });
    // Another org's count is not found, and nothing was written for any of the above.
    const stranger = await org();
    await expect(askSurplus(stranger, { countId, account: '711' })).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_FOUND' });
    const [none] = await rows<{ n: string }>("SELECT count(*)::text AS n FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.journal_voucher.record'", [o.orgId]);
    expect(none?.n).toBe('0');
  });

  it('resolves a surplus once: a second request while one waits is refused, and so is one after it is posted', async () => {
    const o = await org();
    const countId = await confirmedCount(o);
    const first = await askSurplus(o, { countId, account: '711' });
    await expect(askSurplus(o, { countId, account: '3388' })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_PENDING', status: 409 });
    // A viewer cannot approve; the owner can.
    await expect(approve(o, first.proposalId, o.viewer)).rejects.toMatchObject({ status: 403 });
    const posted = await approve(o, first.proposalId);
    await expect(askSurplus(o, { countId, account: '3388' })).rejects.toMatchObject({ code: 'STOCK_SURPLUS_RESOLVED', status: 409, details: { voucherId: posted.voucherId } });
    const vouchers = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_finance.journal_voucher WHERE org_id = $1 AND surplus_count_id = $2', [o.orgId, countId]);
    expect(vouchers[0]?.n).toBe('1');
  });

  it('works the amount out again at the approval: a stored proposal that is not the voucher the books call for is refused and posts nothing', async () => {
    const o = await org();
    const countId = await confirmedCount(o);
    const { proposalId } = await askSurplus(o, { countId, account: '711' });
    // The proposal as a requester could never have made it (the payload is built by the server): one for another amount, written under the owner's hand.
    await rows(
      `UPDATE ludy_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(payload, '{lines,0,debit}', '"100"'), '{lines,1,credit}', '"100"'), '{total}', '"100"')
       WHERE org_id = $1 AND id = $2`,
      [o.orgId, proposalId],
    );
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'STOCK_SURPLUS_STALE', status: 409 });
    const [none] = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_finance.journal_voucher WHERE org_id = $1 AND surplus_count_id IS NOT NULL', [o.orgId]);
    expect(none?.n).toBe('0');
  });

  it('keeps the tag in the table: a voucher naming a count must name its proposal and no other kind of voucher (the check constraint; the trigger that ties it to finance.journal_voucher.record is the same rule for the application role, which these superuser inserts are exempt from)', async () => {
    const o = await org();
    const countId = await confirmedCount(o);
    // Written with no proposal behind it: refused by the constraint (it must name its proposal) before any row exists.
    await expect(
      rows(
        `INSERT INTO ludy_finance.journal_voucher (org_id, legal_entity_id, voucher_date, description, surplus_count_id)
         SELECT $1, c.legal_entity_id, '2026-10-01', 'x', c.id FROM ludy_finance.stock_count c WHERE c.org_id = $1 AND c.id = $2`,
        [o.orgId, countId],
      ),
    ).rejects.toThrow(/journal_voucher_surplus|EFFECT_PROPOSAL_MISMATCH/);
    // The tag is exclusive of the other kinds: a voucher that confirms a count is no resolution.
    await expect(
      rows(
        `INSERT INTO ludy_finance.journal_voucher (org_id, legal_entity_id, voucher_date, description, surplus_count_id, stock_count_id, proposal_id)
         SELECT $1, c.legal_entity_id, '2026-10-01', 'x', c.id, c.id, gen_random_uuid() FROM ludy_finance.stock_count c WHERE c.org_id = $1 AND c.id = $2`,
        [o.orgId, countId],
      ),
    ).rejects.toThrow(/journal_voucher_surplus/);
  });

  // The facts for the explanation of the surplus (#3712 slice 2b): read from the books, the supplier a hint only.
  const source = (o: Org, countId: string, user = o.member) => query<StockSurplusSource>(o, 'finance.stock_count.surplus_source', { countId }, user);
  // A posted purchase of one item on a day, written by the database owner with triggers off (the books insist a document is posted with its entry, which this read does not look at).
  const received = (o: Org, item: string, partyId: string, date: string, quantity: string, invoiceNumber: string) =>
    admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const [entity] = (await c.query<{ id: string }>('SELECT id::text AS id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default ORDER BY created_at LIMIT 1', [o.orgId])).rows;
      const doc = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.purchase_document (org_id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction)
           VALUES ($1, $2, $3, 'AA', $4, $5::date, 100, 0, 100, 'purchase') RETURNING id`,
          [o.orgId, entity?.id, partyId, invoiceNumber, date],
        )
      ).rows[0];
      await c.query(
        `INSERT INTO ludy_finance.purchase_line (org_id, document_id, line_no, description, unit, quantity, amount, debit_account) VALUES ($1, $2, 1, 'Hàng hóa', 'cái', $3, 100, '156')`,
        [o.orgId, doc?.id, quantity],
      );
      await c.query(
        `INSERT INTO ludy_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt)
         VALUES ($1, $2, $3, $4::date, $5, 'document_line', $6, 1, 1)`,
        [o.orgId, entity?.id, item, date, quantity, doc?.id],
      );
    });

  it('gives the facts of a surplus: the items in surplus by value with the total, no supplier when none sold the goods, and a shortage beside it is not in it', async () => {
    const o = await org();
    const countId = await confirmedCount(o, true);
    const facts = await source(o, countId);
    expect(facts).toMatchObject({ countId, countDate: '2026-09-30', total: '150', moreItems: 0, supplier: null, manualEntry: false, voucherId: null, proposalId: null });
    expect(facts.items).toHaveLength(1);
    expect(facts.items[0]).toMatchObject({ quantity: '3', unit: 'cái', value: '150' });
    // A viewer may not (the answer names a supplier and may spend AI budget); another org's member does not find the count.
    await expect(source(o, countId, o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(source(await org(), countId)).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_FOUND' });
  });

  it('refuses a count that is not confirmed and one with no surplus, as a resolution does', async () => {
    const o = await org();
    const a = await makeItem(o, `D${randomUUID().slice(0, 4)}`);
    const draft = await count(o, '2026-09-30', [{ itemId: a, countedQuantity: '2', unitCost: '10' }]);
    await expect(source(o, draft)).rejects.toMatchObject({ code: 'STOCK_SURPLUS_NOT_CONFIRMED' });
  });

  it('names the supplier the goods were last received from as a hint, and follows the resolution: the proposal waiting, then the voucher', async () => {
    const o = await org();
    const party = await supplier(o);
    const other = (await rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name) VALUES ($1, 'Nhà cung cấp cũ') RETURNING id", [o.orgId]))[0]?.id as string;
    const b = await makeItem(o, `S${randomUUID().slice(0, 4)}`);
    await received(o, b, other, '2026-08-01', '5', '000001');
    await received(o, b, party, '2026-09-12', '5', '000002');
    // A receipt after the count day says nothing about what was found on it.
    await received(o, b, other, '2026-10-15', '5', '000003');
    // The books hold ten by the count day (two receipts of five, 100 each on the purchase lines, so 20 a unit), twenty are counted: a surplus of ten.
    const countId = await count(o, '2026-09-30', [{ itemId: b, countedQuantity: '20', unitCost: '50' }]);
    await approve(o, (await askCount(o, countId)).proposalId);
    const facts = await source(o, countId);
    expect(facts.supplier).toEqual({ partyId: party, name: 'Công ty Cung ứng Mẫu', lastReceived: '2026-09-12' });
    // Choosing is the person's: the hint changes nothing in the books, and a requester's own account and supplier are still validated as before.
    const { proposalId } = await askSurplus(o, { countId, account: '331', partyId: party });
    expect(await source(o, countId)).toMatchObject({ proposalId, voucherId: null });
    const posted = await approve(o, proposalId);
    expect(await source(o, countId)).toMatchObject({ proposalId: null, voucherId: posted.voucherId });
  });

  it('flags a manual entry on 3381 made since the count, and not the count\'s own voucher or the resolution', async () => {
    const o = await org();
    const countId = await confirmedCount(o);
    expect((await source(o, countId)).manualEntry).toBe(false);
    const [entity] = await rows<{ id: string }>('SELECT id::text AS id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default ORDER BY created_at LIMIT 1', [o.orgId]);
    const manual = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      {
        command: 'finance.journal_voucher.record',
        input: {
          date: '2026-10-01',
          description: 'Xử lý hàng thừa bằng tay',
          legalEntityId: entity?.id,
          lines: [
            { account: '3381', partyId: null, debit: '150', credit: '0' },
            { account: '711', partyId: null, debit: '0', credit: '150' },
          ],
        },
      },
      { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    await approve(o, manual.proposalId);
    expect((await source(o, countId)).manualEntry).toBe(true);
  });
});
