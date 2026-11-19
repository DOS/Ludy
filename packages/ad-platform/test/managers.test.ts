// SPDX-License-Identifier: AGPL-3.0-only
// The frozen view the manage job is given (ADR-0043, #3835, ads W4): four closures and nothing else, a call for a level or a status that is not manageable never reaches an
// adapter, a budget and an end time belong to an ad set only, and what the job passes (the secret, the ids, the money) reaches the adapter untouched.
import { describe, expect, it } from 'vitest';
import { AdPlatformError, MANAGE_LEVELS, MANAGE_STATUSES, managerOf, type AdManager, type ManagedRead } from '../src/index.ts';

const ACCOUNT = { externalAccountId: 'act_1', currency: 'VND' };

// An adapter that only records what it was asked.
function recording(): { manager: AdManager; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const answer: ManagedRead = { status: 'paused', dailyBudget: '100000', endTime: '2026-11-17T00:00:00+0700' };
  const manager: AdManager = {
    changeStatus: async (...args) => void calls.push(['changeStatus', ...args]),
    setBudget: async (...args) => void calls.push(['setBudget', ...args]),
    setEndTime: async (...args) => void calls.push(['setEndTime', ...args]),
    read: async (...args) => {
      calls.push(['read', ...args]);
      return answer;
    },
  };
  return { manager, calls };
}
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};

describe('the manage view', () => {
  it('has exactly four members, frozen, and nothing of the adapter is reachable through it', () => {
    const { manager } = recording();
    (manager as unknown as Record<string, unknown>).changes = [];
    (manager as unknown as Record<string, unknown>).revokeToken = async () => undefined;
    const view = managerOf(manager);
    expect(Object.getOwnPropertyNames(view).sort()).toEqual(['changeStatus', 'read', 'setBudget', 'setEndTime']);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.isFrozen(view)).toBe(true);
    expect((view as unknown as Record<string, unknown>).changes).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).revokeToken).toBeUndefined();
    expect(Object.getOwnPropertySymbols(view)).toEqual([]);
  });

  it('names the three levels that have a status and the three statuses', () => {
    expect([...MANAGE_LEVELS]).toEqual(['campaign', 'ad_set', 'ad']);
    expect([...MANAGE_STATUSES]).toEqual(['active', 'paused', 'archived']);
  });

  it('refuses a level that is not campaign, ad set or ad, for every call, before the adapter', async () => {
    const { manager, calls } = recording();
    const view = managerOf(manager);
    for (const level of ['creative', 'account', '', 'AD_SET', 'toString'] as const) {
      const target = { level: level as never, id: '120001' };
      expect((await refusal(view.changeStatus('s', target, 'paused'))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
      expect((await refusal(view.setBudget('s', target, ACCOUNT, '100000'))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
      expect((await refusal(view.setEndTime('s', target, '2026-11-17T00:00:00+0700'))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
      expect((await refusal(view.read('s', target, ACCOUNT))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
    }
    expect((await refusal(view.changeStatus('s', { level: 'creative' as never, id: '1' }, 'paused'))).kind).toBe('bad_request');
    expect(calls).toEqual([]);
  });

  it('refuses a budget and an end time for anything but an ad set', async () => {
    const { manager, calls } = recording();
    const view = managerOf(manager);
    for (const level of ['campaign', 'ad'] as const) {
      expect((await refusal(view.setBudget('s', { level, id: '120001' }, ACCOUNT, '100000'))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
      expect((await refusal(view.setEndTime('s', { level, id: '120001' }, '2026-11-17T00:00:00+0700'))).code, level).toBe('LEVEL_NOT_MANAGEABLE');
    }
    expect(calls).toEqual([]);
    await view.setBudget('s', { level: 'ad_set', id: '120001' }, ACCOUNT, '100000');
    await view.setEndTime('s', { level: 'ad_set', id: '120001' }, '2026-11-17T00:00:00+0700');
    expect(calls.map((c) => c[0])).toEqual(['setBudget', 'setEndTime']);
  });

  it('refuses a status word that is not active, paused or archived, and a status is for any of the three levels', async () => {
    const { manager, calls } = recording();
    const view = managerOf(manager);
    for (const word of ['deleted', 'ACTIVE', 'PAUSED', '', 'resume'] as const) {
      expect((await refusal(view.changeStatus('s', { level: 'ad', id: '1' }, word as never))).code, word).toBe('STATUS_REFUSED');
    }
    expect(calls).toEqual([]);
    for (const level of MANAGE_LEVELS) for (const status of MANAGE_STATUSES) await view.changeStatus('s', { level, id: '1' }, status);
    expect(calls).toHaveLength(9);
  });

  it('forwards the secret, the ids and the money untouched, hands the adapter a copy of the target, and returns what the adapter read', async () => {
    const { manager, calls } = recording();
    const view = managerOf(manager);
    const secret = '{"accessToken":"write-token"}';
    const target = { level: 'ad_set' as const, id: '120002', extra: 'smuggled' };
    await view.changeStatus(secret, target, 'archived');
    await view.setBudget(secret, target, ACCOUNT, '100000.50');
    await view.setEndTime(secret, target, '2026-11-17T00:00:00+0700');
    expect(await view.read(secret, target, ACCOUNT)).toEqual({ status: 'paused', dailyBudget: '100000', endTime: '2026-11-17T00:00:00+0700' });
    const plain = { level: 'ad_set', id: '120002' };
    expect(calls).toEqual([
      ['changeStatus', secret, plain, 'archived'],
      ['setBudget', secret, plain, ACCOUNT, '100000.50'],
      ['setEndTime', secret, plain, '2026-11-17T00:00:00+0700'],
      ['read', secret, plain, ACCOUNT],
    ]);
    // The target the adapter got is not the caller's object, and carries no extra field.
    expect(calls[0]?.[2]).not.toBe(target);
    expect(Object.keys(calls[0]?.[2] as object)).toEqual(['level', 'id']);
  });

  it('lets what the adapter throws through as it is', async () => {
    const failing: AdManager = {
      changeStatus: async () => {
        throw new AdPlatformError('transient', 'NETWORK');
      },
      setBudget: async () => {
        throw new AdPlatformError('permission', 'NO');
      },
      setEndTime: async () => {
        throw new AdPlatformError('rate_limited', 'SLOW');
      },
      read: async () => {
        throw new AdPlatformError('unknown', 'ODD');
      },
    };
    const view = managerOf(failing);
    const target = { level: 'ad_set' as const, id: '1' };
    expect(await refusal(view.changeStatus('s', target, 'paused'))).toMatchObject({ kind: 'transient', code: 'NETWORK' });
    expect(await refusal(view.setBudget('s', target, ACCOUNT, '1'))).toMatchObject({ kind: 'permission', code: 'NO' });
    expect(await refusal(view.setEndTime('s', target, 'x'))).toMatchObject({ kind: 'rate_limited', code: 'SLOW' });
    expect(await refusal(view.read('s', target, ACCOUNT))).toMatchObject({ kind: 'unknown', code: 'ODD' });
  });
});
