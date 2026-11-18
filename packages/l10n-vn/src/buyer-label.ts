// SPDX-License-Identifier: AGPL-3.0-only
// What a sales e-invoice prints for a buyer who gave nothing (Decree 254 Art. 10.1.d with Appendix point 4.b; the research of 2026-11-18, E row 6; #3709). One constant, used by the offline
// sandbox's XML, the MISA mapping and the list of drafts, so the wording cannot drift between them.

/** The only wording for a consumer on a coded invoice. "Người mua không lấy hóa đơn" belongs to cash-register invoices and is never used here. */
export const CONSUMER_BUYER_LABEL = 'Bán cho người tiêu dùng';

/** The name a sales e-invoice prints for its buyer: the consumer label for a consumer (who gives no name), else the name given. */
export function buyerNameOnInvoice(kind: string, name: string | null): string | null {
  return kind === 'consumer' ? CONSUMER_BUYER_LABEL : name;
}
