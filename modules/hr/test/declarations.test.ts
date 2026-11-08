// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_NOTICE,
  DECLARATION_LAYOUTS,
  buildAnnual,
  buildCertificates,
  buildD02Lt,
  buildQuarterly,
  quarterMonths,
  type DeclarationBreakdown,
  type DeclarationEmployer,
  type DeclarationLine,
  type DeclarationPerson,
  type InsuranceFundKey,
  type WithholdingMode,
} from '../src/declarations.ts';

const employer: DeclarationEmployer = { name: 'Công ty Thử Nghiệm', taxCode: '0100000000', address: 'Hà Nội' };

const person = (id: string, name: string, extra: Partial<DeclarationPerson> = {}): DeclarationPerson => ({
  employeeId: id,
  name,
  birthDate: '1990-01-01',
  taxCode: `TX${id}`,
  insuranceNumber: `SI${id}`,
  identityNumber: `ID${id}`,
  startedOn: '2025-01-01',
  endedOn: null,
  finalizationAuthorizedYears: [],
  ...extra,
});

const FUNDS: InsuranceFundKey[] = ['retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment'];
function breakdown(wage: string, mode: WithholdingMode = 'progressive', suspended: 'not_insured' | null = null): DeclarationBreakdown {
  return {
    insurance: { suspended, funds: FUNDS.map((fund) => ({ fund, wage: suspended ? '0' : wage, employee: '0', employer: '0' })) },
    tax: { mode, exemptMealCash: '0', exemptOvertime: '100000', exemptNightWork: '0', personalDeduction: '15500000', dependentDeduction: '0', pensionDeduction: '0', assessableIncome: '4500000' },
  };
}
const line = (employeeId: string, month: string, pit: string, extra: Partial<DeclarationLine> = {}): DeclarationLine => ({
  month,
  employeeId,
  kind: 'pay',
  gross: '25000000',
  employeeInsurance: '2625000',
  employerInsurance: '5375000',
  unionFee: '500000',
  taxableIncome: '24900000',
  pit,
  breakdown: breakdown('25000000'),
  ...extra,
});

describe('the declarations carry their name, layout version and draft banner (#2533)', () => {
  it('says "bảng kê để khai báo", the layout version and the unconfirmed plan rows on every document', () => {
    const docs = [
      buildD02Lt({ month: '2026-09', employer, persons: [], lines: [], previousLines: null }),
      buildQuarterly({ quarter: '2026-Q3', employer, persons: [], lines: [], approvedMonths: [] }),
      buildAnnual({ year: 2026, employer, persons: [], lines: [], approvedMonths: [] }),
      buildCertificates({ year: 2026, employer, persons: [], lines: [] }),
    ];
    for (const doc of docs) {
      expect(doc.title.toLowerCase()).toContain(DECLARATION_NOTICE.toLowerCase());
      expect(doc.layout).toEqual(DECLARATION_LAYOUTS[doc.kind]);
      expect(doc.layout.version).toMatch(/^ludy-hr-[0-9a-z]+\/\d+$/);
      expect(doc.draft).toMatch(/^BẢN NHÁP: dòng \d+/);
    }
    expect(docs.map((d) => d.draft?.match(/dòng ([\d, ]+) của/)?.[1])).toEqual(['9', '14', '14', '15']);
  });
});

