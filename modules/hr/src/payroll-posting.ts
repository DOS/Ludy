// SPDX-License-Identifier: AGPL-3.0-only
// The posting proposal of an approved pay run (issue #2532; payroll plan docs/plan/payroll.md section 6.4 and row 18, ADR-0046). `hr.payroll.posting.prepare` is the preparer of
// kernel.proposal.request for `finance.payroll_posting.record` (the finance proposal path): it reads the frozen run in the requester's context (owners and admins only, the people tables
// are never read as the system actor or the worker), builds the entry from stored figures with the account map of the entity's chart (@crove/l10n-vn, every row of it still `commentary`
// until the accountant confirms row 18, #2535), checks it as a general journal voucher through finance's own check (`finance.payroll_posting.check`, regime-aware), and returns the draft. It writes nothing. A person approves the
// proposal; nothing here posts. The lines are one per account, never per person: the detail stays on the run, and Kế toán approves from the totals by account.
//
// No model call is made: everything here is deterministic over stored facts, and the posting works with AI off.
import { PAYROLL_REGIMES, PAYROLL_POSTING_COMMAND, zHrPostingRequest, JOURNAL_VOUCHER_KIND, type PayrollPostingProposal } from '@crove/kernel-contract';
import { PAY_FUNCTIONS, PAYROLL_POSTING_MAPS, PostingRefusedError, buildPosting, money, toMoney, type PayFunction, type PayrollRegime, type PostingLine } from '@crove/l10n-vn';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const FUNDS = ['retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment'] as const;

const monthEnd = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};
export const monthLabel = (month: string): string => `${month.slice(5)}/${month.slice(0, 4)}`;
const incompleteAdjustment = () =>
  new DomainError('HR_POSTING_ADJUSTMENTS', 422, 'Bảng lương có dòng điều chỉnh làm trước khi ghi nhận bộ phận và các quỹ bảo hiểm nên chưa hạch toán được tháng này');
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

export interface BuiltPosting {
  payrollRun: { id: string; legal_entity_id: string; month: string; approved_by: string | null };
  date: string;
  regime: PayrollRegime;
  result: ReturnType<typeof buildPosting>;
  lines: number;
  // How many correction lines the run carries: the payment of such a run is not offered yet (the next change), so the payment commands refuse it.
  adjustments: number;
  // The net pay of each frozen pay line, in whole dong and in no order: what the payment of the net pay counts against the cash limit, without a name or a line id. A correction is a difference, not a
  // person's pay, so it is not counted here (the database counts the same lines in `cashLarge`).
  nets: string[];
}

// What both builds share once the lines are summed: the chart of the entity on the last day of the month (finance alone reads its books; TT133 when none is on record), the account-map gate,
// the entry, and the check that it equals the run's totals as approved, so what the approver saw is what posts.
async function finishPosting(
  ctx: CommandContext,
  run: { legal_entity_id: string; month: string; approval: unknown },
  lines: readonly PostingLine[],
  hasAdjustments: boolean,
): Promise<{ date: string; regime: PayrollRegime; result: ReturnType<typeof buildPosting> }> {
  // The chart of the entity on the last day of the month: finance alone reads its books (TT133 when none is on record).
  const date = monthEnd(run.month);
  const regime = (await ctx.run<{ regime: PayrollRegime }>('finance.payroll_posting.regime', { legalEntityId: run.legal_entity_id, date })).regime;
  if (!(PAYROLL_REGIMES as readonly string[]).includes(regime)) throw mismatch('chế độ kế toán');
  // The gate of the pay run's approval, for the account map: while the accountant has not confirmed the map of this chart (#2535), nothing is posted (finance's record command holds the same gate).
  if (PAYROLL_POSTING_MAPS[regime].status !== 'confirmed') {
    throw new DomainError('HR_POSTING_MAP_UNCONFIRMED', 409, 'Bảng tài khoản hạch toán lương của chế độ kế toán này chưa được kế toán xác nhận; chưa hạch toán được', { regime });
  }
  // A month that carries a correction of an earlier one also waits for the accountant's rule on how a correction is booked (the period and the sign): row 18 of the plan.
  if (hasAdjustments && PAYROLL_POSTING_MAPS[regime].adjustments.status !== 'confirmed') {
    throw new DomainError('HR_POSTING_MAP_UNCONFIRMED', 409, 'Quy tắc hạch toán dòng điều chỉnh của bảng lương này chưa được kế toán xác nhận; chưa hạch toán được', { regime, rule: 'adjustments' });
  }

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
  return { date, regime, result };
}

