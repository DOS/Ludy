// SPDX-License-Identifier: AGPL-3.0-only
// The posting proposal of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4 and row 18, ADR-0046). `hr.payroll.posting.prepare` is the preparer of
// kernel.proposal.request for `finance.payroll_posting.record` (the finance proposal path): it reads the frozen run in the requester's context (owners and admins only, the people tables
// are never read as the system actor or the worker), builds the entry from stored figures with the account map of the entity's chart (@crove/l10n-vn, every row of it still `commentary`
// until the accountant confirms row 18, #2535), checks it as a general journal voucher through finance's own check (`finance.payroll_posting.check`, regime-aware), and returns the draft. It writes nothing. A person approves the
// proposal; nothing here posts. The lines are one per account, never per person: the detail stays on the run, and Kế toán approves from the totals by account.
//
// No model call is made: everything here is deterministic over stored facts, and the posting works with AI off.
import { PAYROLL_REGIMES, PAYROLL_POSTING_COMMAND, zHrPostingRequest, JOURNAL_VOUCHER_KIND, type PayrollPostingProposal } from '@crove/kernel-contract';
import { PAY_FUNCTIONS, PostingRefusedError, buildPosting, money, toMoney, type PayFunction, type PayrollRegime, type PostingLine } from '@crove/l10n-vn';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const FUNDS = ['retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment'] as const;

const monthEnd = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};
const monthLabel = (month: string): string => `${month.slice(5)}/${month.slice(0, 4)}`;
const mismatch = (what: string) => new DomainError('HR_POSTING_MISMATCH', 422, `Số liệu của bảng lương không khớp (${what}); không lập được bút toán`, { what });

interface StoredFund {
  fund: (typeof FUNDS)[number];
  employee: string;
  employer: string;
}

// What a stored breakdown must hold for the posting: the funds of the insurance and the deductions. A line without them cannot be posted, and the entry never guesses.
function fundsOf(breakdown: unknown): StoredFund[] {
  const funds = (breakdown as { insurance?: { funds?: unknown } } | null)?.insurance?.funds;
  if (!Array.isArray(funds)) throw mismatch('thiếu chi tiết bảo hiểm');
  return funds.map((f) => {
    const row = f as { fund?: unknown; employee?: unknown; employer?: unknown };
    if (typeof row.fund !== 'string' || !(FUNDS as readonly string[]).includes(row.fund) || typeof row.employee !== 'string' || typeof row.employer !== 'string') throw mismatch('quỹ bảo hiểm');
    return { fund: row.fund as StoredFund['fund'], employee: row.employee, employer: row.employer };
  });
}
function deductionsOf(breakdown: unknown): { advance: string; other: string } {
  const d = (breakdown as { deductions?: { advance?: unknown; damage?: unknown; other?: unknown } } | null)?.deductions;
  if (!d || typeof d.advance !== 'string' || typeof d.damage !== 'string' || typeof d.other !== 'string') throw mismatch('thiếu các khoản khấu trừ');
  return { advance: d.advance, other: toMoney(money(d.damage).plus(d.other)) };
}

