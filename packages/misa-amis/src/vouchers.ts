// SPDX-License-Identifier: AGPL-3.0-only
// The vouchers MISA AMIS takes as "đề nghị sinh chứng từ" (#3854): the voucher_type numbers of the document's enum, the limit of 500 detail lines, and the checks made before anything is sent. The body of
// a voucher (its fields per kind) is the mapper's business (a later slice); here it is an object whose amounts are exact numbers (see json.ts).
import { AmisError } from './errors.ts';
import { toJsonText } from './json.ts';

// The seven kinds Ludy exports to MISA SME as Excel, with the voucher_type AMIS gives them.
export const AMIS_VOUCHER_TYPES = {
  bankCredit: 1,
  bankDebit: 3,
  cashPayment: 4,
  cashReceipt: 5,
  sales: 13,
  purchaseServices: 17,
  purchaseGoods: 18,
} as const;
export type AmisLudyVoucherType = (typeof AMIS_VOUCHER_TYPES)[keyof typeof AMIS_VOUCHER_TYPES];

// All 19 types the document's /save takes (a type outside it is refused here, not by MISA after a round trip).
const KNOWN = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21]);

export const AMIS_MAX_VOUCHER_LINES = 500;
// Our own bound on one call, not MISA's (the document gives none): a caller sends batches of this size.
export const AMIS_SAVE_BATCH_MAX = 50;

export interface AmisVoucher {
  voucher_type: number;
  // Ludy's own id of the voucher (a UUID): MISA's key for the request, which makes a push idempotent.
  org_refid: string;
  detail: readonly unknown[];
  readonly [field: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrgRefId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Refuses, before anything is sent, a voucher MISA would not take: an unknown type, an id that is not a UUID, no line, more than 500 lines (never cut: cutting a voucher changes what it says) or an amount that is not exact. */
export function checkVoucher(voucher: AmisVoucher): void {
  if (!KNOWN.has(voucher.voucher_type)) throw new AmisError('invalid_request', { reason: 'bad_voucher_type' });
  if (!isOrgRefId(voucher.org_refid)) throw new AmisError('invalid_request', { reason: 'bad_org_refid' });
  if (!Array.isArray(voucher.detail) || voucher.detail.length === 0) throw new AmisError('invalid_request', { reason: 'no_lines' });
  if (voucher.detail.length > AMIS_MAX_VOUCHER_LINES) throw new AmisError('invalid_request', { reason: 'too_many_lines' });
  // A value that cannot be written exactly (a JS number that is not a safe integer) is refused now, before a token is asked for.
  toJsonText(voucher);
}
