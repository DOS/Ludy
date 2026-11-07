// SPDX-License-Identifier: AGPL-3.0-only
// The posting of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4, ADR-0046). The proposal is built by the HR module's own command from the frozen run
// (hr.payroll.posting.prepare: the finance proposal path asks it, in the requester's context, so the lines come from the run and never from the requester); this command is what an
// owner or an admin approves. It runs only through kernel.proposal.approve, on the stored payload:
// - it checks the payload again as a general journal voucher (its shape, its accounts in the org's chart and in use, its total) and that the month is not closed;
// - it refuses a run that already has a posting (the database holds this too: one voucher per run, a unique index);
// - it inserts the voucher, which names the run and the proposal, and posts its entry through the posting path, in the same transaction. The database checks at commit that the proposal
//   has such a voucher (crove_finance.ledger_effect_recorded) before it moves to 'executed'.
// No finance code reads a payroll table: the run's id is the voucher's source, carried in the payload, and the lines are one per account (the detail stays on the run). A posting is
// corrected by reversing its entry (finance.journal.reverse) while the period lock allows it.
import { z } from 'zod';
import { JOURNAL_VOUCHER_KIND, PAYROLL_POSTING_COMMAND, zPayrollPostingProposal } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { checkJournalVoucherLines, postJournalVoucher } from './journal-voucher.ts';
import { journalVoucherTotal } from './domain/journal-voucher.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';

export const recordPayrollPosting = defineCommand({
  name: PAYROLL_POSTING_COMMAND,
  input: z.object({ payload: zPayrollPostingProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const lines = payload.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit }));
    // A pay run's posting names no party: the people are on the run, not in the books.
    if (lines.some((l) => l.partyId !== null)) throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Bút toán lương không ghi theo đối tượng', { problems: ['PARTY_NOT_ALLOWED'] });
    await checkJournalVoucherLines(ctx, lines, true);
    if (journalVoucherTotal(lines) !== payload.total) {
      throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Tổng số tiền không khớp các dòng của phiếu', { problems: ['TOTAL_MISMATCH'] });
    }
    const legalEntityId = await resolveLegalEntity(ctx, payload.legalEntityId);
    const lockedThrough = await periodLockedThrough(ctx, legalEntityId);
    if (lockedThrough && payload.date <= lockedThrough) {
      throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(payload.date)}`, {
        lockedThrough,
        entryDate: payload.date,
      });
    }
    const done = await ctx.trx
      .selectFrom('crove_finance.journal_voucher')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('payroll_run_id', '=', payload.payrollRunId)
      .executeTakeFirst();
    if (done) throw new DomainError('HR_POSTING_DONE', 409, 'Bảng lương này đã được hạch toán');
    return postJournalVoucher(ctx, { ...payload, legalEntityId }, null, null, null, payload.payrollRunId);
  },
});

export const payrollPostingCommands = [recordPayrollPosting];
