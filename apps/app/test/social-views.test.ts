// SPDX-License-Identifier: AGPL-3.0-only
// The Posts screen's tabs and views (#3655): six status tabs and three views of the posts, not ten tabs; the figures and the
// photo library are screens of their own. Every old tab name stays valid in the address.
import { describe, expect, it } from 'vitest';
import { isSocialScreen, parseSocialSearch, SOCIAL_STATUS_TABS, SOCIAL_TABS, tabOfView, viewOfTab } from '../src/lib/social.ts';

describe('the Posts screen views (#3655)', () => {
  it('draws fewer than ten tabs, all of them valid names in the address', () => {
    expect(SOCIAL_STATUS_TABS.length).toBeLessThan(10);
    for (const tab of SOCIAL_STATUS_TABS) expect(SOCIAL_TABS).toContain(tab);
  });

  it('puts every tab in one view, and the figures and the library in none', () => {
    expect(viewOfTab('upcoming')).toBe('list');
    expect(viewOfTab('drafts')).toBe('list');
    expect(viewOfTab('calendar')).toBe('calendar');
    expect(viewOfTab('board')).toBe('board');
    expect(viewOfTab('metrics')).toBeNull();
    expect(viewOfTab('library')).toBeNull();
    expect(isSocialScreen('metrics')).toBe(true);
    expect(isSocialScreen('library')).toBe(true);
    expect(isSocialScreen('calendar')).toBe(false);
  });

  it('returns to the status tab the visit came from, or the schedule, when the list view is picked', () => {
    expect(tabOfView('list', 'review')).toBe('review');
    expect(tabOfView('list', 'upcoming')).toBe('upcoming');
    expect(tabOfView('list', 'calendar')).toBe('upcoming');
    expect(tabOfView('calendar', 'drafts')).toBe('calendar');
    expect(tabOfView('board', 'drafts')).toBe('board');
  });

  it('keeps an old link to a view or a screen working', () => {
    for (const tab of ['calendar', 'board', 'metrics', 'library']) expect(parseSocialSearch({ tab })).toEqual({ tab });
  });
});
