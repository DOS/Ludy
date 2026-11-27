// SPDX-License-Identifier: AGPL-3.0-only
// The three money tiles on Home (#4785) as pure functions. Chưa thu and Chưa trả are the statements' own lines (B01-DNN's 131 and 311, built by buildB01 from the
// same summed balances finance.statements.period reads), so each equals its statement line for the same entity and day. Tiền ngân hàng is the net balance of the
// 112 accounts, listed by account. Money is decimal strings and decimal.js throughout.
import { money } from '@ludy/l10n-vn';
import { HOME_MONEY_BANK_ACCOUNTS_MAX, type HomeMoneyBankAccount } from '@ludy/kernel-contract';
import { canonical } from './money.ts';
import { B01_LINES, buildB01, type ReportEntry } from './tt133-reports.ts';

export const BANK_ACCOUNT_PREFIX = '112';
// The account prefixes the tiles read; the balances query needs nothing else.
export const HOME_MONEY_PREFIXES = ['112', '131', '331'] as const;

// The finance permissions and role keys that let a member (or viewer) see the org's money totals; owners and admins need none.
export const MONEY_PERMISSIONS = ['finance.proposal.approve', 'finance.period.unlock', 'finance.vat.file'] as const;
export const MONEY_ROLE_KEYS = ['finance.chief_accountant', 'finance.accountant', 'finance.entity_chief_accountant', 'finance.viewer', 'external_accountant'] as const;

// Who may see what customers owe, what the org owes and its bank balance: owners and admins, and members holding a finance permission or one of the
// finance roles (as the finance tax block of Home reads them). A plain member or viewer of sales, HR or teamwork does not.
export function canSeeMoneyTotals(input: { role: string | null; permissions: ReadonlySet<string>; roleKeys: ReadonlySet<string> }): boolean {
  if (input.role === 'owner' || input.role === 'admin') return true;
  if (input.role !== 'member' && input.role !== 'viewer') return false;
  return MONEY_PERMISSIONS.some((p) => input.permissions.has(p)) || MONEY_ROLE_KEYS.some((k) => input.roleKeys.has(k));
}

export interface HomeMoneyFigures {
  receivables: string;
  payables: string;
  bank: string;
  bankAccounts: HomeMoneyBankAccount[];
  bankAccountCount: number;
}

// The tiles from the entity's summed balances on 112, 131 and 331 up to `asOf` (`entries` as asEntries builds them), with the names of the 112 accounts
// the chart holds. An account is listed when its net balance is not zero, largest by size first, at most HOME_MONEY_BANK_ACCOUNTS_MAX of them.
export function buildHomeMoney(entries: ReportEntry[], legalEntityId: string, asOf: string, names: ReadonlyMap<string, string>): HomeMoneyFigures {
  // Lines 131 and 311 read the same accounts under the TT133 and the TT99 map (modules/finance/test/tt99-b01.test.ts pins it), so the tiles need no regime.
  for (const code of ['131', '311']) if (!B01_LINES.some((d) => d.code === code)) throw new Error(`B01 has no line ${code}`);
  const b01 = buildB01(entries, legalEntityId, asOf);
  const line = (code: string) => canonical(money(b01.lines.find((l) => l.code === code)?.amount ?? '0'));

  const perAccount = new Map<string, ReturnType<typeof money>>();
  for (const entry of entries) {
    if (entry.entryDate > asOf || entry.legalEntityId !== legalEntityId) continue;
    for (const l of entry.lines) {
      if (!l.accountCode.startsWith(BANK_ACCOUNT_PREFIX)) continue;
      perAccount.set(l.accountCode, (perAccount.get(l.accountCode) ?? money(0)).plus(money(l.debit)).minus(money(l.credit)));
    }
  }
  const held = [...perAccount].filter(([, balance]) => !balance.isZero());
  const total = held.reduce((sum, [, balance]) => sum.plus(balance), money(0));
  const listed = held
    .sort((a, b) => b[1].abs().comparedTo(a[1].abs()) || a[0].localeCompare(b[0]))
    .slice(0, HOME_MONEY_BANK_ACCOUNTS_MAX)
    .map(([code, balance]) => ({ code, name: names.get(code) ?? null, balance: canonical(balance) }));
  return { receivables: line('131'), payables: line('311'), bank: canonical(total), bankAccounts: listed, bankAccountCount: held.length };
}
