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
import { PAYROLL_POSTING_MAPS, money } from '@crove/l10n-vn';
import { z } from 'zod';
import { JOURNAL_VOUCHER_KIND, JOURNAL_VOUCHER_MAX_LINES, PAYROLL_REGIMES, zAccountCode, zId, zJournalAmount, zLocalDate, zPayrollPostingProposal, type JournalVoucherProposal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import { assertUsableAccounts } from './accounts.ts';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { postJournalVoucher } from './journal-voucher.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The chart an entity keeps its books under on a date: its books row in force (the newest that starts on or before the date), TT133 2026.1 when there is none (the only regime before the
// books rows existed). The database's own check of every journal line follows the same rule (crove_finance.check_account_ref).
export async function booksOn(ctx: QueryContext, legalEntityId: string, date: string): Promise<{ regime: string; version: string }> {
  const row = await ctx.trx
    .selectFrom('crove_finance.legal_entity_books')
    .select(['regime', 'chart_version'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { regime: row.regime, version: row.chart_version } : { regime: 'tt133', version: '2026.1' };
}

interface PostingLines {
  date: string;
  legalEntityId: string;
  regime: string;
  lines: ReadonlyArray<{ account: string; debit: string; credit: string }>;
}

// Every check of a pay run's entry, when it is asked for and again when it is posted: its shape (balanced, one side a line), the entity's chart is the regime the HR module built it for, its
// accounts are in that chart (the org's chart and in use for TT133; the regime's own chart otherwise: the accounts of TT99 are not in the TT133 table), and the month is not closed.
async function checkPostingLines(ctx: QueryContext, input: PostingLines): Promise<{ legalEntityId: string; total: string }> {
  // The accountant has not confirmed this chart's map of pay accounts (#2535): nothing is requested or posted from it. The HR module holds the same gate when it builds the proposal.
  if (PAYROLL_POSTING_MAPS[input.regime as keyof typeof PAYROLL_POSTING_MAPS]?.status !== 'confirmed') {
    throw new DomainError('HR_POSTING_MAP_UNCONFIRMED', 409, 'Bảng tài khoản hạch toán lương của chế độ kế toán này chưa được kế toán xác nhận; chưa hạch toán được', { regime: input.regime });
  }
  const problems = journalVoucherProblems(input.lines.map((l) => ({ ...l, partyId: null })));
  if (problems.length > 0) throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Bút toán lương không hợp lệ: các dòng phải cân và mỗi dòng ghi một bên', { problems });
  const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
  const books = await booksOn(ctx, legalEntityId, input.date);
  if (books.regime !== input.regime) {
    throw new DomainError('HR_POSTING_MISMATCH', 422, 'Chế độ kế toán của pháp nhân đã thay đổi từ khi lập bút toán; hãy lập lại đề xuất', { what: 'regime' });
  }
  const codes = [...new Set(input.lines.map((l) => l.account))];
  if (books.regime === 'tt133' && books.version === '2026.1') {
    await assertUsableAccounts(ctx, codes);
  } else {
    const known = await ctx.trx.selectFrom('crove_finance.chart_account').select('code').where('regime', '=', books.regime).where('version', '=', books.version).where('code', 'in', codes).execute();
    const have = new Set(known.map((k) => k.code));
    const unknown = codes.filter((c) => !have.has(c));
    if (unknown.length > 0) throw new DomainError('UNKNOWN_ACCOUNT', 422, `Tài khoản ${unknown.join(', ')} không có trong hệ thống tài khoản của pháp nhân`, { codes: unknown });
  }
  const lockedThrough = await periodLockedThrough(ctx, legalEntityId);
  if (lockedThrough && input.date <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(input.date)}`, { lockedThrough, entryDate: input.date });
  }
  return { legalEntityId, total: journalVoucherTotal(input.lines) };
}

// The check the HR module calls (ctx.run) when it builds the proposal from a frozen run: it validates the entry it hands over and returns it as a general journal voucher payload. It writes
// nothing and reads no payroll table; owners and admins only, like the proposal it serves.
export const checkPayrollPosting = defineCommand({
  name: 'finance.payroll_posting.check',
  input: z.strictObject({
    date: zLocalDate,
    description: z.string().trim().min(1).max(300),
    legalEntityId: zId,
    regime: z.enum(PAYROLL_REGIMES),
    // The run the entry posts: a run with a posting already is refused here, so the HR module reads no finance table.
    payrollRunId: zId,
    lines: z.array(z.strictObject({ account: zAccountCode, debit: zJournalAmount, credit: zJournalAmount })).min(2).max(JOURNAL_VOUCHER_MAX_LINES),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, input) => {
    const posted = await ctx.trx.selectFrom('crove_finance.journal_voucher').select('id').where('org_id', '=', ctx.orgId).where('payroll_run_id', '=', input.payrollRunId).executeTakeFirst();
    if (posted) throw new DomainError('HR_POSTING_DONE', 409, 'Bảng lương này đã được hạch toán');
    const checked = await checkPostingLines(ctx, input);
    const payload: JournalVoucherProposal = {
      date: input.date,
      description: input.description,
      lines: input.lines.map((l) => ({ account: l.account, party: null, debit: l.debit, credit: l.credit })),
      total: checked.total,
      legalEntityId: checked.legalEntityId,
    };
    return { payload };
  },
});

// The chart an entity keeps on a date, for the HR module to pick its account map (ctx.run): finance alone reads its books. Owners and admins, like the proposal it serves.
export const payrollPostingRegime = defineCommand({
  name: 'finance.payroll_posting.regime',
  input: z.strictObject({ legalEntityId: zId, date: zLocalDate }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  // The HR module's verification of a posting asks it on behalf of whoever may approve the posting (an owner, an admin, or a member holding the approval permission; #2751).
  permission: 'finance.proposal.approve',
  writes: [],
  handler: async (ctx, input) => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    return { regime: (await booksOn(ctx, legalEntityId, input.date)).regime };
  },
});

export const recordPayrollPosting = defineCommand({
  // A literal, not the shared constant: the job-egress analyzer follows the nested `ctx.run` calls of a command and reads its name from source (the contract's PAYROLL_POSTING_COMMAND equals it).
  name: 'finance.payroll_posting.record',
  input: z.object({ payload: zPayrollPostingProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    // A pay run's posting names no party: the people are on the run, not in the books.
    if (payload.lines.some((l) => l.party !== null)) throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Bút toán lương không ghi theo đối tượng', { problems: ['PARTY_NOT_ALLOWED'] });
    const lines = payload.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit }));
    // The payload names its entity: it is built so, and one without is refused, never read as the default.
    if (!payload.legalEntityId) throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất hạch toán lương không nêu pháp nhân', { what: 'legalEntityId' });
    const checked = await checkPostingLines(ctx, { date: payload.date, legalEntityId: payload.legalEntityId, regime: payload.regime, lines });
    if (checked.total !== payload.total) {
      throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Tổng số tiền không khớp các dòng của phiếu', { problems: ['TOTAL_MISMATCH'] });
    }
    const done = await ctx.trx.selectFrom('crove_finance.journal_voucher').select('id').where('org_id', '=', ctx.orgId).where('payroll_run_id', '=', payload.payrollRunId).executeTakeFirst();
    if (done) throw new DomainError('HR_POSTING_DONE', 409, 'Bảng lương này đã được hạch toán');
    // The entry is built again from the frozen run, in the approver's context (the HR module's own command: no payroll table is read from here), and the stored proposal must equal it. A proposal
    // row not written by the preparer (raw SQL) cannot post lines the run does not hold.
    // The HR module rebuilds it from the run's totals by cost department, never from a person's line (#2751), so whoever may approve the posting can check it: an owner, an admin, or a member
    // holding the approval permission (a chief accountant). Anyone else is refused by the approval policy before this runs.
    const expected = await ctx.run<{ runId: string; month: string; date: string; regime: string; legalEntityId: string; approvedBy: string | null; lines: { account: string; debit: string; credit: string }[] }>(
      'hr.payroll.posting.verify',
      { runId: payload.payrollRunId },
    );
    // The posting goes into the entity the run belongs to, never another the payload names.
    if (expected.legalEntityId.toLowerCase() !== checked.legalEntityId.toLowerCase()) {
      throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất hạch toán ghi vào pháp nhân khác pháp nhân của bảng lương; hãy lập lại đề xuất', { what: 'legalEntityId' });
    }
    // The person who approved the run is a co-author of its posting (four-eyes): a proposal that does not list them was not made by the preparer, so it is refused.
    if (expected.approvedBy) {
      const own = await ctx.trx.selectFrom('crove_kernel.proposal').select('co_authors').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
      if (!(own?.co_authors ?? []).map((id) => id.toLowerCase()).includes(expected.approvedBy.toLowerCase())) {
        throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất hạch toán không ghi người đã duyệt bảng lương là đồng tác giả; hãy lập lại đề xuất', { what: 'coAuthors' });
      }
    }
    const key = (l: { account: string; debit: string; credit: string }) => `${l.account}|${money(l.debit).toFixed(0)}|${money(l.credit).toFixed(0)}`;
    const stored = payload.lines.map(key).sort();
    const rebuilt = expected.lines.map(key).sort();
    if (expected.month !== payload.month || expected.date !== payload.date || expected.regime !== payload.regime || stored.length !== rebuilt.length || stored.some((k, i) => k !== rebuilt[i])) {
      throw new DomainError('HR_POSTING_MISMATCH', 422, 'Đề xuất hạch toán không khớp bảng lương đã duyệt; hãy lập lại đề xuất', { what: 'lines' });
    }
    return postJournalVoucher(ctx, { ...payload, legalEntityId: checked.legalEntityId }, null, null, null, payload.payrollRunId);
  },
});

export const payrollPostingCommands = [payrollPostingRegime, checkPayrollPosting, recordPayrollPosting];
