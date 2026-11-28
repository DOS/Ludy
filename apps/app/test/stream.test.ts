// Client side of the invalidation stream (issue #69): a hint marks stale exactly the cached queries that show that
// record (by id) or list its kind, events are parsed strictly, and the client reconnects with a fresh ticket.
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { STREAM_HINT_MANY_ID, type contract } from '@ludy/kernel-contract';
import {
  ACCESS_RETRY_MS,
  RECONNECT_MIN_MS,
  invalidateHint,
  parseCloseEvent,
  parseHintEvent,
  startStreamClient,
  type EventSourceLike,
} from '../src/lib/stream.ts';

const client: ContractRouterClient<typeof contract> = createORPCClient(new RPCLink({ url: 'http://localhost/api/rpc' }));
const orpc = createTanstackQueryUtils(client);

const P1 = '0190a000-0000-7000-8000-000000000001';
const P2 = '0190a000-0000-7000-8000-000000000002';
const FILE = '0190a000-0000-7000-8000-0000000000f1';
const ENTRY = '0190a000-0000-7000-8000-0000000000e1';
const DOC = '0190a000-0000-7000-8000-0000000000d1';

const SOCIAL = '0190a000-0000-7000-8000-0000000000c1';
const DEAL = '0190a000-0000-7000-8000-0000000000b1';
const DEAL2 = '0190a000-0000-7000-8000-0000000000b2';
const CONTACT = '0190a000-0000-7000-8000-0000000000a5';
const CONTACT2 = '0190a000-0000-7000-8000-0000000000a6';

function seeded() {
  const qc = new QueryClient();
  const keys = {
    inboxPending: orpc.inbox.list.queryKey({ input: { status: 'pending' } }),
    inboxDone: orpc.inbox.list.queryKey({ input: { status: 'executed' } }),
    detail1: orpc.inbox.get.queryKey({ input: { id: P1 } }),
    detail2: orpc.inbox.get.queryKey({ input: { id: P2 } }),
    files: orpc.files.recent.queryKey(),
    marketplaceStaged: orpc.marketplace.staged.queryKey({ input: {} }),
    batch: orpc.files.batch.queryKey({ input: { ids: [FILE] } }),
    journal: orpc.journal.list.queryKey({ input: {} }),
    entry: orpc.journal.get.queryKey({ input: { id: ENTRY } }),
    documents: orpc.documents.list.queryKey({ input: {} }),
    parties: orpc.parties.list.queryKey({ input: {} }),
    salesGaps: orpc.vat.salesNumberGaps.queryKey({ input: { period: '2026-09' } }),
    customers: orpc.parties.customers.infiniteKey({ input: () => ({}), initialPageParam: undefined }),
    ledger: orpc.ledger.period.queryKey({ input: { period: '2026-09' } }),
    ledgerAccount: orpc.ledger.account.queryKey({ input: { period: '2026-09', accountCode: '331' } }),
    overview: orpc.financeOverview.get.queryKey({ input: { range: 'last_30_days' } }),
    overviewExplain: orpc.financeOverview.explain.queryKey({ input: { range: 'last_30_days' } }),
    homeMoney: orpc.financeHomeMoney.get.queryKey({ input: {} }),
    monthClose: orpc.financeMonthClose.get.queryKey({ input: { month: '2026-10' } }),
    monthCloseExplain: orpc.financeMonthClose.explain.queryKey({ input: { month: '2026-10' } }),
    yearEnd: orpc.financeYearEnd.get.queryKey({ input: { year: 2026 } }),
    yearEndExplain: orpc.financeYearEnd.explain.queryKey({ input: { year: 2026 } }),
    me: orpc.me.get.queryKey(),
    org: orpc.org.get.queryKey(),
    socialList: orpc.social.posts.list.queryKey({ input: {} }),
    socialPost: orpc.social.posts.get.queryKey({ input: { postId: SOCIAL } }),
    socialOther: orpc.social.posts.get.queryKey({ input: { postId: '0190a000-0000-7000-8000-0000000000c2' } }),
    socialQueue: orpc.social.queues.get.queryKey({ input: { connectionId: '0190a000-0000-7000-8000-0000000000c3' } }),
    socialSlots: orpc.social.queues.openSlots.queryKey({ input: { connectionId: '0190a000-0000-7000-8000-0000000000c3', from: '2026-10-23T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' } }),
    socialNotifications: orpc.social.notifications.list.queryKey({ input: {} }),
    dealBoard: orpc.crm.deals.board.queryKey({ input: {} }),
    dealList: orpc.crm.deals.list.infiniteKey({ input: () => ({}), initialPageParam: undefined }),
    dealGet: orpc.crm.deals.get.queryKey({ input: { dealId: DEAL } }),
    dealGetOther: orpc.crm.deals.get.queryKey({ input: { dealId: DEAL2 } }),
    dealsOfContact: orpc.crm.deals.byParty.queryKey({ input: { partyId: CONTACT } }),
    companyPeople: [...orpc.crm.contacts.key(), 'company-people', CONTACT2],
    nextSteps: orpc.crm.nextSteps.list.queryKey({ input: {} }),
    dealsOfOtherContact: orpc.crm.deals.byParty.queryKey({ input: { partyId: CONTACT2 } }),
    contactList: orpc.crm.contacts.list.infiniteKey({ input: () => ({}), initialPageParam: undefined }),
    contactSearch: orpc.crm.parties.search.queryKey({ input: { q: 'abc', limit: 5 } }),
    contactTimeline: orpc.parties.timeline.queryKey({ input: { partyId: CONTACT } }),
    otherTimeline: orpc.parties.timeline.queryKey({ input: { partyId: CONTACT2 } }),
  };
  // Partial records: invalidateHint reads only the ids, so the seeds skip the rest of each response's shape.
  const seed = (key: QueryKey, data: unknown) => qc.setQueryData(key, data);
  for (const key of Object.values(keys)) seed(key, {});
  seed(keys.detail1, { file: { id: FILE }, result: { documentId: DOC, journalEntryId: ENTRY } });
  seed(keys.detail2, { file: { id: '0190a000-0000-7000-8000-0000000000f2' }, result: null });
  const stale = () =>
    Object.entries(keys)
      .filter(([, key]) => qc.getQueryState(key)?.isInvalidated)
      .map(([name]) => name)
      .sort();
  return { qc, stale };
}

