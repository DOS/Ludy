// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post (W3, #3834): the small rules the post card and the panel share. Which posts can be boosted, what the post gives the ad (its words, its
// link, the Page it went out on), the defaults, the posts the AI coworker suggests (a ranking of counts Ludy already reads: no model call), and the words for each
// state, goal and audience in both languages.
import { describe, expect, it } from 'vitest';
import { ADS_BOOST_AUDIENCES, ADS_BOOST_GOALS, ADS_BOOST_STATES, ADS_PLAN_LIMITS } from '@crove/kernel-contract';
import { translatorFor } from '../src/i18n/runtime.ts';
import {
  audienceText,
  boostBlock,
  boostCopy,
  boostDefaults,
  boostGoals,
  boostLink,
  boostOver,
  boostPage,
  boostStateText,
  boostStateTone,
  continueDraft,
  boostableVariants,
  engagementOf,
  goalHintText,
  goalText,
  suggestBoosts,
  SUGGEST_MAX,
  type BoostPost,
} from '../src/lib/ads-boost.ts';

const NOW = Date.parse('2026-11-19T10:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const variant = (over: Partial<BoostPost['variants'][number]> = {}): BoostPost['variants'][number] => ({
  provider: 'facebook_page',
  connectionId: 'page-1',
  status: 'published',
  externalUrl: 'https://www.facebook.com/page/posts/1',
  removedAt: null,
  publishedAt: ago(2),
  ...over,
});
const post = (over: Partial<BoostPost> = {}): BoostPost => ({ id: 'p1', title: null, body: 'Khai trương chi nhánh mới vào thứ Bảy này.', linkUrl: null, archivedAt: null, variants: [variant()], ...over });

describe('which posts can be boosted', () => {
  it('needs a channel Meta can boost, out and not taken down, and a post that is not archived', () => {
    expect(boostBlock(post())).toBeNull();
    expect(boostBlock(post({ archivedAt: ago(1) }))).toBe('archived');
    expect(boostBlock(post({ variants: [] }))).toBe('not_published');
    expect(boostBlock(post({ variants: [variant({ status: 'scheduled' })] }))).toBe('not_published');
    expect(boostBlock(post({ variants: [variant({ removedAt: ago(1) })] }))).toBe('not_published');
    expect(boostBlock(post({ variants: [variant({ provider: 'linkedin' })] }))).toBe('not_published');
    expect(boostBlock(post({ variants: [variant({ provider: 'instagram' })] }))).toBeNull();
    // The offline sandbox channel can be boosted, to try the whole path on the sandbox ad platform.
    expect(boostBlock(post({ variants: [variant({ provider: 'sandbox' })] }))).toBeNull();
    expect(boostableVariants(post({ variants: [variant(), variant({ provider: 'x' }), variant({ provider: 'instagram', connectionId: 'ig' })] })).map((v) => v.provider)).toEqual(['facebook_page', 'instagram']);
  });
});

