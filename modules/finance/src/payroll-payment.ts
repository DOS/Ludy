// SPDX-License-Identifier: AGPL-3.0-only
// The payment vouchers of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046): a phiếu chi or a giấy báo Nợ for the net pay or for one remittance (insurance,
// union fee, tax). The HR module's own command builds the request from the frozen run (hr.payroll.payment.prepare: the finance proposal path asks it, in the requester's context, so the lines
// and the amount come from the run and never from the requester); the two commands here are what finance adds, and the voucher is the ordinary cash voucher (cash-voucher.ts):
// - finance.payroll_payment.prepare: checks that the run has been posted (its voucher names it) and that posting stands (not reversed, #2854), and that this kind of payment is not already recorded
//   (a reversed payment voucher does not count: it can be recorded again), then builds the proposal as any voucher
//   (its accounts in the entity's chart, the bank line it settles) and raises the flag of a cash payment at the 5 million limit. It writes nothing. Owners and admins only, like the proposal it serves.
// - finance.payroll_payment.record: runs only through kernel.proposal.approve. It asks the HR module to rebuild the obligation from the run (in the approver's context, owners and admins) and
//   refuses a stored proposal that differs from it (the entity, the month, the chart, the lines, the total); then it records the voucher with the run and the kind on it (one live voucher per run and kind: a
//   trigger holds it, 20261205124500) and posts its entry, in the same transaction. The database checks at commit that the proposal has such a voucher (crove_finance.ledger_effect_recorded).
// No finance code reads a payroll table, and Ludy never initiates a payment: the voucher records one the business made.
import { sql } from 'kysely';
import { z } from 'zod';
import { PAYROLL_PAYMENT_COMMAND, PAYROLL_PAYMENT_KINDS, PAYROLL_REGIMES, VOUCHER_KIND, zCashVoucherRequest, zId, zPayrollPaymentProposal } from '@crove/kernel-contract';
import { money } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import { buildVoucherProposal, recordVoucherPayload } from './cash-voucher.ts';
import { payrollCashCheck } from './domain/anomaly.ts';
import { VOUCHER_SOURCE, voucherTitle } from './domain/cash-voucher.ts';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const PAYMENT_TYPES = ['cash_payment', 'bank_debit'] as const;

// A source (a voucher) whose entries have all been reversed: it has an original entry (source `source`, reverses nothing) and every original entry of it has a reversal pointing at it. The same
// rule as the database's own (20261205124500, the trigger that holds one live payment voucher per run and kind), read here as the caller sees the books. Kysely `sql` for the correlated
// subqueries; `voucher` is the alias of the voucher row, `source` the journal entry source type of its kind.
const reversedSource = (voucher: string, source: string) => sql<boolean>`(
  EXISTS (SELECT 1 FROM crove_finance.journal_entry o WHERE o.org_id = ${sql.ref(`${voucher}.org_id`)} AND o.source_type = ${source} AND o.source_id = ${sql.ref(`${voucher}.id`)} AND o.reverses_entry_id IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry o
    WHERE o.org_id = ${sql.ref(`${voucher}.org_id`)} AND o.source_type = ${source} AND o.source_id = ${sql.ref(`${voucher}.id`)} AND o.reverses_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)))`;

// The run's entry has been posted (its voucher names the run) and that posting stands, and this kind of payment has not been recorded yet. A posting that was reversed (finance.journal.reverse) is
// no posting any more, so nothing is paid against it (#2854); a payment voucher that was reversed no longer holds its kind, so it can be recorded again. Read under the HR module's lock on the
// run when a proposal is asked for, and again when it is approved.
async function checkPayable(ctx: QueryContext, runId: string, kind: string): Promise<void> {
  const posting = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .select(['j.id', reversedSource('j', JOURNAL_VOUCHER_SOURCE).as('reversed')])
    .where('j.org_id', '=', ctx.orgId)
    .where('j.payroll_run_id', '=', runId)
    .executeTakeFirst();
  if (!posting) throw new DomainError('HR_PAYMENT_NOT_POSTED', 409, 'Bảng lương này chưa được hạch toán; hãy hạch toán trước khi ghi chi lương hay nộp các khoản');
  if (posting.reversed) throw new DomainError('HR_PAYMENT_POSTING_REVERSED', 409, 'Bút toán hạch toán của bảng lương này đã bị đảo nên chưa chi lương hay nộp các khoản được');
  const paid = await ctx.trx
    .selectFrom('crove_finance.cash_voucher as v')
    .select('v.id')
    .where('v.org_id', '=', ctx.orgId)
    .where('v.payroll_run_id', '=', runId)
    .where('v.payroll_payment_kind', '=', kind)
    .where(sql<boolean>`NOT ${reversedSource('v', VOUCHER_SOURCE)}`)
    .executeTakeFirst();
  if (paid) throw new DomainError('HR_PAYMENT_DONE', 409, 'Khoản này của bảng lương đã được chi');
}

