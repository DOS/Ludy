// SPDX-License-Identifier: AGPL-3.0-only
// The late sales invoices of a VAT working, as the coworker's monthly summary line names them (#3540, the AI part of #3535). The facts come from the working's own lists
// (`lateSales` and `supplementary` of finance.vat.period) and nothing else; the template sentence is built from them with no model, so the screen says the same facts with AI off.
// Pure: no money arithmetic, no date arithmetic, nothing is declared or posted here.
import { z } from 'zod';
import { zId, zVatPeriod } from './schemas.ts';

// At most this many invoices are named in a sentence; more are counted ("and N more") and the table below the sentence lists them all.
export const VAT_LATE_NAMED_MAX = 10;

export interface VatLateFact {
  // The invoice as the screen writes it: "series-number", or the number alone when it has no series.
  number: string;
  // The period the sale belongs to (the VAT working's period key: "2026-09" or "2026-Q3").
  period: string;
  // Whether that period is already locked or its return filed, so the sale goes in a supplementary declaration.
  supplementary: boolean;
  // true: issued in the period on screen for a sale of an earlier one; false: a sale of the period on screen that was issued after the period closed.
  issuedHere: boolean;
}

interface ReportInvoice {
  series: string;
  number: string;
}
export interface VatLateSource {
  period: { period: string };
  supplementary: { documents: ReadonlyArray<ReportInvoice> };
  lateSales: ReadonlyArray<ReportInvoice & { originalPeriod: string; supplementary: boolean }>;
}

const written = (invoice: ReportInvoice): string => `${invoice.series ? `${invoice.series}-` : ''}${invoice.number}`;

/** The late invoices of a working, in the order the lists give them: the sales issued here for an earlier period first, then this period's sales issued after it closed. */
export function vatLateFacts(report: VatLateSource): VatLateFact[] {
  return [
    ...report.lateSales.map((s) => ({ number: written(s), period: s.originalPeriod, supplementary: s.supplementary, issuedHere: true })),
    ...report.supplementary.documents.map((d) => ({ number: written(d), period: report.period.period, supplementary: true, issuedHere: false })),
  ];
}

/** A key of the facts a sentence was written from: the client uses a coworker sentence only when its key is the one of the lists on screen, so a sentence never sits beside lists it was not written from. */
export const vatLateKey = (facts: readonly VatLateFact[]): string => facts.map((f) => `${f.number}|${f.period}|${f.supplementary ? 1 : 0}|${f.issuedHere ? 1 : 0}`).join(';');

const more = (language: 'vi' | 'en', rest: number): string => (rest > 0 ? (language === 'vi' ? `, và ${rest} hóa đơn khác (xem bảng bên dưới)` : `, and ${rest} more (see the table below)`) : '');

/** The template sentence: each late invoice and its original period, and which need a supplementary declaration. Null when there is none. A person decides the declaration. */
export function vatLateTemplate(facts: readonly VatLateFact[], language: 'vi' | 'en'): string | null {
  if (facts.length === 0) return null;
  const parts: string[] = [];
  const here = facts.filter((f) => f.issuedHere);
  const later = facts.filter((f) => !f.issuedHere);
  const list = (items: readonly VatLateFact[], line: (f: VatLateFact) => string): string => items.slice(0, VAT_LATE_NAMED_MAX).map(line).join(', ') + more(language, items.length - VAT_LATE_NAMED_MAX);
  if (here.length > 0) {
    parts.push(
      language === 'vi'
        ? `Kỳ này có ${here.length} hóa đơn bán ra lập muộn cho hàng bán ở kỳ trước: ${list(here, (f) => `${f.number} (kỳ ${f.period}, ${f.supplementary ? 'cần kê khai bổ sung' : 'đã tính vào kỳ đó'})`)}.`
        : `This period has ${here.length} sales invoice${here.length === 1 ? '' : 's'} issued late for sales of an earlier period: ${list(here, (f) => `${f.number} (period ${f.period}, ${f.supplementary ? 'needs a supplementary declaration' : 'counted in that period'})`)}.`,
    );
  }
  if (later.length > 0) {
    parts.push(
      language === 'vi'
        ? `${later.length} hóa đơn bán ra của kỳ này được ghi nhận sau khi kỳ đã khóa hoặc đã nộp tờ khai, cần kê khai bổ sung: ${list(later, (f) => f.number)}.`
        : `${later.length} sales invoice${later.length === 1 ? '' : 's'} of this period ${later.length === 1 ? 'was' : 'were'} recorded after the period was locked or its return filed and need a supplementary declaration: ${list(later, (f) => f.number)}.`,
    );
  }
  return parts.join(' ');
}

// The coworker's sentence on the late sales of a working. ai: used (a sentence came back and passed the check), off (the deployment has no model), busy (too many asks at once),
// budget (the org's AI budget of the month is spent), failed (the call failed or its text was refused), quiet (no late sale, so nothing to say). Without text the screen shows
// the template sentence, which is built from the same lists.
export const zVatLateExplainAsk = z.object({
  period: zVatPeriod,
  legalEntityId: zId.optional(),
  lang: z.enum(['vi', 'en']).optional(),
});
export type VatLateExplainAsk = z.infer<typeof zVatLateExplainAsk>;
export const zVatLateExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  text: z.string().nullable(),
  // The key (vatLateKey) of the lists the sentence was written from; null without a sentence.
  key: z.string().nullable(),
});
export type VatLateExplanation = z.infer<typeof zVatLateExplanation>;
