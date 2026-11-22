// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the month-close checklist: the model is told which items are open and nothing else (no count, date, name or amount), its note is refused when it
// states a number, a date, a link, a promise or a done step, and its order is refused unless it is exactly the open items. The generator is a stand-in, so nothing here reaches a model.
import { describe, expect, it } from 'vitest';
import { InboxReader, MONTH_CLOSE_KEYS, checkMonthCloseNote, monthCloseFactsText, monthCloseInstructions, monthClosePrompt, monthCloseQuiet, type MonthCloseFacts } from '../src/index.ts';

const FACTS: MonthCloseFacts = { language: 'en', open: ['proposals', 'bank', 'lock'] };
const ORDER = ['proposals', 'bank', 'lock'];
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };

const check = (note: string, order: readonly string[] = ORDER, facts: MonthCloseFacts = FACTS) => checkMonthCloseNote(facts, { note, order });

describe('monthCloseFactsText and the prompt', () => {
  it('lists the open items only, in the fixed order, each with its key, label and what it depends on', () => {
    const text = monthCloseFactsText({ language: 'vi', open: ['lock', 'proposals'] });
    expect(text.split('\n')).toHaveLength(3);
    expect(text.indexOf('proposals')).toBeLessThan(text.indexOf('lock'));
    expect(text).toContain('it comes last, because it stops further changes to the month');
    expect(text).not.toContain('bank');
  });

  it('tells no count, date, name or amount: not a single digit in what the model is shown', () => {
    for (const language of ['vi', 'en'] as const) {
      const all = { language, open: MONTH_CLOSE_KEYS };
      expect(monthClosePrompt(all)).not.toMatch(/\p{Nd}|@|https?:/u);
      expect(monthCloseInstructions(language)).not.toMatch(/\p{Nd}/u);
    }
    expect(monthCloseInstructions('vi')).toContain('Write the note in Vietnamese');
    expect(monthCloseInstructions('en')).toContain('Write the note in English');
  });

  it('is quiet when nothing is open', () => {
    expect(monthCloseQuiet({ language: 'vi', open: [] })).toBe(true);
    expect(monthCloseQuiet(FACTS)).toBe(false);
  });
});

