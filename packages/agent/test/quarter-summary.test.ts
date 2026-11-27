// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentences on the quarter card (#5183): what the model is told (fixed row names and movement labels, no figure, date, code or name) and every refusal of a sentence: a digit, a number in
// words, a date or a period word other than the three fixed phrases, a name, an invisible mark, a link, a cause, certainty, a done-claim, a promise, advice, advice to move money, a size, a direction the row does
// not have, a repeated or unasked row, and a set below its floor. A refused sentence never stands and nothing is repaired.
import { describe, expect, it } from 'vitest';
import {
  QUARTER_SUMMARY_NOTES_FLOOR,
  checkQuarterSummaryNotes,
  quarterSummaryFactsText,
  quarterSummaryInstructions,
  quarterSummaryNotesHaveNews,
  quarterSummaryPrompt,
  type QuarterNoteRowKey,
  type QuarterNoteTrend,
  type QuarterSummaryNoteFacts,
  type QuarterSummaryNoteRow,
} from '../src/quarter-summary.ts';
import { QuarterSummaryCoworker } from '../src/quarter-summary-coworker.ts';
import { AI_FEATURES, type AiConfig } from '../src/index.ts';

const row = (key: QuarterNoteRowKey, vsPrevious: QuarterNoteTrend, vsLastYear: QuarterNoteTrend, overdue = false): QuarterSummaryNoteRow => ({ row: key, vsPrevious, vsLastYear, overdue });
const factsOf = (...rows: QuarterSummaryNoteRow[]): QuarterSummaryNoteFacts => ({ language: 'en', entity: 'company', rows });

// One row asked, so the floor of the set is one and the verdict is about the sentence alone.
const stands = (text: string, one: QuarterSummaryNoteRow = row('revenue', 'rose', 'fell')): boolean =>
  checkQuarterSummaryNotes(factsOf(one), { notes: [{ row: 1, text }] }).kind === 'notes';

describe('what the model is told', () => {
  const facts: QuarterSummaryNoteFacts = {
    language: 'en',
    entity: 'household',
    rows: [row('revenue', 'rose', 'first_time'), row('receivables', 'steady', 'none', true), row('stock', 'fell', 'none')],
  };

  it('holds fixed names and labels only: no figure, no date, no code, no name', () => {
    const text = quarterSummaryFactsText(facts);
    // The only digits are the row numbers.
    expect(text.replace(/^Row \d+:/gm, 'Row:')).not.toMatch(/\d/);
    expect(text).toContain('Row 1: sales revenue; against the previous quarter it rose');
    expect(text).toContain('Row 2: what customers owe the business; against the previous quarter it stayed steady; against the same quarter last year it no comparison; some sales invoices were overdue at the end');
    expect(text).toContain('household business');
    expect(quarterSummaryPrompt(facts)).toContain('Write one sentence for each row.');
  });

  it('says overdue only for receivables', () => {
    expect(quarterSummaryFactsText(factsOf(row('cash', 'rose', 'rose', true)))).not.toContain('overdue');
  });

  it('asks for no number, no name, no cause and no advice, and names the three period phrases', () => {
    const system = quarterSummaryInstructions('en');
    expect(system).toContain('Write NO number');
    expect(system).toContain('Never say why a figure moved');
    expect(system).toContain('"this quarter", "the previous quarter", "the same quarter last year"');
    expect(quarterSummaryInstructions('vi')).toContain('Write in Vietnamese');
  });

  it('has news only when a row is asked', () => {
    expect(quarterSummaryNotesHaveNews({ rows: [] })).toBe(false);
    expect(quarterSummaryNotesHaveNews(facts)).toBe(true);
  });

  it('is metered under one key of the registry', () => {
    expect(AI_FEATURES['finance.quarter_summary_note']).toBe('finance');
  });
});

describe('a sentence that stands', () => {
  it('says how the figure moved, in English', () => {
    expect(stands('Sales revenue rose against the previous quarter.')).toBe(true);
    expect(stands('Sales revenue fell against the same quarter last year.')).toBe(true);
    expect(stands('Sales revenue rose this quarter but fell against the same quarter last year.')).toBe(true);
  });

  it('says how the figure moved, in Vietnamese', () => {
    expect(stands('Doanh thu tăng so với quý trước.')).toBe(true);
    expect(stands('Doanh thu giảm so với cùng kỳ năm trước.')).toBe(true);
  });

  it('may say steady, or first time, when a label says so', () => {
    expect(stands('Cash stayed steady against the previous quarter.', row('cash', 'steady', 'steady'))).toBe(true);
    expect(stands('Costs appeared for the first time against the previous quarter.', row('costs', 'first_time', 'none'))).toBe(true);
  });

  it('may name VAT, the one capitalised word allowed after the first', () => {
    expect(stands('Revenue and VAT rose against the previous quarter.')).toBe(true);
  });

  it('keeps the text as given, whitespace folded', () => {
    const r = checkQuarterSummaryNotes(factsOf(row('revenue', 'rose', 'rose')), { notes: [{ row: 1, text: '  Sales revenue\n rose against the previous quarter.  ' }] });
    expect(r).toEqual({ kind: 'notes', notes: [{ row: 1, text: 'Sales revenue rose against the previous quarter.' }] });
  });
});

