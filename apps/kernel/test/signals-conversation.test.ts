// SPDX-License-Identifier: AGPL-3.0-only
// Rule 4 of Vy's cross-app alerts (Vy plan C4, rule 4, issue #3124), unit part: a customer conversation unanswered past its reply window (24 hours), on an open deal. The two
// reads it joins (`crm.signals.open_deals` and the inbox's `kernel.conversation.signals_unanswered`) are stubs here; that the inbox read scopes to the member is its own db test
// (signals-conversation.db.test.ts). This file checks the join, the window and its near misses, the fail-closed paths, the grouping, and that no text crosses.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONVERSATION_REPLY_WINDOW_HOURS, CONVERSATION_UNANSWERED_SIGNALS_READ, CRM_OPEN_DEALS_SIGNALS_READ, SIGNAL_PARTIAL_VIEW_CODE, sortTodayItems, zConversationUnansweredSignal, zTodayItems } from '@crove/kernel-contract';
import { DomainError, type Lookup, type QueryContext } from '@crove/kernel-runtime';
import { CONVERSATION_UNANSWERED_READ, SIGNAL_ITEMS_MAX, checkConversationUnanswered, conversationUnansweredQuery } from '@crove/kernel';

const NOW = new Date('2026-11-20T10:00:00Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const party = randomUUID();
const other = randomUUID();
const openDeal = (over: Record<string, unknown> = {}) => ({ dealId: randomUUID(), partyId: party, ...over });
const waiting = (over: Record<string, unknown> = {}) => ({ partyId: party, conversationId: randomUUID(), since: ago(25), ...over });

type Reads = Record<string, unknown | (() => never)>;
type Actor = { type: 'user'; userId: string; aal: 'aal1'; mcp?: unknown } | { type: 'system'; component: string };
const USER: Actor = { type: 'user', userId: randomUUID(), aal: 'aal1' };

function contextOf(reads: Reads, absent: readonly string[] = [], asked: string[] = [], inputs: Record<string, unknown> = {}, actor: Actor = USER): QueryContext {
  return {
    actor,
    query: async (name: string, input?: unknown): Promise<Lookup<unknown>> => {
      asked.push(name);
      inputs[name] = input;
      const module = name.split('.')[0] as string;
      if (absent.includes(module)) return { status: 'not_installed', module };
      if (!(name in reads)) throw new DomainError('QUERY_NOT_FOUND', 404, `no query ${name}`);
      const answer = reads[name];
      if (typeof answer === 'function') (answer as () => never)();
      return { status: 'ok', value: answer };
    },
  } as unknown as QueryContext;
}

const run = (reads: Reads, options: { absent?: readonly string[]; asked?: string[]; inputs?: Record<string, unknown>; actor?: Actor } = {}) =>
  conversationUnansweredQuery({ now: () => NOW }).handler(contextOf(reads, options.absent, options.asked, options.inputs, options.actor), {});

describe('the unanswered conversation on an open deal rule (Vy C4, rule 4)', () => {
  it('is a registered kernel read, with a 24 hour window that is a constant', () => {
    expect(conversationUnansweredQuery().name).toBe(CONVERSATION_UNANSWERED_READ);
    expect(CONVERSATION_REPLY_WINDOW_HOURS).toBe(24);
  });

  it('flags a contact whose customer waited 25 hours on an open deal: a key, the hours, the moment the window closed and a link to the thread, nothing else', async () => {
    const thread = waiting();
    const inputs: Record<string, unknown> = {};
    const items = await run({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal(), openDeal()], [CONVERSATION_UNANSWERED_SIGNALS_READ]: [thread] }, { inputs });
    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'conversations',
        id: `signal:conversation-unanswered:${party}`,
        title: { key: 'signals.conversationUnanswered', params: { hours: 25 } },
        severity: 'warn',
        dueAt: ago(1),
        href: `/social/inbox?c=${thread.conversationId}`,
      },
    ]);
    expect(zTodayItems.safeParse(items).success).toBe(true);
    // The inbox is asked about the parties of the open deals only, each once.
    expect(inputs[CONVERSATION_UNANSWERED_SIGNALS_READ]).toEqual({ partyIds: [party] });
  });

  it('does not fire on its near misses: 23 hours, no open deal for the contact, another contact\'s thread, no thread at all', async () => {
    const deals = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: ago(23) })] })).toHaveLength(0);
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: ago(24) })] })).toHaveLength(1); // the whole window
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: new Date(NOW.getTime() - 24 * HOUR + 1000).toISOString() })] })).toHaveLength(0); // a second short
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ partyId: other })] })).toHaveLength(0);
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [] })).toHaveLength(0);
    expect(await run({ [CRM_OPEN_DEALS_SIGNALS_READ]: [], [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting()] })).toHaveLength(0);
    // A moment in the future (a clock a little ahead) never fires.
    expect(await run({ ...deals, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: ago(-3) })] })).toHaveLength(0);
  });

  it('asks the inbox nothing when no deal is open', async () => {
    const asked: string[] = [];
    expect(await run({ [CRM_OPEN_DEALS_SIGNALS_READ]: [], [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting()] }, { asked })).toEqual([]);
    expect(asked).toEqual([CRM_OPEN_DEALS_SIGNALS_READ]);
  });

  it('fails closed: no item when the CRM or the inbox is unregistered, off, refusing or outside the contract', async () => {
    const crm = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await run(crm)).toEqual([]);
    expect(await run(crm, { absent: ['kernel'] })).toEqual([]);
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: () => { throw new DomainError('FORBIDDEN', 403, 'no'); } })).toEqual([]);
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: () => { throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'partial'); } })).toEqual([]);
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: 'x' })).toEqual([]);
    expect(await run({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal({ title: 'Hợp đồng' })], [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting()] })).toEqual([]);
    expect(await run({}, { absent: ['crm'] })).toEqual([]);
    // A database error is not "nothing": it passes through to fail the read.
    await expect(run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
  });

  it('never looks for an AI app\'s grant, and says nothing it could not check', async () => {
    const asked: string[] = [];
    const reads = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()], [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting()] };
    const grant: Actor = { type: 'user', userId: randomUUID(), aal: 'aal1', mcp: { grantId: randomUUID(), clientId: 'c', clientName: 'C', scopes: ['ludy.read'], kind: 'company' } };
    // The rule query refuses a grant (never an empty answer that could read as "all clear"); the check itself says unavailable, so ludy_signals names the rule unchecked.
    await expect(run(reads, { actor: grant, asked })).rejects.toBeInstanceOf(DomainError);
    expect(asked).toEqual([]);
    const check = await checkConversationUnanswered(contextOf(reads, [], asked, {}, grant), () => NOW);
    expect(check).toEqual({ items: [], status: 'unavailable' });
  });

  it('lets no text cross: a thread row with a field outside the contract voids the whole read, and the rule carries only ids, keys and hours', async () => {
    const crm = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ body: 'Anh Nam hỏi giá' })] })).toEqual([]);
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ subject: 'Báo giá', channel: 'zalo' })] })).toEqual([]);
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: 'hôm qua' })] })).toEqual([]);
    expect(Object.keys(zConversationUnansweredSignal.shape).sort()).toEqual(['conversationId', 'partyId', 'since']);
    const out = JSON.stringify(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting()] }));
    expect(out).not.toMatch(/Nam|Công ty|Hợp đồng|báo giá/i);
  });

  it('reads a repeated party as outside the contract, orders the longest wait first, and caps at 20 with one grouped item', async () => {
    const crm = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await run({ ...crm, [CONVERSATION_UNANSWERED_SIGNALS_READ]: [waiting({ since: ago(30) }), waiting({ since: ago(26) })] })).toEqual([]);
    const parties = Array.from({ length: 23 }, () => randomUUID());
    const items = await run({
      [CRM_OPEN_DEALS_SIGNALS_READ]: parties.map((partyId) => openDeal({ partyId })),
      [CONVERSATION_UNANSWERED_SIGNALS_READ]: parties.map((partyId, i) => waiting({ partyId, since: ago(25 + i) })),
    });
    expect(items).toHaveLength(SIGNAL_ITEMS_MAX + 1);
    expect(items[SIGNAL_ITEMS_MAX]).toMatchObject({ id: 'signal:conversation-unanswered:more', count: 3, title: { key: 'signals.conversationUnansweredMore', params: { count: 3 } } });
    const home = sortTodayItems(items);
    expect(home.at(-1)?.id).toBe('signal:conversation-unanswered:more');
    const hours = home.slice(0, SIGNAL_ITEMS_MAX).map((i) => (i.title.params as { hours: number }).hours);
    expect(hours).toEqual([...hours].sort((x, y) => y - x));
    expect(hours[0]).toBe(25 + 22);
  });
});
