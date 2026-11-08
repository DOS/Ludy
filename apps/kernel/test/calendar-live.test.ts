// SPDX-License-Identifier: AGPL-3.0-only
// The live check of a slot at the hosts' connected calendars (#2139) against a fake runtime and a fake adapter: a busy answer
// is added to the stored blocks, and every other outcome (free, slow, failing, no connection) leaves them alone and never
// stands in the booking's way. No database, no network.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarAdapter } from '@crove/channel';
import { calendarBinding } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { LIVE_CHECK_TIMEOUT_MS, runLiveCheck } from '../src/calendar-live.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const BOOKING = '33333333-3333-4333-8333-333333333333';
const HOST_A = '44444444-4444-4444-8444-444444444444';
const HOST_B = '55555555-5555-4555-8555-555555555555';
const CONN_A = '22222222-2222-4222-8222-222222222222';
const CONN_B = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = 'lan@gmail.test';
const NOW = new Date('2026-11-03T05:30:00Z');
const FROM = '2026-11-04T02:00:00.000Z';
const TO = '2026-11-04T02:30:00.000Z';
const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
const sealed = (() => {
  const s = vault.seal(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }), calendarBinding(ORG, 'google', ACCOUNT));
  return { provider: 'google', externalAccount: ACCOUNT, keyId: s.keyId, envelope: s.envelope.toString('base64') };
})();
const live = new Date(NOW.getTime() + 3_600_000).toISOString();

interface Call {
  kind: 'query' | 'execute';
  name: string;
  input: Record<string, unknown>;
}

type Target = { hostUserIds: string[]; from: string; to: string } | null;
type Conn = { connectionId: string; userId: string; provider: string; expiresAt: string | null; updatedAt: string };

function fakeRuntime(target: Target, connections: Conn[], over: { credential?: () => unknown; execute?: () => unknown; state?: () => unknown; take?: (connectionId: string) => unknown } = {}) {
  const calls: Call[] = [];
  const runtime = {
    query: async (name: string, input: Record<string, unknown>) => {
      calls.push({ kind: 'query', name, input });
      if (name === 'crm.booking.live_target') return target;
      if (name === 'kernel.calendar.connections_of') return connections;
      if (name === 'kernel.calendar.credential') return over.credential ? over.credential() : sealed;
      if (name === 'kernel.calendar.connection_state') return over.state ? over.state() : { status: 'active', updatedAt: 'v1' };
      throw new Error(`unexpected query ${name}`);
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      calls.push({ kind: 'execute', name, input });
      // The shared budget answers allowed unless a test says otherwise.
      if (name === 'kernel.calendar.live_take') return over.take ? over.take(String(input.connectionId)) : { allowed: true };
      if (over.execute) return over.execute();
      return { added: 1 };
    },
  } as unknown as Runtime;
  return { runtime, calls };
}

function adapter(busy: CalendarAdapter['busy']): CalendarAdapter & { asked: Array<{ secret: string; from: string; to: string; timeoutMs: number | undefined }> } {
  const asked: Array<{ secret: string; from: string; to: string; timeoutMs: number | undefined }> = [];
  return {
    provider: 'google',
    oauthProvider: 'google_calendar',
    pkce: true,
    authorizeUrl: () => 'https://example.test/',
    exchange: async () => {
      throw new Error('not used');
    },
    refresh: async () => {
      throw new Error('a live check never renews');
    },
    busy: async (secret, from, to, timeoutMs) => {
      asked.push({ secret, from: from.toISOString(), to: to.toISOString(), timeoutMs });
      return busy(secret, from, to, timeoutMs);
    },
    asked,
    revoke: async () => ({ revoked: true }),
    writeEvent: async () => ({ ok: true }),
    removeEvent: async () => ({ ok: true }),
  };
}

const target: Target = { hostUserIds: [HOST_A], from: FROM, to: TO };
const connA: Conn = { connectionId: CONN_A, userId: HOST_A, provider: 'google', expiresAt: live, updatedAt: 'v1' };
const check = (rt: Runtime, a: CalendarAdapter, over: { timeoutMs?: number } = {}) =>
  runLiveCheck({ runtime: rt, broker: vault, adapters: { google_calendar: a }, now: () => NOW, ...over }, { orgId: ORG, bookingId: BOOKING });
// What the check wrote to the stored blocks (the budget's own calls are looked at apart).
const executed = (calls: Call[]) => calls.filter((c) => c.kind === 'execute' && c.name === 'kernel.calendar.busy_add');
const taken = (calls: Call[]) => calls.filter((c) => c.name === 'kernel.calendar.live_take').map((c) => c.input.connectionId);

