// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the year-end checklist (#5283): the model is told which items are open and can be done now and nothing else (no count, date, name or amount), its note is
// refused when it states a number, a date, a link, a promise or a certainty, a done step or advice about money, and its order is refused unless it is exactly the open items. The generator is a
// stand-in, so nothing here reaches a model.
import { describe, expect, it } from 'vitest';
import { InboxReader, YEAR_END_KEYS, checkYearEndNote, yearEndFactsText, yearEndInstructions, yearEndPrompt, yearEndQuiet, type YearEndFacts } from '../src/index.ts';

const FACTS: YearEndFacts = { language: 'en', open: ['balances', 'depreciation', 'closing_entry'] };
const ORDER = ['balances', 'depreciation', 'closing_entry'];
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };

const check = (note: string, order: readonly string[] = ORDER, facts: YearEndFacts = FACTS) => checkYearEndNote(facts, { note, order });

describe('yearEndFactsText and the prompt', () => {
  it('lists the open items only, in the fixed order, each with its key, label and what it depends on', () => {
    const text = yearEndFactsText({ language: 'vi', open: ['closing_entry', 'balances'] });
    expect(text.split('\n')).toHaveLength(3);
    expect(text.indexOf('balances')).toBeLessThan(text.indexOf('closing_entry'));
    expect(text).toContain('it needs every entry of the year to be in first');
    expect(text).not.toContain('depreciation');
  });

  it('tells no count, date, name or amount: not a single digit in what the model is shown', () => {
    for (const language of ['vi', 'en'] as const) {
      const all = { language, open: YEAR_END_KEYS };
      expect(yearEndPrompt(all)).not.toMatch(/\p{Nd}|@|https?:/u);
      expect(yearEndInstructions(language)).not.toMatch(/\p{Nd}/u);
    }
    expect(yearEndInstructions('vi')).toContain('Write the note in Vietnamese');
    expect(yearEndInstructions('en')).toContain('Write the note in English');
    expect(yearEndInstructions('en')).toContain('Give no advice about money');
  });

  it('is quiet when nothing is open and ready', () => {
    expect(yearEndQuiet({ language: 'vi', open: [] })).toBe(true);
    expect(yearEndQuiet(FACTS)).toBe(false);
  });
});

