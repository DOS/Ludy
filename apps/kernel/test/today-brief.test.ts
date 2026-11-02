// SPDX-License-Identifier: AGPL-3.0-only
// The figures of Vy's daily brief (#2383): the Home list reduced to counts, sums per currency and due dates.
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, checkedSentences, templateBrief, type BriefFacts, type BriefResult } from '@crove/agent';
import { zTodayItem, type TodayItem } from '@crove/kernel-contract';
import type { DraftTicket } from '../src/ai-draft-limit.ts';
import { briefAnswer, briefFactsOf, vietnamDay } from '../src/today-brief.ts';

const item = (over: Record<string, unknown>): TodayItem => zTodayItem.parse({ kind: 'proposal', app: 'finance', id: 'a', title: { key: 'k' }, href: '/inbox', ...over });

describe('briefFactsOf', () => {
  it('counts what each item groups, the blocking flags and the proposals’ amounts per currency', () => {
    const facts = briefFactsOf(
      [
        item({ id: 'p1', count: 3, amount: '1000000.50' }),
        item({ id: 'p2', amount: '250000' }),
        item({ id: 'p3', amount: '10', currency: 'USD' }),
        item({ id: 'f1', kind: 'flag', severity: 'block' }),
        item({ id: 'f2', kind: 'flag', severity: 'warn', count: 2 }),
        item({ id: 'm1', kind: 'message', app: 'conversations', count: 4 }),
        item({ id: 'd1', kind: 'deadline', dueAt: '2026-11-20T00:00:00+07:00', amount: '999' }),
      ],
      'vi',
      '2026-11-02',
    );
    expect(facts).toMatchObject({ language: 'vi', today: '2026-11-02', flags: 3, blocking: 1, proposals: 5, messages: 4, deadlines: 1 });
    // A deadline's amount is not a proposal's: only the proposals are summed, each currency on its own, never converted.
    expect(facts.proposalAmounts).toEqual([
      { currency: 'VND', amount: '1250000.5' },
      { currency: 'USD', amount: '10' },
    ]);
    expect(facts.dueDates).toEqual(['2026-11-20']);
  });

  it('names the nearest three due days, in Vietnam time, once each', () => {
    // 20:00 UTC on the 3rd is already the 4th in Vietnam.
    expect(vietnamDay('2026-11-03T20:00:00Z')).toBe('2026-11-04');
    const dates = ['2026-11-30T09:00:00+07:00', '2026-11-03T20:00:00Z', '2026-11-04T08:00:00+07:00', '2026-11-12T09:00:00+07:00', '2026-12-01T09:00:00+07:00'];
    const facts = briefFactsOf(
      dates.map((dueAt, i) => item({ id: `d${i}`, kind: 'deadline', dueAt })),
      'en',
      '2026-11-02',
    );
    expect(facts.dueDates).toEqual(['2026-11-04', '2026-11-12', '2026-11-30']);
  });

  it('gives a template that passes the numbers check against its own figures, in both languages', () => {
    const items = [item({ id: 'p', count: 12, amount: '148500000' }), item({ id: 'f', kind: 'flag', severity: 'block' }), item({ id: 'd', kind: 'deadline', dueAt: '2026-11-20T00:00:00+07:00' })];
    for (const language of ['vi', 'en'] as const) {
      const facts = briefFactsOf(items, language, '2026-11-02');
      const sentences = templateBrief(facts);
      expect(checkedSentences(sentences, facts)).toEqual({ kept: sentences, dropped: 0 });
    }
  });
});

describe('briefAnswer', () => {
  const items = [item({ id: 'p', count: 12 }), item({ id: 'f', kind: 'flag', severity: 'block' })];
  const ticket = (allowed = true) => {
    const released: number[] = [];
    return { take: (): DraftTicket => (allowed ? { allowed: true, release: () => void released.push(1) } : { allowed: false, retryAfterSeconds: 5, reason: 'busy' }), released };
  };
  const vy: BriefResult = { sentences: ['Có 13 việc cần bạn.'], writtenBy: 'vy' };

  it('says nothing for an empty list, and asks nobody', async () => {
    const t = ticket();
    expect(await briefAnswer([], 'vi', '2026-11-02', async () => vy, t.take)).toEqual({ writtenBy: null, sentences: [], budgetSpent: false });
    expect(t.released).toEqual([]);
  });

  it('gives the plain template with no model, or when the member is rate limited', async () => {
    const plain = templateBrief(briefFactsOf(items, 'vi', '2026-11-02'));
    expect(await briefAnswer(items, 'vi', '2026-11-02', undefined, ticket().take)).toEqual({ writtenBy: 'template', sentences: plain, budgetSpent: false });
    const denied = ticket(false);
    let asked = false;
    expect(await briefAnswer(items, 'vi', '2026-11-02', async () => ((asked = true), vy), denied.take)).toEqual({ writtenBy: 'template', sentences: plain, budgetSpent: false });
    expect(asked).toBe(false);
  });

  it('gives what the writer wrote, built from the figures of the list only, and releases the ticket', async () => {
    const t = ticket();
    let seen: BriefFacts | undefined;
    const answer = await briefAnswer(items, 'vi', '2026-11-02', async (facts) => ((seen = facts), vy), t.take);
    expect(answer).toEqual({ writtenBy: 'vy', sentences: ['Có 13 việc cần bạn.'], budgetSpent: false });
    expect(seen).toMatchObject({ proposals: 12, flags: 1, blocking: 1, today: '2026-11-02', language: 'vi' });
    expect(t.released).toEqual([1]);
  });

  it('gives no brief, and says why, when the month’s AI budget is spent', async () => {
    const t = ticket();
    const spent = async (): Promise<BriefResult> => {
      throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00Z');
    };
    expect(await briefAnswer(items, 'en', '2026-11-02', spent, t.take)).toEqual({ writtenBy: null, sentences: [], budgetSpent: true });
    expect(t.released).toEqual([1]);
  });

  it('lets any other failure through, still releasing the ticket', async () => {
    const t = ticket();
    await expect(
      briefAnswer(items, 'en', '2026-11-02', async () => {
        throw new Error('database down');
      }, t.take),
    ).rejects.toThrow(/database down/);
    expect(t.released).toEqual([1]);
  });
});