describe('invalidateHint', () => {
  it('proposal: the inbox lists, the files lists and that proposal only', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'proposal', id: P1 });
    // batch: the intake list's files, whose chips follow their proposal (#2009).
    // monthClose: the month-close checklist counts the proposals that still wait.
    expect(stale()).toEqual(['batch', 'detail1', 'files', 'inboxDone', 'inboxPending', 'monthClose', 'monthCloseExplain']);
  });

  it('file and extraction: the lists and the proposal that shows the file', async () => {
    for (const type of ['file', 'extraction'] as const) {
      const { qc, stale } = seeded();
      await invalidateHint(qc, { type, id: FILE });
      // marketplaceStaged: an order report read in the sandbox shows up as its card without a reload (#2515).
      expect(stale()).toEqual(['batch', 'detail1', 'files', 'inboxDone', 'inboxPending', 'marketplaceStaged']);
    }
  });

  it('journal_entry: the journal, that entry, the documents, the ledger reports, the overview, the Home money tiles, the customers and the proposal that posted it', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'journal_entry', id: ENTRY });
    expect(stale()).toEqual(['customers', 'detail1', 'documents', 'entry', 'homeMoney', 'journal', 'ledger', 'ledgerAccount', 'monthClose', 'monthCloseExplain', 'overview', 'overviewExplain', 'yearEnd', 'yearEndExplain']);
  });

  it('document: the documents, the vendors, the customers, the sales number gaps and the proposal that recorded it', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'document', id: DOC });
    expect(stale()).toEqual(['customers', 'detail1', 'documents', 'parties', 'salesGaps']);
  });

  it('social_post: the calendar, that post and the queues', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'social_post', id: SOCIAL });
    expect(stale()).toEqual(['socialList', 'socialPost', 'socialQueue', 'socialSlots']);
  });

  it('social_notification: only the notification list (#637)', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'social_notification', id: SOCIAL });
    expect(stale()).toEqual(['socialNotifications']);
  });

  it('todo: invalidates to-do lists, personal list registry, and linked record notes panels (#2595, #3558)', async () => {
    const qc = new QueryClient();
    const todos = orpc.notes.todos.list.queryKey({ input: { view: 'open', limit: 20 } });
    const lists = orpc.notes.todos.lists.list.queryKey({ input: {} });
    const panel = orpc.notes.panel.queryKey({ input: { targetType: 'kernel.task', targetId: P1 } });
    const note = orpc.notes.get.queryKey({ input: { noteId: P2 } });
    const seed = (key: QueryKey) => qc.setQueryData(key, {});
    for (const key of [todos, lists, panel, note]) seed(key);
    await invalidateHint(qc, { type: 'todo', id: '0190a000-0000-7000-8000-0000000000a1' });
    expect(qc.getQueryState(todos)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(lists)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(panel)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(note)?.isInvalidated).toBe(false);
  });

  it('home_layout: invalidates only overview.homeLayout.get (#4925)', async () => {
    const qc = new QueryClient();
    const homeLayout = orpc.overview.homeLayout.get.queryKey({ input: {} });
    const me = orpc.me.get.queryKey();
    const org = orpc.org.get.queryKey();
    const seed = (key: QueryKey) => qc.setQueryData(key, {});
    for (const key of [homeLayout, me, org]) seed(key);
    await invalidateHint(qc, { type: 'home_layout', id: P1 });
    expect(qc.getQueryState(homeLayout)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(me)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(org)?.isInvalidated).toBe(false);
  });

  it('org_apps: invalidates both org.apps and overview.homeLayout.get (#4925)', async () => {
    const qc = new QueryClient();
    const orgApps = orpc.org.apps.queryKey();
    const homeLayout = orpc.overview.homeLayout.get.queryKey({ input: {} });
    const me = orpc.me.get.queryKey();
    const seed = (key: QueryKey) => qc.setQueryData(key, {});
    for (const key of [orgApps, homeLayout, me]) seed(key);
    await invalidateHint(qc, { type: 'org_apps', id: P1 });
    expect(qc.getQueryState(orgApps)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(homeLayout)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(me)?.isInvalidated).toBe(false);
  });

  it('crm_deal: the deal board and list, that deal, the contacts\' deals and the contacts list (#3293)', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'crm_deal', id: DEAL });
    expect(stale()).toEqual(['contactList', 'contactTimeline', 'dealBoard', 'dealGet', 'dealList', 'dealsOfContact', 'dealsOfOtherContact', 'nextSteps', 'otherTimeline']);
  });

  it('crm_party: the contacts, the deal cards, and that contact\'s own panels only (#3293)', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'crm_party', id: CONTACT });
    expect(stale()).toEqual(['companyPeople', 'contactList', 'contactSearch', 'contactTimeline', 'dealBoard', 'dealGet', 'dealGetOther', 'dealList', 'dealsOfContact']);
  });

  it('a bulk crm hint (the nil id) re-reads every view of its type, whichever row a panel is about (#3423)', async () => {
    const party = seeded();
    await invalidateHint(party.qc, { type: 'crm_party', id: STREAM_HINT_MANY_ID });
    expect(party.stale()).toEqual(['companyPeople', 'contactList', 'contactSearch', 'contactTimeline', 'dealBoard', 'dealGet', 'dealGetOther', 'dealList', 'dealsOfContact', 'dealsOfOtherContact', 'otherTimeline']);
    const deal = seeded();
    await invalidateHint(deal.qc, { type: 'crm_deal', id: STREAM_HINT_MANY_ID });
    expect(deal.stale()).toEqual(['contactList', 'contactTimeline', 'dealBoard', 'dealGet', 'dealGetOther', 'dealList', 'dealsOfContact', 'dealsOfOtherContact', 'nextSteps', 'otherTimeline']);
    expect(parseHintEvent(JSON.stringify({ type: 'crm_party', id: STREAM_HINT_MANY_ID }))).toEqual({ type: 'crm_party', id: STREAM_HINT_MANY_ID });
  });

  it('crm hints leave the finance vendors and customers, Social and the apps list alone', async () => {
    for (const type of ['crm_deal', 'crm_party'] as const) {
      const { qc, stale } = seeded();
      await invalidateHint(qc, { type, id: DEAL });
      for (const name of ['parties', 'customers', 'socialList', 'socialPost', 'inboxPending', 'journal', 'documents', 'me', 'org']) expect(stale(), `${type} ${name}`).not.toContain(name);
    }
  });

  it('with crm off no crm query is cached, so a crm hint refreshes nothing and fetches nothing (#3293)', async () => {
    // An org without the crm app shows no CRM screen: its cache holds the other apps' queries only (the server drops the hints of an app that is off as well).
    const qc = new QueryClient();
    const finance: QueryKey = orpc.documents.list.queryKey({ input: {} });
    const social: QueryKey = orpc.social.posts.list.queryKey({ input: {} });
    qc.setQueryData(finance, {});
    qc.setQueryData(social, {});
    await invalidateHint(qc, { type: 'crm_deal', id: DEAL });
    await invalidateHint(qc, { type: 'crm_party', id: CONTACT });
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([finance, social]);
    expect(qc.getQueryState(finance)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(social)?.isInvalidated).toBe(false);
  });

  it('never touches unrelated queries', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'proposal', id: '0190a000-0000-7000-8000-0000000000aa' });
    expect(stale()).not.toContain('me');
    expect(stale()).not.toContain('org');
    expect(stale()).not.toContain('detail1');
  });
});

