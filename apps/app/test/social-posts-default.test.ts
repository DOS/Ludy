// SPDX-License-Identifier: AGPL-3.0-only
// The Posts screen's first view (#3654): it opens on what waits for a person, is named "Bài đăng" like its menu item, says
// the window it lists, and an empty list offers its one action.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { defaultSocialTab, SOCIAL_TABS } from '../src/lib/social.ts';

describe('the tab the Posts screen opens on', () => {
  it('shows the posts in review first, then the posts that need someone, else the schedule', () => {
    expect(defaultSocialTab({ review: 3, attention: 0 })).toBe('review');
    expect(defaultSocialTab({ review: 1, attention: 4 })).toBe('review');
    expect(defaultSocialTab({ review: 0, attention: 2 })).toBe('attention');
    expect(defaultSocialTab({ review: 0, attention: 0 })).toBe('upcoming');
    // Every answer is a tab the screen has.
    for (const counts of [{ review: 1, attention: 0 }, { review: 0, attention: 1 }, { review: 0, attention: 0 }]) {
      expect(SOCIAL_TABS).toContain(defaultSocialTab(counts));
    }
  });
});

describe('the Posts screen copy', () => {
  it('is named Bài đăng / Posts, as the menu is, and every back link says so', () => {
    expect(vi.social.title).toBe('Bài đăng');
    expect(en.social.title).toBe('Posts');
    for (const ns of ['notifications', 'ideas', 'bio', 'feeds', 'snippets', 'labels'] as const) {
      const back = (c: typeof vi | typeof en) => (c.social[ns] as { back?: string }).back;
      expect(back(vi), `vi ${ns}`).toBe('Về Bài đăng');
      expect(back(en), `en ${ns}`).toBe('Back to Posts');
    }
  });

  it('says the schedule window as it is (a year, not 4 weeks) and counts posts, not channels', () => {
    for (const copy of [vi.social, en.social]) {
      expect(copy.agendaEmpty).not.toMatch(/4 tuần|4 weeks/);
      expect(copy.metricsCapped).not.toMatch(/kênh đăng|channels/);
      expect(copy.metricsCappedPartial).not.toMatch(/kênh đăng|channels/);
    }
    expect(vi.social.agendaEmptyHint).toContain('cả năm tới');
    expect(vi.social.metricsCapped).toContain('500 bài đăng gần nhất');
    expect(en.social.metricsCapped).toContain('500 published posts');
  });

  it('has the words of every empty list action, in both languages', () => {
    for (const copy of [vi.social, en.social]) {
      for (const key of ['compose', 'composeFirst', 'seeSchedule', 'seePublished', 'libraryAdd'] as const) expect(copy[key], key).toBeTruthy();
    }
    expect(vi.social.composeFirst).toBe('Soạn bài đầu tiên');
    expect(vi.social.libraryAdd).toBe('Thêm ảnh');
    expect(vi.social.feeds.add).toBe('Thêm nguồn tin');
    expect(vi.social.labels.new).toBe('Thêm nhãn');
  });
});
