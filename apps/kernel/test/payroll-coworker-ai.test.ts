// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on payroll, API side (#2534): the stored run is read through the audited queries, the model is told the pseudonymized sheet only (a planted name, the employer's
// name and an account never reach a request), a text with a figure it was not given or an alias that does not exist gives no text, and every state of `ai` is an answer, never an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, InboxReader } from '@ludy/agent';
import type { HrLineView, HrPayslip, HrRunSheet, HrRunSummary } from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { explainPayslip, flagMonth, payrollSource, prepareMonth, type PayrollAi, type PayrollReads } from '../src/payroll-coworker-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const ENTITY = '00000000-0000-7000-8000-000000000001';
const EMPLOYER = 'Công ty TNHH Thử Nghiệm Lương';
const NAME_A = 'Trần Thị Bích Ngọc';
const NAME_B = 'Lê Quang Vinh';
const SECRETS = [NAME_A, NAME_B, EMPLOYER, '079201012345', '8012345678', '0123456789012', '12 Phố Huế'];
const EMP_A = '00000000-0000-7000-8000-0000000000a1';
const EMP_B = '00000000-0000-7000-8000-0000000000b2';

const totals = { gross: '0', employeeInsurance: '0', employerInsurance: '0', unionFee: '0', taxableIncome: '0', pit: '0', net: '0', employerCost: '0' };
function line(employeeId: string, employeeName: string, net: string, flags: HrLineView['flags'] = [], overtime = '0'): HrLineView {
  return {
    id: `line-${employeeId}`,
    employeeId,
    employeeName,
    kind: 'pay',
    status: 'calculated',
    refusal: null,
    inputs: {},
    figures: { gross: '10000000', employeeInsurance: '1050000', employerInsurance: '2000000', unionFee: '0', taxableIncome: '0', pit: '0', net, employerCost: '12000000' },
    breakdown: {
      pay: { baseWage: '10000000', allowances: [{ label: `Phụ cấp ${employeeName} 079201012345`, paid: '0' }], otherRegularPay: '0', unpaidReduction: '0', overtime: overtime === '0' ? [] : [{ pay: overtime }], nightWork: null, bonus: '0' },
      insurance: { insurablePay: '10000000', bounds: [{ cap: '46800000' }] },
      tax: { dependentsCounted: 0 },
      deductions: { total: '0' },
    },
    checks: [],
    flags,
    note: null,
    adjustsMonth: null,
  };
}
const sheetOf = (id: string, month: string, lines: HrLineView[], blocking = 0): HrRunSheet => ({
  run: { id, legalEntityId: ENTITY, employerName: EMPLOYER, month, status: 'draft', workingDays: '26', approvedAt: null },
  lines,
  totals,
  rules: [],
  blocking: Array.from({ length: blocking }, (_, i) => ({ id: `r${i}`, kind: 'k', key: 'k', effectiveFrom: '2026-01-01', status: 'commentary' as const, cite: 'c', confidence: 'commentary' as const })),
  fingerprint: 'a'.repeat(64),
  approvable: false,
  obstacles: [],
});
const summary = (id: string, month: string): HrRunSummary => ({ id, legalEntityId: ENTITY, month, status: 'approved', workingDays: '26', lines: 2, refused: 0, totals, approvedAt: null });

const SHEETS: Record<string, HrRunSheet> = {
  nov: sheetOf('nov', '2026-11', [line(EMP_A, NAME_A, '12000000', ['new_hire'], '500000'), line(EMP_B, NAME_B, '8950000', [], '0')], 1),
  oct: sheetOf('oct', '2026-10', [line(EMP_A, NAME_A, '8000000', [], '400000'), line(EMP_B, NAME_B, '8950000')]),
  sep: sheetOf('sep', '2026-09', [line(EMP_A, NAME_A, '8000000', [], '300000')]),
};
const reads = (): PayrollReads => ({
  sheet: async (runId) => SHEETS[runId] as HrRunSheet,
  runs: async () => [summary('nov', '2026-11'), summary('oct', '2026-10'), summary('sep', '2026-09')],
  payslip: async (lineId): Promise<HrPayslip> => {
    const l = SHEETS.nov?.lines.find((x) => x.id === lineId) as HrLineView;
    return { lineId, runId: 'nov', month: '2026-11', status: 'draft', employerName: EMPLOYER, employeeName: l.employeeName, figures: l.figures as NonNullable<HrLineView['figures']>, breakdown: l.breakdown as Record<string, unknown>, inputs: {} };
  },
});

