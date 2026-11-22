// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" answer (#3257, Vy plan C5), unit part: the figures are the card's own, the sentences are Vy's checked against them or the template, and the AI budget, the rate limit and AI off
// each leave the template or the figures alone. The model is a stub.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, WeeklyWriter, templateWeekly, type WeeklyFacts, type WeeklyResult } from '@ludy/agent';
import type { WeeklyFigures } from '@ludy/kernel-contract';
import type { DraftTicket } from '../src/ai-draft-limit.ts';
import { todayWeeklyQuery } from '@ludy/kernel';
import { weeklyAnswer, weeklyFactsOf } from '../src/today-weekly.ts';

const figures: WeeklyFigures = {
  from: '2026-11-10',
  to: '2026-11-16',
  before: '2026-11-09',
  deals: { won: { count: 3, amount: '45000000' }, open: 12 },
  money: { cash: { amount: '120000000', previous: '100000000' }, receivables: { amount: '30000000', previous: '35500000' }, payables: { amount: '8000000', previous: '8000000' } },
  tasks: { late: 2 },
};
const nothing: WeeklyFigures = { ...figures, deals: null, money: null, tasks: null };
const ticket = (allowed = true) => {
  const released: number[] = [];
  return { take: (): DraftTicket => (allowed ? { allowed: true, release: () => void released.push(1) } : { allowed: false, retryAfterSeconds: 5, reason: 'busy' }), released };
};
const config = { baseURL: 'http://model.invalid', model: 'stub', apiKey: 'unit-test' };
const vy: WeeklyResult = { sentences: ['Tuần qua có 3 deal thắng.'], writtenBy: 'vy', final: true };

describe('weeklyAnswer', () => {
  it('says nothing, and asks nobody, when the member can open none of what it reads', async () => {
    const t = ticket();
    let asked = false;
    expect(await weeklyAnswer(nothing, 'vi', async () => ((asked = true), vy), t.take)).toEqual({ figures: nothing, writtenBy: null, sentences: [], budgetSpent: false, final: true });
    expect(asked).toBe(false);
    expect(t.released).toEqual([]);
  });

  it('gives the template with AI off, or when the member is rate limited', async () => {
    const plain = templateWeekly(weeklyFactsOf(figures, 'vi'));
    expect(await weeklyAnswer(figures, 'vi', undefined, ticket().take)).toEqual({ figures, writtenBy: 'template', sentences: plain, budgetSpent: false, final: true });
    let asked = false;
    // Asking too often gives the template for now, not kept: the next ask can reach the model.
    expect(await weeklyAnswer(figures, 'vi', async () => ((asked = true), vy), ticket(false).take)).toEqual({ figures, writtenBy: 'template', sentences: plain, budgetSpent: false, final: false });
    expect(asked).toBe(false);
  });

  it('gives what the writer wrote, from the figures only, and releases the ticket', async () => {
    const t = ticket();
    let seen: WeeklyFacts | undefined;
    const answer = await weeklyAnswer(figures, 'en', async (facts) => ((seen = facts), vy), t.take);
    expect(answer).toEqual({ figures, writtenBy: 'vy', sentences: ['Tuần qua có 3 deal thắng.'], budgetSpent: false, final: true });
    expect(seen).toEqual({ language: 'en', deals: figures.deals, money: figures.money, tasks: figures.tasks });
    expect(t.released).toEqual([1]);
  });

  it('keeps the matching sentences and drops one with a number that is not a figure (model stub, whole path)', async () => {
    const writer = new WeeklyWriter(config, async () => ({ sentences: ['Tuần qua có 3 deal thắng.', 'Doanh thu đạt 99.000.000 đồng.'] }));
    const answer = await weeklyAnswer(figures, 'vi', (f) => writer.weekly(f), ticket().take);
    expect(answer.writtenBy).toBe('vy');
    expect(answer.sentences).toEqual(['Tuần qua có 3 deal thắng.']);
  });

  it('shows the template when no sentence passes the numbers check', async () => {
    const writer = new WeeklyWriter(config, async () => ({ sentences: ['Doanh thu đạt 99.000.000 đồng.'] }));
    const answer = await weeklyAnswer(figures, 'vi', (f) => writer.weekly(f), ticket().take);
    expect(answer.writtenBy).toBe('template');
    expect(answer.sentences).toEqual(templateWeekly(weeklyFactsOf(figures, 'vi')));
    expect(answer.final).toBe(false);
  });

  it('gives the template, and says why, when the meter refuses the call (the budget is spent or AI is switched off)', async () => {
    const t = ticket();
    const writer = new WeeklyWriter(config, async () => {
      throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00Z');
    });
    expect(await weeklyAnswer(figures, 'en', (f) => writer.weekly(f), t.take)).toEqual({ figures, writtenBy: 'template', sentences: templateWeekly(weeklyFactsOf(figures, 'en')), budgetSpent: true, final: false });
    expect(t.released).toEqual([1]);
  });

  it('lets any other failure through, still releasing the ticket', async () => {
    const t = ticket();
    await expect(
      weeklyAnswer(figures, 'en', async () => {
        throw new Error('database down');
      }, t.take),
    ).rejects.toThrow(/database down/);
    expect(t.released).toEqual([1]);
  });
});

// The cap rules: a read cut by its own cap would give an undercount, so its figure is null, never a smaller number.
describe('kernel.today_weekly.figures with reads cut by their caps', () => {
  const run = (reads: Record<string, unknown>) =>
    todayWeeklyQuery({ today: () => '2026-11-16', now: () => new Date('2026-11-16T03:00:00Z') }).handler(
      { query: async (name: string) => ({ status: 'ok', value: reads[name] }) } as unknown as Parameters<ReturnType<typeof todayWeeklyQuery>['handler']>[0],
      {},
    );
  const won = (n: number, wonOn: string) => Array.from({ length: n }, () => ({ dealId: randomUUID(), partyId: randomUUID(), wonOn, amount: '1' }));
  const open = (n: number) => Array.from({ length: n }, () => ({ dealId: randomUUID(), partyId: randomUUID() }));
  const tasks = (n: number, due: string | null) => ({ tasks: Array.from({ length: n }, () => ({ status: 'todo', due })) });

  it('gives no deal figure when the won list reached its cap and its oldest win is still inside the window', async () => {
    expect((await run({ 'crm.signals.won_deals': won(500, '2026-11-12') })).deals).toBeNull();
  });

  it('gives no open count when the open list reached its cap, and no task count when the task list did', async () => {
    const f = await run({ 'crm.signals.won_deals': [], 'crm.signals.open_deals': open(500), 'kernel.task.list': tasks(200, '2026-11-01T00:00:00Z') });
    expect(f.deals).toEqual({ won: { count: 0, amount: '0' }, open: null });
    expect(f.tasks).toBeNull();
    const ok = await run({ 'crm.signals.won_deals': [], 'crm.signals.open_deals': open(499), 'kernel.task.list': tasks(199, '2026-11-01T00:00:00Z') });
    expect(ok.deals?.open).toBe(499);
    expect(ok.tasks).toEqual({ late: 199 });
  });

  it('gives null for every group whose read is missing or outside its contract', async () => {
    const f = await run({ 'crm.signals.won_deals': [{ nope: 1 }], 'finance.overview': { nope: 1 }, 'kernel.task.list': { nope: 1 } });
    expect([f.deals, f.money, f.tasks]).toEqual([null, null, null]);
  });
});
