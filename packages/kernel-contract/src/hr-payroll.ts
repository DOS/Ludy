// SPDX-License-Identifier: AGPL-3.0-only
// The monthly pay run of the HR module (issue #2531, docs/plan/payroll.md sections 6.2 and 6.3, ADR-0046): a run is one month of one legal entity, with a line per person. A line holds
// the month's inputs (typed, or copied from last month where they recur) and the figures and breakdown the calculator of @crove/l10n-vn produced from them, stored as facts. A draft run
// changes; an approved one never does (a correction is an adjustment line in a later run). Owners and admins only, and every read is a sensitive query.
import { z } from 'zod';
import { zAccountCode, zCashVoucherProposal, zId, zJournalVoucherProposal, zLocalDate } from './schemas.ts';
import { zHrWage } from './hr.ts';

export const HR_RUN_STATUSES = ['draft', 'approved', 'paid', 'closed'] as const;
export type HrRunStatus = (typeof HR_RUN_STATUSES)[number];
export const HR_LINE_KINDS = ['pay', 'adjustment'] as const;
export type HrLineKind = (typeof HR_LINE_KINDS)[number];
export const HR_LINE_STATUSES = ['calculated', 'refused'] as const;
export type HrLineStatus = (typeof HR_LINE_STATUSES)[number];
export const HR_OVERTIME_DAY_KINDS = ['normal_day', 'weekly_rest_day', 'holiday'] as const;
export type HrOvertimeDayKind = (typeof HR_OVERTIME_DAY_KINDS)[number];
export const HR_ALLOWANCE_TYPES = ['meal_cash', 'other'] as const;
export type HrAllowanceType = (typeof HR_ALLOWANCE_TYPES)[number];
export const HR_DEDUCTION_KINDS = ['damage', 'other'] as const;
export type HrDeductionKind = (typeof HR_DEDUCTION_KINDS)[number];

// The working days of a month when the person names none: six days a week, the usual count of a small Vietnamese employer. The sheet shows it and changing it recalculates.
export const HR_DEFAULT_WORKING_DAYS = '26';

// The inputs of a month's line that recur from one month to the next, copied when a month is opened; every other input starts empty.
export const HR_RECURRING_INPUTS = ['allowances', 'otherRegularPay', 'voluntaryPension', 'commitment', 'insured', 'contractTermMonths', 'withholdingRequested'] as const;

export const zHrMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
// Days in whole or half units (unpaid leave, days not employed, the working days of the month) and hours of overtime: decimal strings, never JS numbers.
export const zHrDays = z.string().regex(/^\d{1,2}(\.\d)?$/, 'days');
const zHours = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'hours');
// A signed amount of an adjustment line.
export const zHrSignedAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'signed decimal string');
const zLabel = z.string().trim().min(1).max(100);

export const zHrPayrollInputs = z.strictObject({
  // What recurs (copied from last month): the allowances with whether the contract names them with an amount, other regular pay, the voluntary pension, the commitment form,
  // whether the person is insured (null: by the contract type), the term of a fixed-term contract in months, the person's request for withholding below the threshold.
  allowances: z.array(z.strictObject({ label: zLabel, amount: zHrWage, type: z.enum(HR_ALLOWANCE_TYPES), namedInContract: z.boolean() })).max(20).default([]),
  otherRegularPay: zHrWage.default('0'),
  voluntaryPension: zHrWage.default('0'),
  commitment: z.boolean().default(false),
  insured: z.boolean().nullable().default(null),
  contractTermMonths: z.number().int().min(1).max(36).nullable().default(null),
  withholdingRequested: z.boolean().default(false),
  // What changed this month.
  unpaidLeaveDays: zHrDays.default('0'),
  daysNotEmployed: zHrDays.default('0'),
  overtime: z.array(z.strictObject({ dayKind: z.enum(HR_OVERTIME_DAY_KINDS), night: z.boolean(), hours: zHours })).max(30).default([]),
  nightHours: zHours.default('0'),
  bonus: zHrWage.default('0'),
  advance: zHrWage.default('0'),
  deductions: z.array(z.strictObject({ label: zLabel, kind: z.enum(HR_DEDUCTION_KINDS), amount: zHrWage })).max(20).default([]),
});
export type HrPayrollInputs = z.output<typeof zHrPayrollInputs>;
export type HrPayrollInputsInput = z.input<typeof zHrPayrollInputs>;

