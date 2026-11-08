// SPDX-License-Identifier: AGPL-3.0-only
// The Reports screen of the Engage app (#2435): one item of the menu, with a tab for each area whose module runs. The tabs and the
// modules they need live here; the screen (routes/reports.tsx) and its panels (components/report-panels.tsx) show them.
import { MODULE_SCREENS, type BoardColumn } from '@crove/kernel-contract';
import { Decimal } from '@crove/l10n-vn';

// The areas in the order the tabs show, each with the module whose reads its panel makes: the conversations and the posts are the
// social module's, the sales the crm module's, the ads the ads module's. The route declares the same modules in MODULE_SCREENS
// (apps/app/test/reports.test.ts holds the two to each other).
export const REPORT_TABS = ['conversations', 'sales', 'quotes', 'posts', 'ads'] as const;
export type ReportTab = (typeof REPORT_TABS)[number];
// The quotes tab (#2699) is the crm module's too: with crm off the app shows none of it.
export const REPORT_TAB_MODULE: Record<ReportTab, string> = { conversations: 'social', sales: 'crm', quotes: 'crm', posts: 'social', ads: 'ads' };

// The tabs this deployment shows: those whose module is installed, in order.
export function reportTabs(modules: readonly string[]): ReportTab[] {
  return REPORT_TABS.filter((tab) => modules.includes(REPORT_TAB_MODULE[tab]));
}

// The modules the reports route declares, for the test that keeps them equal to the tabs'.
export const REPORTS_ROUTE_MODULES: readonly string[] = MODULE_SCREENS.social.routes.find((route) => route.path === 'reports')?.modules ?? [];

// ?area= is the tab shown (not ?tab=: the router types every route's search keys together, and the social screen's `tab` is another set of
// values); a value that is not a tab is left out, so the screen opens on its first tab instead of an error page (#1513).
export interface ReportsSearch {
  area?: ReportTab;
}
export function parseReportsSearch(search: Record<string, unknown>): ReportsSearch {
  const area = REPORT_TABS.find((candidate) => candidate === search.area);
  return area ? { area } : {};
}

// The tab shown: the one asked for when it is among the tabs, else the first.
export function shownTab(tabs: readonly ReportTab[], wanted: ReportTab | undefined): ReportTab | null {
  return wanted && tabs.includes(wanted) ? wanted : (tabs[0] ?? null);
}

// What the board holds, by kind of stage: the deals still open, the ones won and the ones lost, with their amounts. The amounts are
// decimal strings the server summed for each column; they are added here with decimal arithmetic, never as numbers.
export interface PipelineTotals {
  open: { deals: number; amount: string };
  won: { deals: number; amount: string };
  lost: { deals: number; amount: string };
}
export function pipelineTotals(columns: readonly Pick<BoardColumn, 'stage' | 'count' | 'total'>[]): PipelineTotals {
  const sum = (kind: 'open' | 'won' | 'lost') => {
    const of = columns.filter((column) => column.stage.kind === kind);
    return { deals: of.reduce((n, column) => n + column.count, 0), amount: of.reduce((total, column) => total.plus(column.total), new Decimal(0)).toFixed() };
  };
  return { open: sum('open'), won: sum('won'), lost: sum('lost') };
}