describe('numbers, dates and hidden characters refuse the sentence', () => {
  it.each([
    ['a digit', 'Sales revenue rose by 5 percent.'],
    ['a full-width digit', 'Sales revenue rose by ５ percent.'],
    ['a number in words', 'Sales revenue rose twice against the previous quarter.'],
    ['a joined number word', 'Sales revenue rose fivehundred.'],
    ['an ordinal', 'Sales revenue rose for the third time.'],
    ['a fraction word', 'Sales revenue rose by half.'],
    ['a Vietnamese number word', 'Doanh thu tăng hai lần so với quý trước.'],
    ['a Vietnamese joined number', 'Doanh thu tăng mườihai.'],
    ['a month name', 'Sales revenue rose in March.'],
    ['a weekday', 'Sales revenue rose on Monday.'],
    ['today', 'Sales revenue rose today.'],
    ['last year alone', 'Sales revenue rose against last year.'],
    ['a quarter word beyond the fixed phrases', 'Sales revenue rose against next quarter.'],
    ['a quarter number', 'Sales revenue rose in the third quarter.'],
    ['a Vietnamese month', 'Doanh thu tăng so với tháng trước.'],
    ['a Vietnamese year', 'Doanh thu tăng so với năm ngoái.'],
    ['a zero-width split', 'Sales revenue ro​se against the previous quarter.'],
    ['a bidi mark', 'Sales revenue rose ‮against the previous quarter.'],
    ['a combining mark', 'Sales revenue rose x́ against the previous quarter.'],
    ['a link', 'Sales revenue rose, see https://evil.invalid now.'],
    ['markup', 'Sales revenue rose **against** the previous quarter.'],
    ['an emoji', 'Sales revenue rose 🚀 against the previous quarter.'],
    ['another script', 'Sales revenue rose Привет against the previous quarter.'],
  ])('refuses %s', (_name, text) => {
    expect(stands(text)).toBe(false);
  });

  it('refuses a fixed phrase glued into a longer period word', () => {
    expect(stands('Sales revenue rose against the previous quarterly figure.')).toBe(false);
    expect(stands('Sales revenue rose against the same quarter last year and in the year before.')).toBe(false);
  });
});

describe('names, causes, certainty, promises and advice refuse the sentence', () => {
  it.each([
    ['a name after the first word', 'Sales revenue rose at Shopee.'],
    ['a cause', 'Sales revenue rose due to demand.'],
    ['another cause', 'Sales revenue rose because customers bought more.'],
    ['a Vietnamese cause', 'Doanh thu tăng vì khách mua nhiều hơn.'],
    ['certainty', 'Sales revenue clearly rose.'],
    ['a Vietnamese certainty', 'Doanh thu chắc chắn tăng.'],
    ['the future', 'Sales revenue will rise.'],
    ['already', 'Sales revenue already rose.'],
    ['a done-claim', 'Sales revenue rose as customers were invoiced.'],
    ['a Vietnamese done-claim', 'Doanh thu đã tăng.'],
    ['advice', 'Sales revenue rose, so check the invoices.'],
    ['a Vietnamese order', 'Doanh thu tăng, hãy kiểm tra lại.'],
    ['advice to move money', 'Cash fell, so move money to savings.'],
    ['advice to collect', 'Receivables rose, so collect them.'],
    ['a Vietnamese money order', 'Doanh thu tăng, nên chuyển khoản.'],
    ['a size', 'Sales revenue rose sharply.'],
    ['a Vietnamese size', 'Doanh thu tăng mạnh.'],
    ['two sentences', 'Sales revenue rose. Costs rose.'],
    ['nothing', ''],
  ])('refuses %s', (_name, text) => {
    expect(stands(text)).toBe(false);
  });

  it('refuses a sentence over the length limit', () => {
    expect(stands(`Sales revenue rose${' and rose'.repeat(40)}.`)).toBe(false);
  });

  it('does not take "phải trả" (payable) for an order to pay', () => {
    expect(stands('Những khoản phải trả tăng so với quý trước.', row('payables', 'rose', 'rose'))).toBe(true);
  });
});

