// SPDX-License-Identifier: AGPL-3.0-only
// Vy's matches of bank lines, in groups, and the lines already matched (#2385). Two reads on top of the bank matching of
// #326 (bank-match.ts), no write and no model call:
//
// - finance.bank.match_groups sorts the open lines of an account and period into a clean group (one exact candidate, no
//   warning: ask for and approve them together) and lines that need a look, each with the first reason it is not clean
//   (domain/bank-groups.ts). The screen asks for a voucher per clean line through kernel.proposal.request, as it does for
//   a single line, and approves them with kernel.proposal.approve_many: one step-up per batch, each voucher checked
//   one by one, four-eyes as the org's policy says. The grouping only decides what the screen offers in one action.
// - finance.bank.matched lists the lines a voucher settles: the voucher, who approved it, how its party was found
//   (`matchedBy` of the voucher's proposal) and whether it was reversed since. Undoing is the ordinary reversal, never
//   an edit of a posting.
import { sql } from 'kysely';
import { z } from 'zod';
import { voucherCode, zAccountCode, zId, zLedgerPeriod, zBankMatchedBy, type BankMatchGroups, type BankMatched, type BankMatchLine, type VoucherType } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { Decimal } from '@crove/l10n-vn';
import { BANK_SUGGESTIONS_MAX, bankLineStates, bankLineView, findBankLines, lineMatchFor, readParties } from './bank-match.ts';
import { classifyLine, invoiceKey, sharedInvoices, type Classified } from './domain/bank-groups.ts';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { ledgerPeriod } from './domain/ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { latestRevision } from './source-entry.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The most matched lines one read lists.
export const BANK_MATCHED_MAX = 500;

