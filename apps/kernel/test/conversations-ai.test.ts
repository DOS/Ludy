// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's AI suggestions on the API side (CV3, #2306) with a stand-in for the reader: what is cached and for how long, what each state of `ai` means
// and that none of them is an error, that a call is made only when nothing is cached and the member's AI budget allows it, that a failure is logged by its
// name alone, and that the contact ranking leaves the deterministic order when the model is off, busy, spent or failing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type Intent } from '@crove/agent';
import type { ContactCandidates, IntentSource } from '@crove/kernel';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { IntentCache, matchContacts, suggestIntents, type ConversationAi, type ConversationReader } from '../src/conversations-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const src = (id: string, lastSeq = 1, texts = ['Xin chào']): IntentSource => ({ id, lastSeq, texts });

function setup(reader: Partial<ConversationReader> | null, options: { budget?: DraftBudget; now?: () => number } = {}) {
  const calls = { intents: [] as unknown[][], ranks: [] as unknown[][] };
  const full: ConversationReader | null = reader
    ? {
        intents: async (items, onUsage) => {
          calls.intents.push([...items]);
          return reader.intents ? reader.intents(items, onUsage) : items.map(() => null);
        },
        rank: async (name, names, onUsage) => {
          calls.ranks.push([name, [...names]]);
          return reader.rank ? reader.rank(name, names, onUsage) : names.map((_, i) => i);
        },
      }
    : null;
  const ai: ConversationAi = { reader: full, budget: options.budget ?? new DraftBudget(), cache: new IntentCache(options.now) };
  return { ai, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('IntentCache', () => {
  it('keeps an answer for an hour, by org, thread and newest message, and drops the oldest past its bound', () => {
    let now = 1_000;
    const cache = new IntentCache(() => now);
    cache.set(ORG, 'c1', 3, 'complaint');
    cache.set(ORG, 'c2', 3, null);
    expect(cache.get(ORG, 'c1', 3)).toBe('complaint');
    // No suggestion is an answer too: it is not asked again.
    expect(cache.get(ORG, 'c2', 3)).toBeNull();
    // A newer message, another org and another thread are not the same key.
    expect(cache.get(ORG, 'c1', 4)).toBeUndefined();
    expect(cache.get('org-2', 'c1', 3)).toBeUndefined();
    now += 60 * 60_000 + 1;
    expect(cache.get(ORG, 'c1', 3)).toBeUndefined();
    for (let i = 0; i < 2_100; i += 1) cache.set(ORG, `t${i}`, 1, 'spam');
    expect(cache.get(ORG, 't0', 1)).toBeUndefined();
    expect(cache.get(ORG, 't2099', 1)).toBe('spam');
  });
});

describe('suggestIntents', () => {
  it('asks the model for the threads that are not cached, once, and answers in the order given', async () => {
    const { ai, calls } = setup({ intents: async (items) => items.map((_, i) => (['complaint', 'question'] as const)[i] ?? null) });
    const first = await suggestIntents(ai, ORG, USER, [src('a'), src('b')]);
    expect(first).toEqual({ ai: 'used', suggestions: [{ conversationId: 'a', intent: 'complaint' }, { conversationId: 'b', intent: 'question' }] });
    expect(calls.intents).toHaveLength(1);
    // Cached: no second call, and one new thread is the only one asked about.
    const second = await suggestIntents(ai, ORG, USER, [src('b'), src('a'), src('c')]);
    expect(second.suggestions).toEqual([
      { conversationId: 'b', intent: 'question' },
      { conversationId: 'a', intent: 'complaint' },
      { conversationId: 'c', intent: 'complaint' },
    ]);
    expect(calls.intents).toHaveLength(2);
    expect(calls.intents[1]).toEqual([{ texts: ['Xin chào'] }]);
    // Nothing cached is asked for again, so a list with all of them makes no call.
    await suggestIntents(ai, ORG, USER, [src('a'), src('b'), src('c')]);
    expect(calls.intents).toHaveLength(2);
  });

  it('answers off with no suggestion when there is no model, and still answers what was cached', async () => {
    const { ai } = setup(null);
    ai.cache.set(ORG, 'a', 1, 'spam');
    expect(await suggestIntents(ai, ORG, USER, [src('a'), src('b')])).toEqual({ ai: 'off', suggestions: [{ conversationId: 'a', intent: 'spam' }, { conversationId: 'b', intent: null }] });
    expect(await suggestIntents(ai, ORG, USER, [src('a')])).toEqual({ ai: 'used', suggestions: [{ conversationId: 'a', intent: 'spam' }] });
  });

  it('answers budget when the org\'s AI budget is spent, and failed when the call fails, with no error and nothing cached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let mode: 'budget' | 'fail' | 'ok' = 'budget';
    const { ai, calls } = setup({
      intents: async (items) => {
        if (mode === 'budget') throw new AiBudgetExhaustedError('org', null);
        if (mode === 'fail') throw new TypeError('Khách viết: số thẻ 4111 1111 1111 1111');
        return items.map(() => 'question' as Intent);
      },
    });
    const none = (...ids: string[]) => ids.map((conversationId) => ({ conversationId, intent: null }));
    expect(await suggestIntents(ai, ORG, USER, [src('a')])).toEqual({ ai: 'budget', suggestions: none('a') });
    mode = 'fail';
    expect(await suggestIntents(ai, ORG, USER, [src('a')])).toEqual({ ai: 'failed', suggestions: none('a') });
    // Only the kind of error is logged, never its message (which could carry a customer's words).
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).toContain('TypeError');
    expect(JSON.stringify(error.mock.calls)).not.toContain('4111');
    // Neither was cached: the next call asks again.
    mode = 'ok';
    expect(await suggestIntents(ai, ORG, USER, [src('a')])).toEqual({ ai: 'used', suggestions: [{ conversationId: 'a', intent: 'question' }] });
    expect(calls.intents).toHaveLength(3);
  });

  it('answers busy and makes no call when the member has a call running or has used their minute', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { ai, calls } = setup({ intents: async (items) => (await held, items.map(() => 'spam' as Intent)) }, { budget: new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 }) });
    const running = suggestIntents(ai, ORG, USER, [src('a')]);
    // One at a time for a member: the second asks nothing of the model.
    expect(await suggestIntents(ai, ORG, USER, [src('b')])).toEqual({ ai: 'busy', suggestions: [{ conversationId: 'b', intent: null }] });
    release();
    expect((await running).ai).toBe('used');
    // The member's minute is spent (one a minute here): busy again, and the model is not asked.
    expect((await suggestIntents(ai, ORG, USER, [src('c')])).ai).toBe('busy');
    expect(calls.intents).toHaveLength(1);
    // Another member of the org still can (the org's own budget has room).
    expect((await suggestIntents(ai, ORG, 'user-2', [src('c')])).ai).toBe('used');
  });
});

