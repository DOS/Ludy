// SPDX-License-Identifier: AGPL-3.0-only
// What the Sàn screen lets a person act on (#2516 slice F, plan docs/plan/stock-and-marketplaces.md section 8.4): three short lists read by code from the books and the stored settlements, and the gate. No
// model call, nothing stored, no buyer or order data; reading posts nothing. Each item is one proposal a person can ask for with the existing commands (finance.marketplace_settlement.record,
// finance.marketplace_payout.record, finance.marketplace_fee_clearing.record), which still check everything again when asked and when approved; a list may therefore show an item a command later refuses
// (for example a period that has since been locked), and says so in the command's own words. An item that already has a pending proposal carries its id, so the screen links to it instead of offering a
// second request.
// - settlements to post: stored settlements that stand and have no posting voucher, with the net the entry would post (a zero net posts nothing and is not offered);
// - payouts to match: settlements whose posting stands and that have no payout voucher (a reversed payout counts: it is not posted again), that would post one (a receivable, money received, no
//   unexplained adjustment), with the entity's bank lines the transfer may be: money in, equal to the net, not before the period, and free of every voucher and of every pending proposal;
// - invoices to clear: the platform's posted fee invoices that still have something to clear while fees wait on 1388, with what a clearing would take now.
// `postingConfirmed` is false while the accountant has not confirmed the account map of an entity in view (#2520): every request would be refused, so the screen shows the actions disabled.
import { sql } from 'kysely';
import { MARKETPLACE_FEE_CLEARING_COMMAND, zMarketplaceBalanceInput, type MarketplaceWorklist } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { bankLineStates } from './bank-match.ts';
import { balanceOf, invoiceCleared, invoicePayable, standingInvoiceEntry } from './marketplace-fee-clearing-record.ts';
import { payoutOfBankLine } from './marketplace-payout-line.ts';
import { requireConfirmedMarketplaceMap, MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { postingsOf, settlementMonthsFor, settlementPosted } from './marketplace-settlement-months.ts';
import { platformPartyName } from './marketplace-settlement-record.ts';
import { booksOn } from './payroll-posting.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
type Maps = Readonly<Record<string, MarketplacePostingMap>>;
// A short list: the screen is a work list, not a report. The rest waits behind these.
const MAX_SETTLEMENTS = 50;
const MAX_CANDIDATES = 8;
const MAX_INVOICES = 30;

// The pending proposal of a command that names the item, if any (the id in a stored payload keeps the case it was given, so both sides are lowered).
const pendingOf = (ctx: QueryContext, command: string, key: string, id: string) =>
  sql<{ id: string }>`SELECT p.id FROM crove_kernel.proposal p WHERE p.org_id = ${ctx.orgId}::uuid AND p.command = ${command} AND p.status = 'pending' AND lower(p.payload->>${key}) = ${id.toLowerCase()} ORDER BY p.created_at LIMIT 1`
    .execute(ctx.trx)
    .then((r) => r.rows[0]?.id ?? null);

// Whether the account map of every entity in view is confirmed, on the chart the entity keeps today.
async function postingConfirmed(ctx: QueryContext, legalEntityId: string | undefined, maps: Maps): Promise<boolean> {
  const entities = (await sql<{ id: string }>`SELECT id FROM crove_kernel.legal_entity WHERE org_id = ${ctx.orgId}::uuid AND (${legalEntityId ?? null}::uuid IS NULL OR id = ${legalEntityId ?? null}::uuid)`.execute(ctx.trx)).rows;
  if (entities.length === 0) return false;
  const today = await databaseToday(ctx.trx);
  for (const entity of entities) {
    try {
      requireConfirmedMarketplaceMap((await booksOn(ctx, entity.id, today)).regime, maps);
    } catch {
      return false;
    }
  }
  return true;
}

// The read over a set of account maps. A test passes its own with a confirmed map; the shipped one is made from MARKETPLACE_POSTING_MAPS (every row `commentary`, so the gate reads closed).
export const createMarketplaceWorklist = (options: { maps?: Maps } = {}) =>
  defineQuery({
    name: 'finance.marketplace.worklist',
    input: zMarketplaceBalanceInput,
    access: ALL,
    handler: async (ctx, input): Promise<MarketplaceWorklist> => {
      const entity = input.legalEntityId === undefined ? sql`TRUE` : sql`s.legal_entity_id = ${input.legalEntityId}::uuid`;
      const standing = sql`s.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)`;
      const feesAccount = MARKETPLACE_POSTING_MAPS.tt133?.feeAwaitingInvoice.code ?? '1388';

      // Settlements that stand and have no posting voucher: the platform paid for them and the books do not say so yet. A settlement posts as one voucher per month of delivery, all by ONE proposal
      // (#2516 rework, slice C1), so it is one row with its months and the net of their entries (a settlement of zero net posts nothing and is not offered). A settlement with a sale that has no
      // delivery day yet is one row that waits ("chờ ngày giao"), with no month and nothing to ask for.
      const standingRows = (
        await sql<{ id: string; legal_entity_id: string; platform: string; period_start: string; period_end: string }>`
          SELECT s.id, s.legal_entity_id, s.platform, s.period_start::text, s.period_end::text
          FROM crove_finance.channel_settlement s
          WHERE s.org_id = ${ctx.orgId}::uuid AND ${entity} AND ${standing}
            AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher v WHERE v.org_id = s.org_id AND v.settlement_id = s.id)
          ORDER BY s.period_end DESC, s.id LIMIT ${MAX_SETTLEMENTS}`.execute(ctx.trx)
      ).rows;
      const monthsOf = await settlementMonthsFor(ctx, standingRows.map((s) => ({ id: s.id, periodEnd: s.period_end })));
      const settlements: MarketplaceWorklist['settlements'] = [];
      for (const s of standingRows) {
        const m = monthsOf.get(s.id) ?? { months: [], waiting: 0 };
        if (m.months.length === 0 && m.waiting === 0) continue;
        settlements.push({
          id: s.id,
          legalEntityId: s.legal_entity_id,
          platform: s.platform,
          platformName: platformPartyName(s.platform),
          periodFrom: s.period_start,
          periodTo: s.period_end,
          months: m.waiting > 0 ? [] : m.months.map((x) => x.month),
          net: m.waiting > 0 ? '0' : toMoney(sum(m.months.map((x) => x.net))),
          waitingLines: m.waiting,
          proposalId: m.waiting > 0 ? null : await pendingOf(ctx, 'finance.marketplace_settlement.record', 'settlementId', s.id),
        });
      }

      // Settlements whose posting stands and that have no payout voucher (reversed or not): what the platform still has to be recorded as paying.
      const posted = (
        await sql<{ id: string; legal_entity_id: string; platform: string; period_start: string; period_end: string; receivable: string; received: string; other: string }>`
          SELECT s.id, s.legal_entity_id, s.platform, s.period_start::text, s.period_end::text,
                 coalesce(sum(l.sales - l.seller_discount - l.refund), 0)::text AS receivable, coalesce(sum(l.net), 0)::text AS received, coalesce(sum(l.other), 0)::text AS other
          FROM crove_finance.channel_settlement s
          JOIN crove_finance.channel_settlement_line l ON l.org_id = s.org_id AND l.settlement_id = s.id
          WHERE s.org_id = ${ctx.orgId}::uuid AND ${entity} AND ${standing}
            AND EXISTS (SELECT 1 FROM crove_finance.journal_voucher v WHERE v.org_id = s.org_id AND v.settlement_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher p WHERE p.org_id = s.org_id AND p.payout_settlement_id = s.id)
          GROUP BY s.id, s.legal_entity_id, s.platform, s.period_start, s.period_end
          ORDER BY s.period_end DESC, s.id LIMIT ${MAX_SETTLEMENTS * 4}`.execute(ctx.trx)
      ).rows;
      // Posted: the settlement has its vouchers and none is reversed, the rule the payout command asks for too.
      const postedPostings = await postingsOf(ctx, posted.map((p) => p.id));
      const standingPosted = posted.filter((p) => settlementPosted(postedPostings.get(p.id) ?? [])).slice(0, MAX_SETTLEMENTS);
      // Only a settlement the payout command could post: a receivable to clear, money received, no unexplained adjustment.
      const payable = standingPosted.filter((p) => money(p.receivable).greaterThan(0) && money(p.received).greaterThan(0) && money(p.other).isZero());
      const payouts: MarketplaceWorklist['payouts'] = [];
      for (const p of payable) {
        const lines = (
          await sql<{ id: string; value_date: string; amount: string; bank_ref: string | null }>`
            SELECT id, value_date::text, amount::text, bank_ref FROM crove_finance.bank_line
            WHERE org_id = ${ctx.orgId}::uuid AND legal_entity_id = ${p.legal_entity_id}::uuid AND amount = ${money(p.received).toFixed()}::numeric AND value_date >= ${p.period_start}::date
            ORDER BY value_date, id LIMIT ${MAX_CANDIDATES * 3}`.execute(ctx.trx)
        ).rows;
        const states = await bankLineStates(ctx, lines.map((l) => l.id));
        const free: MarketplaceWorklist['payouts'][number]['candidates'] = [];
        for (const l of lines) {
          if (free.length >= MAX_CANDIDATES) break;
          // Open for a bank voucher and never held by a payout (a reversed payout still holds its line: the database keeps one payout voucher per line for good).
          if (states.get(l.id)?.status !== 'open' || (await payoutOfBankLine(ctx, l.id, { reversedToo: true })) !== null) continue;
          free.push({ id: l.id, date: l.value_date, amount: toMoney(money(l.amount)), reference: l.bank_ref });
        }
        payouts.push({
          settlementId: p.id,
          legalEntityId: p.legal_entity_id,
          platform: p.platform,
          platformName: platformPartyName(p.platform),
          periodFrom: p.period_start,
          periodTo: p.period_end,
          received: toMoney(money(p.received)),
          candidates: free,
          proposalId: await pendingOf(ctx, 'finance.marketplace_payout.record', 'settlementId', p.id),
        });
      }

      // The platforms' fee invoices that still have something to clear while fees wait on 1388.
      let links = ctx.trx
        .selectFrom('crove_finance.marketplace_party as m')
        .select(['m.legal_entity_id', 'm.platform', 'm.party_id'])
        .where('m.org_id', '=', ctx.orgId);
      if (input.legalEntityId !== undefined) links = links.where('m.legal_entity_id', '=', input.legalEntityId);
      const invoices: MarketplaceWorklist['invoices'] = [];
      for (const link of await links.orderBy('m.platform').execute()) {
        const waiting = money((await balanceOf(ctx, link.legal_entity_id, link.party_id, feesAccount)).balance);
        if (!waiting.greaterThan(0)) continue;
        const docs = await ctx.trx
          .selectFrom('crove_finance.purchase_document')
          .select(['id', 'invoice_series', 'invoice_number', 'invoice_date'])
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', link.legal_entity_id)
          .where('party_id', '=', link.party_id)
          .where('direction', '=', 'purchase')
          .where('currency', '=', 'VND')
          .orderBy('invoice_date', 'desc')
          .limit(MAX_INVOICES)
          .execute();
        for (const doc of docs) {
          const entry = await standingInvoiceEntry(ctx, doc.id);
          if (!entry || entry.reversed) continue;
          const remaining = money(await invoicePayable(ctx, entry.id, link.party_id)).minus(money(await invoiceCleared(ctx, doc.id)));
          const clearable = remaining.lessThan(waiting) ? remaining : waiting;
          if (!clearable.greaterThan(0)) continue;
          invoices.push({
            documentId: doc.id,
            legalEntityId: link.legal_entity_id,
            platform: link.platform,
            platformName: platformPartyName(link.platform),
            invoice: `${doc.invoice_series ?? ''}${doc.invoice_number ?? ''}`.trim() || doc.id.slice(0, 8),
            date: String(doc.invoice_date).slice(0, 10),
            clearable: toMoney(clearable),
            proposalId: await pendingOf(ctx, MARKETPLACE_FEE_CLEARING_COMMAND, 'purchaseDocumentId', doc.id),
          });
        }
      }

      return { postingConfirmed: await postingConfirmed(ctx, input.legalEntityId, options.maps ?? MARKETPLACE_POSTING_MAPS), settlements, payouts, invoices };
    },
  });

export const marketplaceWorklist = createMarketplaceWorklist();
export const marketplaceWorklistQueries = [marketplaceWorklist];