describe('checkYearEndNote: the note', () => {
  it('keeps a plain note with a valid order, as written', () => {
    const text = 'Review the unusual balances first, because they change what the depreciation and the closing entry start from.';
    expect(check(text)).toEqual({ kind: 'note', text, order: ORDER });
    const vi = 'Xem lại các số dư bất thường trước, vì chúng thay đổi điểm bắt đầu của khấu hao và bút toán kết chuyển.';
    expect(checkYearEndNote({ language: 'vi', open: ['balances', 'depreciation'] }, { note: vi, order: ['balances', 'depreciation'] })).toEqual({ kind: 'note', text: vi, order: ['balances', 'depreciation'] });
  });

  it('allows the plain words for the year itself, and still refuses a bare "năm" (the number five)', () => {
    const facts: YearEndFacts = { language: 'vi', open: ['depreciation'] };
    const ok = 'Xem lại khấu hao trước, vì bút toán kết chuyển cuối năm bắt đầu từ đó.';
    expect(checkYearEndNote(facts, { note: ok, order: ['depreciation'] })).toEqual({ kind: 'note', text: ok, order: ['depreciation'] });
    const year = 'Xem lại khấu hao của năm tài chính trước.';
    expect(checkYearEndNote(facts, { note: year, order: ['depreciation'] }).kind).toBe('note');
    expect(checkYearEndNote(facts, { note: 'Xem lại số dư của năm này trước.', order: ['depreciation'] })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(checkYearEndNote({ language: 'en', open: ['closing_entry'] }, { note: 'Make the closing entry at year-end.', order: ['closing_entry'] }).kind).toBe('note');
    expect(checkYearEndNote({ language: 'en', open: ['closing_entry'] }, { note: 'Make the closing entry by the end of the year.', order: ['closing_entry'] })).toEqual({ kind: 'none', code: 'DATE' });
  });

  it('refuses any digit, any number said in words and any date or day, as the month-close note does', () => {
    for (const text of ['Start with 3 balances.', 'Start with the 2026 books.', 'Start with two balances.', 'Làm hai việc trước.', 'Do one thing first.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
    for (const text of ['Finish this by Friday.', 'Lock the period before December.', 'Do the balances today.', 'Do it next week.', 'Làm trước thứ sáu.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'DATE' });
    }
  });

  it('refuses a link, a promise, a certainty and a claim that a step was done', () => {
    expect(check('See https://example.com first.')).toMatchObject({ kind: 'none' });
    for (const text of [
      'I will review them for you.',
      'The closing entry will be easy.',
      'It is certainly fine.',
      'Tôi sẽ xem giúp bạn.',
      'Hãy chắc chắn số dư đúng.',
      'Everything is done.',
      'Các số dư đã được xem.',
      'The balances are posted.',
    ]) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
    // "not certain" and a step still to do stay.
    expect(check('The closing entry is not yet made, so it waits for the depreciation.').kind).toBe('note');
  });

  it('refuses advice to move, pay, borrow, delay, collect, write off or offset money or a balance', () => {
    for (const text of [
      'Transfer the customer credit first.',
      'Pay the supplier advance back first.',
      'Write off the old balances first.',
      'Offset the advance against the payable first.',
      'Collect the customer debts before the closing entry.',
      'Borrow to cover the depreciation first.',
      'Refund the customer credit first.',
      'Hoãn khấu hao sang kỳ sau.',
      'Hãy thanh toán khoản ứng trước.',
      'Xóa nợ các số dư cũ trước.',
      'Bù trừ khoản ứng với công nợ trước.',
    ]) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'ADVICE' });
    }
    // Words that only look at the books are fine: "payroll", "reviewed later by a person" is not money advice.
    expect(check('Check the payroll entries first, because the returns start from them.').kind).toBe('note');
    expect(check('Xem lại bút toán kết chuyển trước, vì khóa sổ nằm sau nó.').kind).toBe('note');
  });

  it('refuses markdown, a list, an emoji, an empty text, a long text and more than two sentences', () => {
    expect(check('**Start** with the balances.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('- Start with the balances.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('Start with the balances \u{1F600}.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(checkYearEndNote(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check('   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check('Start with the balances. '.repeat(20))).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check('Start here. Then there. Then more.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });

  it('refuses a look-alike letter of another script and an invisible filler, which could hide a word', () => {
    expect(check('Start with the bаlances.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('Start with the b͏alances.')).toEqual({ kind: 'none', code: 'FORMAT' });
  });
});

describe('checkYearEndNote: the order', () => {
  const text = 'Start with the balances, then the depreciation, and make the closing entry last.';

  it('accepts only an exact permutation of the open keys', () => {
    expect(check(text, ['closing_entry', 'depreciation', 'balances'])).toEqual({ kind: 'note', text, order: ['closing_entry', 'depreciation', 'balances'] });
  });

  it('refuses an order that adds an item, drops one, repeats one, names an unknown key or is missing', () => {
    expect(check(text, [...ORDER, 'statements'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['balances', 'depreciation'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['balances', 'depreciation', 'depreciation'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['balances', 'depreciation', 'sleep'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(checkYearEndNote(FACTS, { note: text })).toEqual({ kind: 'none', code: 'ORDER' });
  });
});

describe('InboxReader.yearEndNote', () => {
  const readerOf = (answer: { note: string; order: string[] } | null) => {
    const asked: Array<{ system: string; prompt: string }> = [];
    const reader = new InboxReader(CONFIG, {
      yearEnd: async (args) => {
        asked.push(args);
        return { output: answer, usage: { inputTokens: 7, outputTokens: 3 } };
      },
    });
    return { reader, asked };
  };

  it('does not ask the model when nothing is open and ready', async () => {
    const { reader, asked } = readerOf({ note: 'x', order: [] });
    expect(await reader.yearEndNote({ language: 'en', open: [] })).toEqual({ kind: 'none', code: 'QUIET' });
    expect(asked).toHaveLength(0);
  });

  it('asks with the instructions and the facts, reports the usage, and returns the checked note', async () => {
    const text = 'Review the unusual balances first, because they change what the depreciation and the closing entry start from.';
    const { reader, asked } = readerOf({ note: text, order: ORDER });
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    expect(await reader.yearEndNote(FACTS, (u) => usage.push(u))).toEqual({ kind: 'note', text, order: ORDER });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.system).toBe(yearEndInstructions('en'));
    expect(asked[0]?.prompt).toBe(yearEndPrompt(FACTS));
    expect(usage).toEqual([{ inputTokens: 7, outputTokens: 3 }]);
  });

  it('returns no note when the model gave none or its note is refused', async () => {
    expect(await readerOf(null).reader.yearEndNote(FACTS)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(await readerOf({ note: 'Start with 3 balances.', order: ORDER }).reader.yearEndNote(FACTS)).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
