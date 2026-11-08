// SPDX-License-Identifier: AGPL-3.0-only
// The payroll coworker on the real path (#2534): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText, and searched for
// planted names, identity numbers, tax codes, accounts and addresses. The other tests look at the arguments of a generator; this one looks at the bytes of the HTTP request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayrollCoworker, pseudonymizeSheet, withAiScope, type AiMeter, type PayrollFigures, type PayrollSheetLine } from '../src/index.ts';

const PLANTED = ['Nguyễn Văn Thử', 'Nguyen Van Thu', '079201012345', '8012345678-001', '0123456789012', '12 Phố Huế, Hà Nội', 'VCB 1234 5678 9012', 'Công ty Bảng Lương Thử'];
const zero = (): PayrollFigures => ({ base_wage: '0', allowances: '0', other_regular_pay: '0', overtime: '0', night_work: '0', bonus: '0', unpaid_reduction: '0', gross: '0', employee_insurance: '0', pit: '0', deductions: '0', net: '0' });
const quiet = { minimumWageFailed: false, deductionCapFailed: false, netBelowMinimum: false, insuredAboveCap: false, cashPaymentOverLimit: false };

// A line that carries planted identifiers in fields it should not have, as a careless caller could pass them.
const tainted = (id: string, over: Partial<PayrollSheetLine> = {}): PayrollSheetLine =>
  ({
    employeeId: id,
    figures: { ...zero(), net: '12000000', gross: '13000000' },
    previous: { ...zero(), net: '8000000' },
    contract: { startsInMonth: false, probationEndsInMonth: true, endsInMonth: false },
    overtimeMonthsInRow: 0,
    dependentsWithoutRegistration: 0,
    checks: quiet,
    ...over,
    name: PLANTED[0],
    displayName: PLANTED[1],
    nationalId: PLANTED[2],
    taxCode: PLANTED[3],
    bankAccount: PLANTED[4],
    address: PLANTED[5],
    note: PLANTED[6],
    employer: PLANTED[7],
  }) as PayrollSheetLine;

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model (the bytes of the HTTP request)', () => {
  it('holds no planted name, identity number, tax code, account or address, for prepare, flag and explain', async () => {
    const bodies: string[] = [];
    const answers = [{ items: [] }, { items: [] }, { text: 'Thực nhận 8.950.000 đồng.' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion(answers[bodies.length - 1])), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const coworker = new PayrollCoworker({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const { sheet } = pseudonymizeSheet([tainted('11111111-1111-7111-8111-111111111111'), tainted('22222222-2222-7222-8222-222222222222', { dependentsWithoutRegistration: 1 })], { language: 'vi', blockingRules: 1 });
    const figures = { ...zero(), gross: '10000000', employee_insurance: '1050000', net: '8950000' };
    await withAiScope({ orgId: 'org', meter }, async () => {
      await coworker.prepare(sheet, { forbidden: PLANTED });
      await coworker.flag(sheet, { forbidden: PLANTED });
      await coworker.explain({ language: 'vi', figures, dependentsCounted: 0 }, { forbidden: PLANTED });
    });
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      for (const secret of PLANTED) expect(body).not.toContain(secret);
      expect(body).not.toMatch(/Nguy|079201|8012345|0123456789|Phố Huế|VCB|1111111|2222222/);
      // The request is the real one: a chat completion with the sheet's own words in it.
      expect(body).toContain('"messages"');
    }
    expect(bodies[0]).toContain('E1');
  });
});