export const preparePayrollPayment = defineCommand({
  name: 'finance.payroll_payment.prepare',
  input: z.strictObject({
    runId: zId,
    paymentKind: z.enum(PAYROLL_PAYMENT_KINDS),
    month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
    regime: z.enum(PAYROLL_REGIMES),
    // How many people's net pay is at the cash limit or above (a number from the HR module, no name or figure): a cash payment of the net pay is flagged when there is one.
    cashLarge: z.number().int().min(0).max(100000),
    request: zCashVoucherRequest.extend({ type: z.enum(PAYMENT_TYPES) }),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, input) => {
    await checkPayable(ctx, input.runId, input.paymentKind);
    // A payment of the net pay in cash while some net pay is 5 million or more: an anomaly flag (id `anomaly...`), so the proposal is approved one by one, never in bulk.
    const flag = input.request.type === 'cash_payment' ? payrollCashCheck(input.cashLarge) : null;
    const draft = await buildVoucherProposal(ctx, input.request, flag ? [flag] : []);
    const payload = zPayrollPaymentProposal.parse({ ...draft.payload, payroll: { runId: input.runId, kind: input.paymentKind, month: input.month, regime: input.regime } });
    return { kind: VOUCHER_KIND, command: PAYROLL_PAYMENT_COMMAND, title: voucherTitle(payload), payload };
  },
});

export const recordPayrollPayment = defineCommand({
  // A literal, not the shared constant: the job-egress analyzer follows the nested `ctx.run` calls of a command and reads its name from the source.
  name: 'finance.payroll_payment.record',
  input: z.object({ payload: zPayrollPaymentProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const { runId, kind } = payload.payroll;
    if (payload.type !== 'cash_payment' && payload.type !== 'bank_debit') throw new DomainError('VOUCHER_INVALID', 422, 'Chứng từ chi lương phải là phiếu chi hoặc giấy báo Nợ');
    // A pay run's payment names no party and no person: the people are on the run, not in the books.
    if (payload.party !== null || payload.personName !== null) throw new DomainError('VOUCHER_INVALID', 422, 'Chứng từ chi lương không ghi theo đối tượng', { problems: ['PARTY_NOT_ALLOWED'] });
    // The payload names its entity: it is built so, and one without is refused, never read as the default.
    if (!payload.legalEntityId) throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất chi lương không nêu pháp nhân', { what: 'legalEntityId' });
    // The obligation of the run rebuilt now, in the approver's context, from the run's totals by cost department and never from a person's line (#2751): whoever may approve the payment can check it
    // (an owner, an admin, or a member holding the approval permission). Anyone else is refused by the approval policy before this runs.
    const expected = await ctx.run<{ runId: string; kind: string; month: string; regime: string; legalEntityId: string; approvedBy: string | null; cashLarge: number; lines: ReadonlyArray<{ account: string; amount: string }>; total: string }>(
      'hr.payroll.payment.verify',
      { runId, kind },
    );
    if (expected.legalEntityId !== payload.legalEntityId) throw new DomainError('HR_POSTING_MISMATCH', 422, 'Chứng từ chi lương không cùng pháp nhân với bảng lương', { what: 'legalEntityId' });
    if (expected.month !== payload.payroll.month || expected.regime !== payload.payroll.regime) {
      throw new DomainError('HR_POSTING_MISMATCH', 422, 'Chứng từ chi lương không khớp tháng hoặc chế độ kế toán của bảng lương; hãy lập lại đề xuất', { what: 'month' });
    }
    // The lines are the run's, account by account and amount by amount (money-equal), whatever their order; so is the total.
    const key = (l: { account: string; amount: string }) => `${l.account}:${money(l.amount).toFixed()}`;
    const have = payload.lines.map(key).sort();
    const want = expected.lines.map(key).sort();
    if (have.length !== want.length || have.some((k, i) => k !== want[i]) || !money(payload.total).equals(money(expected.total))) {
      throw new DomainError('HR_POSTING_MISMATCH', 422, 'Số tiền của chứng từ chi không khớp bảng lương; hãy lập lại đề xuất', { what: 'lines' });
    }
    // The cash flag, rebuilt: a cash payment of the net pay while a net pay is 5 million or more carries exactly the flag the preparer raises, and no payment carries any other of its kind. A proposal row
    // written some other way without the flag, or with a changed one, is refused, so it cannot slip into a bulk approval (the flag keeps a proposal out of it).
    const wantFlag = payload.type === 'cash_payment' ? payrollCashCheck(expected.cashLarge) : null;
    const haveFlags = (payload.checks ?? []).filter((c) => c.id === 'anomaly_cash' || c.code?.startsWith('anomaly_cash.'));
    const sameFlag = wantFlag
      ? haveFlags.length === 1 && haveFlags[0]?.id === wantFlag.id && haveFlags[0].status === wantFlag.status && haveFlags[0].code === wantFlag.code && haveFlags[0].params?.count === wantFlag.params?.count
      : haveFlags.length === 0;
    if (!sameFlag) throw new DomainError('HR_POSTING_MISMATCH', 422, 'Cảnh báo chi tiền mặt của đề xuất không khớp bảng lương; hãy lập lại đề xuất', { what: 'checks' });
    // The person who approved the run is listed on the proposal as a co-author (the preparer writes it; a proposal row written some other way must too).
    if (expected.approvedBy) {
      const own = await ctx.trx.selectFrom('crove_kernel.proposal').select('co_authors').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
      if (!(own?.co_authors ?? []).map((id) => id.toLowerCase()).includes(expected.approvedBy.toLowerCase())) {
        throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất chi lương không ghi người đã duyệt bảng lương là đồng tác giả; hãy lập lại đề xuất', { what: 'coAuthors' });
      }
    }
    await checkPayable(ctx, runId, kind);
    return recordVoucherPayload(ctx, payload, { runId, kind });
  },
});

export const payrollPaymentCommands = [preparePayrollPayment, recordPayrollPayment];
