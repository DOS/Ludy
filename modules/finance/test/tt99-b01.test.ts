// SPDX-License-Identifier: AGPL-3.0-only
// DRAFT TT99 B01-DN map (#5204) on synthetic ledgers worked out by hand, a section at a time. The line codes and the accounts of most lines were checked against the official text (domain/tt99-reports.ts, #5269); where the form
// splits an account by maturity Ludy's placement is its own, and the accountant has not confirmed the map, so these tests pin what the code does with it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { B01_LINES, B01_LINES_TT99, B01_ROLES, B01_TT133, B01_TT99, b01For, buildB01, type B01Setup, type ReportEntry } from '../src/index.ts';

const LE = 'le-b01-tt99';
const DAY = '2026-12-31';
type Leg = [account: string, debit: number, credit: number, party?: string | undefined];

function entry(legs: Leg[], date = '2026-06-30'): ReportEntry {
  return {
    legalEntityId: LE,
    entryDate: date,
    currency: 'VND',
    reversal: false,
    lines: legs.map(([accountCode, debit, credit, partyId]) => ({ accountCode, partyId: partyId ?? null, debit: String(debit), credit: String(credit) })),
  };
}
// One balance on an account against owners' equity 4111, so a section holds only the accounts it names: a debit balance, or a credit balance.
const dr = (account: string, amount: number, party?: string) => entry([[account, amount, 0, party], ['4111', 0, amount]]);
const cr = (account: string, amount: number, party?: string) => entry([['4111', amount, 0], [account, 0, amount, party]]);

const amounts = (entries: ReportEntry[], setup: B01Setup = B01_TT99) => Object.fromEntries(buildB01(entries, LE, DAY, 'VND', setup).lines.map((l) => [l.code, l.amount]));
const pick = (all: Record<string, string>, codes: string[]) => Object.fromEntries(codes.map((code) => [code, all[code]]));

describe('TT99 B01-DN, current assets', () => {
  // Cash: 112 100, 111 7, 113 5 = 112. Investments: 1281 50 on 123, 121 30, provision 2291 2 (negative) on 122: 120 = 78.
  // Receivables: 131 150, a supplier advance on 331 25 (132), 1368 5 (133), 337 7 (134), 1388 8 + 141 2 + a debit on 334 1 (135 = 11), provision 2293 5 (136), 1381 3 (137): 130 = 196.
  // Stock: 156 90, provision 2294 1: 140 = 89. Biological: 2152 14, 2153 1, provision 2295 1: 150 = 14. Other: 242 9, 133 12, 3337 2 (a tax receivable), 171 3: 160 = 26. 100 = 112 + 78 + 196 + 89 + 14 + 26 = 515.
  const ledger = [
    dr('112', 100), dr('111', 7), dr('113', 5), dr('1281', 50), dr('121', 30), cr('2291', 2),
    dr('131', 150, 'C1'), dr('331', 25, 'S2'), dr('1368', 5), dr('337', 7), dr('1388', 8), dr('141', 2), dr('334', 1), cr('2293', 5), dr('1381', 3),
    dr('156', 90), cr('2294', 1), dr('2152', 14), dr('2153', 1), cr('2295', 1),
    dr('242', 9), dr('133', 12), dr('3337', 2), dr('171', 3),
  ];

  it('reads every short-term line from its accounts', () => {
    const a = amounts(ledger);
    expect(pick(a, ['111', '112', '110'])).toEqual({ '111': '112', '112': '0', '110': '112' });
    expect(pick(a, ['121', '122', '123', '124', '125', '126', '120'])).toEqual({ '121': '30', '122': '-2', '123': '50', '124': '0', '125': '0', '126': '0', '120': '78' });
    expect(pick(a, ['131', '132', '133', '134', '135', '136', '137', '130'])).toEqual({ '131': '150', '132': '25', '133': '5', '134': '7', '135': '11', '136': '-5', '137': '3', '130': '196' });
    expect(pick(a, ['141', '142', '140', '151', '152', '153', '150'])).toEqual({ '141': '90', '142': '-1', '140': '89', '151': '14', '152': '1', '153': '-1', '150': '14' });
    expect(pick(a, ['161', '162', '163', '164', '165', '160', '100'])).toEqual({ '161': '9', '162': '12', '163': '2', '164': '3', '165': '0', '160': '26', '100': '515' });
  });

  it('reads special consumption tax on imports (1383) on line 163, not on other short-term receivables (135), and other investments (2288) on line 165 (official method text, #5269)', () => {
    const a = amounts([dr('1383', 4), dr('1388', 6), dr('2288', 9)]);
    expect(pick(a, ['135', '163', '165', '160', '263', '274'])).toEqual({ '135': '6', '163': '4', '165': '9', '160': '13', '263': '0', '274': '0' });
  });

  it('counts money in transit (113) as cash, which the TT133 map does not', () => {
    expect(amounts([dr('113', 5)])['110']).toBe('5');
    expect(amounts([dr('113', 5)], B01_TT133)['110']).toBe('0');
  });
});

