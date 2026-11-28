// Bank statement import (issue #326, ADR-0021 section 6): dates and amounts as banks print them, the file's order,
// the dedupe keys (the "+X, -X, +X" day the ADR left open), the classification against stored lines and the running
// balance check. The import itself is tested on PostgreSQL in apps/kernel/test/finance-bank.db.test.ts.
import { describe, expect, it } from 'vitest';
import { normalizeStatementAmount, type BankStatementRow } from '@ludy/kernel-contract';
import { balanceBreaks, checkLines, checkStatement, classify, dedupeKeys, judge, parseStatementAmount, parseStatementDate, readFeedLines, readStatement, skipFedLines } from '../src/domain/bank-statement.ts';

let rowNo = 1;
const row = (date: string, moneyIn: string, moneyOut: string, balance = '', reference = '', description = 'Giao dịch'): BankStatementRow => ({
  rowNo: rowNo++,
  date,
  description,
  moneyIn,
  moneyOut,
  balance,
  reference,
});
const input = (rows: BankStatementRow[]) => ({ bankAccount: '1121', filename: 'sao-ke.xlsx', rows });
const none = { keys: new Set<string>(), dateAmounts: new Set<string>() };

describe('parseStatementDate', () => {
  it('reads Vietnamese dates, ISO dates and Excel serials', () => {
    expect(parseStatementDate('15/09/2026')).toBe('2026-09-15');
    expect(parseStatementDate('5/9/2026 14:03:22')).toBe('2026-09-05');
    expect(parseStatementDate('15-09-2026')).toBe('2026-09-15');
    expect(parseStatementDate('15.09.2026')).toBe('2026-09-15');
    expect(parseStatementDate('2026-09-15')).toBe('2026-09-15');
    expect(parseStatementDate('2026-09-15T08:00:00')).toBe('2026-09-15');
    // Excel: 46280 is 2026-09-15; a fraction is the time of day.
    expect(parseStatementDate('46280')).toBe('2026-09-15');
    expect(parseStatementDate('46280.6')).toBe('2026-09-15');
  });

  it('refuses what is not a day', () => {
    for (const bad of ['', '31/02/2026', '15/13/2026', '09/15/2026x', 'Tổng cộng', '1999-12-31', '1500000', '2026/09/15']) {
      expect(parseStatementDate(bad), bad).toBeNull();
    }
  });
});

describe('amounts', () => {
  it('normalizes printed amounts in the browser', () => {
    expect(normalizeStatementAmount('1.500.000')).toBe('1500000');
    expect(normalizeStatementAmount('1,500,000')).toBe('1500000');
    expect(normalizeStatementAmount('1,500,000.50')).toBe('1500000.50');
    expect(normalizeStatementAmount('1.500.000,50')).toBe('1500000.50');
    expect(normalizeStatementAmount(' 2 000 000 VND')).toBe('2000000');
    expect(normalizeStatementAmount('+11.000')).toBe('11000');
    expect(normalizeStatementAmount('-11,000')).toBe('-11000');
    expect(normalizeStatementAmount('12,5')).toBe('12.5');
    expect(normalizeStatementAmount('-')).toBe('');
    expect(normalizeStatementAmount('')).toBe('');
  });

  it('parses plain decimals with at most 2 decimals, within an amount column', () => {
    expect(parseStatementAmount('')).toEqual({ ok: true, value: null });
    expect(parseStatementAmount('1500000')).toMatchObject({ ok: true });
    expect(parseStatementAmount('1.5E+7')).toMatchObject({ ok: true });
    expect(parseStatementAmount('12.34')).toMatchObject({ ok: true });
    expect(parseStatementAmount('12.345')).toEqual({ ok: false });
    expect(parseStatementAmount('1e16')).toEqual({ ok: false });
    expect(parseStatementAmount('1.500.000')).toEqual({ ok: false });
    expect(parseStatementAmount('abc')).toEqual({ ok: false });
  });
});

