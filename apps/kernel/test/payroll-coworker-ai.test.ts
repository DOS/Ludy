// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on payroll, API side (#2534): the stored run is read through the audited queries, the model is told the pseudonymized sheet only (a planted name, the employer's
// name and an account never reach a request), a text with a figure it was not given or an alias that does not exist gives no text, and every state of `ai` is an answer, never an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, InboxReader } from '@crove/agent';
import type { HrLineView, HrPayslip, HrRunSheet, HrRunSummary } from '@crove/kernel-contract';
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

  it('names its state when the member is too fast or the AI budget is spent or the call fails, never throws, and lists the findings in each', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1 });
    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests) }, budget);
    expect((await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi')).ai).toBe('used');
    const busy = await flagMonth(ai, reads(), ORG, USER, 'nov', 'vi');
    expect(busy.ai).toBe('busy');
    expect(busy.items).toHaveLength(2);
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

  it('does not ask the model when nothing was found by code', async () => {
    const requests: string[] = [];
    const { ai } = setup({ flag: echoFlag(requests) });
    const calm: HrRunSheet = sheetOf('calm', '2026-08', [line(EMP_B, NAME_B, '8950000')]);
    const r: PayrollReads = { ...reads(), sheet: async () => calm, runs: async () => [summary('calm', '2026-08')] };
    expect(await flagMonth(ai, r, ORG, USER, 'calm', 'vi')).toEqual({ ai: 'quiet', items: [] });
    expect(requests).toEqual([]);
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
});
