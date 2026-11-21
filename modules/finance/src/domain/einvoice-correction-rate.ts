// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rate of an adjusting or a replacing sales e-invoice across the end of the 8% rate (Decree 174/2025 ends it on 2026-12-31; #3709, plan einvoice-issue.md section 3c, the research of
// 2026-11-18 E row 7). Pure: no database, no model. Decree 174 has no clause for a correction made after the end; the working answer is the precedent of the 2022 to 2023 changeover (Official
// Letter 2121/TCT-CS, 2023-05-29, medium confidence): a correction that changes neither the goods value nor the VAT, a return and a trade discount set later keep the rate of the original;
// an error in quantity or price that changes the amount and the VAT uses the rate in force on the day the correcting invoice is made. The nature is what a person says the correction is about;
// the code works out the basis and the rate from it and the screen only proposes them, a person confirms.
import type { EInvoiceRateBasis, EInvoiceRateNature, EInvoiceRateReason } from '@ludy/kernel-contract';
import { REDUCED_RATE_PERIODS, normalizeVatRate, reducedRateApplies } from '@ludy/l10n-vn';

export interface CorrectionRateInput {
  nature: EInvoiceRateNature;
  // The VAT rate of a line of the original, as written ('8%', '10%', 'KCT').
  rate: string;
  // The invoice date of the original, and of the correcting invoice (YYYY-MM-DD).
  originalDate: string;
  correctionDate: string;
}

export interface CorrectionRate {
  basis: EInvoiceRateBasis;
  // The rate the correcting invoice carries for that line.
  rate: string;
  reasonCode: EInvoiceRateReason;
}

/** The basis a nature gives: the first three keep the rate of the original; a change of amount is judged on the correction's own date. */
export function rateBasisOf(nature: EInvoiceRateNature): EInvoiceRateBasis {
  return nature === 'amount_change' ? 'correction_date' : 'original';
}

/**
 * The rate one line of the original takes on the correcting invoice. Only an 8% line of a correction that changes the amount moves, and only when the correction date is outside the periods the
 * reduced rate applied (then it is 10%); 0, 5, 10, KCT, KKKNT and any other rate are kept, whatever the nature.
 */
export function proposeCorrectionRate(input: CorrectionRateInput): CorrectionRate {
  const basis = rateBasisOf(input.nature);
  const written = normalizeVatRate(input.rate) ?? input.rate;
  if (input.nature === 'no_amount_change') return { basis, rate: written, reasonCode: 'kept_no_change' };
  if (input.nature === 'return') return { basis, rate: written, reasonCode: 'kept_return' };
  if (input.nature === 'trade_discount') return { basis, rate: written, reasonCode: 'kept_trade_discount' };
  if (written !== '8%') return { basis, rate: written, reasonCode: 'amount_change_no_reduced' };
  return reducedRateApplies(input.correctionDate) ? { basis, rate: '8%', reasonCode: 'amount_change_still_reduced' } : { basis, rate: '10%', reasonCode: 'amount_change_standard' };
}

export interface CorrectionRateProposal {
  nature: EInvoiceRateNature;
  basis: EInvoiceRateBasis;
  reasonCode: EInvoiceRateReason;
  // Each distinct rate of the original that the proposal moves, in the order of the original's lines.
  changes: Array<{ from: string; to: string }>;
  // The distinct rates of the original that stay as they are.
  kept: string[];
}

