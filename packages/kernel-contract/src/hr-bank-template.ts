// SPDX-License-Identifier: AGPL-3.0-only
// The saved layout of one bank's bulk-salary file (issue #2893, payroll plan docs/plan/payroll.md 6.4 and 10 row 4, ADR-0046), on crove_hr.payroll_bank_template: an org sets its bank's layout once,
// and the export applies it. A layout is the six columns of the file (sequence, name, account, bank, amount, content) in the order the bank wants, each with the header it shows, and the text of
// the payment's content (`{month}` becomes MM/YYYY). It holds no person's data. Owners and admins only, in the commands and in the database's policies. These shapes equal the table's own check
// (crove_hr.bank_layout_valid), so a layout the database would refuse is refused here first, with a reason.
import { z } from 'zod';
import { zId } from './schemas.ts';

/** The six columns of the file, in the generic order. A layout holds each exactly once. */
export const HR_BANK_COLUMNS = ['sequence', 'name', 'account', 'bank', 'amount', 'content'] as const;
export type HrBankColumn = (typeof HR_BANK_COLUMNS)[number];

export const HR_BANK_NAME_MAX = 80;
export const HR_BANK_HEADER_MAX = 60;
export const HR_BANK_CONTENT_MAX = 140;

// No NUL character: the database refuses it in text and in jsonb, which would otherwise surface as a server error.
const noNul = (value: string): boolean => !value.includes('\u0000');
const zName = z.string().trim().min(1).max(HR_BANK_NAME_MAX).refine(noNul, 'no NUL character');

/** The columns in the bank's order, each key once, each with the header the bank wants; and the payment's content text, whose only brace form is `{month}`. */
export const zHrBankLayout = z
  .strictObject({
    columns: z.array(z.strictObject({ key: z.enum(HR_BANK_COLUMNS), header: z.string().trim().min(1).max(HR_BANK_HEADER_MAX).refine(noNul, 'no NUL character') })).length(HR_BANK_COLUMNS.length),
    content: z
      .string()
      .trim()
      .min(1)
      .max(HR_BANK_CONTENT_MAX)
      .regex(/^([^{}]|\{month\})*$/, 'the only brace form is {month}')
      .refine(noNul, 'no NUL character'),
  })
  .refine((layout) => new Set(layout.columns.map((c) => c.key)).size === HR_BANK_COLUMNS.length, { message: 'each column once', path: ['columns'] });
export type HrBankLayout = z.infer<typeof zHrBankLayout>;

export const zHrBankTemplate = z.strictObject({ id: zId, legalEntityId: zId, name: z.string(), layout: zHrBankLayout, updatedAt: z.string() });
export type HrBankTemplate = z.infer<typeof zHrBankTemplate>;

/** The templates of an entity (the org's default entity when omitted, as the other HR reads), by name. */
export const zHrBankTemplateList = z.strictObject({ legalEntityId: zId.optional() });
export const zHrBankTemplateCreate = z.strictObject({ legalEntityId: zId.optional(), name: zName, layout: zHrBankLayout });
export const zHrBankTemplateEdit = z
  .strictObject({ templateId: zId, name: zName.optional(), layout: zHrBankLayout.optional() })
  .refine((v) => v.name !== undefined || v.layout !== undefined, { message: 'nothing to change', path: ['name'] });
export const zHrBankTemplateRef = z.strictObject({ templateId: zId });
export const zHrBankTemplateWritten = z.strictObject({ templateId: zId });
export type HrBankTemplateWritten = z.infer<typeof zHrBankTemplateWritten>;
