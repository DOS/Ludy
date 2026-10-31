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

export interface LiveCheckDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The adapters this deployment offers, by OAuth provider id.
  adapters: Readonly<Partial<Record<string, CalendarAdapter>>>;
  now?: () => Date;
  timeoutMs?: number;
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
  const connections = await deps.runtime.query<Array<{ connectionId: string; userId: string; provider: string; expiresAt: string | null }>>(
    'kernel.calendar.connections_of',
    { userIds: target.hostUserIds.slice(0, MAX_HOSTS) },
    options,
  );
  const from = new Date(target.from);
  const to = new Date(target.to);
  const askOne = async (c: (typeof connections)[number]): Promise<'asked' | 'busy' | 'skipped'> => {
    try {
      const adapter = Object.values(deps.adapters).find((a) => a?.provider === c.provider);
      if (!adapter || c.expiresAt === null || Date.parse(c.expiresAt) - now().getTime() < MIN_TOKEN_MS) return 'skipped';
      const sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: c.connectionId }, options);
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
  return { asked: results.filter((r) => r !== 'skipped').length, busy: results.filter((r) => r === 'busy').length };
}