export const zHrRunOpen = z.strictObject({ month: zHrMonth, workingDays: zHrDays.optional(), legalEntityId: zId.optional() });
export type HrRunOpen = z.infer<typeof zHrRunOpen>;
export const zHrRunRef = z.strictObject({ runId: zId });
export type HrRunRef = z.infer<typeof zHrRunRef>;
// Recalculate every line of a draft from the employment terms and dependents as they are now (and add a person hired since); optionally with other working days.
export const zHrRunRecalculate = z.strictObject({ runId: zId, workingDays: zHrDays.optional() });
export type HrRunRecalculate = z.infer<typeof zHrRunRecalculate>;
export const zHrLineInputsSet = z.strictObject({ lineId: zId, inputs: zHrPayrollInputs });
export type HrLineInputsSet = z.input<typeof zHrLineInputsSet>;
// Approving is R3 (a fresh second factor). `fingerprint` is the one the sheet showed: if the figures have changed since, the approval is refused and the person looks again.
// `acceptFlags` says the person has seen the lines whose checks failed (the minimum wage, the cap on deductions).
export const zHrRunApprove = z.strictObject({ runId: zId, fingerprint: z.string().regex(/^[0-9a-f]{64}$/), acceptFlags: z.boolean().default(false) });
export type HrRunApprove = z.input<typeof zHrRunApprove>;
// A signed correction of an approved month, put in a draft run (a later month): the amounts are the differences, net and the employer's cost follow from them.
export const zHrLineAdjust = z.strictObject({
  runId: zId,
  adjustsRunId: zId,
  employeeId: zId,
  note: z.string().trim().min(1).max(500),
  gross: zHrSignedAmount,
  employeeInsurance: zHrSignedAmount.default('0'),
  employerInsurance: zHrSignedAmount.default('0'),
  unionFee: zHrSignedAmount.default('0'),
  taxableIncome: zHrSignedAmount.default('0'),
  pit: zHrSignedAmount.default('0'),
});
export type HrLineAdjust = z.input<typeof zHrLineAdjust>;
export const zHrRunList = z.strictObject({ limit: z.number().int().min(1).max(120).default(24) });
export type HrRunList = z.input<typeof zHrRunList>;
export const zHrPayslipRef = z.strictObject({ lineId: zId });
export type HrPayslipRef = z.infer<typeof zHrPayslipRef>;

// What a command returns: ids and counts, never a figure (idempotency rows keep results).
export const zHrRunWritten = z.object({ runId: zId, lineId: zId.optional(), lines: z.number().int().optional() });
export type HrRunWritten = z.infer<typeof zHrRunWritten>;

export const zHrRunFigures = z.object({
  gross: z.string(),
  employeeInsurance: z.string(),
  employerInsurance: z.string(),
  unionFee: z.string(),
  taxableIncome: z.string(),
  pit: z.string(),
  net: z.string(),
  employerCost: z.string(),
});
export type HrRunFigures = z.infer<typeof zHrRunFigures>;

export const zHrRunSummary = z.object({
  id: zId,
  legalEntityId: zId,
  month: z.string(),
  status: z.enum(HR_RUN_STATUSES),
  workingDays: z.string(),
  lines: z.number().int(),
  refused: z.number().int(),
  totals: zHrRunFigures,
  approvedAt: z.string().nullable(),
});
export type HrRunSummary = z.infer<typeof zHrRunSummary>;

// What the calculator's check says (the minimum wage, the cap on deductions), and the flags the sheet raises beside the figures: a failed check, a refused month, a person hired
// or leaving this month (their days not employed are typed by the person).
export const HR_LINE_FLAGS = ['check_minimum_wage', 'check_deduction_cap', 'refused', 'new_hire', 'ends_this_month', 'fixed_term_months_missing', 'net_below_minimum'] as const;
export type HrLineFlag = (typeof HR_LINE_FLAGS)[number];

export const zHrCheck = z.object({ id: z.enum(['minimum_wage', 'deduction_cap']), ok: z.boolean(), actual: z.string(), limit: z.string() });
export type HrCheck = z.infer<typeof zHrCheck>;