/** The proposal for a whole original: its distinct line rates, the basis, the rates that move and the one reason that says why (a rate that moves outranks one that is kept at 8%). */
export function proposeCorrectionRates(input: { nature: EInvoiceRateNature; rates: readonly string[]; originalDate: string; correctionDate: string }): CorrectionRateProposal {
  const basis = rateBasisOf(input.nature);
  const changes: Array<{ from: string; to: string }> = [];
  const kept: string[] = [];
  let reasonCode: EInvoiceRateReason = proposeCorrectionRate({ nature: input.nature, rate: '10%', originalDate: input.originalDate, correctionDate: input.correctionDate }).reasonCode;
  for (const raw of new Set(input.rates.map((r) => normalizeVatRate(r) ?? r))) {
    const proposed = proposeCorrectionRate({ nature: input.nature, rate: raw, originalDate: input.originalDate, correctionDate: input.correctionDate });
    if (proposed.rate !== raw) changes.push({ from: raw, to: proposed.rate });
    else kept.push(raw);
    if (proposed.reasonCode === 'amount_change_standard' || (proposed.reasonCode === 'amount_change_still_reduced' && reasonCode !== 'amount_change_standard')) reasonCode = proposed.reasonCode;
  }
  return { nature: input.nature, basis, reasonCode, changes, kept };
}

// The day the VAT rate of the correcting invoice's lines is judged on, for the checks: the original's date on the original basis (and on a correction made before the basis existed), else the
// draft's own invoice date, never a sale date a person typed (the rate in force on the day the correcting invoice is made).
export function correctionRateDate(basis: EInvoiceRateBasis | null, originalDate: string | null, ownDate: string): string | null {
  return basis === 'correction_date' ? ownDate : originalDate;
}

const dayText = (iso: string): string => iso.split('-').reverse().join('/');
// The last day of the newest period the reduced rate applied (2026-12-31 for Decree 174/2025).
export const reducedEnd = (): string => REDUCED_RATE_PERIODS.reduce((last, p) => (p.to > last ? p.to : last), '');

/** The fixed Vietnamese reason the screen shows for a proposal: written by code, so it is there with AI off and the coworker's explanation can only add words to it. */
export function correctionRateReason(proposal: CorrectionRateProposal, correctionDate: string): string {
  const day = dayText(correctionDate);
  switch (proposal.reasonCode) {
    case 'kept_no_change':
      return 'Hóa đơn điều chỉnh không làm thay đổi giá trị hàng hóa hay tiền thuế, nên các dòng giữ thuế suất của hóa đơn gốc.';
    case 'kept_return':
      return 'Hàng bị trả lại, nên các dòng giữ thuế suất của hóa đơn gốc.';
    case 'kept_trade_discount':
      return 'Chiết khấu thương mại lập sau, nên các dòng giữ thuế suất của hóa đơn gốc.';
    case 'amount_change_no_reduced':
      return `Sai sót làm thay đổi số tiền nên thuế suất theo ngày lập hóa đơn điều chỉnh (${day}); hóa đơn gốc không có dòng 8%, nên các thuế suất giữ nguyên.`;
    case 'amount_change_still_reduced':
      return `Sai sót làm thay đổi số tiền nên thuế suất theo ngày lập hóa đơn điều chỉnh (${day}); ngày này vẫn trong thời gian áp dụng thuế suất 8% (đến ${dayText(reducedEnd())}) nên dòng 8% giữ 8%.`;
    case 'amount_change_standard':
      return `Sai sót làm thay đổi số tiền nên thuế suất theo ngày lập hóa đơn điều chỉnh (${day}); ngày này sau ${dayText(reducedEnd())} nên dòng 8% chuyển sang 10%.`;
  }
}

/** The note the screen shows, when the original has an 8% line, while no guidance exists for the 2026 to 2027 changeover. */
export const CORRECTION_RATE_PRECEDENT_NOTE =
  'Chưa có hướng dẫn riêng cho việc điều chỉnh hóa đơn 8% sau ngày 31/12/2026. Ludy theo tiền lệ Công văn 2121/TCT-CS ngày 29/05/2023 (lần chuyển thuế suất 2022 sang 2023): điều chỉnh không đổi tiền, trả hàng và chiết khấu giữ thuế suất cũ; sai số lượng hoặc đơn giá làm đổi tiền và thuế thì theo thuế suất ngày lập hóa đơn điều chỉnh. Hãy xác nhận với kế toán của bạn.';