// The entry of an approved pay run, built from its frozen lines in the caller's context: the same build the proposal rests on and the posting is checked against (hr.payroll.posting.verify),
// so what is requested and what is recorded are one fact. `lock` holds the run's row to the end of the request, so two requests for the same run take turns.
export async function buildRunPosting(ctx: CommandContext, runId: string, lock: boolean): Promise<BuiltPosting> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  let query = ctx.trx
    .selectFrom('crove_hr.payroll_run')
    .select(['id', 'legal_entity_id', 'month', 'status', 'approval', 'approved_by'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', runId);
  if (lock) query = query.forUpdate();
  const run = await query.executeTakeFirst();
  if (!run) throw new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
  if (run.status !== 'approved') throw new DomainError('HR_RUN_NOT_APPROVED', 409, 'Chỉ bảng lương đã được duyệt mới hạch toán được');
  const stored = await ctx.trx
    .selectFrom('crove_hr.payroll_line')
    .select(['employee_id', 'employment_id', 'kind', 'status', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'pit', 'net', 'breakdown'])
    .where('org_id', '=', ctx.orgId)
    .where('run_id', '=', runId)
    .execute();
  if (stored.length === 0) throw mismatch('bảng lương không có dòng nào');
  // A correction of an approved month is posted with the pay lines, in this run's period, from the cost department it copied and the split of its insurance across the funds. One made before it held
  // those (no terms, no split) cannot be posted: it is corrected again, so the entry never guesses.
  if (stored.some((l) => l.kind !== 'pay' && (l.employment_id === null || !Array.isArray((l.breakdown as { insurance?: { funds?: unknown } } | null)?.insurance?.funds)))) throw incompleteAdjustment();
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
    // A line without its employment, or one whose employment is gone, has no cost department on record: the entry never falls back to one.
    const payFunction = l.employment_id ? functionOf.get(l.employment_id) : undefined;
    if (payFunction === undefined || !(PAY_FUNCTIONS as readonly string[]).includes(payFunction)) throw mismatch('bộ phận hạch toán');
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

  const { date, regime, result } = await finishPosting(ctx, run, lines, stored.some((l) => l.kind !== 'pay'));
  return { payrollRun: run, date, regime, result, lines: stored.length, adjustments: stored.filter((l) => l.kind !== 'pay').length, nets: stored.filter((l) => l.kind === 'pay').map((l) => String(l.net)) };
}

// The same entry rebuilt from the run's totals by cost department (crove_hr.payroll_run_totals), never from a person's line: what the verification of a posting or of a payment reads, so
// whoever may approve it (an owner, an admin, or a member holding finance.proposal.approve) can check it, and nothing per person is read or returned (#2751). The function checks the caller
// itself; a run it does not show is a run not found. It refuses what cannot be summed (an adjustment line, a line not calculated, one without its cost department or its per-fund split).
export interface BuiltTotals {
  payrollRun: { id: string; legal_entity_id: string; month: string; approved_by: string | null };
  date: string;
  regime: PayrollRegime;
  result: ReturnType<typeof buildPosting>;
  // How many people's net pay is at the cash limit or above: a number only.
  cashLarge: number;
  // How many correction lines the run carries (a count, never a line): see BuiltPosting.
  adjustments: number;
}
interface StoredGroup {
  payFunction: string;
  gross: string;
  unionFee: string;
  pit: string;
  net: string;
  advance: string;
  otherDeductions: string;
  funds: { fund: StoredFund['fund']; employee: string; employer: string }[];
  employeeInsurance: string;
  employerInsurance: string;
}
export async function buildRunPostingFromTotals(ctx: CommandContext, runId: string): Promise<BuiltTotals> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  const { rows } = await sql<{ totals: unknown }>`SELECT crove_hr.payroll_run_totals(${runId}::uuid) AS totals`.execute(ctx.trx);
  const t = rows[0]?.totals as
    | { runId: string; legalEntityId: string; month: string; status: string; approvedBy: string | null; approvalTotals: unknown; counts: Record<string, number>; groups: StoredGroup[] }
    | null
    | undefined;
  if (!t) throw new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
  if (t.status !== 'approved') throw new DomainError('HR_RUN_NOT_APPROVED', 409, 'Chỉ bảng lương đã được duyệt mới hạch toán được');
  const c = t.counts;
  if ((c.lines ?? 0) === 0) throw mismatch('bảng lương không có dòng nào');
  if ((c.adjustmentsIncomplete ?? 0) > 0) throw incompleteAdjustment();
  if ((c.notCalculated ?? 0) > 0) throw mismatch('dòng chưa tính');
  if ((c.noFunction ?? 0) > 0) throw mismatch('bộ phận hạch toán');
  if ((c.noFunds ?? 0) > 0) throw mismatch('thiếu chi tiết bảo hiểm');
  if ((c.noDeductions ?? 0) > 0) throw mismatch('thiếu các khoản khấu trừ');
  // The per-line identities that the sums cannot show (two lines wrong by opposite amounts cancel in a department's total): the database counts the lines that break them, and a run with any is refused.
  if ((c.badLines ?? 0) > 0) throw mismatch('toàn vẹn dòng lương');
  const lines: PostingLine[] = t.groups.map((g) => {
    if (!(PAY_FUNCTIONS as readonly string[]).includes(g.payFunction)) throw mismatch('bộ phận hạch toán');
    if (g.funds.some((f) => !(FUNDS as readonly string[]).includes(f.fund))) throw mismatch('quỹ bảo hiểm');
    // The per-fund sums must add to the insurance the lines carry: the entry rests on one fact, not two.
    const employee = g.funds.reduce((acc, f) => acc.plus(f.employee), money(0));
    const employer = g.funds.reduce((acc, f) => acc.plus(f.employer), money(0));
    if (!employee.equals(money(g.employeeInsurance)) || !employer.equals(money(g.employerInsurance))) throw mismatch('bảo hiểm');
    return {
      payFunction: g.payFunction as PayFunction,
      gross: g.gross,
      funds: g.funds,
      unionFee: g.unionFee,
      pit: g.pit,
      advance: g.advance,
      otherDeductions: g.otherDeductions,
      net: g.net,
    };
  });
  const run = { id: t.runId, legal_entity_id: t.legalEntityId, month: t.month, approved_by: t.approvedBy, approval: { totals: t.approvalTotals } };
  const { date, regime, result } = await finishPosting(ctx, run, lines, (c.adjustments ?? 0) > 0);
  return { payrollRun: { id: run.id, legal_entity_id: run.legal_entity_id, month: run.month, approved_by: run.approved_by }, date, regime, result, cashLarge: c.cashLarge ?? 0, adjustments: c.adjustments ?? 0 };
}

