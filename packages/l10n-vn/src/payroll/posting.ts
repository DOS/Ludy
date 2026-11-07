// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4 and row 18, ADR-0046). Pure: the totals of an approved run in, the lines of its posting proposal, the
// amounts of the payments that settle it, the rows of the bank's bulk-salary file and the cash flag out. No database, no model.
//
// The accounts come from a map per regime (`tt133`, `tt99`) held as data, below. Every row of it is `commentary` until the accountant reads it against the primary texts (#2535, plan row 18),
// as the payroll rules are; the run's approval already refuses a month while a rule is unconfirmed, and the posting proposal carries the map's status so the approver sees it.
// The facts the map rests on are in the repo's charts: unemployment insurance is 3385 in the TT133 chart and 3386 in the TT99 chart, TT99 has no 3385 and no sub-accounts of 334.
import { money, toMoney, type Money } from '../money.ts';
import type { InsuranceFund } from './rules/index.ts';
import type { RuleStatus } from './rule-types.ts';

type Decimal = ReturnType<typeof money>;

export const PAYROLL_REGIMES = ['tt133', 'tt99'] as const;
export type PayrollRegime = (typeof PAYROLL_REGIMES)[number];

/** What an employee's work is for: it picks the expense account of the person's pay. `admin` is the default. */
export const PAY_FUNCTIONS = ['admin', 'sales', 'production', 'overhead', 'construction'] as const;
export type PayFunction = (typeof PAY_FUNCTIONS)[number];

export interface PostingMap {
  regime: PayrollRegime;
  status: RuleStatus;
  /** Where the map comes from and what the sources disagree on, in the words of the rules' `cite`. */
  cite: string;
  /** The expense account of the entity's chart for each function. */
  expense: Record<PayFunction, string>;
  /** Payable to employees (334; TT99 has no sub-accounts of it). */
  wages: string;
  /** The payables to the funds: social insurance (retirement, sickness and maternity, work accident), health, unemployment, and the union fee. */
  social: string;
  health: string;
  unemployment: string;
  union: string;
  /** Personal income tax withheld. */
  pit: string;
  /** Advances recovered, and the other deductions kept from pay (damage, other). */
  advance: string;
  otherDeductions: string;
  cash: string;
  bank: string;
}

// TT133 (Circular 133/2016): the chart has no 622 or 627, so the pay of production staff goes to 154 (the sources say 154, 631 and 642 only, or the full set; the conflict is open, row 18).
// TT99 (Circular 99/2025): 622, 6271, 6411, 6421 and 241 of its chart.
export const PAYROLL_POSTING_MAPS: Record<PayrollRegime, PostingMap> = {
  tt133: {
    regime: 'tt133',
    status: 'commentary',
    cite: 'Circular 133/2016 chart as in crove_finance.account (3385 unemployment insurance); the pay expense accounts are commentary (AMIS, MISA) and the sources conflict: 154, 631 and 642 only, or the full set (row 18).',
    expense: { admin: '6422', sales: '6421', production: '154', overhead: '154', construction: '241' },
    wages: '334',
    social: '3383',
    health: '3384',
    unemployment: '3385',
    union: '3382',
    pit: '3335',
    advance: '141',
    otherDeductions: '3388',
    cash: '111',
    bank: '112',
  },
  tt99: {
    regime: 'tt99',
    status: 'commentary',
    cite: 'Circular 99/2025 chart as in crove_finance.chart_account (3386 unemployment insurance, no 3385, no sub-accounts of 334); the expense accounts are commentary (AMIS, MISA) until the accountant confirms row 18.',
    expense: { admin: '6421', sales: '6411', production: '622', overhead: '6271', construction: '241' },
    wages: '334',
    social: '3383',
    health: '3384',
    unemployment: '3386',
    union: '3382',
    pit: '3335',
    advance: '141',
    otherDeductions: '3388',
    cash: '111',
    bank: '112',
  },
};

/** A payment in cash of this many dong or more is not deductible for corporate income tax (plan row 19, commentary until #2535). */
export const CASH_PAYMENT_LIMIT: Money = '5000000';
export const CASH_LIMIT_STATUS: RuleStatus = 'commentary';

/** One person's month as the posting needs it: figures of the stored line, never recomputed. A correction line carries signed amounts. */
export interface PostingLine {
  payFunction: PayFunction;
  gross: Money;
  funds: { fund: InsuranceFund; employee: Money; employer: Money }[];
  unionFee: Money;
  pit: Money;
  advance: Money;
  otherDeductions: Money;
  net: Money;
}

export interface JournalLine {
  account: string;
  debit: Money;
  credit: Money;
}

export interface PostingTotals {
  gross: Money;
  employeeInsurance: Money;
  employerInsurance: Money;
  unionFee: Money;
  pit: Money;
  advance: Money;
  otherDeductions: Money;
  net: Money;
  /** Gross, the employer's insurance and the union fee: the expense the entry carries. */
  employerCost: Money;
}

export type PaymentKind = 'net_pay' | 'insurance' | 'union' | 'tax';

