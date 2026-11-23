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

  it('refuses "one", the ordinals from the fourth up and "twice", but keeps "no one", "this one", "the last one", first, second and "once"', () => {
    for (const text of ['Do one thing first.', 'Start with the twentieth item.', 'This is the fourth step.', 'Check it twice.', 'The eleventh item waits.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
    for (const text of ['Start with this one, then the bank lines.', 'Do the last one after the others.', 'Once the lines are booked, lock the period.', 'No one step depends on the others.', 'Start with the first, then the second.']) {
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

  it('refuses the number words for a group: hundreds, dozens, a couple, a pair, a score, a handful, chục, đôi', () => {
    for (const text of ['Hundreds of lines wait.', 'Dozens of lines wait.', 'A couple of lines wait.', 'A pair of lines waits.', 'A handful of lines wait.', 'A score of lines wait.', 'Còn cả chục dòng chờ.', 'Còn đôi dòng chờ.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FIGURES' });
    }
    expect(check('Một số dòng còn chờ.').kind).toBe('note');
  });

  it('refuses a combining mark, a variation selector and a Latin small capital, which draw nothing or look like a letter', () => {
    for (const text of ['Start with the b\u034Fank lines.', 'Start with the bank lines\uFE0F.', 'Start with the \u0299ank lines.', 'Start with the bank l\u1D00ines.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'FORMAT' });
    }
    // Vietnamese stays, written in either normal form.
    expect(check('Duyệt các đề xuất trước.').kind).toBe('note');
    expect(check('Duyệt các đề xuất trước.'.normalize('NFD')).kind).toBe('note');
  });

  it('keeps "make sure ... then ...", "sau khi ... xong" and "khi ... đã được ghi", which say what comes first', () => {
    expect(check('Make sure the bank lines are booked, then lock the period.').kind).toBe('note');
    expect(check('Hãy đảm bảo các dòng sao kê đã được hạch toán rồi mới khóa sổ.').kind).toBe('note');
    expect(check('Sau khi các dòng sao kê hạch toán xong, hãy chuẩn bị tờ khai.').kind).toBe('note');
    expect(check('Khi các dòng đã được ghi, hãy khóa sổ.').kind).toBe('note');
    expect(check('Once everything is done, lock the period.').kind).toBe('note');
    // A promise and a plain done claim are still refused.
    expect(check('Tôi đảm bảo mọi thứ đúng.')).toEqual({ kind: 'none', code: 'PROMISE' });
    expect(check('Các dòng đã được ghi.')).toEqual({ kind: 'none', code: 'PROMISE' });
    expect(check('Everything is done.')).toEqual({ kind: 'none', code: 'PROMISE' });
  });

  it('refuses a done claim that only has a condition word somewhere in its clause: the clause itself must START with the condition', () => {
    for (const text of [
      'I checked when you asked and everything is done.',
      'Khi nãy mọi bút toán đã được ghi.',
      'As before everything is done.',
      'Once you check\u2014everything is done.',
      'Once you check \u2013 everything is done.',
      'Review the proposals before the VAT return is filed.',
      'Lock the period once everything is done.',
      'Lúc nãy mọi bút toán đã được ghi.',
      'Once you check, everything is done.',
    ]) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
    // The same words in a clause that starts with the condition stay allowed, the dash included.
    expect(check('Once the lines are booked, lock the period.').kind).toBe('note');
    expect(check('After you check\u2014lock the period.').kind).toBe('note');
  });

  it('refuses "I ensure" and "we ensure" as a promise, and keeps "Ensure ..." at the start of a clause as an instruction', () => {
    for (const text of ['I ensure the lines are posted.', 'We ensure everything is right.', 'I ensure it.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
    expect(check('Ensure the bank lines are booked, then lock the period.').kind).toBe('note');
    expect(check('Tôi đảm bảo mọi thứ đúng.')).toEqual({ kind: 'none', code: 'PROMISE' });
  });

  it('refuses number words written together: mườihai, mườimột, muời, twentyfive, onehundred, twothousand', () => {
    for (const text of ['Còn mườihai dòng.', 'Còn mườimột dòng.', 'Còn muời dòng.', 'Còn haimươi dòng.', 'Còn mộttrăm dòng.', 'Còn hainghìn dòng.', 'Còn bangàn dòng.', 'Còn mộttriệu dòng.', 'Còn twentyfive lines.', 'Còn onehundred lines.', 'Còn twothousand lines.', 'About fiftyfive lines wait.', 'A million lines wait.']) {
      expect(check(text), text).toEqual(expect.objectContaining({ kind: 'none' }));
    }
    // An ordinary Vietnamese or English word that holds none of them stays.
    expect(check('Các đề xuất đang chờ duyệt trước.').kind).toBe('note');
    expect(check('Start with the thirsty accountant.').kind).toBe('note');
  });

  it('refuses a look-alike letter of another script and an invisible filler, which could hide a word', () => {
    expect(check('Start with the bаnk lines.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('Start with the ㅤ bank lines.')).toEqual({ kind: 'none', code: 'FORMAT' });
    expect(check('The VAT return wіll wait.')).toMatchObject({ kind: 'none' });
  });

  it('keeps an ordering rationale that says what must come first ("once ... are booked", "before ... is filed")', () => {
    expect(check('Book the bank lines first. Once they are booked the VAT return can be prepared.').kind).toBe('note');
    expect(check('Before the VAT return is filed, review the proposals.').kind).toBe('note');
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

  it('refuses a stretch of time counted from now: this, next and last week or month, mid-month, the end of the month, rằm, Tết', () => {
    for (const text of ['Do it next week.', 'Close the items of this month.', 'Wait until next month.', 'Finish mid-month.', 'Do it before the end of the month.', 'Xử lý các việc của tháng này.', 'Làm trong tuần này.', 'Làm vào đầu tháng sau.', 'Làm trước rằm.', 'Làm trước Tết.', 'Làm vào cuối tháng.']) {
      expect(check(text), text).toEqual({ kind: 'none', code: 'DATE' });
    }
    expect(check('Close the items in this order.').kind).toBe('note');
    expect(check('Xử lý các việc theo thứ tự này.').kind).toBe('note');
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
