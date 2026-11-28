// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181), on the API side. The owner's question goes to the accounting coworker, which only chooses one entry of the closed catalogue and a kind of period (packages/agent
// ask-books.ts); everything else is code. The period is resolved here, from the day and from what code itself found in the question (never the model's reading). The report is then run through the runtime as the
// asking member, in that member's own transaction: the read's own role list, row security and legal-entity scope answer, and its own refusal is the refusal (it is not caught here, so a scoped member or a viewer gets
// exactly what the report would give them). The card is built from what the read returned, as decimal strings, and shows every figure; the model never sees one.
//
// Read only: nothing here stores a text or changes the books, and it is not a command. What is kept for a while is the coworker's VALIDATED CHOICE (the entry and the kind of period) for a redacted question and nothing
// else: never a figure, never a card, never a sentence. The read runs again on every request as the member who asks, so a viewer can never be given an answer that was read for an owner. When there is no model, the AI
// budget is spent, the member's calls are too frequent, the call fails or its choice is refused, the answer names the state (`ai`) and the screen lists what can be asked, in fixed text. A failure is named, never
// quoted: neither the question nor the model's answer is logged.
import { AiBudgetExhaustedError, prepareAskBooksQuestion, type AskBooksPeriod, type InboxReader } from '@ludy/agent';
import {
  ASK_BOOKS_TOP,
  askBooksAllows,
  askBooksPickOptions,
  resolveAskPeriod,
  resolvePickedPeriod,
  resolveRelativePeriod,
  vietnamToday,
  type AskBooksAnswer,
  type AskBooksCard,
  type AskBooksEntry,
  type AskBooksFigureKey,
  type AskBooksPeriodOutcome,
  type AskBooksPick,
  type AskBooksRelativeToken,
  type AskBooksResolvedPeriod,
  type FinanceAskBooksInput,
  type StockReportRow,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import type { FinanceAging, FinancePartyRanking, FinancialStatements, LedgerReport, VatReport } from '@ludy/mod-finance';
import type { DraftBudget } from './ai-draft-limit.ts';

// A read of the runtime as the asking member: the caller closes over the org and the actor, so a refusal of the read propagates unchanged.
export type AskBooksQuery = <T>(name: string, input: Record<string, unknown>) => Promise<T>;

// The coworker's validated choice: the entry and the kind of period word, nothing else.
export interface AskBooksChoice {
  entry: AskBooksEntry;
  period: Exclude<AskBooksPeriod, 'none'>;
}

export interface AskBooksAi {
  reader: Pick<InboxReader, 'askBooksPick'> | null;
  budget: DraftBudget;
  // Choices by org, language and redacted question, with the time they were made. A null choice is a refusal (or a failed call) kept the same way, so asking the same words again does not pay for the same refused answer; 'none' is a question the catalogue does not answer.
  kept: Map<string, { choice: AskBooksChoice | 'none' | null; at: number; ttl: number }>;
}

export const ASK_BOOKS_KEEP_MS = 30 * 60 * 1000;
// A call that failed (the model unreachable, not a refused choice) is tried again sooner: the cause may pass.
export const ASK_BOOKS_FAILED_KEEP_MS = 5 * 60 * 1000;
export const ASK_BOOKS_KEEP_MAX = 200;

export function askBooksAi(reader: AskBooksAi['reader'], budget: DraftBudget): AskBooksAi {
  return { reader, budget, kept: new Map() };
}

const none = (ai: AskBooksAnswer['ai']): AskBooksAnswer => ({ ai, state: 'none', lead: null, card: null, pick: null });
const pickPeriod = (ai: AskBooksAnswer['ai'], entry: AskBooksEntry, today: string, lead: string | null): AskBooksAnswer => ({
  ai,
  state: 'pick_period',
  lead,
  card: null,
  pick: { entry, options: askBooksPickOptions(entry, today) },
});

// The amount of one statement line; a line the statement does not hold is a bug, not a zero.
function lineAmount(lines: ReadonlyArray<{ code: string; amount: string }>, code: string): string {
  const found = lines.find((l) => l.code === code);
  if (!found) throw new Error(`statement line ${code} is missing`);
  return money(found.amount).toFixed();
}

const figure = (key: AskBooksFigureKey, amount: string): { key: AskBooksFigureKey; amount: string } => ({ key, amount });

// One catalogue entry's read, run as the asking member for a resolved period, and the card from what it returned.
export async function runAskBooksEntry(query: AskBooksQuery, entry: AskBooksEntry, period: AskBooksResolvedPeriod, legalEntityId: string | undefined): Promise<AskBooksCard> {
  const entity = legalEntityId ? { legalEntityId } : {};
  const base = { entry, period, top: [] as AskBooksCard['top'], partyCount: 0, notes: [] as AskBooksCard['notes'] };
  switch (entry) {
    case 'profit_loss': {
      const statements = await query<FinancialStatements>('finance.statements.period', { period: period.value, ...entity });
      const lines = statements.b02.lines;
      return { ...base, figures: [figure('revenue', lineAmount(lines, '10')), figure('cost_of_goods', lineAmount(lines, '11')), figure('profit_before_tax', lineAmount(lines, '50')), figure('profit_after_tax', lineAmount(lines, '60'))], notes: [] };
    }
    case 'cash_balance': {
      const statements = await query<FinancialStatements>('finance.statements.period', { period: period.value, ...entity });
      return { ...base, figures: [figure('cash', lineAmount(statements.b01.lines, '110'))], notes: [] };
    }
    case 'receivables_top':
    case 'payables_top': {
      // The Sổ cái's own per-party balances of 131 or 331 at the period's end, as the ledger screen shows them.
      const report = await query<LedgerReport>('finance.ledger.period', { period: period.value, ...entity });
      const ledger = entry === 'receivables_top' ? report.receivables : report.payables;
      // A balance is in the account's own direction: positive is what is owed (a customer owes us on 131, we owe a supplier on 331), negative is the other side (a customer who paid ahead, an advance to a supplier). The list
      // and its total hold what is owed only; the other side is its own figure and is never netted into it. Largest balance first; ties by name, so the order never changes between two reads.
      const balances = ledger.rows.map((row) => ({ name: row.partyName === null ? null : row.partyName.slice(0, 300), amount: money(row.closing) }));
      const owed = balances.filter((row) => row.amount.greaterThan(0)).sort((a, b) => b.amount.comparedTo(a.amount) || (a.name ?? '').localeCompare(b.name ?? ''));
      const owedTotal = owed.reduce((sum, row) => sum.plus(row.amount), money(0));
      const otherSide = balances.filter((row) => row.amount.isNegative()).reduce((sum, row) => sum.minus(row.amount), money(0));
      return {
        ...base,
        figures: [figure('total', owedTotal.toFixed()), ...(otherSide.greaterThan(0) ? [figure('advances', otherSide.toFixed())] : [])],
        top: owed.slice(0, ASK_BOOKS_TOP).map((row) => ({ name: row.name, amount: row.amount.toFixed() })),
        partyCount: owed.length,
        notes: [],
      };
    }
    case 'receivables_aging':
    case 'payables_aging': {
      // The aging as of the period's end (the read answers today for a period that is not over). Its buckets, its undated part and the other side of the account are its own figures, never netted into one another; the
      // names of the largest overdue parties come from the read and are drawn by code, never sent to the model.
      const aging = await query<FinanceAging>('finance.aging', { side: entry === 'receivables_aging' ? 'receivable' : 'payable', asOf: period.to, ...entity });
      return {
        ...base,
        figures: [
          figure('overdue', money(aging.overdue.total).toFixed()),
          figure('not_due', money(aging.buckets.not_due).toFixed()),
          figure('overdue_1_30', money(aging.buckets.overdue_1_30).toFixed()),
          figure('overdue_31_60', money(aging.buckets.overdue_31_60).toFixed()),
          figure('overdue_61_90', money(aging.buckets.overdue_61_90).toFixed()),
          figure('overdue_over_90', money(aging.buckets.overdue_over_90).toFixed()),
          figure('undated', money(aging.undated).toFixed()),
          ...(money(aging.advances).greaterThan(0) ? [figure('advances', money(aging.advances).toFixed())] : []),
        ],
        top: aging.overdue.parties.slice(0, ASK_BOOKS_TOP).map((row) => ({ name: row.name === null ? null : row.name.slice(0, 300), amount: money(row.amount).toFixed() })),
        partyCount: aging.overdue.partyCount,
        notes: [...(aging.estimatedDueDates ? (['estimated_due_dates'] as const) : []), ...(aging.truncated ? (['truncated'] as const) : [])],
      };
    }
    case 'customers_top_sales':
    case 'suppliers_top_purchases': {
      // The invoiced documents of the period, net of VAT, by party (finance.party_ranking); the card says it counts invoiced documents.
      const ranking = await query<FinancePartyRanking>('finance.party_ranking', { side: entry === 'customers_top_sales' ? 'sales' : 'purchases', period: period.value, ...entity });
      return {
        ...base,
        figures: [figure('total', money(ranking.total).toFixed())],
        top: ranking.parties.slice(0, ASK_BOOKS_TOP).map((row) => ({ name: row.name.slice(0, 300), amount: money(row.amount).toFixed() })),
        partyCount: ranking.partyCount,
        notes: [],
      };
    }
    case 'vat_position': {
      const report = await query<VatReport>('finance.vat.period', { period: period.value, ...entity });
      const output = money(report.output.totals.vat);
      const input = money(report.input.totals.vat);
      return {
        ...base,
        figures: [figure('vat_output', output.toFixed()), figure('vat_input', input.toFixed()), figure('vat_difference', output.minus(input).toFixed()), figure('vat_carry_forward', money(report.carryForward.amount).toFixed())],
        notes: report.output.available ? [] : ['sales_side_unavailable'],
      };
    }
    case 'stock_value': {
      const rows = await query<StockReportRow[]>('finance.stock.report', { month: period.value, ...entity });
      const total = rows.reduce((sum, row) => sum.plus(money(row.closingValue)), money(0));
      return { ...base, figures: [figure('stock_value', total.toFixed())], notes: rows.some((row) => !row.closed) ? ['provisional'] : [] };
    }
  }
}

// What a chip or the picker named, as the period outcome: a relative word or a picked value, kept to the kinds the entry's read takes.
function outcomeOfPick(pick: AskBooksPick, today: string): AskBooksPeriodOutcome {
  const period = pick.period.kind === 'relative' ? resolveRelativePeriod(pick.period.token, today) : resolvePickedPeriod(pick.period.value, today);
  if (period === null || !askBooksAllows(pick.entry, period.kind)) return { kind: 'pick' };
  return { kind: 'period', period };
}

export async function askBooks(
  ai: AskBooksAi,
  query: AskBooksQuery,
  orgId: string,
  userId: string,
  input: FinanceAskBooksInput,
  now: () => number = Date.now,
  // The books' day in Vietnam time from the server's clock: the database's own day, but for the minute around midnight; it only decides which month "this month" names.
  todayOf: () => string = () => vietnamToday(),
): Promise<AskBooksAnswer> {
  const today = todayOf();
  const language = input.lang ?? 'vi';

  // A report and period the owner chose on the card: no model, no meter.
  if (input.pick) {
    const outcome = outcomeOfPick(input.pick, today);
    if (outcome.kind === 'pick') return pickPeriod('picked', input.pick.entry, today, null);
    return { ai: 'picked', state: 'card', lead: null, card: await runAskBooksEntry(query, input.pick.entry, outcome.period, input.legalEntityId), pick: null };
  }

  if (input.question === undefined) return none('failed');
  if (!ai.reader) return none('off');
  const prepared = prepareAskBooksQuestion(input.question);
  const key = `${orgId}\n${language}\n${prepared.redacted}`;
  const keep = (choice: AskBooksChoice | 'none' | null, ttl: number) => {
    if (ai.kept.size >= ASK_BOOKS_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { choice, at: now(), ttl });
  };
  let choice: AskBooksChoice | null;
  let lead: string | null = null;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < hit.ttl) {
    // A kept choice has no sentence: it is the entry and the kind of period only.
    if (hit.choice === null) return none('failed');
    if (hit.choice === 'none') return none('used');
    choice = hit.choice;
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) return none('busy');
    try {
      const result = await ai.reader.askBooksPick(prepared.redacted, language);
      if (result.kind === 'none') {
        console.error(`[finance-ask-books] choice refused: ${result.code}`);
        keep(null, ASK_BOOKS_KEEP_MS);
        return none('failed');
      }
      if (result.entry === 'none' || result.period === 'none') {
        // The question fits no entry of the catalogue: kept like any choice, and the screen lists what can be asked.
        keep('none', ASK_BOOKS_KEEP_MS);
        return none('used');
      }
      if (result.leadCode) console.error(`[finance-ask-books] sentence dropped: ${result.leadCode}`);
      choice = { entry: result.entry, period: result.period };
      lead = result.lead;
      keep(choice, ASK_BOOKS_KEEP_MS);
    } catch (error: unknown) {
      if (error instanceof AiBudgetExhaustedError) return none('budget');
      console.error('[finance-ask-books] call failed', error instanceof Error ? error.name : typeof error);
      keep(null, ASK_BOOKS_FAILED_KEEP_MS);
      return none('failed');
    } finally {
      ticket.release();
    }
  }

  // The period is code's: a relative word from the day, or what the parser found in the question. Anything the entry's read does not take, or that is not clear, is a list to pick from.
  // What code found in the question wins over the word the model gave: an explicit month, quarter or year (or two of them, which is a list) is the owner's, not the model's reading.
  const token: AskBooksRelativeToken | 'named' = prepared.named.kind === 'none' ? choice.period : 'named';
  const outcome = resolveAskPeriod(choice.entry, token, prepared.named, today);
  if (outcome.kind === 'pick') return pickPeriod('used', choice.entry, today, lead);
  return { ai: 'used', state: 'card', lead, card: await runAskBooksEntry(query, choice.entry, outcome.period, input.legalEntityId), pick: null };
}