describe('runLiveCheck (#2139)', () => {
  it('adds what the host\'s calendar shows busy in the slot to the stored blocks, with the token it opened and a short timeout', async () => {
    const { runtime, calls } = fakeRuntime(target, [connA]);
    const a = adapter(async () => ({ busy: [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] }));
    expect(await check(runtime, a)).toEqual({ asked: 1, busy: 1 });
    expect(a.asked).toEqual([{ secret: JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }), from: FROM, to: TO, timeoutMs: LIVE_CHECK_TIMEOUT_MS }]);
    expect(executed(calls)).toEqual([{ kind: 'execute', name: 'kernel.calendar.busy_add', input: { connectionId: CONN_A, busy: [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] } }]);
  });

  it('adds nothing when the slot is free at the provider', async () => {
    const { runtime, calls } = fakeRuntime(target, [connA]);
    expect(await check(runtime, adapter(async () => ({ busy: [] })))).toEqual({ asked: 1, busy: 0 });
    expect(executed(calls)).toEqual([]);
    // An interval the provider returned that does not touch the window is not a reason to add anything either.
    const { runtime: other, calls: otherCalls } = fakeRuntime(target, [connA]);
    expect(await check(other, adapter(async () => ({ busy: [{ start: '2026-11-04T03:00:00.000Z', end: '2026-11-04T04:00:00.000Z' }] })))).toEqual({ asked: 1, busy: 0 });
    expect(executed(otherCalls)).toEqual([]);
  });

  it('falls back to the stored blocks when the provider is slow: it does not wait longer than the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, calls } = fakeRuntime(target, [connA]);
      const slow = adapter(() => new Promise(() => undefined));
      const done = check(runtime, slow, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      expect(await done).toEqual({ asked: 1, busy: 0 });
      expect(executed(calls)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the stored blocks when the provider fails, refuses the token or the call throws', async () => {
    for (const answer of [() => ({ failed: 'UNAVAILABLE' }), () => ({ refused: 'invalid_token' }), () => Promise.reject(new Error('socket hang up'))]) {
      const { runtime, calls } = fakeRuntime(target, [connA]);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await check(runtime, adapter(answer as CalendarAdapter['busy']));
      spy.mockRestore();
      expect(executed(calls)).toEqual([]);
    }
  });

  it('asks nothing for a host without a connection, a deployment without adapters, or a booking with nothing to decide', async () => {
    const none = fakeRuntime(target, []);
    const a = adapter(async () => ({ busy: [] }));
    expect(await check(none.runtime, a)).toEqual({ asked: 0, busy: 0 });
    expect(a.asked).toEqual([]);
    const idle = fakeRuntime(null, [connA]);
    expect(await check(idle.runtime, a)).toEqual({ asked: 0, busy: 0 });
    expect(idle.calls.map((c) => c.name)).toEqual(['crm.booking.live_target']);
    const empty = fakeRuntime({ ...target, hostUserIds: [] }, [connA]);
    expect(await check(empty.runtime, a)).toEqual({ asked: 0, busy: 0 });
    const bare = fakeRuntime(target, [connA]);
    expect(await runLiveCheck({ runtime: bare.runtime, broker: vault, adapters: {}, now: () => NOW }, { orgId: ORG, bookingId: BOOKING })).toEqual({ asked: 0, busy: 0 });
    expect(bare.calls).toEqual([]);
  });

  it('skips a connection without an adapter or whose token is about to run out or has no known expiry: the sweep renews those', async () => {
    const soon = { ...connA, expiresAt: new Date(NOW.getTime() + 30_000).toISOString() };
    const unknown = { ...connA, connectionId: CONN_B, expiresAt: null };
    const microsoft = { ...connA, connectionId: '77777777-7777-4777-8777-777777777777', provider: 'microsoft' };
    const { runtime, calls } = fakeRuntime(target, [soon, unknown, microsoft]);
    const a = adapter(async () => ({ busy: [{ start: FROM, end: TO }] }));
    expect(await check(runtime, a)).toEqual({ asked: 0, busy: 0 });
    expect(a.asked).toEqual([]);
    expect(calls.some((c) => c.name === 'kernel.calendar.credential')).toBe(false);
  });

  it('asks every host\'s connection at once and adds only where one is busy; one failing leaves the others', async () => {
    const connB: Conn = { connectionId: CONN_B, userId: HOST_B, provider: 'google', expiresAt: live, updatedAt: 'v1' };
    const { runtime, calls } = fakeRuntime({ ...target, hostUserIds: [HOST_A, HOST_B] }, [connA, connB]);
    let n = 0;
    const a = adapter(async () => {
      n += 1;
      if (n === 1) return { busy: [{ start: FROM, end: TO }] };
      return { failed: 'UNAVAILABLE' };
    });
    expect(await check(runtime, a)).toEqual({ asked: 2, busy: 1 });
    expect(a.asked).toHaveLength(2);
    expect(executed(calls).map((c) => c.input.connectionId)).toEqual([CONN_A]);
    expect(calls.find((c) => c.name === 'kernel.calendar.connections_of')?.input).toEqual({ userIds: [HOST_A, HOST_B] });
  });

  it('leaves the stored blocks to decide when the credential cannot be read or the add fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = fakeRuntime(target, [connA], { credential: () => Promise.reject(new Error('database blip')) });
    expect(await check(broken.runtime, adapter(async () => ({ busy: [{ start: FROM, end: TO }] })))).toEqual({ asked: 0, busy: 0 });
    const failing = fakeRuntime(target, [connA], { execute: () => Promise.reject(new Error('database blip')) });
    expect(await check(failing.runtime, adapter(async () => ({ busy: [{ start: FROM, end: TO }] })))).toEqual({ asked: 0, busy: 0 });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[calendar-live]'));
    spy.mockRestore();
  });

  it('leaves the provider alone for a connection that was disconnected or connected again after the list was read', async () => {
    for (const state of [{ status: 'disconnecting', updatedAt: 'v1' }, { status: 'expired', updatedAt: 'v1' }, { status: 'active', updatedAt: 'v2' }, null]) {
      const { runtime, calls } = fakeRuntime(target, [connA], { state: () => state });
      const a = adapter(async () => ({ busy: [{ start: FROM, end: TO }] }));
      expect(await check(runtime, a)).toEqual({ asked: 0, busy: 0 });
      expect(a.asked).toEqual([]);
      expect(executed(calls)).toEqual([]);
    }
  });

  it('passes the manage ask along to the target query, and never renews a token', async () => {
    const REQUEST = '88888888-8888-4888-8888-888888888888';
    const { runtime, calls } = fakeRuntime(target, [connA]);
    const a = adapter(async () => ({ busy: [] }));
    await runLiveCheck({ runtime, broker: vault, adapters: { google_calendar: a }, now: () => NOW }, { orgId: ORG, bookingId: BOOKING, requestId: REQUEST });
    expect(calls[0]).toEqual({ kind: 'query', name: 'crm.booking.live_target', input: { bookingId: BOOKING, requestId: REQUEST } });
    expect(calls.some((c) => c.name.includes('refresh'))).toBe(false);
  });
});

