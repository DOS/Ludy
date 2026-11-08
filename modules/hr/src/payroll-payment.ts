// SPDX-License-Identifier: AGPL-3.0-only
// The payment vouchers of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046): one for the net pay and one for each remittance (insurance, union fee, tax).
// `hr.payroll.payment.prepare` is the preparer of kernel.proposal.request for `finance.payroll_payment.record`: it rebuilds the run's entry from its frozen lines in the requester's context
// (the same build the posting rests on, owners and admins only, never as the system actor or the worker), takes the obligation of the kind asked for, and hands finance a voucher request
// whose lines and amount come from the run, never from the requester. Finance checks the voucher as a payment voucher and returns the proposal. Nothing here pays or posts: Ludy never initiates a
// payment, a person approves the proposal and the voucher records a payment the business made. No model call is made.
//
// `hr.payroll.payment.verify` is what finance's record command compares the stored proposal with, in the approver's context, so a proposal row written some other way than by the preparer
// (raw SQL) cannot pay lines the run does not hold.
import { PAYROLL_PAYMENT_COMMAND, zHrPaymentRequest, zHrPaymentVerify, type PayrollPaymentKind } from '@crove/kernel-contract';
import { isCashOverLimit, type Obligation } from '@crove/l10n-vn';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { buildRunPosting, monthLabel } from './payroll-posting.ts';

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
  return found;
}

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
    // The people whose net pay is at the cash limit or above (a payment of 5 million or more must not be in cash for the pay to be deductible, docs/plan/payroll.md row 19, commentary until the
    // accountant confirms it, #2535), as a number: finance flags a cash payment of them, a flag and never a block, and learns no name or figure.
    const cashLarge = input.kind === 'net_pay' ? nets.filter((n) => isCashOverLimit('cash', n)).length : 0;
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
    return draft;
  },
});

// What finance compares the stored proposal with (ctx.run, in the approver's context): the obligation rebuilt from the frozen run now. It writes nothing and reads only what the preparer reads.
export const verifyPayrollPayment = defineCommand({
  name: 'hr.payroll.payment.verify',
  input: zHrPaymentVerify,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, { runId, kind }) => {
    const { payrollRun, regime, result } = await buildRunPosting(ctx, runId, false);
    const obligation = obligationOf(result.obligations, kind);
    return {
      runId,
      kind,
      month: payrollRun.month,
      regime,
      // The run's entity: the voucher must name it (finance's record checks it).
      legalEntityId: payrollRun.legal_entity_id,
      lines: obligation.debits.map((d) => ({ account: d.account, amount: d.amount })),
      total: obligation.amount,
    };
  },
});

export const hrPaymentCommands = [preparePayrollPayment, verifyPayrollPayment];