describe('reading a statement', () => {
  it('signs amounts by side, and refuses rows without exactly one side', () => {
    const { parsed } = readStatement(
      input([row('01/09/2026', '500000', ''), row('02/09/2026', '', '-200000'), row('03/09/2026', '', ''), row('04/09/2026', '1', '2'), row('x', 'y', ''), row('05/09/2026', '1', '', 'z')]),
    );
    expect(parsed.map((p) => (p.ok ? p.amount : p.errors))).toEqual(['500000', '-200000', ['AMOUNT_MISSING'], ['AMOUNT_BOTH'], ['DATE_INVALID', 'AMOUNT_INVALID'], ['BALANCE_INVALID']]);
  });

  it('puts a newest-first file oldest first, by its dates or, on one day, by its balances', () => {
    const byDate = readStatement(input([row('03/09/2026', '1', ''), row('01/09/2026', '1', '')]));
    expect(byDate.order).toBe('newest_first');
    expect(byDate.lines.map((l) => l.date)).toEqual(['2026-09-01', '2026-09-03']);
    // One day, newest first: 100 -> +50 = 150 -> -30 = 120, listed 120, 150.
    const oneDay = readStatement(input([row('01/09/2026', '', '30', '120'), row('01/09/2026', '50', '', '150')]));
    expect(oneDay.order).toBe('newest_first');
    expect(oneDay.lines.map((l) => l.balance)).toEqual(['150', '120']);
  });

  it('keeps a counterparty account as its digits when they are 6 to 20, else none (#2402)', () => {
    const withAccount = (account: string | undefined): BankStatementRow => ({ ...row('01/09/2026', '1000', ''), ...(account === undefined ? {} : { counterpartyAccount: account }) });
    const { lines } = readStatement(input([withAccount('0011 0000.5555'), withAccount('0011-0000-6666'), withAccount('12345'), withAccount('1'.repeat(21)), withAccount('ABC'), withAccount('VCB 0011223344 CN 12'), withAccount('1.2345678901234568E+17'), withAccount('FT26305123456789'), withAccount(''), withAccount(undefined)]));
    expect(lines.map((l) => l.counterpartyAccount)).toEqual(['001100005555', '001100006666', null, null, null, null, null, null, null, null]);
  });

  it('keys by reference, else by date, amount, balance and occurrence, else none', () => {
    const { lines } = readStatement(
      input([
        row('01/09/2026', '11000', '', '111000', 'FT1'),
        // +X, -X, +X on one day: both +X lines keep their own key.
        row('01/09/2026', '5000', '', '116000'),
        row('01/09/2026', '', '5000', '111000'),
        row('01/09/2026', '5000', '', '116000'),
        row('02/09/2026', '1', ''),
      ]),
    );
    expect(dedupeKeys(lines)).toEqual(['ref:FT1', 'bal:2026-09-01|5000|116000|0', 'bal:2026-09-01|-5000|111000|0', 'bal:2026-09-01|5000|116000|1', null]);
  });

  it('classifies against stored keys and stored dates and amounts', () => {
    const { lines, keys } = readStatement(
      input([row('01/09/2026', '1', '', '', 'FT1'), row('01/09/2026', '1', '', '', 'FT1'), row('01/09/2026', '2', '', '', 'FT2'), row('02/09/2026', '3', ''), row('02/09/2026', '3', ''), row('03/09/2026', '4', '')]),
    );
    const stored = { keys: new Set(['ref:FT2']), dateAmounts: new Set(['2026-09-03|4']) };
    // A repeated reference in the file is a duplicate; identical keyless lines are each new; a keyless line matching a
    // stored line's date and amount is ambiguous.
    expect(classify(lines, keys, stored)).toEqual(['new', 'duplicate', 'duplicate', 'new', 'new', 'ambiguous']);
  });

  it('tells a reference that comes again with another date or amount from the same transaction twice (#2191)', () => {
    const { lines, keys } = readStatement(
      input([
        row('01/09/2026', '1000', '', '', 'FT1'),
        // The same reference, the same figures: the same transaction.
        row('01/09/2026', '1000', '', '', 'FT2'),
        // A forged line: FT3's reference with another amount, and FT4's with another date.
        row('02/09/2026', '5000', '', '', 'FT3'),
        row('12/09/2026', '700', '', '', 'FT4'),
        row('02/09/2026', '700', '', '', 'FT5'),
        // The same amount a weekend later: the bank's booking day against its value day, the same transaction.
        row('05/09/2026', '400', '', '', 'FT6'),
      ]),
    );
    const refs = new Map([
      ['FT2', [{ date: '2026-09-01', amount: '1000' }]],
      ['FT3', [{ date: '2026-09-02', amount: '3000' }]],
      ['FT4', [{ date: '2026-09-02', amount: '700' }]],
      ['FT6', [{ date: '2026-09-02', amount: '400' }]],
    ]);
    const verdicts = judge(lines, keys, { keys: new Set(['ref:FT2', 'ref:FT3', 'ref:FT4', 'ref:FT6']), dateAmounts: new Set(), refs });
    expect(verdicts.map((v) => v.status)).toEqual(['new', 'duplicate', 'conflict', 'conflict', 'new', 'duplicate']);
    expect(verdicts[2]?.clash).toEqual({ date: '2026-09-02', amount: '3000' });
    expect(verdicts[3]?.clash).toEqual({ date: '2026-09-02', amount: '700' });
  });

  it('flags a reference the file itself repeats with other figures, and drops only an exact repeat', () => {
    const { lines, keys } = readStatement(input([row('01/09/2026', '1000', '', '', 'FT1'), row('01/09/2026', '1000', '', '', 'FT1'), row('01/09/2026', '2000', '', '', 'FT1'), row('01/09/2026', '2000', '', '', 'FT1')]));
    expect(classify(lines, keys, none)).toEqual(['new', 'duplicate', 'conflict', 'duplicate']);
  });

  it('matches a line stored as a conflict by its reference too, so a retry of the same file stores nothing more', () => {
    const { lines, keys } = readStatement(input([row('02/09/2026', '5000', '', '', 'FT3')]));
    // The account holds FT3 as 3000 (with the key) and as 5000 (the conflict stored earlier, keyless).
    const refs = new Map([
      [
        'FT3',
        [
          { date: '2026-09-02', amount: '3000' },
          { date: '2026-09-02', amount: '5000' },
        ],
      ],
    ]);
    expect(classify(lines, keys, { keys: new Set(['ref:FT3']), dateAmounts: new Set(), refs })).toEqual(['duplicate']);
  });
});