describe('what the post gives the ad', () => {
  it('opens the post’s own https link, else its page on the platform, else none', () => {
    expect(boostLink(post({ linkUrl: 'https://example.com/khai-truong' }))).toBe('https://example.com/khai-truong');
    expect(boostLink(post())).toBe('https://www.facebook.com/page/posts/1');
    // A link that is not https is not used, and the platform's page stands in.
    expect(boostLink(post({ linkUrl: 'http://example.com' }))).toBe('https://www.facebook.com/page/posts/1');
    expect(boostLink(post({ variants: [variant({ externalUrl: null })] }))).toBeNull();
    expect(boostLink(post({ variants: [variant({ externalUrl: 'javascript:alert(1)' })] }))).toBeNull();
    expect(boostLink(post({ linkUrl: `https://example.com/${'a'.repeat(2000)}`, variants: [variant({ externalUrl: null })] }))).toBeNull();
  });

  it('takes the headline from the title or the first line and the text from the body, within the soft limits', () => {
    expect(boostCopy(post({ title: 'Khai trương', body: 'Mời bạn ghé thử cà phê mới.' }))).toEqual({ headline: 'Khai trương', primaryText: 'Mời bạn ghé thử cà phê mới.' });
    expect(boostCopy(post({ body: 'Dòng đầu tiên\nDòng thứ hai' })).headline).toBe('Dòng đầu tiên');
    const long = boostCopy(post({ body: 'từ '.repeat(200) }));
    expect([...long.headline].length).toBeLessThanOrEqual(ADS_PLAN_LIMITS.headlineSoft);
    expect([...long.primaryText].length).toBeLessThanOrEqual(ADS_PLAN_LIMITS.primaryTextSoft);
    // A post with no words leaves both empty for the person to write.
    expect(boostCopy(post({ body: '   ', title: null }))).toEqual({ headline: '', primaryText: '' });
  });

  it('runs as the Page the post went out on when it is one of the org’s, else the person chooses', () => {
    expect(boostPage(post(), [{ id: 'page-1' }, { id: 'page-2' }])).toBe('page-1');
    expect(boostPage(post(), [{ id: 'page-2' }])).toBeNull();
    expect(boostPage(post({ variants: [variant({ provider: 'instagram', connectionId: 'ig-1' })] }), [{ id: 'ig-1' }])).toBeNull();
  });

  it('offers Traffic and Engagement only when there is a link to open, and Messages always', () => {
    expect(boostGoals(post())).toEqual(ADS_BOOST_GOALS);
    expect(boostGoals(post({ variants: [variant({ externalUrl: null })] }))).toEqual(['messages']);
  });

  it('starts with Traffic for a post that has a link of its own, else Engagement, else Messages; a round budget in the currency’s unit; three days; everyone', () => {
    expect(boostDefaults(post({ linkUrl: 'https://example.com/a' }), 'VND')).toEqual({ goal: 'traffic', budget: '100000', days: 3, audience: 'vn_all' });
    expect(boostDefaults(post(), 'USD')).toEqual({ goal: 'engagement', budget: '10', days: 3, audience: 'vn_all' });
    expect(boostDefaults(post({ variants: [variant({ externalUrl: null })] }), 'VND').goal).toBe('messages');
  });
});

describe('continuing a draft', () => {
  it('starts from the draft’s account, goal, amount and days, and the default days when the draft’s are not offered', () => {
    expect(continueDraft({ adAccountId: 'a2', objective: 'messenger', maxSpend: '299997', days: 3 })).toEqual({ accountId: 'a2', prefill: { goal: 'messages', budget: '299997', days: 3 } });
    expect(continueDraft({ adAccountId: 'a1', objective: 'traffic', maxSpend: null, days: 4 })).toEqual({ accountId: 'a1', prefill: { goal: 'traffic' } });
    expect(continueDraft({ adAccountId: 'a1', objective: 'engagement', maxSpend: '100000', days: 30 }).prefill).toMatchObject({ goal: 'engagement', days: 30 });
  });
});

