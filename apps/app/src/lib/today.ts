// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" on Home (issue #2383), the parts that need no screen: grouping the merged items by kind, the screen an
// item opens, and the icon of each kind. The items come from kernel.today (already merged and ordered; the shape is
// @crove/kernel-contract's today.ts), and each line's own read decided what this member may see.
import { TODAY_KIND_ORDER, isTodayAnnotation, sortTodayItems, type TodayItem, type TodayKind, type TodaySeverity } from '@crove/kernel-contract';
import type { NavIconName } from '@crove/ui/components/nav-icon';

export interface TodayGroup {
  kind: TodayKind;
  items: TodayItem[];
}

// The kinds that have items, in Home's order (flags first), each with its items in the order kernel.today gave them.
// The order is applied again here so a list that arrives from a cache or a stub still reads the same way.
export function groupToday(items: readonly TodayItem[]): TodayGroup[] {
  const sorted = sortTodayItems(items);
  return TODAY_KIND_ORDER.map((kind) => ({ kind, items: sorted.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

export const TODAY_ICON: Record<TodayKind, NavIconName> = {
  flag: 'alerts',
  proposal: 'inbox',
  message: 'comments',
  deadline: 'vat',
};

// A line's read does not know the org's slug, so an item's href is a path inside the org (`/vat`, `/inbox/abc`), and the
// app puts the org in front. A path that already names the org (`/o/<slug>/...`) is kept as it is.
export function todayPath(slug: string, href: string): string {
  return href === '/o' || href.startsWith('/o/') ? href : `/o/${encodeURIComponent(slug)}${href === '/' ? '' : href}`;
}

// The number of items, or the sum of what the grouped items count: what the group heading says. An item with no count is one.
export function todayTotal(items: readonly TodayItem[]): number {
  return items.reduce((sum, item) => sum + (item.count ?? 1), 0);
}

// The rows Home lists, and the chips its annotations make: a flag that annotates proposals ("3 have a failed check") is not a row of its
// own, since those are the proposals already listed; it becomes a chip on them (#3591).
export function queueRows(items: readonly TodayItem[]): TodayItem[] {
  return items.filter((item) => !isTodayAnnotation(item));
}

export type ProposalChip = { severity: TodaySeverity; count: number };

// How many of the listed proposals carry a failed check (block) or a warning (warn). A count never exceeds the proposals the member sees:
// the read that flags counts every pending proposal of the books, and some wait for another approver, so the chip is capped by what is listed here.
export function proposalChips(items: readonly TodayItem[]): ProposalChip[] {
  const listed = todayTotal(items.filter((i) => i.kind === 'proposal' && !isTodayAnnotation(i)));
  const noted = (severity: TodaySeverity) => items.filter((i) => i.annotates === 'proposal' && (i.severity ?? 'info') === severity).reduce((n, i) => n + (i.count ?? 1), 0);
  const chips: ProposalChip[] = [];
  let room = listed;
  for (const severity of ['block', 'warn', 'info'] as const) {
    const count = Math.min(noted(severity), room);
    room -= count;
    if (count > 0) chips.push({ severity, count });
  }
  return chips;
}

// The most rows the queue shows before "Xem tất cả" (HM-2): the tax deadlines stay in the first screen.
export const QUEUE_ROWS = 5;

// The first `max` rows over all the groups, in the groups' order; a group left with no row is not listed.
export function limitGroups(groups: readonly TodayGroup[], max: number): TodayGroup[] {
  let left = max;
  const out: TodayGroup[] = [];
  for (const group of groups) {
    if (left <= 0) break;
    const items = group.items.slice(0, left);
    left -= items.length;
    out.push({ kind: group.kind, items });
  }
  return out;
}
