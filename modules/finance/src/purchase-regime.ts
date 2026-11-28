// SPDX-License-Identifier: AGPL-3.0-only
// The regime rules a purchase proposal follows when it is revised and approved (issue #1403). Pure, so they are tested
// without a database; record.ts calls them with the books in force read from the database.
import { TT133_CODES_CHANGED_IN_TT99 } from '@ludy/l10n-vn';
import { DomainError } from '@ludy/kernel-runtime';

// The chart a document is posted under: the regime and the version of the chart the entity's books name on the day.
export interface PostingBooks {
  regime: string;
  version: string;
}

// The refusal named for a proposal whose entry would differ from the one the approver saw: the proposal is rejected and
// the invoice read again. The versions, when known, say which chart each side meant.
export function booksRegimeChanged(proposed: string | undefined, current: string | undefined, versions?: { proposed?: string | undefined; current?: string | undefined }): DomainError {
  return new DomainError(
    'BOOKS_REGIME_CHANGED',
    409,
    'Chế độ kế toán của sổ đã đổi từ khi lập đề xuất nên bút toán sẽ khác bản đã xem; hãy từ chối đề xuất này và đọc lại hóa đơn',
    { proposed: proposed ?? null, current: current ?? null, ...(versions ? { proposedVersion: versions.proposed ?? null, currentVersion: versions.current ?? null } : {}) },
  );
}

// Whether approving a document is refused. A proposal that carries a regime is posted only while the books are still
// that regime, and the same version of its chart when it carries one (a proposal raised before the version was carried
// names none and is held to the regime alone). A purchase with no regime was raised under TT133 and its journal does not
// depend on the regime, so under other books it still posts, except when a line is on a code the two circulars use for
// different things (211, 3386, 6421, 6422): the approver saw one meaning and the entry would carry the other. Every other
// account is checked against the chart of the books by the account check that follows.
export function approvalRegimeRefused(input: {
  carried: string | undefined;
  carriedVersion?: string | undefined;
  current: PostingBooks | undefined;
  accounts: readonly string[];
}): boolean {
  if (input.carried !== undefined) {
    const now = input.current;
    if (!now || now.regime !== input.carried) return true;
    return input.carriedVersion !== undefined && now.version !== input.carriedVersion;
  }
  return input.current !== undefined && input.accounts.some((account) => TT133_CODES_CHANGED_IN_TT99.includes(account));
}

// Whether moving a line from one chart to another is refused: the books changed chart between the two dates, and a line is on a code the two
// circulars use for different things (211, 3386, 6421, 6422). Reversing an entry into the books of another chart would cancel such a line under
// a different meaning than it was posted with, and so would depreciating an asset whose accounts were chosen under the earlier chart. A code only
// one chart has is refused by the account check that follows, which names the chart.
export function chartChangeRefused(input: { from: PostingBooks; to: PostingBooks; accounts: readonly string[] }): boolean {
  const same = input.from.regime === input.to.regime && input.from.version === input.to.version;
  return !same && input.accounts.some((account) => TT133_CODES_CHANGED_IN_TT99.includes(account));
}

// Whether a revision of a purchase is refused. The lines of a revision are checked only where the person changed them, so
// the regime a revision would stamp must be the one the proposal already carries: stamping a new one (none to tt99, or
// back) would let the lines the person did not touch pass as the other circular's accounts.
export function reviseRegimeRefused(carried: { regime: string | undefined; version: string | undefined }, now: PostingBooks | undefined): boolean {
  return carried.regime !== now?.regime || (carried.version !== undefined && carried.version !== now?.version);
}

// Whether a purchase teaches the vendor default and the learned rules: not when it posts under other books than TT133
// (the rules are per organisation and not per regime), and never a sale.
export function learnsRules(sale: boolean, postingRegime: string | undefined): boolean {
  return !sale && postingRegime === undefined;
}

// The vendor default and the learned rules a TT99 purchase is offered. They were made under TT133, whose chart is org-wide, so
// only those naming an account the entity's chart has, and means the same by, are kept.
export function rulesForBooks<R extends { account: string }>(input: {
  vendorDefault: string | null;
  learnedRules: readonly R[];
  inChart: (code: string) => boolean;
}): { vendorDefault: string | null; learnedRules: R[] } {
  const usable = (code: string) => input.inChart(code) && !TT133_CODES_CHANGED_IN_TT99.includes(code);
  return {
    vendorDefault: input.vendorDefault && usable(input.vendorDefault) ? input.vendorDefault : null,
    learnedRules: input.learnedRules.filter((rule) => usable(rule.account)),
  };
}