describe('event parsing', () => {
  it('accepts the crm hint types with a uuid id only (#3293)', () => {
    expect(parseHintEvent(JSON.stringify({ type: 'crm_deal', id: DEAL }))).toEqual({ type: 'crm_deal', id: DEAL });
    expect(parseHintEvent(JSON.stringify({ type: 'crm_party', id: CONTACT }))).toEqual({ type: 'crm_party', id: CONTACT });
    expect(parseHintEvent(JSON.stringify({ type: 'crm.deal', id: DEAL }))).toBeNull();
    expect(parseHintEvent(JSON.stringify({ type: 'crm_deal', id: 'not-a-uuid' }))).toBeNull();
  });

  it('accepts a known type with a uuid id only', () => {
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: P1 }))).toEqual({ type: 'proposal', id: P1 });
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: P1, extra: 1 }))).toEqual({ type: 'proposal', id: P1 });
    expect(parseHintEvent(JSON.stringify({ type: 'secret', id: P1 }))).toBeNull();
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: 'x' }))).toBeNull();
    expect(parseHintEvent('not json')).toBeNull();
  });

  it('reads a close reason, unknown ones as unavailable', () => {
    expect(parseCloseEvent(JSON.stringify({ reason: 'membership' }))).toBe('membership');
    expect(parseCloseEvent(JSON.stringify({ reason: 'whatever' }))).toBe('unavailable');
    expect(parseCloseEvent('')).toBe('unavailable');
  });
});

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, (event: { data?: string }) => void>();
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, data: unknown = {}) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

