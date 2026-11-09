// SPDX-License-Identifier: AGPL-3.0-only
// The payment vouchers of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046): one for the net pay and one for each remittance (insurance, union fee, tax).
// `hr.payroll.payment.prepare` is the preparer of kernel.proposal.request for `finance.payroll_payment.record`: it rebuilds the run's entry from its frozen lines in the requester's context
// (the same build the posting rests on, owners and admins only, never as the system actor or the worker), takes the obligation of the kind asked for, and hands finance a voucher request
// whose lines and amount come from the run, never from the requester. Finance checks the voucher as a payment voucher and returns the proposal. Nothing here pays or posts: Ludy never initiates a
// payment, a person approves the proposal and the voucher records a payment the business made. No model call is made.
//
// `hr.payroll.payment.verify` is what finance's record command compares the stored proposal with, in the approver's context, so a proposal row written some other way than by the preparer
// (raw SQL) cannot pay lines the run does not hold.
import { PAYROLL_PAYMENT_COMMAND, zHrPaymentAmounts, zHrPaymentRequest, zHrPaymentVerify, type HrRunPaymentAmounts, type PayrollPaymentKind } from '@crove/kernel-contract';
import { isCashOverLimit, money, toMoney, type Obligation } from '@crove/l10n-vn';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { buildRunPosting, buildRunPostingFromTotals, monthLabel } from './payroll-posting.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// Words of the reason on the voucher (lý do chi): the month and what is paid, never a name.
const REASON: Record<PayrollPaymentKind, (month: string) => string> = {
  net_pay: (month) => `Chi lương tháng ${monthLabel(month)}`,
  insurance: (month) => `Nộp bảo hiểm xã hội, y tế, thất nghiệp tháng ${monthLabel(month)}`,
  union: (month) => `Nộp kinh phí công đoàn tháng ${monthLabel(month)}`,
  tax: (month) => `Nộp thuế thu nhập cá nhân tháng ${monthLabel(month)}`,
};

// The obligation of the kind in the run's entry, or a refusal when the run owes nothing of that kind (no union fee, no tax withheld).
function obligationOf(obligations: readonly Obligation[], kind: PayrollPaymentKind): Obligation {
  const found = obligations.find((o) => o.kind === kind);
  if (!found) throw new DomainError('HR_PAYMENT_NOTHING_DUE', 422, 'Bảng lương này không có khoản này để chi');
  // The corrections a month carries are signed: when they take a kind below zero (pay or insurance or tax to be given back), there is nothing to pay in this run, and a negative voucher is never made.
  if (money(found.amount).isNegative()) throw new DomainError('HR_PAYMENT_NEGATIVE', 422, 'Khoản này âm sau các điều chỉnh của tháng (phải hoàn lại); chưa ghi chi được, kế toán xử lý riêng');
  return found;
}

// The people whose net pay is at the cash limit or above (a payment of 5 million or more must not be in cash for the pay to be deductible, docs/plan/payroll.md row 19, commentary until the
// accountant confirms it, #2535), as a number: finance flags a cash payment of the net pay when it is not zero, and learns no name or figure. Both the preparer and the verifier count it.
const cashLargeOf = (kind: PayrollPaymentKind, nets: readonly string[]): number => (kind === 'net_pay' ? nets.filter((n) => isCashOverLimit('cash', n)).length : 0);

export const preparePayrollPayment = defineCommand({
  name: 'hr.payroll.payment.prepare',
  input: zHrPaymentRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, input) => {
    // The run's row is held to the end of the request, so two requests for the same run take turns: the second sees the proposal the first made and is refused below.
    const { payrollRun, regime, result, nets } = await buildRunPosting(ctx, input.runId, true);
    const obligation = obligationOf(result.obligations, input.kind);
    // One open proposal per run and kind: another still open ends it, and one already paid is refused by finance's check (a rejected or expired one does not).
    const open = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('command', '=', PAYROLL_PAYMENT_COMMAND)
      .where('status', '=', 'pending')
      // The stored request is the raw input, and a uuid may be written in either case: compare as text in one case.
      .where(sql<string>`pg_catalog.lower(request_input ->> 'runId')`, '=', input.runId.toLowerCase())
      .where(sql<string>`request_input ->> 'kind'`, '=', input.kind)
      .executeTakeFirst();
    if (open) throw new DomainError('HR_PAYMENT_OPEN', 409, 'Khoản này của bảng lương đã có một đề xuất chi đang chờ duyệt');
    const cashLarge = cashLargeOf(input.kind, nets);
    const reason = REASON[input.kind](payrollRun.month);
    const draft = await ctx.run<{ kind: string; command: string; title: string; payload: Record<string, unknown> }>('finance.payroll_payment.prepare', {
      runId: input.runId,
      paymentKind: input.kind,
      month: payrollRun.month,
      regime,
      cashLarge,
      request: {
        type: input.type,
        date: input.date,
        cashAccount: input.cashAccount,
        description: reason,
        lines: obligation.debits.map((d) => ({ account: d.account, amount: d.amount })),
        legalEntityId: payrollRun.legal_entity_id,
        ...(input.bankLineId ? { bankLineId: input.bankLineId } : {}),
      },
    });
    ctx.audit({ runId: input.runId, month: payrollRun.month, paymentKind: input.kind, regime, accounts: obligation.debits.length });
    // The person who approved and froze the run's figures is a co-author of its payments, as of its posting (#2736): they do not approve the payment while another eligible approver exists.
    return { ...draft, ...(payrollRun.approved_by ? { coAuthors: [payrollRun.approved_by] } : {}) };
  },
});

