// The org overview's waiting list (issue #1249): what it lists, in which order, and when it may say nothing waits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAITING_LINKS, allCounted, gapsFromYear, waitingItems } from '../src/lib/overview.ts';

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

  it('keeps posts to review out of the accounting inbox and its menu count (#2234)', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const inbox = readFileSync(join(src, 'routes', 'inbox.tsx'), 'utf8');
    expect(inbox).not.toContain('reviewInbox');
    expect(inbox).not.toContain('SocialReviews');
    // The count of posts to review sits on Social's menu item; the inbox's count is the accounting work and Social's alerts.
    const layout = readFileSync(join(src, 'routes', 'org-layout.tsx'), 'utf8');
    expect(layout.match(/const inboxCount = [^;]*;/)?.[0]).not.toContain('reviews');
    expect(layout).toContain('social: reviewCount > 0 ? reviewCount : null');
  });
});