export const prepareRunPosting = defineCommand({
  name: 'hr.payroll.posting.prepare',
  input: zHrPostingRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, { runId }) => {
    // The run's row is held to the end of the request, so two requests for the same run take turns: the second sees the proposal the first made and is refused below.
    const built = await buildRunPosting(ctx, runId, true);
    const { payrollRun, date, regime, result } = built;
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

    // The entry is checked as a general journal voucher by finance's own check (its accounts in the entity's chart of that regime, the month not closed), which also resolves the entity.
    const description = `Hạch toán lương tháng ${monthLabel(payrollRun.month)}`;
    const draft = await ctx.run<{ payload: Record<string, unknown> }>('finance.payroll_posting.check', {
      date,
      description,
      legalEntityId: payrollRun.legal_entity_id,
      regime,
      payrollRunId: runId,
      lines: result.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })),
    });
    const payload = { ...draft.payload, payrollRunId: runId, month: payrollRun.month, regime, mapStatus: result.mapStatus } as PayrollPostingProposal;
    ctx.audit({ runId, month: payrollRun.month, regime, accounts: result.lines.length, lines: built.lines });
    // The person who approved and froze the run's figures is a co-author of its posting (four-eyes, #2736): they do not approve it while another eligible approver exists.
    return { kind: JOURNAL_VOUCHER_KIND, command: PAYROLL_POSTING_COMMAND, title: `Hạch toán lương tháng ${monthLabel(payrollRun.month)}`, payload, ...(payrollRun.approved_by ? { coAuthors: [payrollRun.approved_by] } : {}) };
  },
});

// What finance's record command compares the stored proposal with (ctx.run, in the approver's context): the entry rebuilt from the frozen run now, so a proposal row written some other way
// than by the preparer (raw SQL) cannot post lines the run does not hold. It writes nothing and reads only what the preparer reads.
export const verifyRunPosting = defineCommand({
  name: 'hr.payroll.posting.verify',
  input: zHrPostingRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  // Whoever may approve the posting reads its totals by cost department (an owner, an admin, or a member holding the approval permission; #2751): never a person's line.
  permission: 'finance.proposal.approve',
  writes: [],
  handler: async (ctx, { runId }) => {
    const { payrollRun, date, regime, result } = await buildRunPostingFromTotals(ctx, runId);
    return {
      runId,
      month: payrollRun.month,
      date,
      regime,
      // The run's entity and the person who approved it: the posting must name this entity, and its proposal must list this person as a co-author (finance's record checks both).
      legalEntityId: payrollRun.legal_entity_id,
      approvedBy: payrollRun.approved_by,
      lines: result.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })),
    };
  },
});

export const hrPostingCommands = [prepareRunPosting, verifyRunPosting];