describe('a direction the row does not have, or says against the wrong basis, refuses the sentence', () => {
  it.each([
    ['was down', 'Sales revenue was down against the previous quarter.'],
    ['slipped', 'Sales revenue slipped against the previous quarter.'],
    ['eased', 'Sales revenue eased against the previous quarter.'],
    ['weakened', 'Sales revenue weakened against the previous quarter.'],
    ['a Vietnamese fall', 'Doanh thu đi xuống so với quý trước.'],
    ['a Vietnamese slump', 'Doanh thu lao dốc so với quý trước.'],
    ['a negated fall', 'Sales revenue did not fall against the previous quarter.'],
    ['a Vietnamese negation', 'Doanh thu không giảm so với quý trước.'],
  ])('refuses %s on a row that rose', (_name, text) => {
    expect(stands(text, row('revenue', 'rose', 'rose'))).toBe(false);
  });

  it.each([
    ['climbed', 'Sales revenue climbed against the previous quarter.'],
    ['was up', 'Sales revenue was up against the previous quarter.'],
    ['improved', 'Sales revenue improved against the previous quarter.'],
    ['a Vietnamese rise', 'Doanh thu đi lên so với quý trước.'],
    ['a Vietnamese gain', 'Doanh thu khởi sắc so với quý trước.'],
  ])('refuses %s on a row that fell', (_name, text) => {
    expect(stands(text, row('revenue', 'fell', 'fell'))).toBe(false);
  });

  it('holds each direction to the basis it is said against', () => {
    const mixed = row('revenue', 'rose', 'fell');
    expect(stands('Sales revenue rose against the previous quarter but fell against the same quarter last year.', mixed)).toBe(true);
    expect(stands('Sales revenue fell against the previous quarter but rose against the same quarter last year.', mixed)).toBe(false);
    expect(stands('Doanh thu giảm so với quý trước nhưng tăng so với cùng kỳ năm trước.', mixed)).toBe(false);
    expect(stands('Doanh thu tăng so với quý trước nhưng giảm so với cùng kỳ năm trước.', mixed)).toBe(true);
    // One direction said against both bases needs both to agree.
    expect(stands('Sales revenue rose against the previous quarter and the same quarter last year.', mixed)).toBe(false);
    expect(stands('Sales revenue rose against the previous quarter and the same quarter last year.', row('revenue', 'rose', 'rose'))).toBe(true);
    expect(stands('Sales revenue rose against both the previous quarter and the same quarter last year.', row('revenue', 'rose', 'rose'))).toBe(true);
    // A direction before its phrase waits for the next clause that has one.
    expect(stands('Against the previous quarter, sales revenue fell.', mixed)).toBe(false);
    expect(stands('Against the previous quarter, sales revenue rose.', mixed)).toBe(true);
  });

  it('refuses two directions in one clause', () => {
    expect(stands('Sales revenue rose then fell against the previous quarter.', row('revenue', 'rose', 'fell'))).toBe(false);
  });

  it('does not call a loss from nothing a rise: the label is fell', () => {
    expect(stands('Profit before tax rose against the previous quarter.', row('profit', 'fell', 'none'))).toBe(false);
    expect(stands('Profit before tax fell against the previous quarter.', row('profit', 'fell', 'none'))).toBe(true);
  });

  it('allows the words a payables or receivables line needs, and refuses vague counts and month abbreviations', () => {
    expect(stands('What customers owe rose, and some invoices were past due.', row('receivables', 'rose', 'rose', true))).toBe(true);
    expect(stands('Sales revenue rose in oct.', row('revenue', 'rose', 'rose'))).toBe(false);
    expect(stands('Sales revenue rose in sept and dec.', row('revenue', 'rose', 'rose'))).toBe(false);
    expect(stands('A few customers paid late.', row('receivables', 'rose', 'rose'))).toBe(false);
  });

  it('refuses up when nothing rose or appeared', () => {
    expect(stands('Sales revenue rose against the previous quarter.', row('revenue', 'fell', 'steady'))).toBe(false);
  });
  it('refuses down when nothing fell', () => {
    expect(stands('Sales revenue fell against the previous quarter.', row('revenue', 'rose', 'rose'))).toBe(false);
    expect(stands('Doanh thu giảm so với quý trước.', row('revenue', 'rose', 'rose'))).toBe(false);
  });
  it('refuses steady when nothing stayed steady', () => {
    expect(stands('Sales revenue stayed steady against the previous quarter.', row('revenue', 'rose', 'rose'))).toBe(false);
  });
  it('refuses first time when nothing appeared', () => {
    expect(stands('Sales revenue appeared for the first time.', row('revenue', 'rose', 'rose'))).toBe(false);
  });
  it('allows both directions when the two bases moved differently', () => {
    expect(stands('Sales revenue rose against the previous quarter but fell against the same quarter last year.', row('revenue', 'rose', 'fell'))).toBe(true);
  });
  it('allows up for a figure that appeared for the first time', () => {
    expect(stands('Costs rose against the previous quarter.', row('costs', 'first_time', 'none'))).toBe(true);
  });
});