describe('balanceBreaks', () => {
  it('reports each line whose balance does not follow, and carries the total over lines without one', () => {
    const line = (amount: string, balance: string | null, n: number | null = null) => ({ date: '2026-09-01', amount, balance, rowNo: n });
    expect(balanceBreaks([line('100', '100'), line('50', '150'), line('-20', null), line('10', '140')])).toEqual([]);
    expect(balanceBreaks([line('100', '100'), line('50', '160', 7), line('10', '170')])).toEqual([{ date: '2026-09-01', rowNo: 7, expected: '150', balance: '160' }]);
  });
});

describe('checkStatement', () => {
  it('stores only new and ambiguous lines, counts every row, and refuses a file with an invalid row', () => {
    const file = input([row('01/09/2026', '100', '', '100', 'A'), row('02/09/2026', '', '30', '70', 'B'), row('03/09/2026', '', '', '70')]);
    const check = checkStatement(file, { keys: new Set(['ref:A']), dateAmounts: new Set() }, { before: null, within: [] });
    expect(check.preview.counts).toEqual({ new: 1, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 1 });
    expect(check.preview.ok).toBe(false);
    expect(check.lines.map((l) => [l.reference, l.position, l.key])).toEqual([['B', 2, 'ref:B']]);
    expect(check.preview.from).toBe('2026-09-01');
    expect(check.preview.to).toBe('2026-09-02');
  });

  it('finds the line a mid-day overlap would drop: the running balance breaks after it', () => {
    // Stored (an import that ended at noon): +5000 -> 116000. Next file starts at noon: -5000 -> 111000, then +5000 ->
    // 116000 (a new line with the same date, amount, balance and occurrence as the stored one), then +1000 -> 117000.
    const file = input([row('01/09/2026', '', '5000', '111000'), row('01/09/2026', '5000', '', '116000'), row('01/09/2026', '1000', '', '117000')]);
    const stored = { keys: new Set(['bal:2026-09-01|5000|116000|0']), dateAmounts: new Set(['2026-09-01|5000']) };
    const check = checkStatement(file, stored, { before: { date: '2026-08-31', amount: '1', balance: '111000' }, within: [{ date: '2026-09-01', amount: '5000', balance: '116000' }] });
    expect(check.preview.counts).toMatchObject({ new: 2, duplicate: 1 });
    // The +1000 line lands on 112000 by the stored chain, not on its printed 117000: the break shows on the screen.
    expect(check.preview.breaks).toEqual([{ date: '2026-09-01', rowNo: file.rows[2]?.rowNo, expected: '112000', balance: '117000' }]);
  });

  it('accepts an exact overlapping re-import with no break', () => {
    const rows = [row('01/09/2026', '100', '', '100'), row('02/09/2026', '', '30', '70')];
    const first = checkStatement(input(rows), none, { before: null, within: [] });
    const stored = { keys: new Set(first.keys), dateAmounts: new Set(first.lines.map((l) => `${l.date}|${l.amount}`)) };
    const again = checkStatement(input([...rows, row('03/09/2026', '5', '', '75')]), stored, {
      before: null,
      within: first.lines.map((l) => ({ date: l.date, amount: l.amount, balance: l.balance })),
    });
    expect(again.preview.counts).toEqual({ new: 1, duplicate: 2, ambiguous: 0, conflict: 0, invalid: 0 });
    expect(again.preview.breaks).toEqual([]);
    expect(again.lines.map((l) => l.position)).toEqual([3]);
  });
});

