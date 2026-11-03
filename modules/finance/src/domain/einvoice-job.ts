// SPDX-License-Identifier: AGPL-3.0-only
// The timing and the codes of the e-invoice issue job (#2502, ADR-0044 points 4 and 5): when to ask a provider about a pending invoice next, and when to give up. Pure.

// A status the adapter cannot map stays `pending` until the day ends, then the invoice is `failed` with the code STATUS_UNKNOWN, shown to a person (ADR-0044 point 5).
export const STATUS_DEADLINE_HOURS = 24;

// Seconds to wait before the next question about a pending invoice, by how many times it was asked: seconds at first, then minutes, never more than half an hour, so a day holds
// about fifty questions and one connection is never asked faster than its provider allows.
const DELAYS = [5, 15, 30, 60, 120, 300, 600, 900, 1200, 1800] as const;
export function nextCheckDelaySeconds(attempts: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempts), DELAYS.length - 1));
  return DELAYS[index] ?? 1800;
}

// After a call whose answer was lost the next try waits a minute, then asks the provider by the key before anything is sent again.
export const AMBIGUOUS_RETRY_SECONDS = 60;

// Whether the day for a submitted invoice is over.
export function statusDeadlinePassed(submittedAt: Date, now: Date): boolean {
  return now.getTime() - submittedAt.getTime() >= STATUS_DEADLINE_HOURS * 3_600_000;
}

// The codes a draft's `error_code` carries (never a provider's own text).
export const EINVOICE_ERROR_CODES = {
  providerNotReady: 'PROVIDER_NOT_READY',
  sellerTaxCodeChanged: 'SELLER_TAX_CODE_CHANGED',
  draftMismatch: 'DRAFT_MISMATCH',
  credentials: 'CREDENTIALS',
  providerUnavailable: 'PROVIDER_UNAVAILABLE',
  statusUnknown: 'STATUS_UNKNOWN',
  rejectedInvalidData: 'REJECTED_INVALID_DATA',
  rejectedSeriesUnknown: 'REJECTED_SERIES_UNKNOWN',
  rejectedByTaxAuthority: 'REJECTED_BY_TAX_AUTHORITY',
  rejectedByProvider: 'REJECTED_BY_PROVIDER',
} as const;

// The error code of a rejection the provider reported.
export function rejectionCode(code: 'invalid_data' | 'series_unknown' | 'rejected_by_tax_authority' | 'provider_refused'): string {
  switch (code) {
    case 'invalid_data':
      return EINVOICE_ERROR_CODES.rejectedInvalidData;
    case 'series_unknown':
      return EINVOICE_ERROR_CODES.rejectedSeriesUnknown;
    case 'rejected_by_tax_authority':
      return EINVOICE_ERROR_CODES.rejectedByTaxAuthority;
    case 'provider_refused':
      return EINVOICE_ERROR_CODES.rejectedByProvider;
  }
}
