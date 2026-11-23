// SPDX-License-Identifier: AGPL-3.0-only
// The resolution of the surplus of a count of stock (#3712 slice 2a, plan stock-and-marketplaces.md section 8.2, research row C3), pure. Confirming a count books a surplus as Dr stock account /
// Cr 3381 (domain/stock-count.ts); a person then decides where the 3381 balance of that count goes, and the resolution is ONE general journal voucher: Dr 3381 / Cr 711 (the default), 3388
// or 331 (the goods were a supplier's, so the line names the supplier). Money is decimal.js and whole dong. The amount is never typed: it is the sum of the positive adjustments the count made,
// worked out again from the books at the request and at the approval.
import type { JournalVoucherProposal, SurplusAccount } from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { SURPLUS_ACCOUNT } from './stock-count.ts';

const SURPLUS_ACCOUNT_SET: readonly SurplusAccount[] = ['711', '3388', '331'];

const plain = (value: { toFixed(): string }): string => {
  const text = value.toFixed();
  return text === '-0' ? '0' : text;
};

// The surplus of a count, whole dong: the sum of the amounts of its adjustments that brought value in. A shortage (a negative amount) is none of it.
export function surplusAmount(adjustments: ReadonlyArray<{ amount: string }>): string {
  let sum = money(0);
  for (const a of adjustments) {
    const amount = money(a.amount);
    if (amount.greaterThan(0)) sum = sum.plus(amount);
  }
  return plain(sum.toDecimalPlaces(0));
}

interface SurplusLine {
  account: string;
  partyId: string | null;
  debit: string;
  credit: string;
}

// The two lines of the voucher: the 3381 balance out (debit) and the account it goes to (credit). 331 names the supplier; the others name nobody.
export function surplusVoucherLines(amount: string, account: SurplusAccount, partyId: string | null): SurplusLine[] {
  return [
    { account: SURPLUS_ACCOUNT, partyId: null, debit: amount, credit: '0' },
    { account, partyId: account === '331' ? partyId : null, debit: '0', credit: amount },
  ];
}

// The words of the voucher: what it is, for which count and where the surplus goes, so the approver reads it in the proposal's title.
export function surplusDescription(countDate: string, account: SurplusAccount): string {
  const [year, month, day] = countDate.split('-') as [string, string, string];
  const where = account === '711' ? 'thu nhập khác (711)' : account === '3388' ? 'phải trả khác (3388)' : 'phải trả người bán (331)';
  return `Xử lý hàng thừa kiểm kê ngày ${day}/${month}/${year}: ghi nhận vào ${where}`;
}

// Whether a stored proposal is exactly the voucher the books call for now: the one the count's surplus is worth, to an account of the fixed set (the party only on 331). A proposal built
// from the amount of an earlier day, a changed count or an account outside the set is not.
export function isSurplusVoucher(payload: Pick<JournalVoucherProposal, 'lines' | 'total'>, amount: string): { ok: true; account: SurplusAccount } | { ok: false } {
  const [out, into, extra] = payload.lines;
  if (!out || !into || extra) return { ok: false };
  const account = SURPLUS_ACCOUNT_SET.find((a) => a === into.account);
  if (!account) return { ok: false };
  const same = (a: string, b: string) => money(a).equals(money(b));
  if (out.account !== SURPLUS_ACCOUNT || out.party !== null || !same(out.debit, amount) || !same(out.credit, '0')) return { ok: false };
  if (!same(into.debit, '0') || !same(into.credit, amount) || !same(payload.total, amount)) return { ok: false };
  // 331 is kept per party and must name one; the other two name nobody.
  if (account === '331' ? into.party === null : into.party !== null) return { ok: false };
  return { ok: true, account };
}