export const prepareRunPosting = defineCommand({
  name: 'hr.payroll.posting.prepare',
  input: zHrPostingRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, { runId }) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const run = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status', 'approval'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
    if (run.status !== 'approved') throw new DomainError('HR_RUN_NOT_APPROVED', 409, 'Chỉ bảng lương đã được duyệt mới hạch toán được');
    // One proposal per run: another still open ends it, and one already posted is refused by finance's check (a rejected or expired one does not).
    const open = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('command', '=', PAYROLL_POSTING_COMMAND)
      .where('status', '=', 'pending')
      // The stored request is the raw input, and a uuid may be written in either case: compare as text in one case.
      .where(sql<string>`pg_catalog.lower(request_input ->> 'runId')`, '=', runId.toLowerCase())
      .executeTakeFirst();
    if (open) throw new DomainError('HR_POSTING_OPEN', 409, 'Bảng lương này đã có một đề xuất hạch toán đang chờ duyệt');

    const stored = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['employee_id', 'employment_id', 'kind', 'status', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'pit', 'net', 'breakdown'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', runId)
      .execute();
    if (stored.length === 0) throw mismatch('bảng lương không có dòng nào');
    // A correction of an approved month carries no per-fund split of its insurance: posting it needs its own rule (a follow-up), so a run holding one is not posted here.
    if (stored.some((l) => l.kind !== 'pay')) throw new DomainError('HR_POSTING_ADJUSTMENTS', 422, 'Bảng lương có dòng điều chỉnh; chưa hạch toán được loại bảng lương này');
    if (stored.some((l) => l.status !== 'calculated' || l.gross === null || l.employee_insurance === null || l.employer_insurance === null || l.union_fee === null || l.pit === null || l.net === null)) {
      throw mismatch('dòng chưa tính');
    }
    const employmentIds = stored.map((l) => l.employment_id).filter((id): id is string => id !== null);
    const employments =
      employmentIds.length === 0
        ? []
        : await ctx.trx.selectFrom('crove_hr.payroll_employment').select(['id', 'pay_function']).where('org_id', '=', ctx.orgId).where('id', 'in', employmentIds).execute();
    const functionOf = new Map(employments.map((e) => [e.id, e.pay_function]));

    const lines: PostingLine[] = stored.map((l) => {
      const funds = fundsOf(l.breakdown);
      const employee = funds.reduce((acc, f) => acc.plus(f.employee), money(0));
      const employer = funds.reduce((acc, f) => acc.plus(f.employer), money(0));
      // The split of the funds must add to the line's own insurance: the entry rests on one fact, not two.
      if (!employee.equals(money(l.employee_insurance)) || !employer.equals(money(l.employer_insurance))) throw mismatch('bảo hiểm');
      const payFunction = (l.employment_id ? functionOf.get(l.employment_id) : undefined) ?? 'admin';
      if (!(PAY_FUNCTIONS as readonly string[]).includes(payFunction)) throw mismatch('bộ phận hạch toán');
      const d = deductionsOf(l.breakdown);
      return {
        payFunction: payFunction as PayFunction,
        gross: String(l.gross),
        funds,
        unionFee: String(l.union_fee),
        pit: String(l.pit),
        advance: d.advance,
        otherDeductions: d.other,
        net: String(l.net),
      };
    });

    // The chart of the entity on the last day of the month: finance alone reads its books (TT133 when none is on record).
    const date = monthEnd(run.month);
    const regime = (await ctx.run<{ regime: PayrollRegime }>('finance.payroll_posting.regime', { legalEntityId: run.legal_entity_id, date })).regime;
    if (!(PAYROLL_REGIMES as readonly string[]).includes(regime)) throw mismatch('chế độ kế toán');

    let result;
    try {
      result = buildPosting(regime, lines);
    } catch (error) {
      if (error instanceof PostingRefusedError) throw mismatch(error.code);
      throw error;
    }
    // The entry equals the run's totals as approved: what the approver saw is what posts.
    const totals = (run.approval as { totals?: { gross?: string; employeeInsurance?: string; employerInsurance?: string; unionFee?: string; pit?: string; net?: string; employerCost?: string } } | null)?.totals;
    const same = (a: string | undefined, b: string) => a !== undefined && money(a).equals(money(b));
    if (
      !totals ||
      !same(totals.gross, result.totals.gross) ||
      !same(totals.employeeInsurance, result.totals.employeeInsurance) ||
      !same(totals.employerInsurance, result.totals.employerInsurance) ||
      !same(totals.unionFee, result.totals.unionFee) ||
      !same(totals.pit, result.totals.pit) ||
      !same(totals.net, result.totals.net) ||
      !same(totals.employerCost, result.totals.employerCost)
    ) {
      throw mismatch('tổng so với lúc duyệt');
    }

    // The entry is checked as a general journal voucher by finance's own check (its accounts in the entity's chart of that regime, the month not closed), which also resolves the entity.
    const description = `Hạch toán lương tháng ${monthLabel(run.month)}`;
    const draft = await ctx.run<{ payload: Record<string, unknown> }>('finance.payroll_posting.check', {
      date,
      description,
      legalEntityId: run.legal_entity_id,
      regime,
      payrollRunId: runId,
      lines: result.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })),
    });
    const payload = { ...draft.payload, payrollRunId: runId, month: run.month, regime, mapStatus: result.mapStatus } as PayrollPostingProposal;
    ctx.audit({ runId, month: run.month, regime, accounts: result.lines.length, lines: stored.length });
    return { kind: JOURNAL_VOUCHER_KIND, command: PAYROLL_POSTING_COMMAND, title: `Hạch toán lương tháng ${monthLabel(run.month)}`, payload };
  },
});

export const hrPostingCommands = [prepareRunPosting];