describe('TT99 B01-DN, non-current assets', () => {
  // 1361 9 (213), 244 6 (215): 210 = 15. Tangible 211 200 less 2141 20 = 180; finance lease 212 25 less 2142 2 = 23; intangible 213 40 less 2143 10 = 30: 220 = 233.
  // Biological: 21511 12 (232), 215121 16 less 215122 4 = 12 (233), 231 = 24, so 230 = 24. Property 217 60 less 2147 3: 240 = 57. Work in progress 241 11: 250 = 11.
  // Investments: 221 70, 222 8, 2281 5, provision 2292 3: 260 = 80. 243 4: 270 = 4. 200 = 15 + 233 + 24 + 57 + 11 + 80 + 4 = 424.
  const ledger = [
    dr('1361', 9), dr('244', 6),
    dr('211', 200), cr('2141', 20), dr('212', 25), cr('2142', 2), dr('213', 40), cr('2143', 10),
    dr('21511', 12), dr('215121', 16), cr('215122', 4), dr('217', 60), cr('2147', 3), dr('241', 11),
    dr('221', 70), dr('222', 8), dr('2281', 5), cr('2292', 3), dr('243', 4),
  ];

  it('reads every long-term line from its accounts', () => {
    const a = amounts(ledger);
    expect(pick(a, ['213', '215', '210'])).toEqual({ '213': '9', '215': '6', '210': '15' });
    expect(pick(a, ['222', '223', '221', '225', '226', '224', '228', '229', '227', '220'])).toEqual({ '222': '200', '223': '-20', '221': '180', '225': '25', '226': '-2', '224': '23', '228': '40', '229': '-10', '227': '30', '220': '233' });
    expect(pick(a, ['232', '234', '235', '233', '231', '230'])).toEqual({ '232': '12', '234': '16', '235': '-4', '233': '12', '231': '24', '230': '24' });
    expect(pick(a, ['241', '242', '240', '252', '250'])).toEqual({ '241': '60', '242': '-3', '240': '57', '252': '11', '250': '11' });
    expect(pick(a, ['261', '262', '263', '264', '260', '272', '270', '200'])).toEqual({ '261': '70', '262': '8', '263': '5', '264': '-3', '260': '80', '272': '4', '270': '4', '200': '424' });
  });

  it('reads no long-term line that has no account of its own, and no short-term account on one', () => {
    const a = amounts(ledger);
    for (const code of ['211', '212', '214', '216', '236', '237', '238', '251', '265', '266', '271', '273', '274']) expect(a[code], code).toBe('0');
  });
});

describe('TT99 B01-DN, liabilities', () => {
  // Short-term: 331 credit 90 (311), a customer's 131 credit 40 (312), 332 4, 33311 15, 334 18, 335 5, 3368 3, 337 credit 6, 3387 6, 3388 3 plus 1388 credit 2 (320 = 5), 3411 80, 3521 2, 3531 1, 357 2:
  // 310 = 90 + 40 + 4 + 15 + 18 + 5 + 3 + 6 + 6 + 5 + 80 + 2 + 1 + 2 = 277. Long-term: 3361 8, 344 4, 3431 100, 3432 20, 347 5, 356 3: 330 = 140. 300 = 417.
  const ledger = [
    cr('331', 90, 'S1'), cr('131', 40, 'C2'), cr('332', 4), cr('33311', 15), cr('334', 18), cr('335', 5), cr('3368', 3), cr('337', 6), cr('3387', 6), cr('3388', 3), cr('1388', 2),
    cr('3411', 80), cr('3521', 2), cr('3531', 1), cr('357', 2),
    cr('3361', 8), cr('344', 4), cr('3431', 100), cr('3432', 20), cr('347', 5), cr('356', 3),
  ];

  it('reads every liability line from its accounts', () => {
    const a = amounts(ledger);
    expect(pick(a, ['311', '312', '313', '314', '315', '316', '317', '318', '319', '320', '321', '322', '323', '324', '325', '310'])).toEqual({
      '311': '90', '312': '40', '313': '4', '314': '15', '315': '18', '316': '5', '317': '3', '318': '6', '319': '6', '320': '5', '321': '80', '322': '2', '323': '1', '324': '2', '325': '0', '310': '277',
    });
    expect(pick(a, ['335', '338', '339', '340', '342', '344', '330', '300'])).toEqual({ '335': '8', '338': '4', '339': '100', '340': '20', '342': '5', '344': '3', '330': '140', '300': '417' });
  });
});