describe('the quarterly figures tie to the approved runs', () => {
  const an = person('1', 'An');
  const binh = person('2', 'Bình', { endedOn: '2026-08-15' });
  const chi = person('3', 'Chi');
  const lines = [
    ...['2026-07', '2026-08', '2026-09'].map((m) => line('1', m, '1000000')),
    ...['2026-07', '2026-08'].map((m) => line('2', m, '500000')),
    line('3', '2026-09', '200000', { breakdown: breakdown('0', 'flat', 'not_insured'), gross: '6000000', taxableIncome: '6000000', employeeInsurance: '0' }),
    // A month outside the quarter is ignored.
    line('1', '2026-10', '999'),
  ];
  const doc = buildQuarterly({ quarter: '2026-Q3', employer, persons: [an, binh, chi], lines, approvedMonths: ['2026-07', '2026-08', '2026-09'] });
  const [summary, progressive, flat] = doc.sheets;

  it('sums the tax withheld, the income and the headcount of the quarter from the lines', () => {
    const value = (item: string) => summary?.rows.find((r) => r.item?.startsWith(item))?.value;
    expect(value('Tổng số người lao động')).toBe('3');
    expect(value('Tổng số thuế đã khấu trừ')).toBe('4200000.00'); // 3 x 1,000,000 + 2 x 500,000 + 200,000
    expect(value('Tổng thu nhập chi trả')).toBe('131000000.00'); // 5 x 25,000,000 + 6,000,000; the October line is outside the quarter
    expect(progressive?.totals?.pit).toBe('4000000.00');
    expect(flat?.totals?.pit).toBe('200000.00');
  });

  it('keeps a person who left mid-quarter for the months they were paid, with the day they left', () => {
    const row = progressive?.rows.find((r) => r.name === 'Bình');
    expect(row?.months).toBe('2026-07, 2026-08');
    expect(row?.note).toBe('Nghỉ việc ngày 2026-08-15');
    expect(row?.pit).toBe('1000000.00');
  });

  it('puts the 10% person on their own schedule and the missing months in the header', () => {
    expect(flat?.rows.map((r) => r.name)).toEqual(['Chi']);
    expect(progressive?.rows.map((r) => r.name)).toEqual(['An', 'Bình']);
    expect(doc.header.find((h) => h.label.startsWith('Tháng chưa'))?.value).toBe('không có');
  });

  it('says which months have no approved run, and refuses a line for an unknown person', () => {
    const partial = buildQuarterly({ quarter: '2026-Q3', employer, persons: [an], lines: [line('1', '2026-07', '1')], approvedMonths: ['2026-07'] });
    expect(partial.header.find((h) => h.label.startsWith('Tháng chưa'))?.value).toBe('2026-08, 2026-09');
    expect(partial.notes[0]).toContain('2026-08, 2026-09');
    expect(() => buildQuarterly({ quarter: '2026-Q3', employer, persons: [], lines: [line('9', '2026-07', '1')], approvedMonths: [] })).toThrow(/not in the list/);
    expect(quarterMonths('2026-Q4')).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(() => quarterMonths('2026-Q5')).toThrow();
  });
});

describe('the annual data is for staff who authorized the payer', () => {
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  const authorized = person('1', 'An', { finalizationAuthorizedYears: [2026] });
  const notAuthorized = person('2', 'Bình');
  const leftEarly = person('3', 'Chi', { finalizationAuthorizedYears: [2026], endedOn: '2026-08-31' });
  const shortContract = person('4', 'Dũng', { finalizationAuthorizedYears: [2026] });
  const lines = [
    ...months.map((m) => line('1', m, '1000000')),
    ...months.map((m) => line('2', m, '1000000')),
    ...months.slice(0, 8).map((m) => line('3', m, '1000000')),
    line('4', '2026-05', '300000', { breakdown: breakdown('0', 'flat', 'not_insured') }),
  ];
  const doc = buildAnnual({ year: 2026, employer, persons: [authorized, notAuthorized, leftEarly, shortContract], lines, approvedMonths: months });
  const [summary, schedule, excluded] = doc.sheets;

  it('schedules only the person who authorized, was withheld monthly and worked to year end', () => {
    expect(schedule?.rows.map((r) => r.name)).toEqual(['An']);
    expect(schedule?.rows[0]?.pit).toBe('12000000.00');
    expect(schedule?.rows[0]?.months).toBe('12');
    expect(summary?.rows.find((r) => r.item?.startsWith('Tổng số thuế'))?.value).toBe('12000000.00');
    // The payable tax is left for the person: the annual brackets are not confirmed.
    expect(summary?.rows.find((r) => r.item?.startsWith('Thuế phải nộp'))?.value).toBe('');
  });

  it('lists everyone else with the reason, so nobody is silently missing', () => {
    expect(excluded?.rows.map((r) => [r.name, r.reason?.split(':')[0]])).toEqual([
      ['Bình', 'Không ủy quyền quyết toán'],
      ['Chi', 'Không còn làm việc đến cuối năm'],
      ['Dũng', 'Hợp đồng dưới 3 tháng hoặc không có hợp đồng'],
    ]);
  });

  it('says which months have no approved run', () => {
    const partial = buildAnnual({ year: 2026, employer, persons: [authorized], lines: lines.slice(0, 6), approvedMonths: months.slice(0, 6) });
    expect(partial.notes[0]).toContain('2026-07');
  });
});

