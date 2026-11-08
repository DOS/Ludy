// SPDX-License-Identifier: AGPL-3.0-only
// The previous invoice as a source for the finance coworker (#2721, plan einvoice-issue.md section 9): its lines written as plain text that the model reads next to what the person typed, so a
// quantity, a price or a VAT rate it states can be checked against the text like any other figure of the source. Pure: no database. The invoice's number, date and the buyer are not in it (the
// buyer is the customer's record, never the model's, and a number or a date would only add figures that mean nothing here). A VAT rate that the new invoice's date no longer allows is left out, so the
// text does not state it and the model cannot carry it over (the caller then gives the line the customer's usual rate).
export interface SourceLine {
  description: string;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

// At most this many lines go to the model: the text the model reads is bounded (packages/agent EINVOICE_DRAFT_TEXT_MAX), and a line past it would be cut off the source anyway.
export const SOURCE_LINES_MAX = 15;

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function invoiceSourceText(lines: readonly SourceLine[], allowedRates: readonly string[]): string {
  const rows = lines.slice(0, SOURCE_LINES_MAX).map((l) => {
    const parts = [oneLine(l.description)];
    if (l.unit !== null && l.unit.trim() !== '') parts.push(`đơn vị ${oneLine(l.unit)}`);
    parts.push(`số lượng ${l.quantity}`, `đơn giá ${l.unitPrice}`);
    if (allowedRates.includes(l.vatRate)) parts.push(`VAT ${l.vatRate}`);
    return `- ${parts.join(', ')}`;
  });
  return rows.length === 0 ? '' : `Hóa đơn trước gửi cùng khách:\n${rows.join('\n')}`;
}