describe('TT99 B01-DN, equity', () => {
  // Equity is put in against cash 112. 4111 500 and 41111 50 (411a = 550), 41112 100 (411b): 411 = 650. 4112 20, 4113 5, 4118 6, 419 debit 10 (415, negative), 412 4, 413 3, 414 7, 418 8.
  // Retained: 4211 100 (420a); 420b is 4212 10 plus the result not yet closed: 511 150 less 632 60 less 642 18 = 72, 82 in all; 420 = 182. 400 = 650 + 20 + 5 + 6 - 10 + 4 + 3 + 7 + 8 + 182 = 875.
  const eq = (account: string, amount: number) => entry([['112', amount, 0], [account, 0, amount]]);
  const result = [entry([['112', 150, 0], ['511', 0, 150]]), entry([['632', 60, 0], ['112', 0, 60]]), entry([['642', 18, 0], ['112', 0, 18]])];
  const ledger = [
    eq('4111', 500), eq('41111', 50), eq('41112', 100), eq('4112', 20), eq('4113', 5), eq('4118', 6), entry([['419', 10, 0], ['112', 0, 10]]), eq('412', 4), eq('413', 3), eq('414', 7), eq('418', 8),
    eq('4211', 100), eq('4212', 10), ...result,
  ];

  it('reads every equity line from its accounts, the unclosed result on the line of this period', () => {
    const a = amounts(ledger);
    expect(pick(a, ['411a', '411b', '411', '412', '413', '414', '415', '416', '417', '418', '419', '420a', '420b', '420', '400'])).toEqual({
      '411a': '550', '411b': '100', '411': '650', '412': '20', '413': '5', '414': '6', '415': '-10', '416': '4', '417': '3', '418': '7', '419': '8', '420a': '100', '420b': '82', '420': '182', '400': '875',
    });
  });

  it('shows the same equity before and after the year-end closing entries', () => {
    // Close 511, 632 and 642 to 911 and 911 to nothing yet: 911 holds the 72 result, which is still this period's line.
    const closed = [...ledger, entry([['511', 150, 0], ['911', 0, 150]], DAY), entry([['911', 78, 0], ['632', 0, 60], ['642', 0, 18]], DAY)];
    expect(pick(amounts(closed), ['420b', '420', '400'])).toEqual({ '420b': '82', '420': '182', '400': '875' });
  });
});

describe('TT99 B01-DN balances', () => {
  // Capital 1,000 in the bank; stock bought from S1 on credit 300; a 50 advance to supplier S2 (331 debit); a sale of 200 to C1 on credit; a 80 prepayment from customer C2 (131 credit); cost of goods 120.
  // Assets: 111 1,030 (1,000 - 50 + 80), 131 200, 132 50, 141 180 (300 - 120): 280 = 1,460. Sources: 311 300, 312 80, 411 1,000, 420 80 (the unclosed result 200 - 120): 440 = 1,460.
  const ledger = [
    entry([['112', 1000, 0], ['4111', 0, 1000]]),
    entry([['156', 300, 0], ['331', 0, 300, 'S1']]),
    entry([['331', 50, 0, 'S2'], ['112', 0, 50]]),
    entry([['131', 200, 0, 'C1'], ['511', 0, 200]]),
    entry([['112', 80, 0], ['131', 0, 80, 'C2']]),
    entry([['632', 120, 0], ['156', 0, 120]]),
  ];

  it('balances with a supplier advance on its asset line and a customer prepayment on its liability line', () => {
    const report = buildB01(ledger, LE, DAY, 'VND', B01_TT99);
    const a = Object.fromEntries(report.lines.map((l) => [l.code, l.amount]));
    expect(pick(a, ['111', '131', '132', '141', '280'])).toEqual({ '111': '1030', '131': '200', '132': '50', '141': '180', '280': '1460' });
    expect(pick(a, ['311', '312', '411', '420', '440'])).toEqual({ '311': '300', '312': '80', '411': '1000', '420': '80', '440': '1460' });
    expect(report.balanced).toBe(true);
    expect(report.unmapped).toEqual([]);
  });

  it('reads cash, receivables and payables on the same lines under both maps, so Home and the Overview need no regime for 131 and 311', () => {
    const tt133 = amounts(ledger, B01_TT133);
    const tt99 = amounts(ledger, B01_TT99);
    for (const regime of ['tt133', 'tt99'] as const) {
      const roles = B01_ROLES[regime];
      const codes = new Set(b01For(regime).defs.map((l) => l.code));
      for (const code of Object.values(roles)) expect(codes.has(code), `${regime} ${code}`).toBe(true);
    }
    for (const code of [B01_ROLES.tt133.receivables, B01_ROLES.tt133.payables]) expect(tt99[code], code).toBe(tt133[code]);
    expect(B01_ROLES.tt99).toEqual(B01_ROLES.tt133);
  });

  it('does not balance, and says what it left out, when a balance no line reads is in the books', () => {
    // A credit balance on 133 (VAT deductible): its debit side is line 162, its credit side no line.
    const report = buildB01([...ledger, entry([['4111', 5, 0], ['133', 0, 5]])], LE, DAY, 'VND', B01_TT99);
    expect(report.balanced).toBe(false);
    expect(report.unmapped).toEqual([{ accountCode: '133', partyId: null, amount: '-5' }]);
  });

  it('checks the right total lines for each map', () => {
    expect(b01For('tt133')).toBe(B01_TT133);
    expect(b01For('tt99')).toBe(B01_TT99);
    expect([B01_TT133.assets, B01_TT133.sources, B01_TT99.assets, B01_TT99.sources]).toEqual(['200', '500', '280', '440']);
  });
});

