// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's part of payroll (#2534): the model is told the pseudonymized sheet only, and a text it writes is dropped when it states a figure it was not given or names an alias
// that is not the item's. The generators are stand-ins, so nothing here reaches a model.
import { describe, expect, it } from 'vitest';
import {
  PayrollCoworker,
  PayrollPromptLeakError,
  checkExplanation,
  checkFlagSentences,
  checkPrepareProposals,
  dependentsCountedOf,
  explainFactsText,
  findAnomalies,
  findSignals,
  payrollFiguresOf,
  promptLeaks,
  pseudonymizeSheet,
  restoreAliases,
  type PayrollFigures,
  type PayrollSheetLine,
} from '../src/index.ts';

const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const zero = (): PayrollFigures => ({ base_wage: '0', allowances: '0', other_regular_pay: '0', overtime: '0', night_work: '0', bonus: '0', unpaid_reduction: '0', gross: '0', employee_insurance: '0', pit: '0', deductions: '0', net: '0' });
const figures = (over: Partial<PayrollFigures>): PayrollFigures => ({ ...zero(), ...over });
const quiet = { minimumWageFailed: false, deductionCapFailed: false, netBelowMinimum: false, insuredAboveCap: false, cashPaymentOverLimit: false };
const calm = { startsInMonth: false, probationEndsInMonth: false, endsInMonth: false };

// Values that must never reach a model, planted wherever a careless caller could put them.
const PLANTED = ['Nguyễn Văn Thử', 'Nguyen Van Thu', '079201012345', '8012345678-001', '0123456789012', '12 Phố Huế, Hà Nội', 'VCB 1234 5678 9012'];

function line(id: string, over: Partial<PayrollSheetLine> = {}): PayrollSheetLine {
  return {
    employeeId: id,
    figures: figures({ base_wage: '10000000', gross: '10000000', employee_insurance: '1050000', pit: '0', net: '8950000' }),
    previous: figures({ base_wage: '10000000', gross: '10000000', employee_insurance: '1050000', pit: '0', net: '8950000' }),
    contract: calm,
    overtimeMonthsInRow: 0,
    dependentsWithoutRegistration: 0,
    checks: quiet,
    ...over,
  };
}

// A line that carries planted identifiers in fields it should not have, as a careless caller could pass them.
const tainted = (id: string, over: Partial<PayrollSheetLine> = {}): PayrollSheetLine =>
  ({ ...line(id, over), name: PLANTED[0], displayName: PLANTED[1], nationalId: PLANTED[2], taxCode: PLANTED[3], bankAccount: PLANTED[4], address: PLANTED[5], note: PLANTED[6] }) as PayrollSheetLine;

describe('pseudonymizeSheet', () => {
  it('gives an alias per person in the order of the ids, keeps the mapping aside and copies only the named fields', () => {
    const { sheet, aliases } = pseudonymizeSheet([tainted('b-2'), tainted('a-1')], { language: 'vi', blockingRules: 0 });
    expect(sheet.lines.map((l) => l.alias)).toEqual(['E1', 'E2']);
    expect([...aliases]).toEqual([['E1', 'a-1'], ['E2', 'b-2']]);
    const json = JSON.stringify(sheet);
    for (const secret of PLANTED) expect(json).not.toContain(secret);
    expect(json).not.toContain('a-1');
  });
});

describe('promptLeaks', () => {
  it('finds a name without its accents, an identity number with separators, and ignores a one-letter value', () => {
    expect(promptLeaks('E1 và nguyen van thu', ['Nguyễn Văn Thử'])).toEqual(['Nguyễn Văn Thử']);
    expect(promptLeaks('so 0792 0101 2345', ['079201012345'])).toEqual(['079201012345']);
    expect(promptLeaks('E1 gets a bonus', ['a'])).toEqual([]);
  });
});

