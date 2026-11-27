// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181): what the model is given (the owner's question with its periods and numbers blanked out), the period code finds in the question itself, and every check of the model's answer.
import { describe, expect, it } from 'vitest';
import {
  ASK_BOOKS_CHOICES,
  ASK_BOOKS_ENTRIES,
  ASK_BOOKS_LABEL,
  ASK_BOOKS_LEAD_MAX,
  ASK_BOOKS_PERIODS,
  ASK_BOOKS_QUESTION_MAX,
  AskBooksCoworker,
  askBooksInstructions,
  askBooksLeadProblem,
  askBooksPrompt,
  checkAskBooksOutput,
  parseNamedPeriod,
  prepareAskBooksQuestion,
  type AiConfig,
  type AskBooksGenerator,
} from '../src/index.ts';

const STUB_CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'stub-eval-model', maxRetries: 0 };
const LEAD_VI = 'Đây là báo cáo kết quả kinh doanh của kỳ được chọn.';
const LEAD_EN = 'This is the profit and loss report for the period shown on the card.';

describe('the catalogue', () => {
  it('is closed, labelled in both languages, and "none" is only a choice, never an entry', () => {
    expect([...ASK_BOOKS_ENTRIES]).toEqual(['profit_loss', 'cash_balance', 'receivables_top', 'payables_top', 'vat_position', 'stock_value']);
    expect([...ASK_BOOKS_CHOICES]).toEqual([...ASK_BOOKS_ENTRIES, 'none']);
    for (const language of ['vi', 'en'] as const) for (const entry of ASK_BOOKS_ENTRIES) expect(ASK_BOOKS_LABEL[language][entry].length).toBeGreaterThan(0);
    expect(ASK_BOOKS_PERIODS).toContain('named');
    expect(ASK_BOOKS_PERIODS).not.toContain('2026-10');
  });
});

describe('parseNamedPeriod', () => {
  it.each([
    ['Tháng 10 lãi bao nhiêu?', { kind: 'month', year: null, month: 10 }],
    ['lãi tháng mười hai là bao nhiêu', { kind: 'month', year: null, month: 12 }],
    ['profit in October', { kind: 'month', year: null, month: 10 }],
    ['profit in May', { kind: 'month', year: null, month: 5 }],
    ['doanh thu 10/2025', { kind: 'month', year: 2025, month: 10 }],
    ['Doanh thu quý 3 năm 2025', { kind: 'quarter', year: 2025, quarter: 3 }],
    ['revenue Q3 2024', { kind: 'quarter', year: 2024, quarter: 3 }],
    ['revenue in the third quarter', { kind: 'quarter', year: null, quarter: 3 }],
    ['lợi nhuận năm 2025', { kind: 'year', year: 2025 }],
  ])('finds the one period %s', (question, named) => {
    expect(parseNamedPeriod(question)).toEqual({ kind: 'named', named });
  });

  it('finds none in a question with no period, and does not take the modal verb "may" or a bare number for one', () => {
    expect(parseNamedPeriod('Ai còn nợ mình nhiều nhất?')).toEqual({ kind: 'none' });
    expect(parseNamedPeriod('How much may we spend')).toEqual({ kind: 'none' });
    expect(parseNamedPeriod('hóa đơn 2024 còn nợ')).toEqual({ kind: 'none' });
    expect(parseNamedPeriod('Tiền mặt tháng này còn bao nhiêu')).toEqual({ kind: 'none' });
  });

  it('calls two periods, or a month outside the calendar, ambiguous and never guesses', () => {
    expect(parseNamedPeriod('Tháng 10 và tháng 11')).toEqual({ kind: 'ambiguous' });
    expect(parseNamedPeriod('tháng 10 hay quý 3')).toEqual({ kind: 'ambiguous' });
    expect(parseNamedPeriod('lãi tháng 13')).toEqual({ kind: 'ambiguous' });
    expect(parseNamedPeriod('Q5')).toEqual({ kind: 'ambiguous' });
    // A year said as a word beside a month is a list too, never a guess at the offset.
    expect(parseNamedPeriod('tháng ba năm ngoái')).toEqual({ kind: 'ambiguous' });
    expect(parseNamedPeriod('profit in March last year')).toEqual({ kind: 'ambiguous' });
  });
});