// A bank feed's lines (ADR-0039, #2044) go through the same keys and classification as a statement's.
describe('readFeedLines', () => {
  const line = (date: string, amount: string, reference: string, balance: string | null = null) => ({ date, description: ' Giao dịch ', amount, balance, reference });

  it('puts the lines oldest first, keeping the order within a day, and keys them as a statement', () => {
    const read = readFeedLines([line('2026-11-03', '-22000.00', 'FT2'), line('2026-11-02', '1000000', 'FT1'), line('2026-11-03', '5', 'FT3', '100.50')]);
    expect(read).toEqual({
      ok: true,
      lines: [
        { rowNo: 2, date: '2026-11-02', description: 'Giao dịch', amount: '1000000', balance: null, reference: 'FT1' },
        { rowNo: 1, date: '2026-11-03', description: 'Giao dịch', amount: '-22000', balance: null, reference: 'FT2' },
        { rowNo: 3, date: '2026-11-03', description: 'Giao dịch', amount: '5', balance: '100.5', reference: 'FT3' },
      ],
      keys: ['ref:FT1', 'ref:FT2', 'ref:FT3'],
    });
  });

  it("turns a day the feed lists newest first round by its balances, so the chain holds", () => {
    // Opening 100, then +50 (150) and -30 (120) on the 2nd; the feed sends the 2nd newest first.
    const read = readFeedLines([line('2026-11-02', '-30', 'B', '120'), line('2026-11-02', '50', 'A', '150'), line('2026-11-01', '100', 'O', '100')]);
    if (!read.ok) throw new Error('read');
    expect(read.lines.map((l) => l.reference)).toEqual(['O', 'A', 'B']);
    expect(balanceBreaks(read.lines.map((l) => ({ ...l, rowNo: l.rowNo })))).toEqual([]);
  });

  it('names every line whose amount is zero, too precise or too large, whose balance is unreadable, or whose day no statement has', () => {
    expect(
      readFeedLines([
        line('2026-11-02', '1', 'A'),
        line('2026-11-02', '0', 'B'),
        line('2026-11-02', '1.005', 'C'),
        line('2026-11-02', '1e16', 'D'),
        line('2026-11-02', '1', 'E', '0.001'),
        line('1999-12-31', '1', 'F'),
        line('2100-01-01', '1', 'G'),
      ]),
    ).toEqual({ ok: false, rows: [2, 3, 4, 5, 6, 7] });
  });

  it('classifies a feed batch against the stored lines as a statement is', () => {
    const read = readFeedLines([line('2026-11-02', '1000', 'FT1'), line('2026-11-02', '2000', 'FT2'), line('2026-11-02', '2000', 'FT2')]);
    if (!read.ok) throw new Error('read');
    const checked = checkLines(read.lines, read.keys, { keys: new Set(['ref:FT1']), dateAmounts: new Set() }, { before: null, within: [] });
    expect(checked.statuses).toEqual(['duplicate', 'new', 'duplicate']);
    expect(checked.toStore.map((l) => [l.key, l.position])).toEqual([['ref:FT2', 2]]);
  });
});

