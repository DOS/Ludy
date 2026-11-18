// SPDX-License-Identifier: AGPL-3.0-only
// The sentence under a post's title (#3656): the post's standing from its channels' statuses.
import { describe, expect, it } from 'vitest';
import { postStatus } from '../src/lib/social-post-status.ts';
import type { VariantStatus } from '../src/lib/social.ts';

const v = (status: VariantStatus, effectiveAt: string | null = null) => ({ status, effectiveAt });
const post = (variants: ReturnType<typeof v>[], archivedAt: string | null = null) => ({ archivedAt, variants });

describe('postStatus (#3656)', () => {
  it('names a draft, a review and an approval by what comes next', () => {
    expect(postStatus(post([v('draft')])).key).toBe('draft');
    expect(postStatus(post([v('in_review')])).key).toBe('review');
    expect(postStatus(post([v('approved')])).key).toBe('approved');
    expect(postStatus(post([v('changes_requested')])).key).toBe('changes');
  });

  it('puts a failure first, whatever else the channels say', () => {
    expect(postStatus(post([v('published', '2026-11-18T02:00:00Z'), v('failed')])).key).toBe('attention');
    expect(postStatus(post([v('draft'), v('needs_attention')])).key).toBe('attention');
  });

  it('gives the earliest time of what is still to go out, and the latest of what went out', () => {
    expect(postStatus(post([v('scheduled', '2026-11-20T09:00:00Z'), v('scheduled', '2026-11-19T09:00:00Z')]))).toEqual({ key: 'scheduled', at: '2026-11-19T09:00:00Z' });
    // One channel out, one still to go: what is to happen is the news.
    expect(postStatus(post([v('published', '2026-11-18T02:00:00Z'), v('scheduled', '2026-11-19T09:00:00Z')]))).toEqual({ key: 'scheduled', at: '2026-11-19T09:00:00Z' });
    expect(postStatus(post([v('published', '2026-11-18T02:00:00Z'), v('published', '2026-11-18T03:00:00Z')]))).toEqual({ key: 'published', at: '2026-11-18T03:00:00Z' });
  });

  it('ignores cancelled and removed channels, and says so when none is left', () => {
    expect(postStatus(post([v('cancelled'), v('draft')])).key).toBe('draft');
    expect(postStatus(post([v('cancelled'), v('removed')])).key).toBe('cancelled');
  });

  it('says archived before anything else', () => {
    expect(postStatus(post([v('published', '2026-11-18T02:00:00Z')], '2026-11-18T05:00:00Z')).key).toBe('archived');
  });
});
