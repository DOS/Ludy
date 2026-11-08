// SPDX-License-Identifier: AGPL-3.0-only
// The Reports screen of the Engage app (#2435): which tabs show for the modules a deployment runs, the tab a link asks for, and the pipeline's
// totals from the deal board's columns.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { REPORTS_ROUTE_MODULES, REPORT_TABS, REPORT_TAB_MODULE, parseReportsSearch, pipelineTotals, reportTabs, shownTab } from '../src/lib/reports.ts';

describe('the tabs of the reports', () => {
  it('shows a tab for each area whose module runs, in the order of the design', () => {
    expect(reportTabs(['kernel', 'social', 'crm', 'ads'])).toEqual(['conversations', 'sales', 'quotes', 'posts', 'ads']);
    // Only crm: the sales tab alone. Only social: the conversations and the posts. Only ads: the ads.
    expect(reportTabs(['kernel', 'crm'])).toEqual(['sales', 'quotes']);
    expect(reportTabs(['kernel', 'social'])).toEqual(['conversations', 'posts']);
    expect(reportTabs(['kernel', 'ads'])).toEqual(['ads']);
    expect(reportTabs(['kernel', 'social', 'crm'])).toEqual(['conversations', 'sales', 'quotes', 'posts']);
    expect(reportTabs(['kernel', 'finance', 'notes'])).toEqual([]);
  });

  it('asks for the same modules as the route that declares the screen, and has each tab named in both languages', () => {
    expect([...new Set(Object.values(REPORT_TAB_MODULE))].sort()).toEqual([...REPORTS_ROUTE_MODULES].sort());
    expect([...REPORT_TABS]).toEqual(Object.keys(REPORT_TAB_MODULE));
    for (const tab of REPORT_TABS) {
      expect(viMessages.reports.tabs, `vi reports.tabs.${tab}`).toHaveProperty(tab);
      expect(en.reports.tabs, `en reports.tabs.${tab}`).toHaveProperty(tab);
    }
  });

  it('reads ?area= and leaves out what is not a tab', () => {
    expect(parseReportsSearch({ area: 'sales' })).toEqual({ area: 'sales' });
    expect(parseReportsSearch({ area: 'ads' })).toEqual({ area: 'ads' });
    for (const area of ['', 'Sales', 'money', 'deals', 7, null, undefined, ['sales']]) expect(parseReportsSearch({ area }), String(area)).toEqual({});
    // ?tab= is the social screen's own key: it never opens a report.
    expect(parseReportsSearch({ tab: 'sales' })).toEqual({});
  });

  it('shows the tab asked for when the deployment has it, else the first', () => {
    expect(shownTab(['sales'], 'sales')).toBe('sales');
    expect(shownTab(['sales'], 'ads')).toBe('sales');
    expect(shownTab(['conversations', 'posts'], undefined)).toBe('conversations');
    expect(shownTab(['conversations', 'posts'], 'posts')).toBe('posts');
    expect(shownTab([], 'sales')).toBeNull();
  });
});

describe('the pipeline totals', () => {
  const column = (kind: 'open' | 'won' | 'lost', count: number, total: string) => ({ stage: { id: `${kind}-${total}`, name: kind, kind, position: 0 }, count, total });

  it('adds each kind of stage as decimals, never as numbers', () => {
    expect(
      pipelineTotals([column('open', 2, '1000000.10'), column('open', 3, '0.20'), column('open', 0, '0'), column('won', 1, '250000'), column('lost', 4, '90000000000000000.5')]),
    ).toEqual({ open: { deals: 5, amount: '1000000.3' }, won: { deals: 1, amount: '250000' }, lost: { deals: 4, amount: '90000000000000000.5' } });
  });

  it('answers zero for a board with nothing in it', () => {
    expect(pipelineTotals([])).toEqual({ open: { deals: 0, amount: '0' }, won: { deals: 0, amount: '0' }, lost: { deals: 0, amount: '0' } });
  });
});