export interface Obligation {
  kind: PaymentKind;
  amount: Money;
  /** The payables it clears (Dr), by account; the credit is the bank (or cash) account of the voucher. */
  debits: { account: string; amount: Money }[];
}

export interface PostingResult {
  regime: PayrollRegime;
  mapStatus: RuleStatus;
  lines: JournalLine[];
  totals: PostingTotals;
  obligations: Obligation[];
}

export class PostingRefusedError extends Error {
  readonly code: 'unbalanced' | 'totals_mismatch' | 'no_lines';
  constructor(code: PostingRefusedError['code'], message: string) {
    super(message);
    this.name = 'PostingRefusedError';
    this.code = code;
  }
}

const ZERO = (): Decimal => money(0);
const FUND_GROUP: Record<InsuranceFund, 'social' | 'health' | 'unemployment'> = {
  retirement_death: 'social',
  sickness_maternity: 'social',
  work_accident: 'social',
  health: 'health',
  unemployment: 'unemployment',
};

/**
 * The posting of a run: Dr the expense of each function (gross, employer insurance, union fee), Cr 334 for the gross; Dr 334 and Cr the funds for the employee's insurance, Dr 334 Cr 3335
 * for the PIT, Dr 334 Cr 141 / 3388 for the advances and other deductions. The entries are summed per account and an account carries one line, on the side of its balance (334 therefore
 * carries the net pay). Amounts are dong; the figures of the lines are already whole dong, so nothing is rounded here.
 *
 * Refuses an entry that does not balance, and a run whose lines do not add to the net pay they carry (a line whose net is not gross less its deductions), instead of posting it.
 */