describe('the budget of live calls (a public page can trigger them; kept in the kernel, shared by every worker)', () => {
  const busyAnswer = async () => ({ busy: [{ start: FROM, end: TO }] });
  const connB: Conn = { connectionId: CONN_B, userId: HOST_B, provider: 'google', expiresAt: live, updatedAt: 'v1' };

  it('takes one call of the budget per connection asked, before it reads the credential or calls the provider', async () => {
    const { runtime, calls } = fakeRuntime({ ...target, hostUserIds: [HOST_A, HOST_B] }, [connA, connB]);
    expect(await check(runtime, adapter(busyAnswer))).toEqual({ asked: 2, busy: 2 });
    expect(taken(calls)).toEqual([CONN_A, CONN_B]);
    const names = calls.map((c) => c.name);
    expect(names.indexOf('kernel.calendar.live_take')).toBeLessThan(names.indexOf('kernel.calendar.credential'));
  });

  it('makes no call once the budget is spent, and the stored blocks decide: no credential read, no call, nothing added', async () => {
    const { runtime, calls } = fakeRuntime(target, [connA], { take: () => ({ allowed: false, limit: 'org' }) });
    const a = adapter(busyAnswer);
    expect(await check(runtime, a)).toEqual({ asked: 0, busy: 0, limited: 1 });
    expect(a.asked).toEqual([]);
    expect(calls.some((c) => c.name === 'kernel.calendar.credential')).toBe(false);
    expect(executed(calls)).toEqual([]);
  });

  it('skips only the connection that is over its budget and still asks the others', async () => {
    const { runtime } = fakeRuntime({ ...target, hostUserIds: [HOST_A, HOST_B] }, [connA, connB], { take: (id) => (id === CONN_A ? { allowed: false, limit: 'connection' } : { allowed: true }) });
    const a = adapter(busyAnswer);
    expect(await check(runtime, a)).toEqual({ asked: 1, busy: 1, limited: 1 });
    expect(a.asked).toHaveLength(1);
  });

  it('falls back to the stored blocks when the budget cannot be read: never a refusal, no call', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runtime, calls } = fakeRuntime(target, [connA], { take: () => Promise.reject(new Error('database blip')) });
    const a = adapter(busyAnswer);
    expect(await check(runtime, a)).toEqual({ asked: 0, busy: 0 });
    expect(a.asked).toEqual([]);
    expect(executed(calls)).toEqual([]);
    spy.mockRestore();
  });
});