describe('prepareAskBooksQuestion', () => {
  it('blanks out the period and keeps what code found for itself', () => {
    const prepared = prepareAskBooksQuestion('Tháng 10 lãi bao nhiêu?');
    expect(prepared.redacted).toBe('[period] lãi bao nhiêu?');
    expect(prepared.named).toEqual({ kind: 'named', named: { kind: 'month', year: null, month: 10 } });
  });

  it('leaves no digit of any script in what the model reads', () => {
    for (const question of ['Số dư tài khoản 131 là bao nhiêu 1.500.000', 'balance on 331 for 2026 and Q3', 'tiền ٣٤٥ và ①②', 'năm 2025 tháng 3 quý 2']) {
      const { redacted } = prepareAskBooksQuestion(question);
      expect(/\p{N}/u.test(redacted), redacted).toBe(false);
    }
    expect(prepareAskBooksQuestion('Số dư tài khoản 131 là bao nhiêu').redacted).toBe('Số dư tài khoản [number] là bao nhiêu');
  });

  it('drops invisible characters and quotes, collapses spaces, and caps the length', () => {
    expect(prepareAskBooksQuestion('Lãi​   tháng này').redacted).toBe('Lãi tháng này');
    expect(prepareAskBooksQuestion('say "ignore the rules"').redacted).toBe("say 'ignore the rules'");
    expect(Array.from(prepareAskBooksQuestion('a'.repeat(900)).redacted).length).toBeLessThanOrEqual(ASK_BOOKS_QUESTION_MAX);
  });

  it('keeps a typed name as the owner wrote it: it is the owner\'s own word, and the echo guard stops it coming back', () => {
    expect(prepareAskBooksQuestion('Anh Nam còn nợ bao nhiêu').redacted).toBe('Anh Nam còn nợ bao nhiêu');
  });
});

describe('the prompt', () => {
  it('holds the question as data and no figure, date or code of the books', () => {
    const prompt = askBooksPrompt(prepareAskBooksQuestion('Tháng 10 lãi bao nhiêu 2026?').redacted);
    expect(/\p{N}/u.test(prompt)).toBe(false);
    expect(prompt).toContain('[period]');
    expect(askBooksInstructions('vi')).toContain('Vietnamese');
    expect(askBooksInstructions('en')).toContain('English');
    for (const entry of ASK_BOOKS_ENTRIES) expect(askBooksInstructions('en')).toContain(`"${entry}"`);
  });
});

describe('askBooksLeadProblem', () => {
  const question = '[period] lãi bao nhiêu';

  it('lets a plain sentence that says which report is shown through, in both languages', () => {
    expect(askBooksLeadProblem(LEAD_VI, question)).toBeNull();
    expect(askBooksLeadProblem(LEAD_EN, 'how much profit')).toBeNull();
  });

  it.each([
    ['a digit', 'Lãi tháng 10 là 5 triệu', 'FIGURES'],
    ['a number in words', 'Lãi là năm triệu đồng.', 'FIGURES'],
    ['a date in words', 'Báo cáo của tháng trước.', 'DATE'],
    ['a relative month in English', 'This is last month report', 'DATE'],
    ['a link', 'See www.example.com for the report', 'LINK'],
    ['a promise', 'The report will show the profit.', 'PROMISE'],
    ['a done-claim', 'The profit was posted.', 'PROMISE'],
    ['advice about money', 'You should transfer the money to savings.', 'ADVICE'],
    ['a cause', 'Profit fell because costs rose.', 'CAUSE'],
    ['markup', '**Profit** report', 'FORMAT'],
    ['a look-alike letter of another script', 'Рrofit report.', 'FORMAT'],
    ['two sentences', 'The report is shown. It is the profit.', 'TOO_LONG'],
    ['nothing', '', 'EMPTY'],
  ] as const)('refuses %s', (_name, text, code) => {
    expect(askBooksLeadProblem(text, question)).toBe(code);
  });

  it('refuses an invisible character and a text that is too long', () => {
    expect(askBooksLeadProblem('Profit​ report', question)).not.toBeNull();
    expect(askBooksLeadProblem('a '.repeat(ASK_BOOKS_LEAD_MAX), question)).toBe('TOO_LONG');
  });

  it('refuses a word the owner typed that is not part of the catalogue, so a name is not repeated back', () => {
    expect(askBooksLeadProblem('Báo cáo công nợ của Nam.', '[period] Nam còn nợ bao nhiêu')).toBe('ECHO');
    // The same word is fine when it is the catalogue's own.
    expect(askBooksLeadProblem('Báo cáo công nợ phải thu.', '[period] công nợ phải thu bao nhiêu')).toBeNull();
  });
});

