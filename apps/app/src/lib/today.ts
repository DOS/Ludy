// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" on Home (issue #2383), the parts that need no screen: grouping the merged items by kind, the screen an
// item opens, and the icon of each kind. The items come from kernel.today (already merged and ordered; the shape is
// @crove/kernel-contract's today.ts), and each line's own read decided what this member may see.
import { TODAY_KIND_ORDER, sortTodayItems, type TodayItem, type TodayKind } from '@crove/kernel-contract';
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