describe('the withholding certificate data', () => {
  const months = ['2026-01', '2026-02'];
  const an = person('1', 'An');
  const authorized = person('2', 'Bình', { finalizationAuthorizedYears: [2026] });
  const flat = person('3', 'Chi');
  const none = person('4', 'Dũng');
  const lines = [
    ...months.map((m) => line('1', m, '1000000')),
    ...months.map((m) => line('2', m, '1000000')),
    ...months.map((m) => line('3', m, '200000', { breakdown: breakdown('0', 'flat', 'not_insured') })),
    ...months.map((m) => line('4', m, '0')),
  ];
  const doc = buildCertificates({ year: 2026, employer, persons: [an, authorized, flat, none], lines });

  it('gives one yearly row to a person withheld monthly, one row per withholding at the flat rate, none to the authorizer or to a person with no tax', () => {
    const rows = doc.sheets[0]?.rows ?? [];
    expect(rows.map((r) => [r.name, r.period, r.pit])).toEqual([
      ['An', '2026-01 đến 2026-02', '2000000.00'],
      ['Chi', '2026-01', '200000.00'],
      ['Chi', '2026-02', '200000.00'],
    ]);
    expect(doc.sheets[1]?.rows.map((r) => r.name)).toEqual(['Bình']);
  });
});

describe('the D02-LT of the month', () => {
  const newHire = person('1', 'An', { startedOn: '2026-09-10' });
  const raised = person('2', 'Bình');
  const same = person('3', 'Chi');
  const leaver = person('4', 'Dũng', { endedOn: '2026-09-20' });
  const probation = person('5', 'Em', { startedOn: '2026-09-01' });
  const previous = [line('2', '2026-08', '0', { breakdown: breakdown('10000000') }), line('3', '2026-08', '0', { breakdown: breakdown('10000000') }), line('4', '2026-08', '0', { breakdown: breakdown('10000000') })];
  const current = [
    line('1', '2026-09', '0', { breakdown: breakdown('8000000') }),
    line('2', '2026-09', '0', { breakdown: breakdown('12000000') }),
    line('3', '2026-09', '0', { breakdown: breakdown('10000000') }),
    line('4', '2026-09', '0', { breakdown: breakdown('10000000') }),
    line('5', '2026-09', '0', { breakdown: breakdown('0', 'progressive', 'not_insured') }),
  ];
  const doc = buildD02Lt({ month: '2026-09', employer, persons: [newHire, raised, same, leaver, probation], lines: current, previousLines: previous });
  const rows = doc.sheets[0]?.rows ?? [];

  it('lists new hires, changes and ends with the contribution wage per fund, and no one else', () => {
    expect(rows.map((r) => [r.seq, r.name, r.movement, r.effectiveOn])).toEqual([
      ['1', 'An', 'Tăng lao động', '2026-09-10'],
      ['2', 'Bình', 'Điều chỉnh mức đóng', '2026-09-01'],
      ['3', 'Dũng', 'Giảm lao động', '2026-09-20'],
    ]);
    expect(rows[0]).toMatchObject({ wageRetirement: '8000000.00', wageUnemployment: '8000000.00', wageHealth: '8000000.00' });
    expect(rows[1]?.wageSickness).toBe('12000000.00');
    expect(doc.notes.join(' ')).toContain('1 người không đóng bảo hiểm');
  });

  it('does not guess a change of wage without the previous month', () => {
    const noPrevious = buildD02Lt({ month: '2026-09', employer, persons: [raised, newHire], lines: current, previousLines: null });
    expect(noPrevious.sheets[0]?.rows.map((r) => r.name)).toEqual(['An']);
    expect(noPrevious.notes.join(' ')).toContain('Chưa có bảng lương đã duyệt của tháng trước');
  });

  it('flags a missing birth date or insurance number instead of inventing one', () => {
    const bare = buildD02Lt({ month: '2026-09', employer, persons: [{ ...newHire, birthDate: null }], lines: current, previousLines: previous });
    expect(bare.sheets[0]?.rows[0]?.note).toContain('Thiếu ngày sinh');
  });
});
