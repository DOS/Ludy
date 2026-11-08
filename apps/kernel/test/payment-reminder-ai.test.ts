// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's wording of a payment reminder on the API side (#2488, slice 2) with a stand-in for the reader: the model is asked once with the
// notice level, the language, the sender and the hint and nothing else, and every state of `ai` is an answer with no words (the screen then keeps the fixed
// template), never an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type ReminderWordsRequest, type ReminderWordsResult } from '@crove/agent';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { wordReminder, type ReminderAi } from '../src/payment-reminder-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const FACTS = { level: 2 as const, lang: 'vi' as const, org: 'Công ty TNHH Ánh Dương' };
const WORDS = { lead: 'Chúng tôi xin nhắc Quý khách về các hóa đơn dưới đây.', closing: 'Rất mong sớm nhận được phản hồi.' };

function setup(answer: ((request: ReminderWordsRequest) => Promise<ReminderWordsResult>) | null, budget = new DraftBudget()) {
  const asked: ReminderWordsRequest[] = [];
  const ai: ReminderAi = {
    reader: answer
      ? {
          reminderWords: async (request) => {
            asked.push(request);
            return answer(request);
          },
        }
      : null,
    budget,
  };
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('wordReminder', () => {
  it('asks the model once with the level, the language, the sender and the hint, and answers its words', async () => {
    const { ai, asked } = setup(async () => ({ kind: 'words', words: WORDS }));
    expect(await wordReminder(ai, ORG, USER, FACTS, 'khách quen')).toEqual({ ai: 'used', words: WORDS });
    expect(asked).toEqual([{ level: 2, language: 'vi', orgName: 'Công ty TNHH Ánh Dương', hint: 'khách quen' }]);
  });

  it('leaves the hint out of the ask when there is none', async () => {
    const { ai, asked } = setup(async () => ({ kind: 'words', words: WORDS }));
    await wordReminder(ai, ORG, USER, FACTS, undefined);
    expect(asked[0]).toEqual({ level: 2, language: 'vi', orgName: 'Công ty TNHH Ánh Dương' });
  });

  it('says off, with no words and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await wordReminder(ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'off', words: null });
    expect(asked).toEqual([]);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => ({ kind: 'words', words: WORDS }), budget);
    expect((await wordReminder(first.ai, ORG, USER, FACTS, undefined)).ai).toBe('used');
    expect(await wordReminder(first.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'busy', words: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await wordReminder(spent.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'budget', words: null });
  });

  it('says failed, with no words, when the call fails or its text was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await wordReminder(refused.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'failed', words: null });
    const broken = setup(async () => {
      throw new Error('boom: Công ty TNHH Ánh Dương');
    });
    expect(await wordReminder(broken.ai, ORG, USER, FACTS, 'hint text')).toEqual({ ai: 'failed', words: null });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('FIGURES');
    expect(logged).not.toContain('Ánh Dương');
    expect(logged).not.toContain('hint text');
  });

  it('frees the member\'s slot after a call, however it ended', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 });
    const failing = setup(async () => {
      throw new Error('x');
    }, budget);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await wordReminder(failing.ai, ORG, USER, FACTS, undefined);
    const ok = setup(async () => ({ kind: 'words', words: WORDS }), budget);
    expect((await wordReminder(ok.ai, ORG, USER, FACTS, undefined)).ai).toBe('used');
  });
});
