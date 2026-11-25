// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA SME voucher export (#3848, plan docs/plan/accounting-software-sync.md "The AI part"): what MISA's import will refuse or cut, found by code over the very rows the file is
// built from, and listed before the download. The check only warns; it never blocks the export. Findings are grouped by kind and column with a count and the first examples, because the services,
// sales and cash templates leave catalog codes blank on purpose and a line per row would warn on every row. No party name, invoice number, amount or bank detail is in a finding: a voucher
// number (Ludy's own, `CRMDV...`) and a line number name the row.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

// The seven MISA SME exports, named as the export audit row names them (finance.journal.export `format`).
export const MISA_CHECK_FORMATS = [
  'misa_sme_purchases',
  'misa_sme_goods_purchases',
  'misa_sme_sales',
  'misa_sme_cash_receipts',
  'misa_sme_cash_payments',
  'misa_sme_bank_credits',
  'misa_sme_bank_debits',
] as const;
export type MisaCheckFormat = (typeof MISA_CHECK_FORMATS)[number];

// MISSING_CODE: a catalog code cell (party, item) is blank, so MISA cannot match the row. MISSING_REQUIRED: another cell the template marks (*) is blank. VAT_CODE: the VAT rate cell is blank or not one of
// 0, 5, 8, 10, KCT, KKKNT, KHAC although the row has VAT. ACCOUNT_NOT_IN_CHART: an account the row names is not in the org's chart. TOO_LONG: a text is over the template's length limit
// (it is cut in the file) or an invoice number is over MISA's 25 characters (it is never cut, MISA flags it).
export const MISA_CHECK_KINDS = ['MISSING_CODE', 'MISSING_REQUIRED', 'VAT_CODE', 'ACCOUNT_NOT_IN_CHART', 'TOO_LONG'] as const;
export type MisaCheckKind = (typeof MISA_CHECK_KINDS)[number];
export const MISA_CHECK_EXAMPLES = 20;

export const zMisaCheckAsk = z.strictObject({
  format: z.enum(MISA_CHECK_FORMATS),
  from: zLocalDate.optional(),
  to: zLocalDate.optional(),
  legalEntityId: zId.optional(),
});
export type MisaCheckAsk = z.infer<typeof zMisaCheckAsk>;

export const zMisaFindingExample = z.strictObject({ voucherNo: z.string().max(40), lineNo: z.number().int().min(0).nullable() });
export const zMisaFindingGroup = z.strictObject({
  kind: z.enum(MISA_CHECK_KINDS),
  // The template's header, as MISA spells it.
  column: z.string().max(120),
  // The most the column takes, for TOO_LONG; null for the other kinds.
  limit: z.number().int().positive().nullable(),
  count: z.number().int().min(1),
  examples: z.array(zMisaFindingExample).max(MISA_CHECK_EXAMPLES),
});
export type MisaFindingGroup = z.infer<typeof zMisaFindingGroup>;

export const zMisaCheck = z.strictObject({
  format: z.enum(MISA_CHECK_FORMATS),
  // The rows of the file the check read.
  rows: z.number().int().min(0),
  // Every finding, over all groups.
  findings: z.number().int().min(0),
  groups: z.array(zMisaFindingGroup).max(200),
});
export type MisaCheck = z.infer<typeof zMisaCheck>;

// The finance coworker's one line above the list (#3848 slice B): a second read that runs the check again on the server (so what the model is told comes from the books, never from the caller) and answers
// the counts per kind it was written from, so the screen shows the sentence only while those counts equal the list on screen, and the sentence when there is one. `ai` says why there is no sentence: `off` (no
// model), `busy` (too frequent), `budget` (the AI budget is spent), `failed` (the call failed or its text was refused; the reason is logged as a code, never the words) or `none` (nothing is flagged).
export const zMisaCheckLineAsk = zMisaCheckAsk.extend({ lang: z.enum(['vi', 'en']).optional() });
export type MisaCheckLineAsk = z.infer<typeof zMisaCheckLineAsk>;
export const zMisaCheckCounts = z.strictObject({
  rows: z.number().int().min(0),
  codes: z.number().int().min(0),
  required: z.number().int().min(0),
  vat: z.number().int().min(0),
  accounts: z.number().int().min(0),
  tooLong: z.number().int().min(0),
});
export type MisaCheckCounts = z.infer<typeof zMisaCheckCounts>;
export const zMisaCheckLine = z.strictObject({
  counts: zMisaCheckCounts,
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'none']),
  text: z.string().nullable(),
});
export type MisaCheckLine = z.infer<typeof zMisaCheckLine>;