describe('TT99 B01-DN map', () => {
  it('defines no code twice and every formula part somewhere in the map, in the form\'s own order', () => {
    const codes = B01_LINES_TT99.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const def of B01_LINES_TT99) for (const [, part] of def.formula ?? []) expect(codes.includes(part), `${def.code} -> ${part}`).toBe(true);
    // The form prints a total before its parts: 100 first, 280 after the long-term assets, 440 last.
    expect(codes[0]).toBe('100');
    expect(codes.indexOf('280')).toBeGreaterThan(codes.indexOf('274'));
    expect(codes[codes.length - 1]).toBe('440');
  });

  it('reads each side of every account of the TT99 chart at most once (the engine throws otherwise)', () => {
    // The chart's own account list (the migration that seeds it), classes 1 to 4: one debit and one credit balance on each, so every account meets every rule that matches it.
    const sql = readFileSync(new URL('../../../supabase/migrations/20261103020000_crove_finance_books_regime.sql', import.meta.url), 'utf8');
    const block = sql.slice(sql.indexOf("SELECT 'tt99', '2026.1', v.code"));
    const codes = [...block.slice(0, block.indexOf(') AS v')).matchAll(/\('([1-4]\d*)', '/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(100);
    const entries = codes.flatMap((code) => [dr(code, 1, 'P'), cr(code, 1, 'P')]);
    expect(() => buildB01(entries, LE, DAY, 'VND', B01_TT99)).not.toThrow();
  });

  it('leaves the TT133 output as it was: the same lines in the same order whichever way the map is named', () => {
    const ledger = [entry([['112', 1000, 0], ['4111', 0, 1000]]), entry([['131', 200, 0, 'C1'], ['511', 0, 200]])];
    const named = buildB01(ledger, LE, DAY, 'VND', B01_TT133);
    const unnamed = buildB01(ledger, LE, DAY);
    expect(named).toEqual(unnamed);
    expect(unnamed.lines.map((l) => l.code)).toEqual(B01_LINES.map((l) => l.code));
  });

  it('works out a formula that names a line printed later, and refuses a cycle or an unknown line', () => {
    const later: B01Setup = {
      defs: [
        { code: 'T', label: 'Total', formula: [[1, 'A'], [1, 'B']] },
        { code: 'A', label: 'A', rules: [{ prefixes: ['111'], take: 'debit' }] },
        { code: 'B', label: 'B', formula: [[1, 'A'], [-1, 'C']] },
        { code: 'C', label: 'C', rules: [{ prefixes: ['112'], take: 'debit' }] },
      ],
      assets: 'T',
      sources: 'T',
    };
    const lines = buildB01([dr('111', 10), dr('112', 3)], LE, DAY, 'VND', later).lines;
    expect(lines.map((l) => [l.code, l.amount])).toEqual([['T', '17'], ['A', '10'], ['B', '7'], ['C', '3']]);
    const cycle: B01Setup = { defs: [{ code: 'A', label: 'A', formula: [[1, 'B']] }, { code: 'B', label: 'B', formula: [[1, 'A']] }], assets: 'A', sources: 'B' };
    expect(() => buildB01([], LE, DAY, 'VND', cycle)).toThrow(/depends on itself/);
    const unknown: B01Setup = { defs: [{ code: 'A', label: 'A', formula: [[1, 'Z']] }], assets: 'A', sources: 'A' };
    expect(() => buildB01([], LE, DAY, 'VND', unknown)).toThrow(/not defined/);
  });
});
