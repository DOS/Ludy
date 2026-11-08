// SPDX-License-Identifier: AGPL-3.0-only
// The payroll declaration exports (issue #2533, payroll plan docs/plan/payroll.md section 6.5, ADR-0046 point 7): the D02-LT of Decision 366, the quarterly figures of 05/KK-TNCN, the
// annual data of 05/QTT-TNCN for staff who authorized the payer, and the withholding certificate data (03/TNCN). The query hands back a document the xlsx file and the print view both render.
// Owners and admins only; a sensitive query (the audit row is written before the sealed identifiers are opened). Nothing is sent, nothing is filed.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const HR_DECLARATION_KINDS = ['d02lt', 'kk', 'qtt', 'certificate'] as const;
export type HrDeclarationKind = (typeof HR_DECLARATION_KINDS)[number];

// The period by kind: a month (YYYY-MM) for the D02-LT, a quarter (YYYY-Qn) for 05/KK-TNCN, a year for the annual data and the certificates.
const PERIOD: Record<HrDeclarationKind, RegExp> = {
  d02lt: /^\d{4}-(0[1-9]|1[0-2])$/,
  kk: /^\d{4}-Q[1-4]$/,
  qtt: /^(20[2-9]\d|2100)$/,
  certificate: /^(20[2-9]\d|2100)$/,
};
export const hrDeclarationPeriodOk = (kind: HrDeclarationKind, period: string): boolean => PERIOD[kind].test(period);

export const zHrDeclarationQuery = z
  .strictObject({ kind: z.enum(HR_DECLARATION_KINDS), period: z.string().max(10), legalEntityId: zId.optional() })
  .refine((v) => hrDeclarationPeriodOk(v.kind, v.period), { message: 'period does not fit the declaration', path: ['period'] });
export type HrDeclarationQuery = z.infer<typeof zHrDeclarationQuery>;

const zColumn = z.object({ key: z.string(), header: z.string(), kind: z.enum(['text', 'money', 'count']) });
const zSheet = z.object({
  name: z.string(),
  title: z.string(),
  columns: z.array(zColumn),
  rows: z.array(z.record(z.string(), z.string())),
  totals: z.record(z.string(), z.string()).optional(),
});

export const zHrDeclarationDocument = z.object({
  kind: z.enum(HR_DECLARATION_KINDS),
  notice: z.string(),
  notSent: z.string(),
  layout: z.object({ form: z.string(), version: z.string() }),
  draft: z.string().nullable(),
  title: z.string(),
  header: z.array(z.object({ label: z.string(), value: z.string() })),
  sheets: z.array(zSheet),
  notes: z.array(z.string()),
  // What the document was built from, so a file says which approved months and which authorization list it used (also recorded in the audit row of the download).
  used: z.object({ months: z.array(z.string()), authorizedYear: z.number().int().optional(), authorizedPeople: z.number().int().optional() }),
});
export type HrDeclarationDocument = z.infer<typeof zHrDeclarationDocument>;

// The audit command of a downloaded file: counts only, never a name or an amount. No row, no download.
export const zHrDeclarationExport = z.strictObject({
  kind: z.enum(HR_DECLARATION_KINDS),
  period: z.string().max(10),
  rows: z.number().int().min(0),
  // The approved months the list was built from, and for the annual lists the authorization list's year and size.
  months: z.array(z.string().max(7)).max(13),
  authorizedYear: z.number().int().optional(),
  authorizedPeople: z.number().int().optional(),
  legalEntityId: zId.optional(),
  // How it left the server: as a file, or as the document for the screen's view and print (the same row, so a print is recorded like a download).
  via: z.enum(['xlsx', 'view']).default('xlsx'),
});
export type HrDeclarationExport = z.infer<typeof zHrDeclarationExport>;

// More people than this in one declaration is refused with a message, never cut short: a file with some people missing must not exist.
export const HR_DECLARATION_MAX_PEOPLE = 5000;