describe('the set', () => {
  const three = factsOf(row('revenue', 'rose', 'rose'), row('costs', 'rose', 'steady'), row('cash', 'fell', 'fell'));
  const good = [
    { row: 1, text: 'Sales revenue rose against the previous quarter.' },
    { row: 2, text: 'Costs stayed steady against the same quarter last year.' },
    { row: 3, text: 'Cash fell against the previous quarter.' },
  ];

  it('stands when every row has its sentence, in the order of the rows', () => {
    const r = checkQuarterSummaryNotes(three, { notes: [...good].reverse() });
    expect(r).toEqual({ kind: 'notes', notes: good });
  });

  it('is dropped whole below its floor', () => {
    expect(QUARTER_SUMMARY_NOTES_FLOOR).toBe(3);
    const r = checkQuarterSummaryNotes(three, { notes: [good[0]!, { row: 2, text: 'Costs rose by 5 percent.' }, { row: 3, text: 'Cash rose.' }] });
    expect(r).toEqual({ kind: 'none', code: 'TOO_FEW' });
  });

  it('needs only as many sentences as rows when fewer than the floor are asked', () => {
    const two = factsOf(row('revenue', 'rose', 'rose'), row('cash', 'fell', 'fell'));
    expect(checkQuarterSummaryNotes(two, { notes: [good[0]!, good[2]!].map((n, i) => ({ ...n, row: i + 1 })) }).kind).toBe('notes');
    expect(checkQuarterSummaryNotes(two, { notes: [{ row: 1, text: good[0]!.text }] })).toEqual({ kind: 'none', code: 'TOO_FEW' });
  });

  it('drops every copy of a row given twice', () => {
    const r = checkQuarterSummaryNotes(factsOf(row('revenue', 'rose', 'rose')), { notes: [good[0]!, { row: 1, text: 'Sales revenue rose against the same quarter last year.' }] });
    expect(r).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it('drops a row that was not asked', () => {
    const r = checkQuarterSummaryNotes(factsOf(row('revenue', 'rose', 'rose')), { notes: [{ row: 9, text: good[0]!.text }, { row: 0, text: good[0]!.text }, { row: 1.5, text: good[0]!.text }] });
    expect(r).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it('says there is nothing when the model gave nothing', () => {
    expect(checkQuarterSummaryNotes(three, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkQuarterSummaryNotes(three, { notes: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});

describe('QuarterSummaryCoworker', () => {
  const config = { baseUrl: 'http://unused.invalid', apiKey: 'x', model: 'm' } as unknown as AiConfig;

  it('asks the model nothing when no row is asked, and checks the answer when one is', async () => {
    let asked = 0;
    const coworker = new QuarterSummaryCoworker(config, async ({ system, prompt }) => {
      asked += 1;
      expect(system).toContain('Write NO number');
      expect(prompt.replace(/^Row \d+:/gm, 'Row:')).not.toMatch(/\d/);
      return { output: { notes: [{ row: 1, text: 'Sales revenue rose against the previous quarter.' }] }, usage: { inputTokens: 3, outputTokens: 4 } };
    });
    expect(await coworker.notes({ language: 'en', entity: 'company', rows: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(asked).toBe(0);
    const used: number[] = [];
    const result = await coworker.notes(factsOf(row('revenue', 'rose', 'rose')), (u) => used.push(u.inputTokens + u.outputTokens));
    expect(asked).toBe(1);
    expect(used).toEqual([7]);
    expect(result).toEqual({ kind: 'notes', notes: [{ row: 1, text: 'Sales revenue rose against the previous quarter.' }] });
  });

  it('says why when the model gave nothing', async () => {
    const coworker = new QuarterSummaryCoworker(config, async () => ({ output: null }));
    expect(await coworker.notes(factsOf(row('revenue', 'rose', 'rose')))).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
