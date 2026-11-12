// SPDX-License-Identifier: AGPL-3.0-only
// The meetings coworker's wording of a follow-up email on the API side (L3, #2590) with a stand-in for the reader: the model is asked once with the language, the sender and
// the hint and nothing else, every state of `ai` is an answer with no words (the dialog keeps the fixed words), and a text the model's own checks accept is still held to
// the send command's checks. The two checkers (packages/agent and the contract's) agree on a shared corpus: nothing the agent accepts is refused at the send.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, checkFollowupWords, type FollowupWordsRequest, type FollowupWordsResult } from '@crove/agent';
import { FOLLOWUP_CLOSING_MAX, FOLLOWUP_LEAD_MAX, followupClean, followupWordsProblem } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { wordFollowup, type FollowupAi } from '../src/followup-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const FACTS = { lang: 'vi' as const, org: 'Công ty Tiên Phong' };
const WORDS = { lead: 'Cảm ơn mọi người đã dành thời gian cho cuộc họp.', closing: 'Nếu có gì chưa đúng, mọi người báo lại giúp.' };

function setup(answer: ((request: FollowupWordsRequest) => Promise<FollowupWordsResult>) | null, budget = new DraftBudget()) {
  const asked: FollowupWordsRequest[] = [];
  const ai: FollowupAi = {
    reader: answer
      ? {
          followupWords: async (request) => {
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

describe('wordFollowup', () => {
  it('asks the model once with the language, the sender and the hint, and answers its words', async () => {
    const { ai, asked } = setup(async () => ({ kind: 'words', words: WORDS }));
    expect(await wordFollowup(ai, ORG, USER, FACTS, 'thân mật')).toEqual({ ai: 'used', words: WORDS });
    expect(asked).toEqual([{ language: 'vi', orgName: 'Công ty Tiên Phong', hint: 'thân mật' }]);
  });

  it('says off, with no words and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await wordFollowup(ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'off', words: null });
    expect(asked).toEqual([]);
  });

  it("says busy when the member asks too often, and budget when a budget or a kill switch stops the call", async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => ({ kind: 'words', words: WORDS }), budget);
    expect((await wordFollowup(first.ai, ORG, USER, FACTS, undefined)).ai).toBe('used');
    expect(await wordFollowup(first.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'busy', words: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await wordFollowup(spent.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'budget', words: null });
  });

  it('says failed, with no words, when the call fails or its text is refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await wordFollowup(refused.ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'failed', words: null });
    const broken = setup(async () => {
      throw new Error('boom: Công ty Tiên Phong');
    });
    expect(await wordFollowup(broken.ai, ORG, USER, FACTS, 'gợi ý')).toEqual({ ai: 'failed', words: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Tiên Phong');
    expect(JSON.stringify(log.mock.calls)).not.toContain('gợi ý');
  });

  it("holds the model's words to the send command's checks too", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ai } = setup(async () => ({ kind: 'words', words: { lead: 'Hai bên xem ¥ nhé.', closing: WORDS.closing } }));
    expect(await wordFollowup(ai, ORG, USER, FACTS, undefined)).toEqual({ ai: 'failed', words: null });
  });
});

describe('the two checkers agree', () => {
  const CORPUS = [
    'Cảm ơn mọi người đã dành thời gian.',
    'Thank you for your time today.',
    'Hai bên đã thống nhất. Một lần nữa cảm ơn.',
    'Gửi 5 triệu đồng',
    'Pay twenty dollars',
    'hạn 15',
    'Truy cập https://x.test',
    'mail a@b.test',
    'pay.example.cn',
    'name (at) host',
    'ba mươi ngày',
    'Ba trăm',
    'Giá 10$',
    '₫',
    '¥',
    'www tại đây',
    '',
  ];
  it('refuses at the send whatever the agent refuses', () => {
    for (const text of CORPUS) {
      const agent = checkFollowupWords({ lead: text, closing: WORDS.closing });
      const send = followupWordsProblem(followupClean(text, false), FOLLOWUP_LEAD_MAX);
      if (agent.kind === 'none') expect(send, text).not.toBeNull();
      if (send === null) expect(agent.kind, text).toBe('words');
      const agentClosing = checkFollowupWords({ lead: WORDS.lead, closing: text });
      const sendClosing = followupWordsProblem(followupClean(text, false), FOLLOWUP_CLOSING_MAX);
      if (agentClosing.kind === 'none') expect(sendClosing, text).not.toBeNull();
    }
  });
});
