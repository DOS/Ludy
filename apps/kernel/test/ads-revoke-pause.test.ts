// SPDX-License-Identifier: AGPL-3.0-only
// The pause the revoke sweep makes before it revokes (W2-4a), without a database: how long one try may spend, and what happens when the pause fails on the obligation's
// last try. The commands are stand-ins that answer as the real ones do; the database side of the same flow is in ads.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdRevoker } from '@crove/ad-platform';
import type { Runtime } from '@crove/kernel-runtime';
import type { PauseBegin } from '@crove/mod-ads';
import { PAUSE_BUDGET_MS, pausedFirst, type AdsRevokeDeps } from '../src/ads-revoke.ts';

const ORG = '0198a3b4-0000-7000-8000-000000000001';
const OBLIGATION = { orgId: ORG, id: '0198a3b4-0000-7000-8000-0000000000aa' };
const launchIds = (n: number) => Array.from({ length: n }, (_, i) => `0198a3b4-0000-7000-8000-00000000010${i}`);

const begun = (launchId: string): PauseBegin => ({
  action: 'pause',
  launchId,
  callKey: `ads.pause:${launchId}:1`,
  tries: 1,
  via: 'copy',
  tag: 'ludy:abcdefghij',
  provider: null,
  connectionId: null,
  account: { externalAccountId: 'sbxads-1', currency: 'VND' },
  objects: [],
});

interface Setup {
  launches: string[];
  blocked?: boolean;
  lastChance?: boolean;
  // Milliseconds one pause takes at the platform, on the test's own clock.
  pauseTakes?: number;
  // A command that fails, and how.
  // The reason `ads.pause.begin` gives for leaving a launch alone (no pause is made).
  leftAlone?: string;
  failing?: 'ads.pause.begin' | 'ads.pause.record';
  failOn?: string;
}

function setup(s: Setup) {
  let clock = 1_000_000;
  const begins: string[] = [];
  const records: string[] = [];
  const execute = vi.fn(async (name: string, input: { launchId: string }) => {
    if (name === s.failing && (!s.failOn || s.failOn === input.launchId)) throw new Error('database says: secret-ish detail');
    if (name === 'ads.pause.begin') {
      begins.push(input.launchId);
      if (s.leftAlone) return { action: 'none', reason: s.leftAlone } satisfies PauseBegin;
      return begun(input.launchId);
    }
    records.push(input.launchId);
    return { recorded: true, state: 'done' };
  });
  const runtime = { query: vi.fn(async () => ({ launches: s.launches, blocked: s.blocked ?? false, lastChance: s.lastChance ?? false })), execute } as unknown as Runtime;
  const pauseLaunch = vi.fn(async () => {
    clock += s.pauseTakes ?? 0;
    return { listed: { campaign: { ok: true as const }, ad_set: { ok: true as const }, ad: { ok: true as const } }, found: [], paused: [], failed: [], notTried: [], tokenRefused: false, retryAt: null };
  });
  const revoker = { pauseLaunch, revokeToken: vi.fn() } as unknown as AdRevoker;
  const deps = { runtime, now: () => clock } as unknown as AdsRevokeDeps;
  return { run: () => pausedFirst(deps, OBLIGATION, 'secret', revoker), begins, records, pauseLaunch, revoker };
}

afterEach(() => vi.restoreAllMocks());

describe('the pause before a revoke: one try has a time budget', () => {
  it('begins no pause once the budget is spent, and the revoke waits for the next try', async () => {
    const t = setup({ launches: launchIds(4), pauseTakes: PAUSE_BUDGET_MS * 0.75 });
    const [first, second] = launchIds(4);
    expect(await t.run()).toBe(true);
    // The first begins at the start, the second 90 s in, and the third finds the budget (120 s) spent.
    expect(t.begins).toEqual([first, second]);
    expect(t.records).toEqual([first, second]);
    expect(t.pauseLaunch).toHaveBeenCalledTimes(2);
  });

  it('pauses them all and lets the revoke go on when they are quick', async () => {
    const t = setup({ launches: launchIds(3), pauseTakes: 5_000 });
    expect(await t.run()).toBe(false);
    expect(t.begins).toEqual(launchIds(3));
  });

  it('holds the revoke while another account of the person waits or there are more launches than one try pauses, and not past the last try', async () => {
    expect(await setup({ launches: [], blocked: true }).run()).toBe(true);
    expect(await setup({ launches: launchIds(6) }).run()).toBe(true);
    expect(await setup({ launches: [], blocked: true, lastChance: true }).run()).toBe(false);
    // The last try revokes although the budget kept a pause from beginning.
    expect(await setup({ launches: launchIds(4), pauseTakes: PAUSE_BUDGET_MS, lastChance: true }).run()).toBe(false);
  });
});

describe('the pause before a revoke: a launch left alone', () => {
  it('holds the revoke while another run or an activation call that may still land holds the launch, and not when there is nothing to pause', async () => {
    for (const reason of ['in_flight', 'activation_in_flight']) {
      const held = setup({ launches: launchIds(1), leftAlone: reason });
      expect(await held.run(), reason).toBe(true);
    }
    const settled = setup({ launches: launchIds(1), leftAlone: 'wound_down' });
    expect(await settled.run()).toBe(false);
  });
});

describe('the pause before a revoke: a failure of the pause', () => {
  it('is thrown on a try that is not the last, so the claim runs out and the obligation is tried again', async () => {
    const t = setup({ launches: launchIds(2), failing: 'ads.pause.begin' });
    await expect(t.run()).rejects.toThrow();
    expect(t.pauseLaunch).not.toHaveBeenCalled();
  });

  it('does not stop the revoke on the last try: the other launches are still paused, and the log has a code and nothing the failure said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [first, second] = launchIds(2);
    const t = setup({ launches: launchIds(2), lastChance: true, failing: 'ads.pause.begin', failOn: first as string });
    expect(await t.run()).toBe(false);
    expect(t.begins).toEqual([second]);
    expect(t.records).toEqual([second]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe('[ads-revoke] a pause failed on the last try of its revoke: ERROR');
  });

  it('does not stop the revoke when it is the record that fails on the last try', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup({ launches: launchIds(1), lastChance: true, failing: 'ads.pause.record' });
    expect(await t.run()).toBe(false);
    expect(t.pauseLaunch).toHaveBeenCalledTimes(1);
  });
});