describe('findAnomalies', () => {
  it('finds each anomaly of the plan from stored facts, in a fixed order, with the figures as the sentence must write them', () => {
    const { sheet } = pseudonymizeSheet(
      [
        line('1', { figures: figures({ net: '12000000', gross: '13000000' }), previous: figures({ net: '8000000' }) }),
        line('2', { previous: null, checks: { ...quiet, netBelowMinimum: true }, figures: figures({ net: '3000000' }) }),
        line('3', { previous: null, checks: { ...quiet, deductionCapFailed: true }, figures: figures({ deductions: '4000000' }) }),
        line('4', { previous: null, dependentsWithoutRegistration: 2 }),
        line('5', { previous: null, checks: { ...quiet, insuredAboveCap: true } }),
        line('6', { previous: null, checks: { ...quiet, cashPaymentOverLimit: true }, figures: figures({ net: '6500000' }) }),
      ],
      { language: 'vi', blockingRules: 2 },
    );
    const anomalies = findAnomalies(sheet);
    expect(anomalies.map((a) => a.kind)).toEqual(['pay_moved', 'net_below_minimum', 'deduction_over_cap', 'dependent_unregistered', 'insured_above_cap', 'cash_payment_over_limit', 'rule_blocks']);
    expect(anomalies[0]?.facts).toBe('E1: thực nhận 12.000.000 đồng, tháng trước 8.000.000 đồng; tăng 50%');
    expect(anomalies[6]?.alias).toBeNull();
    expect(anomalies.map((a) => a.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
  });

  it('finds nothing in a month that did not move by more than the threshold', () => {
    const { sheet } = pseudonymizeSheet([line('1', { figures: figures({ net: '9000000' }), previous: figures({ net: '8000000' }) })], { language: 'en', blockingRules: 0 });
    expect(findAnomalies(sheet)).toEqual([]);
  });
});

describe('findSignals', () => {
  it('finds a hire, a probation and a contract ending, recurring overtime and a changed regular component', () => {
    const { sheet } = pseudonymizeSheet(
      [
        line('1', { previous: null, contract: { startsInMonth: true, probationEndsInMonth: false, endsInMonth: false } }),
        line('2', { previous: null, contract: { startsInMonth: false, probationEndsInMonth: true, endsInMonth: true } }),
        line('3', { previous: null, overtimeMonthsInRow: 3, figures: figures({ overtime: '1200000' }) }),
        line('4', { figures: figures({ allowances: '700000' }), previous: figures({ allowances: '500000' }) }),
      ],
      { language: 'en', blockingRules: 0 },
    );
    const signals = findSignals(sheet);
    expect(signals.map((s) => [s.alias, s.kind])).toEqual([['E1', 'new_hire'], ['E2', 'probation_ends'], ['E2', 'contract_ends'], ['E3', 'recurring_overtime'], ['E4', 'component_changed']]);
    expect(signals[4]?.facts).toBe('E4: Allowances 700,000 dong, last month 500,000 dong');
  });
});

describe('checkFlagSentences', () => {
  const { sheet } = pseudonymizeSheet([line('1', { figures: figures({ net: '12000000' }), previous: figures({ net: '8000000' }) }), line('2', { dependentsWithoutRegistration: 2 })], { language: 'vi', blockingRules: 0 });
  const anomalies = findAnomalies(sheet);

  it('keeps a sentence that uses only the given figures and its own alias', () => {
    const r = checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E1 nhận 12.000.000 đồng, tăng 50% so với 8.000.000 đồng tháng trước.' }] });
    expect(r).toMatchObject({ kind: 'flags', refused: 0, items: [{ id: 'A1', alias: 'E1' }] });
  });

  it('gives no text for a figure the input does not hold', () => {
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E1 nhận 13.000.000 đồng, tăng 50%.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E1 nhận 12 triệu đồng.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E1 nhận mười hai triệu đồng.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
  });

  it('gives no text for an alias that does not exist or belongs to another item, and drops an unknown or repeated id', () => {
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E9 nhận 12.000.000 đồng.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A1', sentence: 'E2 nhận 12.000.000 đồng.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    const r = checkFlagSentences(anomalies, {
      items: [
        { id: 'A7', sentence: 'Không có.' },
        { id: 'A2', sentence: 'E2 có 2 người phụ thuộc chưa đăng ký.' },
        { id: 'A2', sentence: 'E2 có 2 người phụ thuộc chưa đăng ký.' },
      ],
    });
    expect(r).toMatchObject({ kind: 'flags', refused: 2, items: [{ id: 'A2' }] });
  });

  it('refuses a link, an empty sentence and a null answer', () => {
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A2', sentence: 'E2 có 2 người phụ thuộc, xem pay.example.cn' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkFlagSentences(anomalies, { items: [{ id: 'A2', sentence: '  ' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkFlagSentences(anomalies, null)).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});

describe('checkPrepareProposals', () => {
  const { sheet } = pseudonymizeSheet([line('1', { contract: { startsInMonth: false, probationEndsInMonth: true, endsInMonth: false } })], { language: 'en', blockingRules: 0 });
  const signals = findSignals(sheet);

  it('keeps a proposal with its field and drops one that names another alias, an unknown id or a made-up figure', () => {
    expect(checkPrepareProposals(signals, { items: [{ id: 'S1', field: 'allowances', note: 'E1 leaves probation: check the allowances.' }] })).toMatchObject({ kind: 'proposals', items: [{ alias: 'E1', field: 'allowances' }] });
    expect(checkPrepareProposals(signals, { items: [{ id: 'S1', field: 'none', note: 'E2 leaves probation.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkPrepareProposals(signals, { items: [{ id: 'S9', field: 'none', note: 'E1 leaves probation.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkPrepareProposals(signals, { items: [{ id: 'S1', field: 'bonus', note: 'E1 gets a bonus of 500000 dong.' }] })).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});

describe('explain', () => {
  const breakdown = {
    pay: { baseWage: '10000000', allowances: [{ label: 'Nguyễn Văn Thử lunch', paid: '730000' }], otherRegularPay: '0', unpaidReduction: '0', overtime: [{ pay: '500000' }], nightWork: null, bonus: '0' },
    tax: { dependentsCounted: 1 },
    deductions: { total: '200000' },
  };
  const f = payrollFiguresOf({ gross: '11230000', employeeInsurance: '1050000', pit: '120000', net: '10060000' }, breakdown);
  const request = { language: 'vi' as const, figures: f, dependentsCounted: dependentsCountedOf(breakdown) };

  it('reads the stored breakdown into fixed components and never carries a free label', () => {
    expect(f.allowances).toBe('730000');
    expect(f.overtime).toBe('500000');
    expect(f.deductions).toBe('200000');
    const text = explainFactsText(request);
    expect(text).toContain('Phụ cấp: 730.000 đồng');
    expect(text).toContain('Thực nhận: 10.060.000 đồng');
    expect(text).not.toContain('Nguyễn');
  });

  it('accepts a text whose figures are all given and refuses one that states another, scales a figure or says a number in words', () => {
    expect(checkExplanation(request, { text: 'Tổng thu nhập 11.230.000 đồng, trừ bảo hiểm 1.050.000 đồng và thuế 120.000 đồng nên thực nhận 10.060.000 đồng.' }).kind).toBe('text');
    expect(checkExplanation(request, { text: 'Thực nhận 10.060.001 đồng.' })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(checkExplanation(request, { text: 'Thực nhận khoảng 10 triệu đồng.' })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(checkExplanation(request, { text: 'Thực nhận mười triệu đồng.' })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(checkExplanation(request, { text: 'Xem thêm tại pay.example.cn' })).toEqual({ kind: 'none', code: 'LINK' });
    expect(checkExplanation(request, { text: 'E1 nhận 10.060.000 đồng.' })).toEqual({ kind: 'none', code: 'ALIAS' });
    expect(checkExplanation(request, null)).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});

describe('restoreAliases', () => {
  it('puts a name back for an alias it knows and leaves an unknown one', () => {
    expect(restoreAliases('E1 và E7', new Map([['E1', 'An']]))).toBe('An và E7');
  });
});

describe('PayrollCoworker', () => {
  const prompts: string[] = [];
  const spy = <T>(output: T) => async ({ system, prompt }: { system: string; prompt: string }) => {
    prompts.push(`${system}\n${prompt}`);
    return { output, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  const { sheet } = pseudonymizeSheet(
    [
      tainted('1', { figures: figures({ net: '12000000' }), previous: figures({ net: '8000000' }), contract: { startsInMonth: false, probationEndsInMonth: true, endsInMonth: false } }),
      tainted('2', { dependentsWithoutRegistration: 1 }),
    ],
    { language: 'vi', blockingRules: 1 },
  );

  it('no request to a model holds a planted name, identity number, tax code, account or address, in the system text or the prompt', async () => {
    prompts.length = 0;
    const coworker = new PayrollCoworker(CONFIG, {
      prepare: spy({ items: [{ id: 'S1', field: 'none', note: 'E1 kết thúc thử việc.' }] }),
      flag: spy({ items: [{ id: 'A1', sentence: 'E1 nhận 12.000.000 đồng, tăng 50%.' }] }),
      explain: spy({ text: 'Thực nhận 8.950.000 đồng.' }),
    });
    const forbidden = [...PLANTED, '1', '2'].filter((v) => v.length >= 3);
    expect((await coworker.prepare(sheet, { forbidden })).kind).toBe('proposals');
    expect((await coworker.flag(sheet, { forbidden })).kind).toBe('flags');
    const f = figures({ gross: '10000000', employee_insurance: '1050000', net: '8950000' });
    expect((await coworker.explain({ language: 'vi', figures: f, dependentsCounted: 0 }, { forbidden })).kind).toBe('text');
    expect(prompts).toHaveLength(3);
    for (const sent of prompts) {
      for (const secret of PLANTED) expect(sent).not.toContain(secret);
      expect(sent).not.toMatch(/Nguy|079201|8012345|0123456789/);
    }
  });

  it('refuses a call whose prompt holds a value that must not leave, before the model is asked', async () => {
    prompts.length = 0;
    const coworker = new PayrollCoworker(CONFIG, { flag: spy({ items: [] }) });
    // The caller's own list of values: a value that appears in the prompt (here a phrase of the facts) stops the call.
    await expect(coworker.flag(sheet, { forbidden: ['tháng trước'] })).rejects.toBeInstanceOf(PayrollPromptLeakError);
    expect(prompts).toEqual([]);
  });

  it('does not ask the model when code found nothing to say, and reports the tokens of a call', async () => {
    prompts.length = 0;
    const calm_ = pseudonymizeSheet([line('1')], { language: 'vi', blockingRules: 0 }).sheet;
    const coworker = new PayrollCoworker(CONFIG, { flag: spy({ items: [] }), prepare: spy({ items: [] }) });
    expect(await coworker.flag(calm_)).toEqual({ kind: 'none', code: 'QUIET' });
    expect(await coworker.prepare(calm_)).toEqual({ kind: 'none', code: 'QUIET' });
    expect(prompts).toEqual([]);
    const used: number[] = [];
    await new PayrollCoworker(CONFIG, { flag: spy({ items: [{ id: 'A1', sentence: 'E1 nhận 12.000.000 đồng, tăng 50%.' }] }) }).flag(sheet, { onUsage: (u) => used.push(u.inputTokens) });
    expect(used).toEqual([10]);
  });

  it('a model that states a figure it was not given, or an alias that does not exist, produces no text', async () => {
    const coworker = new PayrollCoworker(CONFIG, {
      flag: spy({ items: [{ id: 'A1', sentence: 'E1 nhận 99.000.000 đồng.' }, { id: 'A2', sentence: 'E9 có người phụ thuộc chưa đăng ký.' }] }),
      explain: spy({ text: 'Thực nhận 1.234.567 đồng.' }),
    });
    expect(await coworker.flag(sheet)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(await coworker.explain({ language: 'vi', figures: figures({ net: '8950000', gross: '10000000' }), dependentsCounted: 0 })).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
