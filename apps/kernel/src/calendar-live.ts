// SPDX-License-Identifier: AGPL-3.0-only
// The live check of a slot at the hosts' connected calendars (#2139, part of #1374): the stored busy blocks are at most 15
// minutes old, so before the worker decides a booking (a visitor's request, or a visitor's ask to move one) it asks each
// host's Google calendar, live, whether the slot is busy. A busy answer is added to that connection's stored blocks
// (kernel.calendar.busy_add), and the command that follows then refuses the slot as taken like any other busy time.
//
// It only ever helps: no connection, no adapter, a token about to run out or refused, a slow or failing provider, or any
// error here means the booking is decided on the stored blocks, as before. One short call per connection, all in
// parallel, so a booking waits on Google for the timeout at most. It never renews a token (the sweep does) and sends
// nothing but the window of the slot: the answer is busy intervals only.
import { calendarBinding, type CalendarProvider } from '@crove/kernel-contract';
import type { CalendarAdapter } from '@crove/channel';
import type { CredentialBroker, Runtime, SystemActor } from '@crove/kernel-runtime';
import type { SealedCalendarCredential } from '@crove/kernel';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.calendar.live' };
// How long one provider call may take: a booking never waits on Google longer.
export const LIVE_CHECK_TIMEOUT_MS = 3_000;
// A token with less than this left is not used: the sweep renews it, and the check falls back to the stored blocks.
const MIN_TOKEN_MS = 60_000;
// The most connections one check asks (the hosts of a team type).
const MAX_HOSTS = 20;
// A public booking page can trigger this check, so the live calls are budgeted: this many in any minute for an org, and for one
// connection. Counted in this worker process (a deployment with several workers allows that much per worker, far under the
// provider's quota). A call over the budget is not made and the stored blocks decide: the budget never refuses a booking.
export const LIVE_ORG_PER_MINUTE = 60;
export const LIVE_CONNECTION_PER_MINUTE = 12;
const BUDGET_WINDOW_MS = 60_000;

// Counts calls per key in a sliding window; take() says whether one more is within the limit and counts it if so.
export class LiveBudget {
  private readonly calls = new Map<string, number[]>();
  take(key: string, limit: number, now: number): boolean {
    const recent = (this.calls.get(key) ?? []).filter((at) => now - at < BUDGET_WINDOW_MS);
    if (recent.length >= limit) {
      this.calls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(key, recent);
    // Keys of orgs and connections that went quiet do not pile up.
    if (this.calls.size > 10_000) for (const [k, v] of this.calls) if (v.every((at) => now - at >= BUDGET_WINDOW_MS)) this.calls.delete(k);
    return true;
  }
}

const defaultBudget = new LiveBudget();

export interface LiveCheckDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The adapters this deployment offers, by OAuth provider id.
  adapters: Readonly<Partial<Record<string, CalendarAdapter>>>;
  now?: () => Date;
  timeoutMs?: number;
  // The budget of live calls (one per worker process unless a test gives its own).
  budget?: LiveBudget;
}

export interface LiveCheckJob {
  orgId: string;
  bookingId: string;
  // A visitor's ask from a manage link; without it, the booking being confirmed.
  requestId?: string;
}

export interface LiveCheckOutcome {
  // Connections asked, and those whose calendar showed the slot busy.
  asked: number;
  busy: number;
  // Connections not asked because the org's or the connection's budget of live calls was spent.
  limited?: number;
}

const none: LiveCheckOutcome = { asked: 0, busy: 0 };

function within<T>(run: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

export async function runLiveCheck(deps: LiveCheckDeps, job: LiveCheckJob): Promise<LiveCheckOutcome> {
  if (Object.keys(deps.adapters).length === 0) return none;
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? LIVE_CHECK_TIMEOUT_MS;
  const target = await deps.runtime.query<{ hostUserIds: string[]; from: string; to: string } | null>(
    'crm.booking.live_target',
    { bookingId: job.bookingId, ...(job.requestId ? { requestId: job.requestId } : {}) },
    options,
  );
  if (!target || target.hostUserIds.length === 0) return none;
  const connections = await deps.runtime.query<Array<{ connectionId: string; userId: string; provider: string; expiresAt: string | null; updatedAt: string }>>(
    'kernel.calendar.connections_of',
    { userIds: target.hostUserIds.slice(0, MAX_HOSTS) },
    options,
  );
  const from = new Date(target.from);
  const to = new Date(target.to);
  const budget = deps.budget ?? defaultBudget;
  const askOne = async (c: (typeof connections)[number]): Promise<'asked' | 'busy' | 'skipped' | 'limited'> => {
    try {
      const adapter = Object.values(deps.adapters).find((a) => a?.provider === c.provider);
      if (!adapter || c.expiresAt === null || Date.parse(c.expiresAt) - now().getTime() < MIN_TOKEN_MS) return 'skipped';
      // Over the budget: no call, the stored blocks decide. The connection's cap is looked at first so a connection that is
      // over it does not use the org's budget.
      const at = now().getTime();
      if (!budget.take(`conn:${c.connectionId}`, LIVE_CONNECTION_PER_MINUTE, at) || !budget.take(`org:${job.orgId}`, LIVE_ORG_PER_MINUTE, at)) return 'limited';
      const sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: c.connectionId }, options);
      // The credential is also handed out for a connection on its way out (its revoke needs it): a member who disconnected, or
      // connected again, since the list was read has this check leave the provider alone, like the sync does.
      const again = await deps.runtime.query<{ status: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: c.connectionId }, options);
      if (!again || again.status !== 'active' || again.updatedAt !== c.updatedAt) return 'skipped';
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(job.orgId, sealed.provider as CalendarProvider, sealed.externalAccount));
      const answer = await within(adapter.busy(secret, from, to, timeoutMs), timeoutMs);
      // A timeout, a refused token or a failing provider: the stored blocks decide.
      if (answer === 'timeout' || 'refused' in answer || 'failed' in answer) return 'asked';
      const seen = answer.busy.filter((b) => Date.parse(b.end) > from.getTime() && Date.parse(b.start) < to.getTime());
      if (seen.length === 0) return 'asked';
      await deps.runtime.execute('kernel.calendar.busy_add', { connectionId: c.connectionId, busy: seen.slice(0, 100).map((b) => ({ start: b.start, end: b.end })) }, options);
      return 'busy';
    } catch (error) {
      // Never the booking's problem: the credential, the database or the provider failing leaves the stored blocks to decide.
      console.error(`[calendar-live] connection ${c.connectionId.slice(0, 8)}: ${error instanceof Error ? error.name : 'error'}`);
      return 'skipped';
    }
  };
  const results = await Promise.all(connections.map(askOne));
  const limited = results.filter((r) => r === 'limited').length;
  return { asked: results.filter((r) => r === 'asked' || r === 'busy').length, busy: results.filter((r) => r === 'busy').length, ...(limited > 0 ? { limited } : {}) };
}