// Whether the party's open balance on the line's side (receivable 131 for money in, payable 331 for money out) covers the
// amount as the books stand now: an invoice already settled by a voucher leaves no balance for this line, and one whose
// voucher was reversed has it back (the reversal may be dated after the line, so no date cut-off is applied).
async function balanceCovers(ctx: QueryContext, line: { legalEntityId: string; amount: string }, partyId: string): Promise<boolean> {
  const amount = new Decimal(line.amount).abs();
  const inflow = new Decimal(line.amount).isPositive();
  const side = inflow ? sql<string>`pg_catalog.sum(l.debit) - pg_catalog.sum(l.credit)` : sql<string>`pg_catalog.sum(l.credit) - pg_catalog.sum(l.debit)`;
  const row = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .select(side.as('balance'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', line.legalEntityId)
    .where('l.party_id', '=', partyId)
    .where('l.account_code', 'like', inflow ? '131%' : '331%')
    .executeTakeFirst();
  return row?.balance != null && new Decimal(row.balance).greaterThanOrEqualTo(amount);
}

export const bankMatchGroups = defineQuery({
  name: 'finance.bank.match_groups',
  input: z.object({ bankAccount: zAccountCode, period: zLedgerPeriod, legalEntityId: zId.optional() }),
  access: REQUESTERS,
  handler: async (ctx, input): Promise<BankMatchGroups> => {
    const period = ledgerPeriod(input.period);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const ids = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('bank_account', '=', input.bankAccount)
      .where('value_date', '>=', period.from)
      .where('value_date', '<=', period.to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .limit(BANK_SUGGESTIONS_MAX)
      .execute();
    const states = await bankLineStates(ctx, ids.map((r) => r.id));
    const open = await findBankLines(ctx, ids.filter((r) => states.get(r.id)?.status === 'open').map((r) => r.id));
    const byId = new Map(open.map((l) => [l.id, l]));
    const parties = await readParties(ctx);
    const rows: Array<{ id: string; made: BankMatchLine; partyId: string | null; classified: Classified }> = [];
    for (const { id } of ids) {
      const line = byId.get(id);
      if (!line) continue;
      const { made, invoices } = await lineMatchFor(ctx, line, { status: 'open' }, parties, false);
      // A line with no voucher to make (fractions of a dong) or no party in sight stays an Inbox exception.
      if (!made.voucher || made.candidates.length === 0) continue;
      const partyId = made.suggested?.party.id ?? null;
      const exactInvoices = partyId ? invoices.filter((i) => i.partyId === partyId).map((i) => ({ series: i.series, number: i.number })) : [];
      const strong = made.suggested !== null && (made.suggested.reason === 'tax_code' || made.suggested.reason === 'invoice');
      const covers = partyId && strong && exactInvoices.length === 1 && made.candidates.length === 1 && !line.ambiguous ? await balanceCovers(ctx, line, partyId) : null;
      const classified = classifyLine({
        suggested: made.suggested ? { reason: made.suggested.reason } : null,
        candidates: made.candidates.length,
        flaggedAtImport: line.ambiguous,
        exactInvoices,
        balanceCovers: covers,
      });
      rows.push({ id, made: { ...made, group: classified.group, why: classified.why }, partyId, classified });
    }
    // Two clean lines naming one invoice are a double payment: both leave the clean group.
    const shared = sharedInvoices(rows.flatMap((r) => (r.classified.group === 'clean' && r.partyId ? ([[r.id, invoiceKey(r.partyId, r.classified.invoice)]] as const) : [])));
    const out: BankMatchGroups = { clean: [], look: [], more: ids.length >= BANK_SUGGESTIONS_MAX };
    for (const r of rows) {
      if (r.classified.group === 'clean' && !shared.has(r.id)) {
        // The clean line shows the invoice it settles, whatever reason found its party.
        const suggested = r.made.suggested ? { ...r.made.suggested, invoice: r.classified.invoice } : null;
        out.clean.push({ ...r.made, suggested });
      } else {
        out.look.push(r.classified.group === 'clean' ? { ...r.made, group: 'look', why: 'duplicate' } : r.made);
      }
    }
    return out;
  },
});

interface MatchedRow {
  line_id: string;
  voucher_id: string;
  voucher_type: string;
  number: number;
  voucher_date: string;
  amount: string;
  proposal_id: string | null;
  entry_id: string;
  party_id: string | null;
  party_name: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  matched_by: unknown;
  reversal_id: string | null;
  reversal_date: string | null;
}

// The lines of an account (all accounts when none is named) and period that a voucher settles, oldest first, with the
// voucher, who approved it and how its party was found. A voucher reversed since stays listed as reversed: the line is
// open again and may be matched anew. Names are those of members only (member_profiles).
export const bankMatched = defineQuery({
  name: 'finance.bank.matched',
  input: z.object({ bankAccount: zAccountCode.optional(), period: zLedgerPeriod, legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<BankMatched> => {
    const period = ledgerPeriod(input.period);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const { rows } = await sql<MatchedRow>`
      SELECT v.bank_line_id::text AS line_id, v.id::text AS voucher_id, v.voucher_type, v.number,
             pg_catalog.to_char(v.voucher_date, 'YYYY-MM-DD') AS voucher_date, v.amount::text AS amount,
             v.proposal_id::text AS proposal_id, j.id::text AS entry_id,
             v.party_id::text AS party_id, pa.name AS party_name,
             pr.decided_by::text AS decided_by, pr.decided_at, pr.payload -> 'matchedBy' AS matched_by,
             r.id::text AS reversal_id, pg_catalog.to_char(r.entry_date, 'YYYY-MM-DD') AS reversal_date
      FROM crove_finance.cash_voucher v
      JOIN crove_finance.bank_line l ON l.org_id = v.org_id AND l.id = v.bank_line_id
      JOIN crove_finance.journal_entry j ON j.org_id = v.org_id AND j.source_id = v.id AND j.source_type = ${VOUCHER_SOURCE} AND j.reverses_entry_id IS NULL AND ${latestRevision('j')}
      LEFT JOIN crove_finance.journal_entry r ON r.org_id = j.org_id AND r.reverses_entry_id = j.id
      LEFT JOIN crove_kernel.party pa ON pa.org_id = v.org_id AND pa.id = v.party_id
      LEFT JOIN crove_kernel.proposal pr ON pr.org_id = v.org_id AND pr.id = v.proposal_id
      WHERE v.org_id = ${ctx.orgId}
        AND l.legal_entity_id = ${legalEntityId}
        AND l.value_date >= ${period.from}::date AND l.value_date <= ${period.to}::date
        ${input.bankAccount ? sql`AND l.bank_account = ${input.bankAccount}` : sql``}
      ORDER BY l.value_date, l.import_id, l.position, v.created_at
      LIMIT ${BANK_MATCHED_MAX + 1}`.execute(ctx.trx);
    const more = rows.length > BANK_MATCHED_MAX;
    const shown = rows.slice(0, BANK_MATCHED_MAX);
    const lines = await findBankLines(ctx, [...new Set(shown.map((r) => r.line_id))]);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const deciders = [...new Set(shown.flatMap((r) => (r.decided_by ? [r.decided_by] : [])))];
    const names = new Map<string, string>();
    if (deciders.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${deciders}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    const items: BankMatched['items'] = [];
    for (const r of shown) {
      const line = lineById.get(r.line_id);
      if (!line) continue;
      const matchedBy = zBankMatchedBy.safeParse(r.matched_by);
      const approverName = r.decided_by ? names.get(r.decided_by) : undefined;
      items.push({
        line: bankLineView(line, r.reversal_id ? { status: 'open' } : { status: 'matched', voucherId: r.voucher_id, code: voucherCode(r.voucher_type as VoucherType, r.number) }),
        voucher: { id: r.voucher_id, code: voucherCode(r.voucher_type as VoucherType, r.number), type: r.voucher_type as VoucherType, date: r.voucher_date, amount: new Decimal(r.amount).toFixed(), journalEntryId: r.entry_id },
        party: r.party_id && r.party_name !== null ? { id: r.party_id, name: r.party_name } : null,
        proposalId: r.proposal_id,
        approvedBy: approverName ? { name: approverName } : null,
        approvedAt: r.decided_at ? r.decided_at.toISOString() : null,
        matchedBy: matchedBy.success ? matchedBy.data : null,
        reversal: r.reversal_id && r.reversal_date ? { id: r.reversal_id, entryDate: r.reversal_date } : null,
      });
    }
    return { items, more };
  },
});

// Registered together by the module.
export const bankGroupQueries = [bankMatchGroups, bankMatched];