function setup(generators: NonNullable<ConstructorParameters<typeof InboxReader>[1]>['payroll'], budget = new DraftBudget()) {
  const reader = new InboxReader({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, { payroll: generators });
  const ai: PayrollAi = { reader, budget };
  return { ai };
}
const record = (requests: string[]) => (output: unknown) => async ({ system, prompt }: { system: string; prompt: string }) => {
  requests.push(`${system}\n${prompt}`);
  return { output: output as never, usage: { inputTokens: 1, outputTokens: 1 } };
};

afterEach(() => vi.restoreAllMocks());

describe('payrollSource', () => {
  it('builds the facts of the month from the stored run and the two months before, and carries no label a person typed', async () => {
    const source = await payrollSource(reads(), 'nov');
    const a = source.lines.find((l) => l.employeeId === EMP_A);
    expect(a).toMatchObject({ contract: { startsInMonth: true, endsInMonth: false }, overtimeMonthsInRow: 3, previous: { net: '8000000', overtime: '400000' }, figures: { net: '12000000', overtime: '500000' } });
    expect(source.lines.find((l) => l.employeeId === EMP_B)?.overtimeMonthsInRow).toBe(0);
    expect(source.blockingRules).toBe(1);
    expect(JSON.stringify(source.lines)).not.toContain('079201012345');
  });
});

// A stand-in model that answers every finding of the prompt with its own facts as the sentence (what a faithful model would write), so what comes back is decided by the checks and the aliases.
const FINDING = /^- ([AS]\d+) \(([a-z_]+)\): (.+)$/gmu;
const echoFlag = (requests: string[]) => async ({ system, prompt }: { system: string; prompt: string }) => {
  requests.push(`${system}\n${prompt}`);
  return { output: { items: [...prompt.matchAll(FINDING)].map((m) => ({ id: m[1] as string, sentence: m[3] as string })) } };
};
const echoPrepare = (requests: string[]) => async ({ system, prompt }: { system: string; prompt: string }) => {
  requests.push(`${system}\n${prompt}`);
  return { output: { items: [...prompt.matchAll(FINDING)].map((m) => ({ id: m[1] as string, field: 'none' as const, note: m[3] as string })) } };
};

describe('prepareMonth and flagMonth', () => {
  it('no request to the model holds a name, the employer or a planted identifier, and the names are put back by code in every finding', async () => {
    const requests: string[] = [];
    const { ai } = setup({ prepare: echoPrepare(requests), flag: echoFlag(requests) });
    const prepared = await prepareMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    const flagged = await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    expect(prepared.ai).toBe('used');
    expect(flagged.ai).toBe('used');
    const moved = flagged.items.find((i) => i.kind === 'pay_moved');
    expect(moved).toMatchObject({ employeeId: EMP_A });
    expect(moved?.facts).toContain(`${NAME_A}: thực nhận 12.000.000 đồng, tháng trước 8.000.000 đồng; tăng 50%`);
    expect(moved?.text).toContain(NAME_A);
    expect(flagged.items.find((i) => i.kind === 'rule_blocks')).toMatchObject({ employeeId: null, text: expect.any(String) });
    expect(prepared.items.map((i) => i.kind).sort()).toEqual(['new_hire', 'recurring_overtime']);
    expect(requests.length).toBe(2);
    for (const sent of requests) for (const secret of SECRETS) expect(sent).not.toContain(secret);
    // The model never saw a real id either: the aliases are drawn per request.
    for (const sent of requests) expect(sent).not.toContain(EMP_A);
  });

  it('with AI off every finding of code is listed with its facts and no sentence', async () => {
    const flagged = await flagMonth({ reader: null, budget: new DraftBudget() }, reads(), ORG, USER, 'nov', 'vi');
    expect(flagged.ai).toBe('off');
    expect(flagged.items.map((i) => i.kind)).toEqual(['pay_moved', 'rule_blocks']);
    expect(flagged.items.every((i) => i.text === null)).toBe(true);
    expect(flagged.items[0]?.facts).toContain(NAME_A);
    const prepared = await prepareMonth({ reader: null, budget: new DraftBudget() }, reads(), ORG, USER, 'nov', 'vi');
    expect(prepared.ai).toBe('off');
    expect(prepared.items.map((i) => i.kind)).toEqual(['new_hire', 'recurring_overtime']);
    expect(prepared.items.every((i) => i.text === null && i.field === null && i.employeeId === EMP_A)).toBe(true);
  });

  it('a model that states a figure it was not given, or an alias that does not exist, adds no sentence, and the findings stay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ai } = setup({
      prepare: async () => ({ output: { items: [{ id: 'S1', field: 'none', note: 'E9 bắt đầu làm việc.' }] } }),
      flag: async () => ({ output: { items: [{ id: 'A1', sentence: 'E1 nhận 99.000.000 đồng.' }] } }),
    });
    const prepared = await prepareMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    const flagged = await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    expect(prepared.ai).toBe('failed');
    expect(flagged.ai).toBe('failed');
    expect(prepared.items).toHaveLength(2);
    expect(flagged.items).toHaveLength(2);
    expect([...prepared.items, ...flagged.items].every((i) => i.text === null)).toBe(true);
  });

  it('when only one sentence passes, that finding has its text and the others still appear', async () => {
    const { ai } = setup({
      flag: async ({ prompt }) => {
        const first = [...prompt.matchAll(FINDING)].find((m) => m[2] === 'rule_blocks');
        return { output: { items: [{ id: first?.[1] as string, sentence: first?.[3] as string }, { id: 'A99', sentence: 'không có' }] } };
      },
    });
    const flagged = await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    expect(flagged.ai).toBe('used');
    expect(flagged.items.map((i) => [i.kind, i.text !== null])).toEqual([['pay_moved', false], ['rule_blocks', true]]);
  });

  it('names its state when the member is too fast or the AI budget is spent or the call fails, never throws, and triggers zero audited reads when rate-limited', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1 });
    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests), prepare: echoPrepare(requests) }, budget);
    expect((await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi')).ai).toBe('used');
    const spyReads: PayrollReads = {
      authorize: vi.fn(async () => ({ ok: true })),
      sheet: vi.fn(reads().sheet),
      runs: vi.fn(reads().runs),
      payslip: vi.fn(reads().payslip),
    };
    const busyFlag = await flagMonth(ai, spyReads, ORG, USER, 'nov', 'vi');
    expect(busyFlag).toEqual({ ai: 'busy', items: [] });
    const busyPrepare = await prepareMonth(ai, spyReads, ORG, USER, 'nov', 'vi');
    expect(busyPrepare).toEqual({ ai: 'busy', items: [] });
    expect(spyReads.authorize).toHaveBeenCalledTimes(2);
    expect(spyReads.sheet).not.toHaveBeenCalled();
    expect(spyReads.runs).not.toHaveBeenCalled();
    expect(spyReads.payslip).not.toHaveBeenCalled();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spent = setup({
      flag: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
    });
    const noBudget = await flagMonth(spent.ai, reads(), ORG, USER, 'nov', 'vi');
    expect(noBudget.ai).toBe('budget');
    expect(noBudget.items).toHaveLength(2);
    const broken = setup({
      flag: async () => {
        throw new Error('boom');
      },
    });
    const failed = await flagMonth(broken.ai, reads(), ORG, USER, 'nov', 'vi');
    expect(failed.ai).toBe('failed');
    expect(failed.items).toHaveLength(2);
  });

  it('checks caller authorization before taking a rate ticket, so a forbidden member neither reads sensitive data nor burns org tickets', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const requests: string[] = [];
    const { ai } = setup({ prepare: echoPrepare(requests), flag: echoFlag(requests) }, budget);
    const forbiddenReads: PayrollReads = {
      authorize: vi.fn(async () => {
        throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ hoặc quản trị viên mới thực hiện được việc này');
      }),
      sheet: vi.fn(reads().sheet),
      runs: vi.fn(reads().runs),
      payslip: vi.fn(reads().payslip),
    };
    await expect(prepareMonth(ai, forbiddenReads, ORG, 'member-1', 'nov', 'vi')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(flagMonth(ai, forbiddenReads, ORG, 'member-1', 'nov', 'vi')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(forbiddenReads.sheet).not.toHaveBeenCalled();
    expect(forbiddenReads.runs).not.toHaveBeenCalled();
    // The org's single rate ticket is still intact for the authorized owner.
    expect((await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi')).ai).toBe('used');
  });

  it('does not ask the model or consume a rate ticket when nothing was found by code (QUIET)', async () => {
    const requests: string[] = [];
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const { ai } = setup({ prepare: echoPrepare(requests), flag: echoFlag(requests) }, budget);
    const calm: HrRunSheet = sheetOf('calm', '2026-08', [line(EMP_B, NAME_B, '8950000')]);
    const r: PayrollReads = { ...reads(), sheet: async (id) => (id === 'calm' ? calm : (SHEETS[id] as HrRunSheet)), runs: async () => [summary('calm', '2026-08'), summary('nov', '2026-11'), summary('oct', '2026-10'), summary('sep', '2026-09')] };
    expect(await prepareMonth(ai, r, ORG, USER, 'calm', 'vi')).toEqual({ ai: 'quiet', items: [] });
    expect(await flagMonth(ai, r, ORG, USER, 'calm', 'vi')).toEqual({ ai: 'quiet', items: [] });
    expect(requests).toEqual([]);
    // Neither QUIET call consumed the 1/minute budget: an immediate non-quiet call still gets `used`.
    expect((await flagMonth(ai, r, ORG, USER, 'nov', 'vi')).ai).toBe('used');
    expect(requests).toHaveLength(1);
  });

  it('scopes reads.runs to the target run legalEntityId and allows concurrent prepareMonth + flagMonth with separate budgets', async () => {
    const otherEntity = '00000000-0000-7000-8000-000000000099';
    const seenEntities: string[] = [];
    const multiEntityReads: PayrollReads = {
      ...reads(),
      runs: async (legalEntityId) => {
        seenEntities.push(legalEntityId);
        // Simulate 120 other-entity runs hiding ENTITY's prior months unless filtered by legalEntityId.
        if (legalEntityId !== ENTITY) {
          return Array.from({ length: 120 }, (_, i) => ({ ...summary(`other-${i}`, '2026-11'), legalEntityId: otherEntity }));
        }
        return [summary('nov', '2026-11'), summary('oct', '2026-10'), summary('sep', '2026-09')];
      },
    };
    const requests: string[] = [];
    const reader = new InboxReader({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, { payroll: { prepare: echoPrepare(requests), flag: echoFlag(requests) } });
    const ai: PayrollAi = {
      reader,
      budget: new DraftBudget({ perUserPerMinute: 1 }),
      prepareBudget: new DraftBudget({ perUserPerMinute: 1 }),
      flagBudget: new DraftBudget({ perUserPerMinute: 1 }),
    };
    const [prepared, flagged] = await Promise.all([
      prepareMonth(ai, multiEntityReads, ORG, USER, 'nov', 'vi'),
      flagMonth(ai, multiEntityReads, ORG, USER, 'nov', 'vi'),
    ]);
    expect(seenEntities).toEqual([ENTITY, ENTITY]);
    expect(prepared.ai).toBe('used');
    expect(flagged.ai).toBe('used');
    expect(flagged.items.some((i) => i.kind === 'pay_moved')).toBe(true);
    expect(prepared.items.some((i) => i.kind === 'recurring_overtime')).toBe(true);
  });

  it('surfaces overtime_cap check failures as overtime_over_cap anomalies with AI off and AI on, without leaking names', async () => {
    const otLine: HrLineView = {
      ...line(EMP_B, NAME_B, '10450000', ['check_overtime_cap'], '1500000'),
      checks: [{ id: 'overtime_cap', ok: false, actual: '45', limit: '40' }],
    };
    const otSheet: HrRunSheet = sheetOf('ot', '2026-08', [otLine]);
    const r: PayrollReads = { ...reads(), sheet: async () => otSheet, runs: async () => [summary('ot', '2026-08')] };

    const off = await flagMonth({ reader: null, budget: new DraftBudget() }, r, ORG, USER, 'ot', 'vi');
    expect(off.ai).toBe('off');
    expect(off.items).toHaveLength(1);
    expect(off.items[0]?.kind).toBe('overtime_over_cap');
    expect(off.items[0]?.facts).toContain(NAME_B);
    expect(off.items[0]?.facts).toContain('40');
    expect(off.items[0]?.text).toBeNull();

    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests) });
    const on = await flagMonth(ai, r, ORG, USER, 'ot', 'vi');
    expect(on.ai).toBe('used');
    expect(on.items[0]?.kind).toBe('overtime_over_cap');
    expect(on.items[0]?.text).toContain(NAME_B);
    for (const secret of SECRETS) expect(requests[0]).not.toContain(secret);
  });

  it('surfaces annual_leave_exceeded as a deterministic anomaly when AI is off and on without leaking PII', async () => {
    const leaveLine: HrLineView = {
      ...line(EMP_B, NAME_B, '8950000', ['annual_leave_exceeded']),
      exceededAnnualDays: '2',
    };
    const leaveSheet: HrRunSheet = sheetOf('lv', '2026-11', [leaveLine]);
    const r: PayrollReads = { ...reads(), sheet: async () => leaveSheet, runs: async () => [summary('lv', '2026-11')] };

    const off = await flagMonth({ reader: null, budget: new DraftBudget() }, r, ORG, USER, 'lv', 'vi');
    expect(off.ai).toBe('off');
    expect(off.items).toHaveLength(1);
    expect(off.items[0]?.kind).toBe('annual_leave_exceeded');
    expect(off.items[0]?.facts).toContain(NAME_B);
    expect(off.items[0]?.facts).toContain('2');
    expect(off.items[0]?.text).toBeNull();

    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests) });
    const on = await flagMonth(ai, r, ORG, USER, 'lv', 'vi');
    expect(on.ai).toBe('used');
    expect(on.items[0]?.kind).toBe('annual_leave_exceeded');
    expect(on.items[0]?.text).toContain(NAME_B);
    for (const secret of SECRETS) expect(requests[0]).not.toContain(secret);
    expect(requests[0]).not.toMatch(/2026-\d{2}/);
  });

  it('surfaces severance_check flag as a deterministic prepare signal in vi and en without leaking names or dates', async () => {
    const sevLine = line(EMP_B, NAME_B, '8950000', ['ends_this_month', 'severance_check']);
    const sevSheet: HrRunSheet = sheetOf('sev', '2026-11', [sevLine]);
    const r: PayrollReads = { ...reads(), sheet: async () => sevSheet, runs: async () => [summary('sev', '2026-11')] };

    const offVi = await prepareMonth({ reader: null, budget: new DraftBudget() }, r, ORG, USER, 'sev', 'vi');
    expect(offVi.ai).toBe('off');
    expect(offVi.items.map((i) => i.kind)).toEqual(['contract_ends', 'severance_check']);
    expect(offVi.items[1]?.facts).toContain(NAME_B);
    expect(offVi.items[1]?.facts).toContain('12');
    expect(offVi.items[1]?.text).toBeNull();

    const offEn = await prepareMonth({ reader: null, budget: new DraftBudget() }, r, ORG, USER, 'sev', 'en');
    expect(offEn.ai).toBe('off');
    expect(offEn.items.map((i) => i.kind)).toEqual(['contract_ends', 'severance_check']);
    expect(offEn.items[1]?.facts).toContain(NAME_B);
    expect(offEn.items[1]?.facts).toContain('12');

    const requests: string[] = [];
    const { ai } = setup({ prepare: echoPrepare(requests) });
    const on = await prepareMonth(ai, r, ORG, USER, 'sev', 'vi');
    expect(on.ai).toBe('used');
    expect(on.items.find((i) => i.kind === 'severance_check')?.text).toContain(NAME_B);
    for (const secret of SECRETS) expect(requests[0]).not.toContain(secret);
    expect(requests[0]).not.toMatch(/2026-\d{2}/);
  });

  it('surfaces probation_ends_this_month flag as probationEndsInMonth and probation_ends signal without leaking names or dates', async () => {
    const probLine = line(EMP_B, NAME_B, '8950000', ['probation_ends_this_month']);
    const probSheet: HrRunSheet = sheetOf('prob', '2026-11', [probLine]);
    const r: PayrollReads = { ...reads(), sheet: async () => probSheet, runs: async () => [summary('prob', '2026-11')] };

    const src = await payrollSource(r, 'prob');
    expect(src.lines[0]?.contract.probationEndsInMonth).toBe(true);

    const offVi = await prepareMonth({ reader: null, budget: new DraftBudget() }, r, ORG, USER, 'prob', 'vi');
    expect(offVi.ai).toBe('off');
    expect(offVi.items.map((i) => i.kind)).toEqual(['probation_ends']);
    expect(offVi.items[0]?.facts).toContain(NAME_B);
    expect(offVi.items[0]?.text).toBeNull();

    const requests: string[] = [];
    const { ai } = setup({ prepare: echoPrepare(requests) });
    const on = await prepareMonth(ai, r, ORG, USER, 'prob', 'en');
    expect(on.ai).toBe('used');
    expect(on.items.map((i) => i.kind)).toEqual(['probation_ends']);
    expect(on.items[0]?.text).toContain(NAME_B);
    for (const secret of SECRETS) expect(requests[0]).not.toContain(secret);
    expect(requests[0]).not.toMatch(/2026-\d{2}/);
  });

  it('still lists the findings when the run has more people than one prompt holds, with no model call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests) });
    const many = Array.from({ length: 201 }, (_, i) => line(`00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, `Người ${i}`, '8950000', i === 0 ? ['ends_this_month', 'net_below_minimum'] : []));
    const big: HrRunSheet = sheetOf('big', '2026-08', many);
    const r: PayrollReads = { ...reads(), sheet: async () => big, runs: async () => [summary('big', '2026-08')] };
    const flagged = await flagMonth(ai, r, ORG, USER, 'big', 'vi');
    expect(flagged.ai).toBe('failed');
    expect(flagged.items.map((i) => i.kind)).toEqual(['net_below_minimum']);
    expect(requests).toEqual([]);
  });
});

describe('explainPayslip', () => {
  it('explains from the stored components with no name in the request, and refuses a figure it was not given', async () => {
    const requests: string[] = [];
    const { ai } = setup({ explain: record(requests)({ text: 'Tổng thu nhập 10.000.000 đồng, trừ bảo hiểm 1.050.000 đồng nên thực nhận 8.950.000 đồng.' }) });
    const r = reads();
    const said = await explainPayslip(ai, r, ORG, USER, `line-${EMP_B}`, 'vi');
    expect(said).toMatchObject({ ai: 'used' });
    for (const secret of SECRETS) expect(requests[0]).not.toContain(secret);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = setup({ explain: record(requests)({ text: 'Thực nhận 9.000.000 đồng.' }) });
    expect(await explainPayslip(bad.ai, r, ORG, USER, `line-${EMP_B}`, 'vi')).toEqual({ ai: 'failed', text: null });
  });

  it('calls reads.payslip for RBAC and audit even when AI is off, and propagates refusal errors', async () => {
    const offAi: PayrollAi = { reader: null, budget: new DraftBudget() };
    const baseReads = reads();
    const payslipSpy = vi.fn(baseReads.payslip);
    const authorizedReads: PayrollReads = { ...baseReads, payslip: payslipSpy };

    const lineId = `line-${EMP_B}`;
    expect(await explainPayslip(offAi, authorizedReads, ORG, USER, lineId, 'vi')).toEqual({ ai: 'off', text: null });
    expect(payslipSpy).toHaveBeenCalledTimes(1);
    expect(payslipSpy).toHaveBeenCalledWith(lineId);

    const forbiddenReads: PayrollReads = {
      ...baseReads,
      payslip: vi.fn(async () => {
        throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ hoặc quản trị viên mới xem được phiếu lương');
      }),
    };
    await expect(explainPayslip(offAi, forbiddenReads, ORG, USER, lineId, 'vi')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    // When AI is on, a rate-limited caller gets `busy` before `reads.payslip` is called, and a forbidden caller fails before spending the rate ticket.
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const { ai } = setup({ explain: async () => ({ output: { text: 'Tổng thu nhập 10.000.000 đồng, trừ bảo hiểm 1.050.000 đồng nên thực nhận 8.950.000 đồng.' } }) }, budget);
    const gatedForbidden: PayrollReads = {
      ...baseReads,
      authorize: vi.fn(async () => {
        throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ hoặc quản trị viên mới xem được phiếu lương');
      }),
      payslip: vi.fn(baseReads.payslip),
    };
    await expect(explainPayslip(ai, gatedForbidden, ORG, 'member-1', lineId, 'vi')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(gatedForbidden.payslip).not.toHaveBeenCalled();

    const trackedReads: PayrollReads = { ...baseReads, payslip: vi.fn(baseReads.payslip) };
    expect((await explainPayslip(ai, trackedReads, ORG, USER, lineId, 'vi')).ai).toBe('used');
    expect(trackedReads.payslip).toHaveBeenCalledTimes(1);
    expect(await explainPayslip(ai, trackedReads, ORG, USER, lineId, 'vi')).toEqual({ ai: 'busy', text: null });
    expect(trackedReads.payslip).toHaveBeenCalledTimes(1);
  });
});