export const zHrRuleRef = z.object({ id: z.string(), kind: z.string(), key: z.string(), effectiveFrom: z.string(), status: z.enum(['confirmed', 'commentary']) });
export type HrRuleRef = z.infer<typeof zHrRuleRef>;

// A rule a month rests on, with the text it comes from: what the sheet lists when it blocks an approval.
export const zHrRuleView = zHrRuleRef.extend({ cite: z.string(), confidence: z.enum(['primary', 'gov', 'commentary', 'unverified']) });
export type HrRuleView = z.infer<typeof zHrRuleView>;

export const zHrLineView = z.object({
  id: zId,
  employeeId: zId,
  employeeName: z.string(),
  kind: z.enum(HR_LINE_KINDS),
  status: z.enum(HR_LINE_STATUSES),
  // The calculator's refusal for this person's month, or null.
  refusal: z.string().nullable(),
  inputs: z.record(z.string(), z.unknown()),
  figures: zHrRunFigures.nullable(),
  // The calculator's breakdown (PayrollBreakdown of @crove/l10n-vn), null for an adjustment and a refused line.
  breakdown: z.record(z.string(), z.unknown()).nullable(),
  checks: z.array(zHrCheck),
  flags: z.array(z.enum(HR_LINE_FLAGS)),
  note: z.string().nullable(),
  // The month an adjustment corrects.
  adjustsMonth: z.string().nullable(),
});
export type HrLineView = z.infer<typeof zHrLineView>;

export const zHrRunSheet = z.object({
  run: z.object({
    id: zId,
    legalEntityId: zId,
    employerName: z.string(),
    month: z.string(),
    status: z.enum(HR_RUN_STATUSES),
    workingDays: z.string(),
    approvedAt: z.string().nullable(),
  }),
  lines: z.array(zHrLineView),
  totals: zHrRunFigures,
  // The rules the lines used (a draft: as they are now; an approved month: as they were when it was approved), and the ones still `commentary`, which refuse the approval.
  rules: z.array(zHrRuleView),
  blocking: z.array(zHrRuleView),
  // The fingerprint of the figures shown: the approval names it.
  fingerprint: z.string(),
  // Whether an approval would be refused now, and why: nothing to pay, a refused line, a rule still `commentary`. Failed checks do not refuse; they need `acceptFlags`.
  approvable: z.boolean(),
  obstacles: z.array(z.enum(['no_lines', 'refused_lines', 'rules_commentary'])),
});
export type HrRunSheet = z.infer<typeof zHrRunSheet>;

// A payslip of Labor Code Art. 95(3): the period, the pay components, overtime and night pay, each deduction with its amount, the net pay and the employer's name; a view of the
// stored line, never a recomputation. The person prints it as a PDF from the screen.
export const zHrPayslip = z.object({
  lineId: zId,
  runId: zId,
  month: z.string(),
  status: z.enum(HR_RUN_STATUSES),
  employerName: z.string(),
  employeeName: z.string(),
  figures: zHrRunFigures,
  breakdown: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()),
});
export type HrPayslip = z.infer<typeof zHrPayslip>;

// The posting of an approved run (#2532, payroll plan 6.4 and row 18): one proposal per run through the finance proposal path. A person asks for it with the run's id
// (kernel.proposal.request with command `finance.payroll_posting.record`); the server builds every line from the frozen run, so the request carries nothing else. An owner or an admin
// approves it like any posting (R3, four-eyes, fresh second factor).
export const PAYROLL_POSTING_COMMAND = 'finance.payroll_posting.record';
export const PAYROLL_REGIMES = ['tt133', 'tt99'] as const;
export const zHrPostingRequest = z.strictObject({ runId: zId });
export type HrPostingRequest = z.infer<typeof zHrPostingRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the run it posts, the month, the chart it follows and whether the accountant has confirmed the account map yet.
// Its lines are one per account, never per person: the detail stays on the run.
export const zPayrollPostingProposal = zJournalVoucherProposal.extend({
  payrollRunId: zId,
  month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
  regime: z.enum(PAYROLL_REGIMES),
  mapStatus: z.enum(['confirmed', 'commentary']),
});
export type PayrollPostingProposal = z.infer<typeof zPayrollPostingProposal>;