describe('the posts the AI coworker suggests', () => {
  const posts = [
    post({ id: 'quiet', variants: [variant({ publishedAt: ago(1) })] }),
    post({ id: 'best', variants: [variant({ publishedAt: ago(3) })] }),
    post({ id: 'second', variants: [variant({ publishedAt: ago(5) })] }),
    post({ id: 'third', variants: [variant({ publishedAt: ago(6) })] }),
    post({ id: 'fourth', variants: [variant({ publishedAt: ago(7) })] }),
    post({ id: 'old', variants: [variant({ publishedAt: ago(30) })] }),
    post({ id: 'boosted', variants: [variant({ publishedAt: ago(2) })] }),
    post({ id: 'archived', archivedAt: ago(1), variants: [variant({ publishedAt: ago(2) })] }),
    post({ id: 'draft', variants: [variant({ status: 'draft', publishedAt: null })] }),
  ];
  const metrics = [
    { postId: 'quiet', metrics: {} },
    { postId: 'best', metrics: { reactions: 50, comments: 10, shares: 5, saves: 5, reach: 9000 } },
    { postId: 'second', metrics: { reactions: 30, comments: 5 } },
    { postId: 'third', metrics: { reactions: 20 } },
    { postId: 'fourth', metrics: { reactions: 10 } },
    { postId: 'old', metrics: { reactions: 900 } },
    { postId: 'boosted', metrics: { reactions: 500 } },
    { postId: 'archived', metrics: { reactions: 500 } },
    { postId: 'draft', metrics: { reactions: 500 } },
  ];

  it('counts what people did with the post: reactions, comments, shares and saves, never reach, and nothing for a count the platform does not report', () => {
    expect(engagementOf({ reactions: 50, comments: 10, shares: 5, saves: 5, reach: 9000 })).toBe(70);
    expect(engagementOf({})).toBe(0);
    expect(engagementOf({ reactions: Number.NaN, comments: 3 })).toBe(3);
  });

  it('ranks the recent published posts by it, at most three, leaving out the quiet, the old, the boosted, the archived and what is not out', () => {
    const found = suggestBoosts(posts, metrics, new Set(['boosted']), NOW);
    expect(found.map((s) => s.post.id)).toEqual(['best', 'second', 'third']);
    expect(found).toHaveLength(SUGGEST_MAX);
    expect(found[0]?.engagement).toBe(70);
  });

  it('takes the best count of a post that went out on several channels, and breaks a tie by id so the list never shuffles', () => {
    const two = post({ id: 'two', variants: [variant({ publishedAt: ago(2) }), variant({ provider: 'instagram', connectionId: 'ig', publishedAt: ago(2) })] });
    const tie = post({ id: 'aaa', variants: [variant({ publishedAt: ago(2) })] });
    const found = suggestBoosts([two, tie], [{ postId: 'two', metrics: { reactions: 5 } }, { postId: 'two', metrics: { reactions: 9 } }, { postId: 'aaa', metrics: { reactions: 9 } }], new Set(), NOW);
    expect(found.map((s) => [s.post.id, s.engagement])).toEqual([['aaa', 9], ['two', 9]]);
  });

  it('suggests nothing when no post has counts yet, and never a post from the future', () => {
    expect(suggestBoosts(posts, [], new Set(), NOW)).toEqual([]);
    expect(suggestBoosts([post({ id: 'later', variants: [variant({ publishedAt: ago(-2) })] })], [{ postId: 'later', metrics: { reactions: 5 } }], new Set(), NOW)).toEqual([]);
  });
});

describe('the words', () => {
  it('says every state, goal and audience in both languages, and which states are over', () => {
    for (const locale of ['en', 'vi'] as const) {
      const t = translatorFor(locale);
      for (const state of ADS_BOOST_STATES) {
        const text = boostStateText(state, null, t);
        expect(text, `${locale} ${state}`).not.toMatch(/^ads\./);
        expect(text.length).toBeGreaterThan(2);
      }
      for (const goal of ADS_BOOST_GOALS) {
        expect(goalText(goal, t), `${locale} ${goal}`).not.toMatch(/^ads\./);
        expect(goalHintText(goal, t), `${locale} ${goal}`).not.toMatch(/^ads\./);
      }
      for (const audience of ADS_BOOST_AUDIENCES) expect(audienceText(audience, t), `${locale} ${audience}`).not.toMatch(/^ads\./);
    }
    const en = translatorFor('en');
    expect(boostStateText('launching', 'paused', en)).toBe('Created, starts on its first day');
    expect(boostStateText('launching', 'ad_set', en)).toBe('Being created at the ad platform');
    expect(boostStateText('waiting_approval', null, translatorFor('vi'))).toBe('Chờ duyệt');
    expect(ADS_BOOST_STATES.filter(boostOver)).toEqual(['stopped', 'failed', 'cancelled', 'ended']);
    expect(boostStateTone('live')).toBe('success');
    expect(boostStateTone('failed')).toBe('destructive');
    expect(boostStateTone('waiting_approval')).toBe('warning');
  });
});
