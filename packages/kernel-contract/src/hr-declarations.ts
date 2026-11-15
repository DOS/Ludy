// SPDX-License-Identifier: AGPL-3.0-only
// The payroll declaration exports (issue #2533, payroll plan docs/plan/payroll.md section 6.5, ADR-0046 point 7): the D02-LT of Decision 366, the quarterly figures of 05/KK-TNCN, the
// annual data of 05/QTT-TNCN for staff who authorized the payer, and the withholding certificate data (03/TNCN). The query hands back a document the xlsx file and the print view both render.
// Owners and admins only; a sensitive query (the audit row is written before the sealed identifiers are opened). Nothing is sent, nothing is filed.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const HR_DECLARATION_KINDS = ['d02lt', 'kk', 'qtt', 'certificate', 'labor_register', '01pli'] as const;
export type HrDeclarationKind = (typeof HR_DECLARATION_KINDS)[number];

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isValidLaborRegisterDate(period: string): boolean {
  const match = ISO_DATE.exec(period);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < 2020 || year > 2100) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && isLeap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day >= 1 && day <= maxDay;
}

// The period by kind: YYYY-MM for D02-LT, YYYY-Qn for 05/KK-TNCN, YYYY for annual tax declarations/certificates,
// YYYY-MM-DD (2020..2100) for Sổ quản lý lao động, and YYYY-H1, YYYY-H2, or YYYY (2020..2100) for Báo cáo 01/PLI.
const PERIOD: Record<Exclude<HrDeclarationKind, 'labor_register'>, RegExp> = {
  d02lt: /^\d{4}-(0[1-9]|1[0-2])$/,
  kk: /^\d{4}-Q[1-4]$/,
  qtt: /^(20[2-9]\d|2100)$/,
  certificate: /^(20[2-9]\d|2100)$/,
  '01pli': /^(20[2-9]\d|2100)(-H[12])?$/,
};

export function hrDeclarationPeriodOk(kind: HrDeclarationKind, period: string): boolean {
  if (kind === 'labor_register') return isValidLaborRegisterDate(period);
  return PERIOD[kind].test(period);
}

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
export const zHrDeclarationExport = z
  .strictObject({
    kind: z.enum(HR_DECLARATION_KINDS),
    period: z.string().max(10),
    rows: z.number().int().min(0),
    // The approved months the list was built from (empty for labor_register and 01pli), and for the annual lists the authorization list's year and size.
    months: z.array(z.string().max(7)).max(13),
    authorizedYear: z.number().int().optional(),
    authorizedPeople: z.number().int().optional(),
    legalEntityId: zId.optional(),
    // How it left the server: as a file, or as the document for the screen's view and print (the same row, so a print is recorded like a download).
    via: z.enum(['xlsx', 'view']).default('xlsx'),
  })
  .refine((v) => hrDeclarationPeriodOk(v.kind, v.period), { message: 'period does not fit the declaration', path: ['period'] });
export type HrDeclarationExport = z.infer<typeof zHrDeclarationExport>;

// Pre-export readiness and Labor Code compliance review for Sổ quản lý lao động and Báo cáo 01/PLI (#3372).
export const HR_LABOR_CHECK_KINDS = ['labor_register', '01pli'] as const;
export type HrLaborCheckKind = (typeof HR_LABOR_CHECK_KINDS)[number];

export const zHrLaborCheckAsk = z
  .strictObject({
    kind: z.enum(HR_LABOR_CHECK_KINDS),
    period: z.string().max(10),
    legalEntityId: zId.optional(),
    lang: z.enum(['vi', 'en']).optional(),
  })
  .refine((v) => hrDeclarationPeriodOk(v.kind, v.period), { message: 'period does not fit the declaration', path: ['period'] });
export type HrLaborCheckAsk = z.infer<typeof zHrLaborCheckAsk>;

export const HR_LABOR_CHECK_AI_REASONS = ['ok', 'off', 'budget', 'unavailable', 'refused'] as const;
export type HrLaborCheckAiReason = (typeof HR_LABOR_CHECK_AI_REASONS)[number];

export const zHrLaborCheckFinding = z.strictObject({
  employeeId: zId,
  employeeName: z.string().optional(),
  code: z.string().min(1).max(64),
  fieldOrRule: z.string().min(1).max(160),
});
export type HrLaborCheckFinding = z.infer<typeof zHrLaborCheckFinding>;

export const zHrLaborCheckCounts = z.strictObject({
  checked: z.number().int().min(0),
  employeesMissingIdentity: z.number().int().min(0),
  employeesMissingInsuranceNumber: z.number().int().min(0),
  employeesMissingBirthDateOrAddress: z.number().int().min(0),
  unwrittenNoneContracts: z.number().int().min(0),
  contractAlerts: z.number().int().min(0),
});
export type HrLaborCheckCounts = z.infer<typeof zHrLaborCheckCounts>;

export const zHrLaborCheckResult = z.strictObject({
  findings: z.array(zHrLaborCheckFinding),
  counts: zHrLaborCheckCounts,
  summary: z.string().nullable().optional(),
  notes: z.array(z.string()),
  ai: z.strictObject({
    ok: z.boolean(),
    reason: z.enum(HR_LABOR_CHECK_AI_REASONS),
  }),
});
export type HrLaborCheckResult = z.infer<typeof zHrLaborCheckResult>;

export const zHrLaborCheckAudit = z.strictObject({
  kind: z.enum(HR_LABOR_CHECK_KINDS),
  checked: z.number().int().min(0),
});
export type HrLaborCheckAudit = z.infer<typeof zHrLaborCheckAudit>;

// More people than this in one declaration is refused with a message, never cut short: a file with some people missing must not exist.
export const HR_DECLARATION_MAX_PEOPLE = 5000;