describe('matchContacts', () => {
  const found = (over: Partial<ContactCandidates> = {}): ContactCandidates => ({
    customerName: 'Hoa Nguyen',
    phone: [{ partyId: 'p1', name: 'Trần Văn Bình' }],
    names: [
      { partyId: 'n1', name: 'Nguyễn Thị Hoa' },
      { partyId: 'n2', name: 'Nguyễn Văn Hoa' },
    ],
    ...over,
  });

  it('puts the phone match first, then the names in the order the model gave', async () => {
    const { ai, calls } = setup({ rank: async () => [1, 0] });
    expect(await matchContacts(ai, ORG, USER, found())).toEqual({
      ai: 'used',
      candidates: [
        { partyId: 'p1', name: 'Trần Văn Bình', reason: 'phone' },
        { partyId: 'n2', name: 'Nguyễn Văn Hoa', reason: 'name' },
        { partyId: 'n1', name: 'Nguyễn Thị Hoa', reason: 'name' },
      ],
    });
    expect(calls.ranks).toEqual([['Hoa Nguyen', ['Nguyễn Thị Hoa', 'Nguyễn Văn Hoa']]]);
  });

  it('asks the model nothing for fewer than two names, and keeps the deterministic order when it is off, busy, spent or failing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const one = setup({ rank: async () => [0] });
    expect((await matchContacts(one.ai, ORG, USER, found({ names: [{ partyId: 'n1', name: 'Nguyễn Thị Hoa' }] }))).ai).toBe('used');
    expect((await matchContacts(one.ai, ORG, USER, found({ customerName: null }))).ai).toBe('used');
    expect(one.calls.ranks).toHaveLength(0);
    const order = (r: Awaited<ReturnType<typeof matchContacts>>) => r.candidates.map((c) => c.partyId);
    expect(await matchContacts(setup(null).ai, ORG, USER, found()).then((r) => [r.ai, order(r)])).toEqual(['off', ['p1', 'n1', 'n2']]);
    expect(await matchContacts(setup({ rank: async () => { throw new AiBudgetExhaustedError('module', null); } }).ai, ORG, USER, found()).then((r) => [r.ai, order(r)])).toEqual(['budget', ['p1', 'n1', 'n2']]);
    expect(await matchContacts(setup({ rank: async () => { throw new Error('down'); } }).ai, ORG, USER, found()).then((r) => [r.ai, order(r)])).toEqual(['failed', ['p1', 'n1', 'n2']]);
    // The member's minute is spent (one a minute here).
    const spent = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const ticket = spent.take(ORG, USER);
    if (ticket.allowed) ticket.release();
    const busy = setup({ rank: async () => [1, 0] }, { budget: spent });
    expect(await matchContacts(busy.ai, ORG, USER, found()).then((r) => [r.ai, order(r)])).toEqual(['busy', ['p1', 'n1', 'n2']]);
    expect(busy.calls.ranks).toHaveLength(0);
  });

  it('shows at most five contacts, the phone matches first', async () => {
    const many = found({
      phone: [{ partyId: 'p1', name: 'A' }, { partyId: 'p2', name: 'B' }],
      names: Array.from({ length: 6 }, (_, i) => ({ partyId: `n${i}`, name: `Hoa ${i}` })),
    });
    const result = await matchContacts(setup(null).ai, ORG, USER, many);
    expect(result.candidates.map((c) => c.partyId)).toEqual(['p1', 'p2', 'n0', 'n1', 'n2']);
  });
});
