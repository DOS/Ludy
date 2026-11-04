// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSURANCE_FUNDS, PAYROLL_RULES, REGIONS, listRulesUsed, ruleInForce, type PayrollRule } from '../src/index.ts';

// The rule data of the payroll calculator (#2529, ADR-0046 point 2): every row dated, cited and with a status, and no
// rate or threshold outside it.

describe('payroll rule data', () => {
  it('gives every row a unique id built from kind, key and date, an ISO effective date, a cited source and a status', () => {
    const ids = new Set<string>();
    for (const row of PAYROLL_RULES) {
      expect(row.id).toBe(`${row.kind}.${row.key}@${row.effectiveFrom}`);
      expect(row.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(row.effectiveFrom))).toBe(false);
      expect(row.source.cite.trim().length).toBeGreaterThan(20);
      expect(['primary', 'gov', 'commentary', 'unverified']).toContain(row.source.confidence);
      expect(['confirmed', 'commentary']).toContain(row.status);
      expect(ids.has(row.id), `duplicate rule ${row.id}`).toBe(false);
      ids.add(row.id);
    }
  });

  it('holds the regional minimum wage of Decree 293/2025 and, from 2027-01-01, of Decree 399/2026, for all four regions', () => {
    const monthly = (region: string, onDate: string) => ruleInForce(PAYROLL_RULES, 'minimum_wage', region, onDate)?.value.monthly;
    expect(REGIONS.map((r) => monthly(r, '2026-12-31'))).toEqual(['5310000', '4730000', '4140000', '3700000']);
    expect(REGIONS.map((r) => monthly(r, '2027-01-01'))).toEqual(['5700000', '5080000', '4450000', '4040000']);
    expect(ruleInForce(PAYROLL_RULES, 'minimum_wage', 'I', '2027-01-01')?.source.cite).toContain('Decree 399/2026');
  });

  it('changes the reference level on 2026-07-01 and nowhere else', () => {
    const level = (onDate: string) => ruleInForce(PAYROLL_RULES, 'reference_level', 'default', onDate)?.value.amount;
    expect(level('2026-06-30')).toBe('2340000');
    expect(level('2026-07-01')).toBe('2530000');
    expect(level('2027-06-30')).toBe('2530000');
  });

  it('holds a rate for every fund, summing to 21.5% for the employer and 10.5% for the employee', () => {
    const rows = INSURANCE_FUNDS.map((fund) => ruleInForce(PAYROLL_RULES, 'insurance_rate', fund, '2026-08-01'));
    expect(rows.every((row) => row !== undefined)).toBe(true);
    const total = (pick: 'employerPercent' | 'employeePercent') => rows.reduce((sum, row) => sum + Number(row?.value[pick]), 0);
    expect(total('employerPercent')).toBeCloseTo(21.5, 10);
    expect(total('employeePercent')).toBeCloseTo(10.5, 10);
  });

  it('holds five PIT brackets from the 2026 tax period, and the deductions', () => {
    const brackets = ruleInForce(PAYROLL_RULES, 'pit_brackets', 'resident_monthly', '2026-01-01')?.value.brackets;
    expect(brackets?.map((b) => [b.upTo, b.percent])).toEqual([
      ['10000000', '5'],
      ['30000000', '10'],
      ['60000000', '20'],
      ['100000000', '30'],
      [null, '35'],
    ]);
    const deduction = (key: string) => ruleInForce(PAYROLL_RULES, 'pit_deduction', key, '2026-01-01')?.value.monthly;
    expect(deduction('personal')).toBe('15500000');
    expect(deduction('dependent')).toBe('6200000');
    expect(deduction('dependent_income_limit')).toBe('3000000');
    expect(ruleInForce(PAYROLL_RULES, 'pit_brackets', 'resident_monthly', '2025-12-31')).toBeUndefined();
  });

  it('keeps every row commentary until the accountant confirms it (#2535)', () => {
    expect(PAYROLL_RULES.filter((row) => row.status === 'confirmed')).toEqual([]);
  });
});

describe('listRulesUsed', () => {
  const calculation = { rulesUsed: [rowRef('reference_level.default@2026-07-01'), rowRef('pit_deduction.personal@2026-01-01')] };

  it('lists the rules a calculation used and the ones still commentary', () => {
    const result = listRulesUsed([calculation]);
    expect(result.used.map((row) => row.id)).toEqual(['pit_deduction.personal@2026-01-01', 'reference_level.default@2026-07-01']);
    expect(result.commentary.map((row) => row.id)).toEqual(result.used.map((row) => row.id));
    expect(result.blocksApproval).toBe(true);
  });

  it('counts each rule once across the lines of a month', () => {
    const result = listRulesUsed([calculation, calculation, { rulesUsed: [rowRef('pit_deduction.dependent@2026-01-01')] }]);
    expect(result.used).toHaveLength(3);
  });

  it('stops listing a row as commentary once the rule set marks it confirmed', () => {
    const flipped: PayrollRule[] = PAYROLL_RULES.map((row) => (row.id === 'pit_deduction.personal@2026-01-01' ? { ...row, status: 'confirmed' } : row));
    const result = listRulesUsed([calculation], flipped);
    expect(result.commentary.map((row) => row.id)).toEqual(['reference_level.default@2026-07-01']);
    expect(result.blocksApproval).toBe(true);
    const allConfirmed = listRulesUsed([calculation], PAYROLL_RULES.map((row) => ({ ...row, status: 'confirmed' }) as PayrollRule));
    expect(allConfirmed.commentary).toEqual([]);
    expect(allConfirmed.blocksApproval).toBe(false);
  });

  it('refuses a rule id the rule set does not hold', () => {
    const removed = { id: 'pit_deduction.personal@2000-01-01', kind: 'pit_deduction', key: 'personal', effectiveFrom: '2000-01-01', status: 'commentary' } as const;
    expect(() => listRulesUsed([{ rulesUsed: [removed] }])).toThrow(/not in the rule set/);
  });
});

function rowRef(id: string) {
  const row = PAYROLL_RULES.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return { id, kind: row.kind, key: row.key, effectiveFrom: row.effectiveFrom, status: row.status };
}

describe('payroll sources keep rates out of code', () => {
  const dir = new URL('../src/payroll/', import.meta.url);
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));

  // Comments, strings and the month pattern removed: what is left is code.
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^.*\bconst MONTH\b.*$/m, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g, '""');

  it('uses no number but 0, 1 and the percent scale outside the rule data', () => {
    for (const { name, text } of sources) {
      const numbers = (code(text).match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) ?? []).filter((n) => !['0', '1', '100'].includes(n));
      expect(numbers, `${name} has a numeric constant`).toEqual([]);
    }
  });

  it('never turns money into a JS number', () => {
    for (const { name, text } of sources) {
      expect(code(text), `${name} converts to a JS number`).not.toMatch(/\bparseFloat\b|\bparseInt\b|\btoNumber\b|\bNumber\(|\bMath\./);
    }
  });
});