describe('cross-source feed/file ambiguous (#4227)', () => {
  const line = (date: string, amount: string, reference: string, balance: string | null = null) => ({ date, description: ' Giao dịch ', amount, balance, reference });

  it('flags a referenced feed line matching a stored file date and amount as ambiguous with key null and preserved reference', () => {
    const read = readFeedLines([line('2026-11-02', '1000.00', 'FEED-1')]);
    if (!read.ok) throw new Error('read');
    const stored = { keys: new Set(['ref:FILE-1']), dateAmounts: new Set(['2026-11-02|1000']), fileDateAmounts: new Set(['2026-11-02|1000']) };
    expect(judge(read.lines, read.keys, stored)).toEqual([{ status: 'ambiguous', clash: null }]);
    const checked = checkLines(read.lines, read.keys, stored, { before: null, within: [] });
    expect(checked.statuses).toEqual(['ambiguous']);
    expect(checked.toStore).toHaveLength(1);
    expect(checked.toStore[0]).toMatchObject({ date: '2026-11-02', amount: '1000', reference: 'FEED-1', key: null, ambiguous: true });
  });

  it('deduplicates a repeated reference in the same feed batch and flags a differing amount as conflict', () => {
    const read = readFeedLines([line('2026-11-02', '1000', 'FEED-1'), line('2026-11-02', '1000', 'FEED-1'), line('2026-11-02', '2000', 'FEED-1')]);
    if (!read.ok) throw new Error('read');
    const stored = { keys: new Set(['ref:FILE-1']), dateAmounts: new Set(['2026-11-02|1000']), fileDateAmounts: new Set(['2026-11-02|1000']) };
    const verdicts = judge(read.lines, read.keys, stored);
    expect(verdicts).toEqual([
      { status: 'ambiguous', clash: null },
      { status: 'duplicate', clash: null },
      { status: 'conflict', clash: { date: '2026-11-02', amount: '1000' } },
    ]);
    const checked = checkLines(read.lines, read.keys, stored, { before: null, within: [] });
    expect(checked.toStore.map((l) => [l.reference, l.amount, l.key, l.ambiguous])).toEqual([
      ['FEED-1', '1000', null, true],
      ['FEED-1', '2000', null, true],
    ]);
  });

  it('deduplicates a second pull of a cross-source ambiguous feed line via stored.refs and preserves same-ref precedence', () => {
    const read = readFeedLines([line('2026-11-02', '1000', 'FEED-1'), line('2026-11-02', '1000', 'FEED-KEY-ONLY'), line('2026-11-02', '1000', 'FEED-CFL')]);
    if (!read.ok) throw new Error('read');
    const stored = {
      keys: new Set(['ref:FILE-1', 'ref:FEED-KEY-ONLY', 'ref:FEED-CFL']),
      dateAmounts: new Set(['2026-11-02|1000']),
      fileDateAmounts: new Set(['2026-11-02|1000']),
      refs: new Map([
        ['FEED-1', [{ date: '2026-11-02', amount: '1000' }]],
        ['FEED-CFL', [{ date: '2026-11-02', amount: '2000' }]],
      ]),
    };
    expect(judge(read.lines, read.keys, stored)).toEqual([
      { status: 'duplicate', clash: null },
      { status: 'duplicate', clash: null },
      { status: 'conflict', clash: { date: '2026-11-02', amount: '2000' } },
    ]);
  });

  it('keeps referenced lines new when fileDateAmounts is omitted or does not match', () => {
    const read = readFeedLines([line('2026-11-02', '1000', 'FEED-A'), line('2026-11-02', '1000', 'FEED-B'), line('2026-11-03', '1000', 'FEED-C')]);
    if (!read.ok) throw new Error('read');
    const withoutFileSet = checkLines(read.lines, read.keys, { keys: new Set(['ref:FILE-1']), dateAmounts: new Set(['2026-11-02|1000']) }, { before: null, within: [] });
    expect(withoutFileSet.statuses).toEqual(['new', 'new', 'new']);
    expect(withoutFileSet.toStore.map((l) => [l.key, l.ambiguous])).toEqual([
      ['ref:FEED-A', false],
      ['ref:FEED-B', false],
      ['ref:FEED-C', false],
    ]);

    const emptyFileSet = checkLines(
      read.lines,
      read.keys,
      { keys: new Set(), dateAmounts: new Set(['2026-11-02|1000']), fileDateAmounts: new Set(['2026-11-04|999']) },
      { before: null, within: [] },
    );
    expect(emptyFileSet.statuses).toEqual(['new', 'new', 'new']);
    expect(emptyFileSet.toStore.map((l) => [l.key, l.ambiguous])).toEqual([
      ['ref:FEED-A', false],
      ['ref:FEED-B', false],
      ['ref:FEED-C', false],
    ]);
  });
});

