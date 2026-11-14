// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useLocation } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { tabGroupOfPath, type NavItem } from '../lib/apps.ts';

// The strip over a screen that is a tab of a menu item (#3225): Chứng từ opens on "Chờ duyệt" and has "Tất cả chứng từ" beside it, a customer list has the payment reminders, and so on. The tabs
// are links to screens that keep their own addresses, so a bookmark, a notification and the overview's cards still land on the right one; the strip is drawn here, once, instead of
// in each page. A tab whose module is not installed is left out, and a group left with one tab shows no strip.
export function ScreenTabs({ slug, installed, badges }: { slug: string; installed: readonly NavItem[]; badges: Partial<Record<string, string | number | null | undefined>> }) {
  const t = useTranslations('nav');
  const { pathname } = useLocation();
  const group = tabGroupOfPath(pathname);
  if (!group) return null;
  const tabs = group.tabs.filter((tab) => installed.some((item) => item.to === `/o/$slug/${tab.path}`));
  if (tabs.length < 2) return null;
  const here = pathname.split('/').slice(3).join('/').replace(/\/$/, '');
  return (
    <nav aria-label={t('tabsLabel')} className="mb-5 border-b">
      <ul className="-mb-px flex flex-wrap gap-x-5">
        {tabs.map((tab) => {
          const current = tab.path === here;
          const badge = badges[tab.label];
          return (
            <li key={tab.path}>
              <Link
                to={`/o/$slug/${tab.path}` as NavItem['to']}
                params={{ slug }}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                className={`flex min-h-11 items-center gap-1.5 border-b-2 px-0.5 text-sm md:min-h-9 ${current ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {t(tab.label)}
                {badge ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{badge}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