function harness(ticket: () => Promise<string> = async () => `t${Math.random()}`) {
  const sources: FakeEventSource[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const calls = { hints: [] as unknown[], resyncs: 0, access: [] as string[], live: [] as boolean[] };
  let clock = 0;
  const stop = startStreamClient({
    ticket,
    open: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    hint: (h) => void calls.hints.push(h),
    resync: () => void calls.resyncs++,
    accessChanged: (r) => void calls.access.push(r),
    live: (l) => void calls.live.push(l),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    now: () => clock,
    random: () => 1,
  });
  const fireTimer = async () => {
    const timer = timers.shift();
    timer?.fn();
    await vi.waitFor(() => undefined);
    return timer?.ms;
  };
  return { sources, timers, calls, stop, fireTimer, advance: (ms: number) => (clock += ms) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startStreamClient', () => {
  it('opens with a ticket, passes hints on, and resyncs after a reconnect', async () => {
    const h = harness(async () => 'abc');
    await tick();
    expect(h.sources[0]?.url).toBe('/api/stream?ticket=abc');
    h.sources[0]?.fire('ready', { recheckSeconds: 30 });
    expect(h.calls.live).toEqual([true]);
    expect(h.calls.resyncs).toBe(0);
    h.sources[0]?.fire('invalidate', { type: 'file', id: FILE });
    h.sources[0]?.fire('invalidate', { type: 'bogus', id: FILE });
    expect(h.calls.hints).toEqual([{ type: 'file', id: FILE }]);

    // A dropped connection never reuses the spent ticket: it closes and reconnects with a new one.
    h.sources[0]?.onerror?.({});
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.calls.live).toEqual([true, false]);
    expect(h.timers[0]?.ms).toBe(RECONNECT_MIN_MS);
    await h.fireTimer();
    await tick();
    expect(h.sources).toHaveLength(2);
    h.sources[1]?.fire('ready');
    expect(h.calls.resyncs).toBe(1);
    h.stop();
    expect(h.sources[1]?.closed).toBe(true);
  });

  it('backs off while streams keep failing, and resets after a stable one', async () => {
    const h = harness();
    await tick();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.sources.at(-1)?.fire('ready');
      h.sources.at(-1)?.fire('close', { reason: 'unavailable' });
      delays.push((await h.fireTimer()) as number);
      await tick();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    h.sources.at(-1)?.fire('ready');
    h.advance(60_000);
    h.sources.at(-1)?.fire('close', { reason: 'expired' });
    expect(h.timers[0]?.ms).toBe(RECONNECT_MIN_MS);
    h.stop();
  });

  it('on an access reason, lets the app re-check and waits before reconnecting', async () => {
    const h = harness();
    await tick();
    h.sources[0]?.fire('ready');
    h.sources[0]?.fire('close', { reason: 'membership' });
    expect(h.calls.access).toEqual(['membership']);
    expect(h.timers[0]?.ms).toBe(ACCESS_RETRY_MS);
    // The error that follows the server's close is ignored.
    h.sources[0]?.onerror?.({});
    expect(h.timers).toHaveLength(1);
    h.stop();
  });

  it('keeps polling when the deployment has no stream, and retries later when refused', async () => {
    const off = harness(async () => Promise.reject(Object.assign(new Error('off'), { status: 404 })));
    await tick();
    expect(off.sources).toHaveLength(0);
    expect(off.timers).toHaveLength(0);
    const refused = harness(async () => Promise.reject(Object.assign(new Error('no'), { status: 403 })));
    await tick();
    expect(refused.timers[0]?.ms).toBe(ACCESS_RETRY_MS);
    refused.stop();
  });
});
