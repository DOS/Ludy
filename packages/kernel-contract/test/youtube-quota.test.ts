// SPDX-License-Identifier: AGPL-3.0-only
// The YouTube polling budget (#3134) with a fake clock: a poll never starts past the connection's daily unit budget, the day resets at midnight Pacific
// time (daylight saving included), and the interval backs off while nothing new comes and returns at the first new comment.
import { describe, expect, it } from 'vitest';
import {
  YOUTUBE_POLL_BUDGET_UNITS,
  YOUTUBE_POLL_DELAYS_MINUTES,
  YOUTUBE_POLL_MAX_UNITS,
  youtubePollAllowed,
  youtubePollDelayMinutes,
  youtubeQuotaNow,
  youtubeQuotaResetAt,
  type YoutubeQuotaState,
} from '../src/conversations.ts';

const fresh = (over: Partial<YoutubeQuotaState> = {}): YoutubeQuotaState => ({ resetAt: null, pollUnits: 0, replyUnits: 0, blockedUntil: null, ...over });

describe('youtubeQuotaResetAt', () => {
  it('is the next midnight Pacific time plus a minute, in standard and daylight time', () => {
    // 2026-11-13 is Pacific standard time (UTC-8): midnight is 08:00 UTC.
    expect(youtubeQuotaResetAt(new Date('2026-11-13T12:00:00Z')).toISOString()).toBe('2026-11-14T08:01:00.000Z');
    // 2026-07-01 is Pacific daylight time (UTC-7): midnight is 07:00 UTC.
    expect(youtubeQuotaResetAt(new Date('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-07-02T07:01:00.000Z');
    // The reset is never in the past, at the edges of the day.
    expect(youtubeQuotaResetAt(new Date('2026-11-14T07:59:59Z')).toISOString()).toBe('2026-11-14T08:01:00.000Z');
    expect(youtubeQuotaResetAt(new Date('2026-11-14T08:00:00Z')).toISOString()).toBe('2026-11-15T08:01:00.000Z');
    // The day the clocks go back (2026-11-01): that Pacific day is 25 hours long.
    expect(youtubeQuotaResetAt(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-02T08:01:00.000Z');
  });
});

describe('the daily polling budget', () => {
  it('never lets a poll start that might not fit the rest of the day, and holds it until the reset', () => {
    let now = new Date('2026-11-13T12:00:00Z');
    let state = fresh();
    let spent = 0;
    let polls = 0;
    // Polls every 15 minutes from noon until before the next reset (20 hours), each costing the most one may: the budget stops them, never more than the budget is spent.
    for (let i = 0; i < 80; i++) {
      now = new Date(Date.parse('2026-11-13T12:00:00Z') + i * 15 * 60_000);
      const q = youtubeQuotaNow(state, now);
      const allowed = youtubePollAllowed(state, now, YOUTUBE_POLL_MAX_UNITS);
      if (!allowed.allowed) {
        expect(allowed.reason).toBe('budget');
        // Held until the reset, which is after now and the same for the rest of the day.
        expect(allowed.until.getTime()).toBeGreaterThan(now.getTime());
        continue;
      }
      polls++;
      spent += YOUTUBE_POLL_MAX_UNITS;
      expect(spent).toBeLessThanOrEqual(YOUTUBE_POLL_BUDGET_UNITS);
      state = { ...state, resetAt: q.resetAt, pollUnits: q.pollUnits + YOUTUBE_POLL_MAX_UNITS };
    }
    expect(polls).toBe(Math.floor(YOUTUBE_POLL_BUDGET_UNITS / YOUTUBE_POLL_MAX_UNITS));
    expect(spent).toBeLessThanOrEqual(YOUTUBE_POLL_BUDGET_UNITS);
  });

  it('starts a new day at the reset and counts nothing of the old one', () => {
    const resetAt = new Date('2026-11-14T08:01:00Z');
    const spentDay = fresh({ resetAt, pollUnits: YOUTUBE_POLL_BUDGET_UNITS, replyUnits: 100 });
    expect(youtubePollAllowed(spentDay, new Date('2026-11-14T08:00:59Z'), 1)).toMatchObject({ allowed: false, reason: 'budget', until: resetAt });
    expect(youtubePollAllowed(spentDay, new Date('2026-11-14T08:01:00Z'), YOUTUBE_POLL_MAX_UNITS)).toEqual({ allowed: true });
    expect(youtubeQuotaNow(spentDay, new Date('2026-11-14T08:01:00Z'))).toMatchObject({ pollUnits: 0, replyUnits: 0 });
    expect(youtubeQuotaNow(spentDay, new Date('2026-11-14T00:00:00Z'))).toMatchObject({ pollUnits: YOUTUBE_POLL_BUDGET_UNITS, replyUnits: 100, resetAt });
  });

  it('holds polling while the platform says its own quota is spent, whatever the budget, and lets replies count beside it', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const until = new Date('2026-11-14T08:01:00Z');
    expect(youtubePollAllowed(fresh({ blockedUntil: until }), now, 1)).toEqual({ allowed: false, until, reason: 'blocked' });
    // A block that has passed holds nothing.
    expect(youtubePollAllowed(fresh({ blockedUntil: new Date('2026-11-13T11:00:00Z') }), now, 1)).toEqual({ allowed: true });
    // Reply units do not count against the polling budget (replies are a person's act).
    expect(youtubePollAllowed(fresh({ resetAt: until, replyUnits: 5_000 }), now, YOUTUBE_POLL_MAX_UNITS)).toEqual({ allowed: true });
  });
});

describe('the adaptive interval', () => {
  it('backs off 15, 30, 60, then 120 minutes and stays there', () => {
    expect([0, 1, 2, 3, 4, 50].map(youtubePollDelayMinutes)).toEqual([15, 30, 60, 120, 120, 120]);
    expect([...YOUTUBE_POLL_DELAYS_MINUTES]).toEqual([15, 30, 60, 120]);
    expect(youtubePollDelayMinutes(-3)).toBe(15);
  });
  it('a day of polling at the base interval fits the budget the plan counts on (about 96 polls a day at one unit)', () => {
    expect((24 * 60) / YOUTUBE_POLL_DELAYS_MINUTES[0]).toBe(96);
    expect(YOUTUBE_POLL_BUDGET_UNITS).toBeGreaterThanOrEqual(96);
  });
});
