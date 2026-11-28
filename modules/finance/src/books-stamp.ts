// SPDX-License-Identifier: AGPL-3.0-only
// The books a voucher is prepared under, and the check that they are still in force when it is approved (issue #1403, TT99 books). A voucher (cash or journal) is asked for by one command and posted by another,
// and a switch of the entity's books can come between them (or a choice be taken back), so a voucher prepared under books that are not TT133 2026.1 carries the regime and the chart version it was prepared under,
// as a purchase does (purchase-regime.ts), and approval compares them with the books on its date, under the entity's lock (lockBooks). Nothing is stamped under TT133 2026.1, so those payloads stay as they were.
import type { QueryContext } from '@ludy/kernel-runtime';
import { booksOn, isTt133Books } from './books.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { booksRegimeChanged, voucherRegimeRefused } from './purchase-regime.ts';

// The payload with the books of its entity on its date, unless they are TT133 2026.1.
export async function stampBooks<P extends { date: string; legalEntityId?: string | undefined }>(ctx: QueryContext, payload: P): Promise<P> {
  const books = await booksOn(ctx, await resolveLegalEntity(ctx, payload.legalEntityId), payload.date);
  return isTt133Books(books) ? payload : { ...payload, regime: books.regime, chartVersion: books.version };
}

// Refuses a voucher whose books are no longer those it was prepared under (BOOKS_REGIME_CHANGED, as for a purchase). The caller has locked the entity's books and resolved its entity.
export async function refuseChangedBooks(
  ctx: QueryContext,
  payload: { date: string; regime?: string | undefined; chartVersion?: string | undefined },
  legalEntityId: string,
  accounts: readonly string[],
): Promise<void> {
  const books = await booksOn(ctx, legalEntityId, payload.date);
  if (voucherRegimeRefused({ carried: payload.regime, carriedVersion: payload.chartVersion, current: { regime: books.regime, version: books.version }, accounts })) {
    throw booksRegimeChanged(payload.regime, books.regime, { proposed: payload.chartVersion, current: books.version });
  }
}