// What finance compares the stored proposal with (ctx.run, in the approver's context): the obligation rebuilt from the frozen run now. It writes nothing and reads only what the preparer reads.
export const verifyPayrollPayment = defineCommand({
  name: 'hr.payroll.payment.verify',
  input: zHrPaymentVerify,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  // Whoever may approve the payment reads what the run owes by cost department (an owner, an admin, or a member holding the approval permission; #2751): never a person's line.
  permission: 'finance.proposal.approve',
  writes: [],
  handler: async (ctx, { runId, kind }) => {
    const { payrollRun, regime, result, cashLarge } = await buildRunPostingFromTotals(ctx, runId);
    const obligation = obligationOf(result.obligations, kind);
    return {
      runId,
      kind,
      month: payrollRun.month,
      regime,
      // The run's entity and the person who approved it: the voucher must name this entity, and its proposal must list this person as a co-author (finance's record checks both).
      legalEntityId: payrollRun.legal_entity_id,
      approvedBy: payrollRun.approved_by,
      lines: obligation.debits.map((d) => ({ account: d.account, amount: d.amount })),
      total: obligation.amount,
      // How many people's net pay is at the cash limit or above: finance rebuilds the cash flag from it, so a proposal written without the flag is refused.
      cashLarge: kind === 'net_pay' ? cashLarge : 0,
    };
  },
});

// The amount of each payment of the approved runs asked for, for the matching of a bank statement line with a payment (#2532). Owners and admins, who are the ones that ask for a payment. It reads the
// run's totals by cost department (crove_hr.payroll_run_totals, in the caller's own context), never a line, and gives a run only when the same checks the verification makes hold: a run that is not
// approved, that has an adjustment made before its split was kept, a line not calculated or a figure the sums cannot be trusted for is not offered (asking for its payment says why). The amounts equal the obligations of the run's
// entry (a test ties them): the net pay, the insurance (what employees and the employer owe), the union fee and the tax.
export const payrollPaymentAmounts = defineQuery({
  name: 'hr.payroll.payment.amounts',
  input: zHrPaymentAmounts,
  access: MANAGERS,
  handler: async (ctx, { runIds }): Promise<HrRunPaymentAmounts[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const out: HrRunPaymentAmounts[] = [];
    for (const runId of new Set(runIds)) {
      const { rows } = await sql<{ totals: unknown }>`SELECT crove_hr.payroll_run_totals(${runId}::uuid) AS totals`.execute(ctx.trx);
      const t = rows[0]?.totals as
        | { month: string; status: string; counts: Record<string, number>; groups: { net: string; unionFee: string; pit: string; employeeInsurance: string; employerInsurance: string }[] }
        | null
        | undefined;
      if (!t || t.status !== 'approved') continue;
      const c = t.counts;
      if ((c.lines ?? 0) === 0 || [c.adjustmentsIncomplete, c.notCalculated, c.noFunction, c.noFunds, c.noDeductions, c.badLines].some((n) => (n ?? 0) > 0)) continue;
      const groups = t.groups;
      const sum = (pick: (g: (typeof groups)[number]) => string) => groups.reduce((acc, g) => acc.plus(money(pick(g))), money(0));
      const all: Record<PayrollPaymentKind, ReturnType<typeof sum>> = {
        net_pay: sum((g) => g.net),
        insurance: sum((g) => g.employeeInsurance).plus(sum((g) => g.employerInsurance)),
        union: sum((g) => g.unionFee),
        tax: sum((g) => g.pit),
      };
      const amounts: HrRunPaymentAmounts['amounts'] = {};
      // A kind the corrections take below zero is not offered: there is nothing to pay in this run (asking for it says why).
      for (const kind of Object.keys(all) as PayrollPaymentKind[]) if (all[kind].greaterThan(0)) amounts[kind] = toMoney(all[kind]);
      out.push({ runId, month: t.month, amounts });
    }
    return out;
  },
});

export const hrPaymentCommands = [preparePayrollPayment, verifyPayrollPayment];
export const hrPaymentQueries = [payrollPaymentAmounts];