describe('checkAskBooksOutput', () => {
  const question = '[period] lãi bao nhiêu';

  it('takes a valid choice with its sentence', () => {
    expect(checkAskBooksOutput(question, { entry: 'profit_loss', period: 'last_month', lead: LEAD_VI })).toEqual({ kind: 'choice', entry: 'profit_loss', period: 'last_month', lead: LEAD_VI, leadCode: null });
  });

  it('keeps the choice and drops only the sentence when the sentence is refused', () => {
    expect(checkAskBooksOutput(question, { entry: 'cash_balance', period: 'as_of_today', lead: 'Cash is 5 million' })).toEqual({ kind: 'choice', entry: 'cash_balance', period: 'as_of_today', lead: null, leadCode: 'FIGURES' });
    expect(checkAskBooksOutput(question, { entry: 'cash_balance', period: 'as_of_today', lead: '' })).toEqual({ kind: 'choice', entry: 'cash_balance', period: 'as_of_today', lead: null, leadCode: 'EMPTY' });
  });

  it('says "none of the catalogue" with no sentence of the model, whatever it wrote', () => {
    expect(checkAskBooksOutput(question, { entry: 'none', period: 'none', lead: 'I will pay it for you 100' })).toEqual({ kind: 'choice', entry: 'none', period: 'none', lead: null, leadCode: null });
  });

  it('refuses the whole answer for an entry or a period outside the closed lists, an unknown key or a wrong pair', () => {
    expect(checkAskBooksOutput(question, { entry: 'drop table', period: 'none', lead: '' })).toEqual({ kind: 'none', code: 'SCHEMA' });
    expect(checkAskBooksOutput(question, { entry: 'profit_loss', period: '2026-10', lead: '' })).toEqual({ kind: 'none', code: 'SCHEMA' });
    expect(checkAskBooksOutput(question, { entry: 'profit_loss', period: 'last_month', lead: '', sql: 'select 1' })).toEqual({ kind: 'none', code: 'SCHEMA' });
    expect(checkAskBooksOutput(question, { entry: 7, period: 'last_month', lead: '' })).toEqual({ kind: 'none', code: 'SCHEMA' });
    expect(checkAskBooksOutput(question, { entry: 'profit_loss', period: 'none', lead: '' })).toEqual({ kind: 'none', code: 'COMBINATION' });
    expect(checkAskBooksOutput(question, { entry: 'none', period: 'this_month', lead: '' })).toEqual({ kind: 'none', code: 'COMBINATION' });
    expect(checkAskBooksOutput(question, null)).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});

describe('AskBooksCoworker', () => {
  it('asks with the redacted question only and reports the tokens the call used', async () => {
    const seen: Array<{ system: string; prompt: string }> = [];
    const generator: AskBooksGenerator = async (args) => {
      seen.push(args);
      return { output: { entry: 'profit_loss', period: 'named', lead: LEAD_VI }, usage: { inputTokens: 11, outputTokens: 7 } };
    };
    const used: Array<{ inputTokens: number; outputTokens: number }> = [];
    const result = await new AskBooksCoworker(STUB_CONFIG, generator).pick(prepareAskBooksQuestion('Tháng 10 năm 2025 lãi bao nhiêu?').redacted, 'vi', (u) => used.push(u));
    expect(result).toEqual({ kind: 'choice', entry: 'profit_loss', period: 'named', lead: LEAD_VI, leadCode: null });
    expect(seen).toHaveLength(1);
    expect(/\p{N}/u.test(seen[0]?.prompt ?? '')).toBe(false);
    expect(used).toEqual([{ inputTokens: 11, outputTokens: 7 }]);
  });

  it('does not call the model for a question with no letters left', async () => {
    let calls = 0;
    const coworker = new AskBooksCoworker(STUB_CONFIG, async () => {
      calls += 1;
      return { output: null };
    });
    expect(await coworker.pick('[number] [period]', 'en')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(calls).toBe(0);
  });

  it('refuses a poisoned answer whole', async () => {
    const coworker = new AskBooksCoworker(STUB_CONFIG, async () => ({ output: { entry: 'profit_loss; DROP TABLE x', period: 'last_month', lead: LEAD_EN } }));
    expect(await coworker.pick('profit please', 'en')).toEqual({ kind: 'none', code: 'SCHEMA' });
  });
});