describe('skipFedLines (#4218)', () => {
  const checked = () => {
    const rows = [row('2026-10-10', '100', '', '', 'F-A'), row('2026-10-15', '200', '', '', 'F-B'), row('2026-10-20', '300', '', '', 'F-C')];
    return checkStatement(input(rows), none, { before: null, within: [] });
  };

  it('turns the lines on or after the day into duplicates, stores none of them, and says how many', () => {
    const skipped = skipFedLines(checked(), '2026-10-15');
    expect(skipped.preview.rows.map((r) => r.status)).toEqual(['new', 'duplicate', 'duplicate']);
    expect(skipped.preview.counts).toMatchObject({ new: 1, duplicate: 2 });
    expect(skipped.lines.map((l) => l.date)).toEqual(['2026-10-10']);
    expect(skipped.preview.feed).toEqual({ from: '2026-10-15', leftOut: 2 });
  });

  it('leaves a file wholly before the day as it was, and says nothing was skipped', () => {
    const skipped = skipFedLines(checked(), '2026-11-01');
    expect(skipped.preview.counts).toMatchObject({ new: 3, duplicate: 0 });
    expect(skipped.lines).toHaveLength(3);
    expect(skipped.preview.feed).toEqual({ from: '2026-11-01', leftOut: 0 });
  });

  it('skips ambiguous lines on or after the day, while keeping conflicts flagged and stored (#4223)', () => {
    // Rows: keyless ambiguous before cut-over, keyless ambiguous on cut-over, conflict after cut-over, already-duplicate after cut-over, new after cut-over.
    const rows = [
      row('2026-10-10', '100', ''),
      row('2026-10-15', '200', ''),
      row('2026-10-16', '9000', '', '', 'FT-CONFLICT'),
      row('2026-10-17', '300', '', '', 'FT-DUP'),
      row('2026-10-18', '400', '', '', 'FT-NEW'),
    ];
    const stored = {
      keys: new Set(['ref:FT-CONFLICT', 'ref:FT-DUP']),
      dateAmounts: new Set(['2026-10-10|100', '2026-10-15|200']),
      refs: new Map([
        ['FT-CONFLICT', [{ date: '2026-10-16', amount: '2000' }]],
        ['FT-DUP', [{ date: '2026-10-17', amount: '300' }]],
      ]),
    };
    const skipped = skipFedLines(checkStatement(input(rows), stored, { before: null, within: [] }), '2026-10-15');
    expect(skipped.preview.rows.map((r) => [r.status, r.clash])).toEqual([
      ['ambiguous', null],
      ['duplicate', null],
      ['conflict', { date: '2026-10-16', amount: '2000' }],
      ['duplicate', null],
      ['duplicate', null],
    ]);
    // Ambiguous on cut-over (1) + new after cut-over (1) = 2 skipped; already-duplicate and conflict are not counted as skipped by cut-over.
    expect(skipped.preview.counts).toEqual({ new: 0, duplicate: 3, ambiguous: 1, conflict: 1, invalid: 0 });
    expect(skipped.preview.feed).toEqual({ from: '2026-10-15', leftOut: 2 });
    expect(skipped.lines.map((l) => [l.date, l.reference, l.key, l.ambiguous])).toEqual([
      ['2026-10-10', null, null, true],
      ['2026-10-16', 'FT-CONFLICT', null, true],
    ]);
  });

  it('keeps newest-first preview order and oldest-first stored lines across the cut-over day (#4223)', () => {
    const rows = [
      row('2026-10-20', '400', '', '1400', 'NF-4'),
      row('2026-10-15', '300', '', '1000', 'NF-3'),
      row('2026-10-12', '200', '', '700', 'NF-2'),
      row('2026-10-10', '500', '', '500', 'NF-1'),
    ];
    const skipped = skipFedLines(checkStatement(input(rows), none, { before: null, within: [] }), '2026-10-15');
    expect(skipped.preview.order).toBe('newest_first');
    expect(skipped.preview.rows.map((r) => [r.date, r.status])).toEqual([
      ['2026-10-20', 'duplicate'],
      ['2026-10-15', 'duplicate'],
      ['2026-10-12', 'new'],
      ['2026-10-10', 'new'],
    ]);
    expect(skipped.preview.counts).toEqual({ new: 2, duplicate: 2, ambiguous: 0, conflict: 0, invalid: 0 });
    expect(skipped.preview.feed).toEqual({ from: '2026-10-15', leftOut: 2 });
    expect(skipped.lines.map((l) => [l.date, l.reference, l.position])).toEqual([
      ['2026-10-10', 'NF-1', 1],
      ['2026-10-12', 'NF-2', 2],
    ]);
  });

  it('keeps balance breaks on retained conflict lines on or after the cut-over day while dropping breaks on skipped rows (#4223)', () => {
    const preBreakRow = row('2026-10-10', '100', '', '999', 'BR-PRE');
    const skippedBreakRow = row('2026-10-15', '200', '', '1500', 'BR-SKIP');
    const conflictBreakRow = row('2026-10-16', '900', '', '1700', 'BR-CFL');
    const stored = {
      keys: new Set(['ref:BR-CFL']),
      dateAmounts: new Set<string>(),
      refs: new Map([['BR-CFL', [{ date: '2026-10-16', amount: '200' }]]]),
    };
    const chain = {
      before: { date: '2026-10-09', amount: '50', balance: '50' },
      within: [{ date: '2026-10-16', amount: '200', balance: '1700' }],
    };
    const checked = checkStatement(input([preBreakRow, skippedBreakRow, conflictBreakRow]), stored, chain);
    const skipped = skipFedLines(checked, '2026-10-15');
    // preBreakRow (before cut-over: 50+100=150 != 999) and conflictBreakRow (retained: 1700+900=2600 != 1700) stay; skippedBreakRow (999+200=1199 != 1500) is dropped.
    expect(skipped.preview.breaks).toEqual([
      { date: '2026-10-10', rowNo: preBreakRow.rowNo, expected: '150', balance: '999' },
      { date: '2026-10-16', rowNo: conflictBreakRow.rowNo, expected: '2600', balance: '1700' },
    ]);
  });
});
