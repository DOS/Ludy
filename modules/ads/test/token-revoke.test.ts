// SPDX-License-Identifier: AGPL-3.0-only
// The policy of the revoke at the platform (W2-1, #2296): when an obligation is due, what each answer means, and the only ways the sealed copy of a token
// ends: revoked (or the person had already removed the app), another live connection of the person needs the grant, the token cannot be revoked, after ten
// tries, or after seven days. Never a copy that lives for ever, never one wiped without a try (but for the cases that make no call).
import { describe, expect, it } from 'vitest';
import { REVOKE_MAX_AGE_MS, REVOKE_MAX_ATTEMPTS, backoffMs, isDue, isTooOld, needsAPerson, settleAttempt, type RevokeOutcome, type RevokeRow } from '../src/token-revoke.ts';

const T0 = new Date('2026-11-03T08:00:00Z');
// The count includes the try being settled: the database counted it when it opened the copy.
const row = (over: Partial<RevokeRow> = {}): RevokeRow => ({ state: 'pending', attempts: 1, createdAt: T0, ...over });
const failed = (over: Partial<Extract<RevokeOutcome, { kind: 'failed' }>> = {}): RevokeOutcome => ({ kind: 'failed', error: 'transient', code: 'NETWORK', retryAt: null, ...over });
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('when an obligation is due', () => {
  it('is due when pending and its time has come, and not otherwise', () => {
    expect(isDue({ state: 'pending' }, at(0), at(0))).toBe(true);
    expect(isDue({ state: 'pending' }, at(1), at(0))).toBe(false);
    expect(isDue({ state: 'done' }, at(0), at(10))).toBe(false);
    expect(isDue({ state: 'gave_up' }, at(0), at(10))).toBe(false);
    expect(isDue({ state: 'pending' }, null, at(10))).toBe(false);
  });

  it('is too old from the seventh day on', () => {
    expect(isTooOld(row(), at(REVOKE_MAX_AGE_MS - 1))).toBe(false);
    expect(isTooOld(row(), at(REVOKE_MAX_AGE_MS))).toBe(true);
  });
});

describe('the wait between tries', () => {
  it('grows from a minute to a day, and the ten tries are spread over the seven days', () => {
    const waits = Array.from({ length: REVOKE_MAX_ATTEMPTS }, (_, i) => backoffMs(i + 1));
    expect(waits.slice(0, 4)).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(waits.at(-1)).toBe(86_400_000);
    expect([...waits].sort((a, b) => a - b)).toEqual(waits);
    // The waits before the tenth try fit the seven days.
    expect(waits.slice(0, -1).reduce((a, b) => a + b, 0)).toBeLessThan(REVOKE_MAX_AGE_MS);
    // Out of range counts are clamped, never undefined.
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(99)).toBe(86_400_000);
  });
});

describe('a try that worked', () => {
  it('is done, wipes the copy and says how, for each way it can end', () => {
    for (const how of ['revoked', 'already_invalid', 'sandbox', 'shared_grant'] as const) {
      expect(settleAttempt(row({ attempts: 4 }), { kind: 'done', how }, at(1000))).toEqual({ state: 'done', nextAttemptAt: null, wipe: true, how, giveUp: null });
    }
  });

  it('is done at once for a grant another live connection of the person needs, with no try made', () => {
    expect(settleAttempt(row({ attempts: 0 }), { kind: 'done', how: 'shared_grant' }, at(0)).state).toBe('done');
  });
});

describe('a token that cannot be revoked', () => {
  it('wipes the copy and gives up as unrevocable, so the screen says "revoke by hand" and never "revoked"', () => {
    expect(settleAttempt(row(), { kind: 'unrevocable', code: 'OPEN_FAILED' }, at(0))).toEqual({ state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'unrevocable' });
  });
});

describe('a try that failed', () => {
  it('keeps the copy and asks again after the backoff of the try it was', () => {
    expect(settleAttempt(row(), failed(), at(1000))).toEqual({ state: 'pending', nextAttemptAt: at(1000 + 60_000), wipe: false, how: null, giveUp: null });
    expect(settleAttempt(row({ attempts: 4 }), failed(), at(0)).nextAttemptAt).toEqual(at(3_600_000));
  });

  it('waits for the time the platform names when it is later than the backoff, and for the backoff when it is not', () => {
    expect(settleAttempt(row(), failed({ error: 'rate_limited', retryAt: at(600_000) }), at(0)).nextAttemptAt).toEqual(at(600_000));
    expect(settleAttempt(row(), failed({ error: 'rate_limited', retryAt: at(1_000) }), at(0)).nextAttemptAt).toEqual(at(60_000));
  });

  it('wipes the copy after the tenth try and says why, so the screen can say "revoke by hand"', () => {
    expect(settleAttempt(row({ attempts: REVOKE_MAX_ATTEMPTS }), failed(), at(1000))).toEqual({ state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'attempts' });
    // The ninth try still keeps it.
    expect(settleAttempt(row({ attempts: REVOKE_MAX_ATTEMPTS - 1 }), failed(), at(1000)).wipe).toBe(false);
  });

  it('wipes the copy once seven days have passed, whatever the count', () => {
    expect(settleAttempt(row({ attempts: 3 }), failed(), at(REVOKE_MAX_AGE_MS))).toEqual({ state: 'gave_up', nextAttemptAt: null, wipe: true, how: null, giveUp: 'age' });
    expect(settleAttempt(row({ attempts: 3 }), failed(), at(REVOKE_MAX_AGE_MS - 1)).wipe).toBe(false);
  });

  it('is never a success: only an answer that says so wipes the copy as done', () => {
    for (const error of ['rate_limited', 'transient', 'permission', 'bad_request', 'unknown'] as const) {
      const s = settleAttempt(row(), failed({ error }), at(0));
      expect([s.state, s.wipe, s.how]).toEqual(['pending', false, null]);
    }
  });
});

describe('which failures a person has to look at', () => {
  it('are the refused permission and the bad request: waiting will not mend them', () => {
    expect((['rate_limited', 'transient', 'permission', 'bad_request', 'unknown'] as const).filter(needsAPerson)).toEqual(['permission', 'bad_request']);
  });
});
