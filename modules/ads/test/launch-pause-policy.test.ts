// SPDX-License-Identifier: AGPL-3.0-only
// The policy of the pause of a stopped launch (W2-4a, #2296): when a run winds the launch down, when it is due again and when Ludy gives up and tells the person to pause
// by hand at the platform. No database and no network.
import { describe, expect, it } from 'vitest';
import { REVOKE_MAX_AGE_MS, REVOKE_MAX_ATTEMPTS, backoffMs } from '../src/token-revoke.ts';
import { WIND_DOWN_LEASE_SECONDS, WIND_DOWN_MAX_AGE_MS, WIND_DOWN_MAX_TRIES, isTooOld, settlePause } from '../src/launch-pause-policy.ts';

const NOW = new Date('2026-11-04T10:00:00Z');
const stoppedAt = (agoMs: number) => new Date(NOW.getTime() - agoMs);
const run = (tries: number, ago = 60_000) => ({ tries, stoppedAt: stoppedAt(ago) });

describe('the pause of a stopped launch', () => {
  it('follows the revoke’s limits, since the sealed copy of a closed connection’s token lives as long and is the only token left to pause with', () => {
    expect(WIND_DOWN_MAX_TRIES).toBe(REVOKE_MAX_ATTEMPTS);
    expect(WIND_DOWN_MAX_AGE_MS).toBe(REVOKE_MAX_AGE_MS);
    expect(WIND_DOWN_LEASE_SECONDS).toBe(600);
  });

  it('winds the launch down when every level was listed, every object paused and no create is in flight', () => {
    expect(settlePause(run(1), { complete: true, tokenRefused: false, retryAt: null }, NOW)).toEqual({ state: 'done', nextAt: null, code: null });
    // Even on the last try, and past the age: a run that finished the job is done.
    expect(settlePause(run(WIND_DOWN_MAX_TRIES, WIND_DOWN_MAX_AGE_MS + 1), { complete: true, tokenRefused: false, retryAt: null }, NOW).state).toBe('done');
  });

  it('gives up at once on a refused token, which cannot pause anything, and says so', () => {
    expect(settlePause(run(1), { complete: false, tokenRefused: true, retryAt: null }, NOW)).toEqual({ state: 'gave_up', nextAt: null, code: 'token_refused' });
  });

  it('asks again after the backoff for any other incomplete run, later when the platform names a later time', () => {
    for (const tries of [1, 2, 5, 9]) {
      const settled = settlePause(run(tries), { complete: false, tokenRefused: false, retryAt: null }, NOW);
      expect(settled).toEqual({ state: 'pending', nextAt: new Date(NOW.getTime() + backoffMs(tries)), code: null });
    }
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(settlePause(run(2), { complete: false, tokenRefused: false, retryAt: later }, NOW).nextAt).toEqual(later);
    // A platform that names an earlier time than the backoff does not shorten it.
    const sooner = new Date(NOW.getTime() + 1000);
    expect(settlePause(run(2), { complete: false, tokenRefused: false, retryAt: sooner }, NOW).nextAt).toEqual(new Date(NOW.getTime() + backoffMs(2)));
  });

  it('gives up on the tenth run and on the seventh day, with the reason', () => {
    expect(settlePause(run(WIND_DOWN_MAX_TRIES), { complete: false, tokenRefused: false, retryAt: null }, NOW)).toEqual({ state: 'gave_up', nextAt: null, code: 'attempts' });
    expect(settlePause(run(3, WIND_DOWN_MAX_AGE_MS), { complete: false, tokenRefused: false, retryAt: null }, NOW)).toEqual({ state: 'gave_up', nextAt: null, code: 'age' });
    expect(isTooOld({ stoppedAt: stoppedAt(WIND_DOWN_MAX_AGE_MS - 1) }, NOW)).toBe(false);
    expect(isTooOld({ stoppedAt: stoppedAt(WIND_DOWN_MAX_AGE_MS) }, NOW)).toBe(true);
  });
});