describe('checkMonthCloseNote: the note', () => {
  it('keeps a plain note with a valid order, as written', () => {
    const text = 'Approve or reject the waiting proposals first, because they change what the bank step finds. Lock the period last.';
    expect(check(text)).toEqual({ kind: 'note', text, order: ORDER });
    const vi = 'Duyệt hoặc từ chối các đề xuất đang chờ trước, vì chúng thay đổi những gì bước sao kê tìm thấy.';
    expect(checkMonthCloseNote({ language: 'vi', open: ['proposals', 'bank'] }, { note: vi, order: ['proposals', 'bank'] })).toEqual({ kind: 'note', text: vi, order: ['proposals', 'bank'] });
  });

  it('refuses any digit, in any script, and any number said in words or scaled', () => {
    for (const text of ['Start with 3 proposals.', 'Start with the 2026 books.', 'Start with ٣ proposals.', 'Start with ３ proposals.', 'Làm 5 việc đầu.', 'Start with two proposals.', 'Làm hai việc trước.', 'Costs of 5 million.', 'Start with the 1st step.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
  });

  it('refuses the English number words the shared check stops short of, and zero', () => {
    for (const text of ['There are fifteen lines waiting. Do bank first.', 'Seventeen days remain.', 'Start with thirteen items.', 'Nothing: zero items.', 'About ninety lines wait.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
  });

  it('refuses "one", the ordinals from the fourth up and "once" or "twice", but keeps "no one", "this one", first and second', () => {
    for (const text of ['Do one thing first.', 'Start with the twentieth item.', 'This is the fourth step.', 'Check it once before you start.', 'Check it twice.', 'The eleventh item waits.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
    for (const text of ['Start with this one, then the bank lines.', 'No one step depends on the others.', 'Start with the first, then the second.']) {
      expect(check(text).kind, text).toBe('note');
    }
  });

  it('refuses a numeric character of any script or style: circled, dingbat, Ethiopic, Hangzhou', () => {
    for (const text of ['Start with ❶ proposal.', 'Start with ➂ proposals.', 'Start with ፫ proposals.', 'Start with 〥 proposals.', 'Start with ½ of them.', 'Start with Ⅷ items.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
  });

  it('refuses a deadline said as "by the end of", and a done claim that is a bare participle or "rồi"', () => {
    expect(check('Finish by the end of the month.')).toEqual({ kind: 'none', code: 'DATE' });
    expect(check('Hoàn thiện trước cuối tháng.')).toEqual({ kind: 'none', code: 'DATE' });
    for (const text of ['Posted.', 'All the bank lines are posted.', 'Duyệt rồi.', 'Các đề xuất được duyệt rồi.', 'Khóa sổ rồi.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
    // "rồi" in the middle of a clause is "then", and a participle after "not yet" or "to be" says what is left.
    expect(check('Xử lý các đề xuất rồi mới khóa sổ.').kind).toBe('note');
    expect(check('The VAT return is not yet filed.').kind).toBe('note');
    expect(check('The bank lines still to be booked come next.').kind).toBe('note');
  });

  it('refuses a look-alike letter of another script and an invisible filler, which could hide a word', () => {
    expect(check('Start with the bаnk lines.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('Start with the ㅤ bank lines.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('The VAT return wіll wait.')).toMatchObject({ kind: 'none' });
  });

  it('keeps an ordering rationale that says what must come first ("once ... are booked", "before ... is filed")', () => {
    expect(check('Book the bank lines first. Once they are booked the VAT return can be prepared.').kind).toBe('note');
    expect(check('Review the proposals before the VAT return is filed.').kind).toBe('note');
    expect(check('Sau khi các dòng sao kê được hạch toán, hãy chuẩn bị tờ khai.').kind).toBe('note');
    // The same words as a statement that something is done are still refused.
    expect(check('The VAT return is filed.')).toEqual({ kind: 'none', code: 'PROMISE' });
    expect(check('Once they are booked I will file it.')).toEqual({ kind: 'none', code: 'PROMISE' });
  });

  it('refuses a number hidden by an invisible character', () => {
    expect(check('Start with tw​o proposals.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('refuses a date or a day, said in words', () => {
    for (const text of [
      'Finish this by Friday.',
      'Lock the period before December.',
      'Do the bank lines today.',
      'Approve them tomorrow.',
      'Do it before the weekend.',
      'Hãy làm trước thứ sáu.',
      'Khóa sổ trước tháng mười hai.',
      'Làm ngay hôm nay.',
      'Duyệt vào ngày mai.',
      'Làm trước cuối tuần.',
    ]) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'DATE' });
    }
  });

  it('keeps "this month" and "last month", which name no date', () => {
    expect(check('Close the items of this month in this order.').kind).toBe('note');
    expect(check('Xử lý các việc của tháng này theo thứ tự này.').kind).toBe('note');
  });

  it('refuses a link, an address and a domain', () => {
    for (const text of ['See https://example.com first.', 'Write to me@example.com first.', 'Open www.example.com first.', 'Check example.vn first.']) {
      expect(check(text), text).toMatchObject({ kind: 'none' });
      expect(['LINK', 'FIGURES'], text).toContain((check(text) as { code: string }).code);
    }
  });

  it('refuses a promise and a claim that a step was done', () => {
    for (const text of [
      'I will approve them for you.',
      'This will be done soon.',
      "I'll lock the period.",
      'The proposals have been approved.',
      'The VAT return is filed.',
      'The period was locked.',
      'The bank lines are booked already.',
      'Everything is completed.',
      'Tôi sẽ duyệt giúp bạn.',
      'Các đề xuất đã được duyệt.',
      'Đã khóa sổ.',
      'Việc này xong rồi.',
      'Tôi đảm bảo mọi thứ đúng.',
    ]) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
  });

  it('keeps a note that says what is left to do ("not yet filed", "to be booked")', () => {
    expect(check('The VAT return is not yet filed, so it waits for the bank lines to be booked.').kind).toBe('note');
  });

  it('refuses markdown, a list, an emoji, an empty text, a long text and more than two sentences', () => {
    expect(check('**Start** with the proposals.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('- Start with the proposals.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('Start with the proposals \u{1F600}.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(checkMonthCloseNote(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check('   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check('Start with the proposals. '.repeat(20))).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check('Start here. Then there. Then more.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });
});

describe('checkMonthCloseNote: the order', () => {
  const text = 'Start with the proposals, then the bank lines, and lock last.';

  it('accepts only an exact permutation of the open keys', () => {
    expect(check(text, ['lock', 'bank', 'proposals'])).toEqual({ kind: 'note', text, order: ['lock', 'bank', 'proposals'] });
  });

  it('refuses an order that adds an item, drops one, repeats one, names an unknown key or is missing', () => {
    expect(check(text, ['proposals', 'bank', 'lock', 'stock'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['proposals', 'bank'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['proposals', 'bank', 'bank'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['proposals', 'bank', 'sleep'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(check(text, ['proposals', 'bank', 'stock'])).toEqual({ kind: 'none', code: 'ORDER' });
    expect(checkMonthCloseNote(FACTS, { note: text })).toEqual({ kind: 'none', code: 'ORDER' });
  });
});

describe('InboxReader.monthCloseNote', () => {
  const readerOf = (answer: { note: string; order: string[] } | null) => {
    const asked: Array<{ system: string; prompt: string }> = [];
    const reader = new InboxReader(CONFIG, {
      monthClose: async (args) => {
        asked.push(args);
        return { output: answer, usage: { inputTokens: 7, outputTokens: 3 } };
      },
    });
    return { asked, reader };
  };

  it('asks the model once with the open items, passes its tokens on and returns the checked note', async () => {
    const { asked, reader } = readerOf({ note: 'Start with the proposals, then the bank lines, and lock last.', order: ORDER });
    const used: number[] = [];
    expect(await reader.monthCloseNote(FACTS, (u) => used.push(u.inputTokens + u.outputTokens))).toMatchObject({ kind: 'note', order: ORDER });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain('proposals');
    expect(asked[0]?.prompt).not.toContain('stock');
    expect(used).toEqual([10]);
  });

  it('does not ask the model when nothing is open', async () => {
    const { asked, reader } = readerOf({ note: 'x', order: [] });
    expect(await reader.monthCloseNote({ language: 'en', open: [] })).toEqual({ kind: 'none', code: 'QUIET' });
    expect(asked).toEqual([]);
  });

  it('refuses a note that states a number the model was never given', async () => {
    const { reader } = readerOf({ note: 'Approve the 4 waiting proposals first.', order: ORDER });
    expect(await reader.monthCloseNote(FACTS)).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('refuses when the model gives no answer', async () => {
    const { reader } = readerOf(null);
    expect(await reader.monthCloseNote(FACTS)).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