// The payment of an approved run's obligations (#2532, payroll plan 6.4): one voucher (a phiếu chi from the cash box or a giấy báo Nợ from a bank account) for the net pay and one for each
// remittance. A person asks for it with the run, the kind of payment, the date and the account the money moves through (kernel.proposal.request with command
// `finance.payroll_payment.record`); the server builds the lines and the amount from the frozen run, so the request carries nothing else. Ludy never initiates a payment: the voucher records one made.
export const PAYROLL_PAYMENT_COMMAND = 'finance.payroll_payment.record';
export const PAYROLL_PAYMENT_KINDS = ['net_pay', 'insurance', 'union', 'tax'] as const;
export type PayrollPaymentKind = (typeof PAYROLL_PAYMENT_KINDS)[number];
export const zHrPaymentRequest = z.strictObject({
  runId: zId,
  kind: z.enum(PAYROLL_PAYMENT_KINDS),
  type: z.enum(['cash_payment', 'bank_debit']),
  date: zLocalDate,
  cashAccount: zAccountCode,
  // The bank statement line the payment settles (#326, #2385), when it is made from one.
  bankLineId: zId.optional(),
});
export type HrPaymentRequest = z.infer<typeof zHrPaymentRequest>;
// What finance's record command asks the HR module to rebuild before it records the payment (hr.payroll.payment.verify).
export const zHrPaymentVerify = z.strictObject({ runId: zId, kind: z.enum(PAYROLL_PAYMENT_KINDS) });
// The proposal (kind finance.cash_voucher, shown as a voucher) with the run it pays, the kind of payment, the month and the chart the run was posted under. It names no person.
export const zPayrollPaymentProposal = zCashVoucherProposal.extend({
  payroll: z.strictObject({ runId: zId, kind: z.enum(PAYROLL_PAYMENT_KINDS), month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/), regime: z.enum(PAYROLL_REGIMES) }),
});
export type PayrollPaymentProposal = z.infer<typeof zPayrollPaymentProposal>;

// The finance coworker on payroll (#2534, plan 6.7). Each call is read-only: it reads the stored run through the audited sensitive queries, asks the model about the pseudonymized sheet
// only (outside any transaction, under the AI budget meter) and answers with checked text, the people's names put back by code. `ai` names the state when there is no text: the sheet,
// the payslips and the exports are complete in every state. The proposals and the notes are for a person to read and accept or edit; nothing here changes a run or presses approve.
export const HR_COWORKER_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'quiet'] as const;
export const zHrCoworkerAsk = z.strictObject({ runId: zId, lang: z.enum(['vi', 'en']).optional() });
export type HrCoworkerAsk = z.infer<typeof zHrCoworkerAsk>;
export const zHrCoworkerPayslipAsk = z.strictObject({ lineId: zId, lang: z.enum(['vi', 'en']).optional() });
export type HrCoworkerPayslipAsk = z.infer<typeof zHrCoworkerPayslipAsk>;
// A finding is what code found (the facts, written by code with the people's names put back), with the model's sentence only when it passed the checks. The findings come back in every state
// of `ai`, so with AI off, busy, out of budget or refused the owner still sees every anomaly and every signal.
const zCoworkerItem = z.object({ id: z.string(), kind: z.string(), employeeId: zId.nullable(), facts: z.string(), text: z.string().nullable() });
export const zHrCoworkerPrepared = z.object({
  ai: z.enum(HR_COWORKER_STATES),
  items: z.array(zCoworkerItem.extend({ field: z.enum(['overtime', 'unpaid_days', 'bonus', 'allowances', 'insured', 'contract', 'none']).nullable() })),
});
export type HrCoworkerPrepared = z.infer<typeof zHrCoworkerPrepared>;
export const zHrCoworkerFlagged = z.object({ ai: z.enum(HR_COWORKER_STATES), items: z.array(zCoworkerItem) });
export type HrCoworkerFlagged = z.infer<typeof zHrCoworkerFlagged>;
export const zHrCoworkerExplained = z.object({ ai: z.enum(HR_COWORKER_STATES), text: z.string().nullable() });
export type HrCoworkerExplained = z.infer<typeof zHrCoworkerExplained>;
