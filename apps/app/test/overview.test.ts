// The org overview's waiting list (issue #1249): what it lists, in which order, and when it may say nothing waits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAITING_LINKS, allCounted, gapsFromYear, shellBadges, waitingItems } from '../src/lib/overview.ts';

describe('org overview', () => {
  it('lists what waits, the books first, and leaves out counts of 0', () => {
    expect(waitingItems({ tasks: 2, bankLines: 0, proposals: 3, failedFiles: 1, notifications: 0 })).toEqual([
      { key: 'proposals', count: 3 },
      { key: 'failedFiles', count: 1 },
      { key: 'tasks', count: 2 },
    ]);
    expect(waitingItems({})).toEqual([]);
  });

  it('says nothing waits only once every asked figure is read', () => {
    expect(allCounted({ proposals: 0, failedFiles: 0 }, ['proposals', 'failedFiles'])).toBe(true);
    expect(allCounted({ proposals: 0 }, ['proposals', 'failedFiles'])).toBe(false);
    // A figure the deployment does not run (no finance: no bank lines) is not asked for.
    expect(allCounted({ proposals: 0, tasks: 0 }, ['proposals', 'tasks'])).toBe(true);
  });

  it('reads sales invoice number gaps from this year on, and from last year through March (#2140)', () => {
    expect(gapsFromYear(new Date(2026, 0, 15))).toBe(2025);
    expect(gapsFromYear(new Date(2026, 2, 31))).toBe(2025);
    expect(gapsFromYear(new Date(2026, 3, 1))).toBe(2026);
    expect(gapsFromYear(new Date(2026, 9, 31))).toBe(2026);
  });

  it("opens the card for posts to review on Social's review tab, not on an accounting screen (#2234)", () => {
    expect(WAITING_LINKS.socialReviews).toEqual({ to: '/o/$slug/social', search: { tab: 'review' } });
    // Every other card keeps its own screen.
    expect(WAITING_LINKS.proposals.to).toBe('/o/$slug/inbox');
    expect(WAITING_LINKS.bankLines.to).toBe('/o/$slug/bank');
  });

  it("counts posts to review on Social's menu item and never on the Inbox's (#2234)", () => {
    expect(shellBadges({ pending: 0, attention: 0, failedJobs: 0, reviews: 4 })).toEqual({ inbox: null, social: 4 });
    expect(shellBadges({ pending: 2, attention: 1, failedJobs: 3, reviews: 0 })).toEqual({ inbox: 6, social: null });
    // A reviews total moves only the Social badge.
    const without = shellBadges({ pending: 2, attention: 1, failedJobs: 0, reviews: 0 });
    expect(shellBadges({ pending: 2, attention: 1, failedJobs: 0, reviews: 9 }).inbox).toBe(without.inbox);
  });

  it('lists no post to review in the accounting Inbox (#2234)', () => {
    // The Inbox screen is too wired to the router and the stream to render here; its source must not ask for the
    // reviews at all, in either of the two ways it could (the inbox of reviews, or the review stage of the post list).
    const inbox = readFileSync(join(import.meta.dirname, '..', 'src', 'routes', 'inbox.tsx'), 'utf8');
    expect(inbox).not.toMatch(/reviewInbox|SocialReviews|stage:\s*['"]review['"]/);
  });
});
