// SPDX-License-Identifier: AGPL-3.0-only
// The cash and bank book of a household on the income method (S2e-HKD, #2517), as a pure function over posted journal lines: for every account that is 111 or 112 or a sub-account of them, the opening
// balance, one row per journal line of the book's days (cash in = debit, cash out = credit, the accounts on the other side of the entry, the running balance) and the closing balance. A line belongs to
// its own account only, so a parent never repeats the lines of its sub-accounts and the sections add up without double counting. Amounts are decimal strings through decimal.js, never JS numbers.
import type { Money } from '@crove/l10n-vn';
import { Chart, type ChartAccount, type OpeningBalance, type PeriodLine } from './ledger-reports.ts';
import { canonical, parseDecimal } from './money.ts';

// TT133: 111 cash on hand, 112 cash in bank; sub-accounts at any depth roll up to them by the chart.
export const CASH_ACCOUNT_ROOTS = ['111', '112'] as const;

export interface CashRow {
  entryId: string;
  lineNo: number;
  date: string;
  reference: string | null;
  description: string;
  counterAccounts: string[];
  cashIn: Money;
  cashOut: Money;
  balance: Money;
  reversal: boolean;
}

export interface CashAccountSection {
  accountCode: string;
  accountName: string;
  opening: Money;
  rows: CashRow[];
  totalIn: Money;
  totalOut: Money;
  closing: Money;
}

// `from` is the first day of the book: lines dated before it (inside the ledger period but before the household's books opened) go into the opening balance, so the opening is the balance the day before the book.
// Accounts with no opening balance and no line in the book's days are left out; an account whose own balance is zero but that has lines stays.
export function cashBook(chartAccounts: ReadonlyArray<ChartAccount>, opening: ReadonlyArray<OpeningBalance>, lines: ReadonlyArray<PeriodLine>, from: string): CashAccountSection[] {
  const chart = new Chart(chartAccounts);
  const isCash = (code: string) => CASH_ACCOUNT_ROOTS.some((root) => chart.within(code, root));
  const openingOf = new Map<string, ReturnType<typeof parseDecimal>>();
  const add = (code: string, amount: ReturnType<typeof parseDecimal>) => openingOf.set(code, (openingOf.get(code) ?? parseDecimal('0')).plus(amount));
  for (const o of opening) if (isCash(o.accountCode)) add(o.accountCode, parseDecimal(o.debit).minus(parseDecimal(o.credit)));
  for (const l of lines) if (l.entryDate < from && isCash(l.accountCode)) add(l.accountCode, parseDecimal(l.debit).minus(parseDecimal(l.credit)));

  const byEntry = new Map<string, PeriodLine[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);

  const sections = new Map<string, { balance: ReturnType<typeof parseDecimal>; rows: CashRow[]; totalIn: ReturnType<typeof parseDecimal>; totalOut: ReturnType<typeof parseDecimal> }>();
  const sectionOf = (code: string) => {
    let s = sections.get(code);
    if (!s) {
      const balance = openingOf.get(code) ?? parseDecimal('0');
      s = { balance, rows: [], totalIn: parseDecimal('0'), totalOut: parseDecimal('0') };
      sections.set(code, s);
    }
    return s;
  };
  for (const code of openingOf.keys()) if (!openingOf.get(code)!.isZero()) sectionOf(code);
  for (const l of lines) {
    if (l.entryDate < from || !isCash(l.accountCode)) continue;
    const s = sectionOf(l.accountCode);
    const d = parseDecimal(l.debit);
    const c = parseDecimal(l.credit);
    s.balance = s.balance.plus(d).minus(c);
    s.totalIn = s.totalIn.plus(d);
    s.totalOut = s.totalOut.plus(c);
    const isDebit = !d.isZero();
    const counter: string[] = [];
    for (const other of [...(byEntry.get(l.entryId) ?? [])].sort((a, b) => a.lineNo - b.lineNo)) {
      const otherIsDebit = !parseDecimal(other.debit).isZero();
      if (otherIsDebit !== isDebit && !counter.includes(other.accountCode)) counter.push(other.accountCode);
    }
    s.rows.push({ entryId: l.entryId, lineNo: l.lineNo, date: l.entryDate, reference: l.reference, description: l.description, counterAccounts: counter, cashIn: canonical(d), cashOut: canonical(c), balance: canonical(s.balance), reversal: l.reversal });
  }
  return [...sections.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((code) => {
      const s = sections.get(code)!;
      const open = openingOf.get(code) ?? parseDecimal('0');
      return { accountCode: code, accountName: chart.name(code), opening: canonical(open), rows: s.rows, totalIn: canonical(s.totalIn), totalOut: canonical(s.totalOut), closing: canonical(s.balance) };
    });
}