export function buildPosting(regime: PayrollRegime, lines: readonly PostingLine[]): PostingResult {
  if (lines.length === 0) throw new PostingRefusedError('no_lines', 'a run with no line has nothing to post');
  const map = PAYROLL_POSTING_MAPS[regime];
  // Debit minus credit per account.
  const balances = new Map<string, Decimal>();
  const move = (account: string, debit: Decimal, credit: Decimal) => balances.set(account, (balances.get(account) ?? ZERO()).plus(debit).minus(credit));
  const totals = { gross: ZERO(), employeeInsurance: ZERO(), employerInsurance: ZERO(), unionFee: ZERO(), pit: ZERO(), advance: ZERO(), otherDeductions: ZERO(), net: ZERO() };
  const payable = { social: ZERO(), health: ZERO(), unemployment: ZERO() };
  for (const line of lines) {
    const expense = map.expense[line.payFunction];
    const gross = money(line.gross);
    let employee = ZERO();
    let employer = ZERO();
    const groups = { social: ZERO(), health: ZERO(), unemployment: ZERO() };
    for (const f of line.funds) {
      const fe = money(f.employee);
      const fr = money(f.employer);
      employee = employee.plus(fe);
      employer = employer.plus(fr);
      groups[FUND_GROUP[f.fund]] = groups[FUND_GROUP[f.fund]].plus(fe).plus(fr);
    }
    const union = money(line.unionFee);
    const pit = money(line.pit);
    const advance = money(line.advance);
    const other = money(line.otherDeductions);
    const net = money(line.net);
    if (!gross.minus(employee).minus(pit).minus(advance).minus(other).equals(net)) {
      throw new PostingRefusedError('totals_mismatch', 'a line of the run is not its gross less its deductions');
    }
    move(expense, gross.plus(employer).plus(union), ZERO());
    move(map.wages, ZERO(), gross);
    move(map.social, ZERO(), groups.social);
    move(map.health, ZERO(), groups.health);
    move(map.unemployment, ZERO(), groups.unemployment);
    move(map.union, ZERO(), union);
    move(map.wages, employee.plus(pit).plus(advance).plus(other), ZERO());
    move(map.pit, ZERO(), pit);
    move(map.advance, ZERO(), advance);
    move(map.otherDeductions, ZERO(), other);
    payable.social = payable.social.plus(groups.social);
    payable.health = payable.health.plus(groups.health);
    payable.unemployment = payable.unemployment.plus(groups.unemployment);
    totals.gross = totals.gross.plus(gross);
    totals.employeeInsurance = totals.employeeInsurance.plus(employee);
    totals.employerInsurance = totals.employerInsurance.plus(employer);
    totals.unionFee = totals.unionFee.plus(union);
    totals.pit = totals.pit.plus(pit);
    totals.advance = totals.advance.plus(advance);
    totals.otherDeductions = totals.otherDeductions.plus(other);
    totals.net = totals.net.plus(net);
  }
  const journal: JournalLine[] = [...balances.entries()]
    .filter(([, balance]) => !balance.isZero())
    .map(([account, balance]) => ({ account, debit: balance.isPositive() ? toMoney(balance) : '0', credit: balance.isNegative() ? toMoney(balance.negated()) : '0' }))
    // Debits first, then credits, each by account code: the same run always gives the same entry.
    .sort((a, b) => Number(money(b.debit).greaterThan(0)) - Number(money(a.debit).greaterThan(0)) || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  const debit = journal.reduce((acc, l) => acc.plus(l.debit), ZERO());
  const credit = journal.reduce((acc, l) => acc.plus(l.credit), ZERO());
  if (!debit.equals(credit)) throw new PostingRefusedError('unbalanced', 'the posting does not balance');
  const employerCost = totals.gross.plus(totals.employerInsurance).plus(totals.unionFee);
  const accountTotal = (account: string): Decimal => {
    const l = journal.find((j) => j.account === account);
    return l ? money(l.debit).minus(l.credit) : ZERO();
  };
  // The expense accounts hold exactly the employer's cost of the run. (An account can be shared by two roles, such as 154 for two functions, so they are summed over the distinct accounts.)
  const expenseAccounts = [...new Set(PAY_FUNCTIONS.map((f) => map.expense[f]))];
  if (!expenseAccounts.reduce((acc, a) => acc.plus(accountTotal(a)), ZERO()).equals(employerCost)) {
    throw new PostingRefusedError('totals_mismatch', 'the expense of the entry is not the employer cost of the run');
  }
  const obligations: Obligation[] = [];
  const add = (kind: PaymentKind, debits: { account: string; amount: Decimal }[]) => {
    const live = debits.filter((d) => !d.amount.isZero());
    const amount = live.reduce((acc, d) => acc.plus(d.amount), ZERO());
    if (!amount.isZero()) obligations.push({ kind, amount: toMoney(amount), debits: live.map((d) => ({ account: d.account, amount: toMoney(d.amount) })) });
  };
  add('net_pay', [{ account: map.wages, amount: totals.net }]);
  add('insurance', [
    { account: map.social, amount: payable.social },
    { account: map.health, amount: payable.health },
    { account: map.unemployment, amount: payable.unemployment },
  ]);
  add('union', [{ account: map.union, amount: totals.unionFee }]);
  add('tax', [{ account: map.pit, amount: totals.pit }]);
  return {
    regime,
    mapStatus: map.status,
    lines: journal,
    totals: {
      gross: toMoney(totals.gross),
      employeeInsurance: toMoney(totals.employeeInsurance),
      employerInsurance: toMoney(totals.employerInsurance),
      unionFee: toMoney(totals.unionFee),
      pit: toMoney(totals.pit),
      advance: toMoney(totals.advance),
      otherDeductions: toMoney(totals.otherDeductions),
      net: toMoney(totals.net),
      employerCost: toMoney(employerCost),
    },
    obligations,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The cash flag
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PayMethod = 'bank' | 'cash';

/** True for a payment in cash of the limit or more. A bank payment is never flagged. */
export function isCashOverLimit(method: PayMethod, amount: Money): boolean {
  return method === 'cash' && money(amount).greaterThanOrEqualTo(CASH_PAYMENT_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The bank bulk-salary file
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const BANK_FILE_COLUMN_KEYS = ['sequence', 'name', 'account', 'bank', 'amount', 'content'] as const;
export type BankFileColumnKey = (typeof BANK_FILE_COLUMN_KEYS)[number];

/** The layout of one bank's file: the columns in order with the header each shows. The org sets it once. */
export interface BankFileLayout {
  columns: { key: BankFileColumnKey; header: string }[];
  /** The text of the payment's content; `{month}` becomes MM/YYYY. Banks' own forms usually refuse diacritics, so the default has none. */
  content: string;
}

export const DEFAULT_BANK_FILE_LAYOUT: BankFileLayout = {
  columns: [
    { key: 'sequence', header: 'STT' },
    { key: 'name', header: 'Ten nguoi nhan' },
    { key: 'account', header: 'So tai khoan' },
    { key: 'bank', header: 'Ngan hang' },
    { key: 'amount', header: 'So tien' },
    { key: 'content', header: 'Noi dung' },
  ],
  content: 'Luong thang {month}',
};

export interface BankFilePerson {
  name: string;
  account: string;
  bank: string;
  net: Money;
}

export interface BankFileTable {
  header: string[];
  rows: string[][];
  total: Money;
}

/** One row per person with the net pay, in the layout's column order. Ludy writes a file; it never initiates a payment. A person whose net is zero or less has no row. */
export function buildBankFile(people: readonly BankFilePerson[], month: string, layout: BankFileLayout = DEFAULT_BANK_FILE_LAYOUT): BankFileTable {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`not a month (YYYY-MM): ${month}`);
  const [year, m] = month.split('-') as [string, string];
  const content = layout.content.replaceAll('{month}', `${m}/${year}`);
  const paid = people.filter((p) => money(p.net).greaterThan(0));
  const cell = (key: BankFileColumnKey, p: BankFilePerson, i: number): string =>
    key === 'sequence' ? String(i + 1) : key === 'name' ? p.name : key === 'account' ? p.account : key === 'bank' ? p.bank : key === 'amount' ? toMoney(money(p.net)) : content;
  return {
    header: layout.columns.map((c) => c.header),
    rows: paid.map((p, i) => layout.columns.map((c) => cell(c.key, p, i))),
    total: toMoney(paid.reduce((acc, p) => acc.plus(p.net), ZERO())),
  };
}
