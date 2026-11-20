// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { tabGroupOfPath, type NavItem } from '../lib/apps.ts';

// The strip over a screen that is a tab of a menu item (#3225): Chứng từ opens on "Chờ duyệt" and has "Tất cả chứng từ" beside it, a customer list has the payment reminders, and so on. The tabs
// are links to screens that keep their own addresses, so a bookmark, a notification and the overview's cards still land on the right one; the strip is drawn here, once, instead of
// in each page. A tab whose module is not installed is left out, and a group left with one tab shows no strip.
export function ScreenTabs({ slug, installed, badges }: { slug: string; installed: readonly NavItem[]; badges: Partial<Record<string, string | number | null | undefined>> }) {
  const t = useTranslations('nav');
  const { pathname } = useLocation();
  // On a phone the strip scrolls sideways: a screen opened by address brings its own tab into view.
  useEffect(() => {
    document.querySelector('ul[aria-label] a[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [pathname]);
  const group = tabGroupOfPath(pathname);
  if (!group) return null;
  const tabs = group.tabs.filter((tab) => installed.some((item) => item.to === `/o/$slug/${tab.path}`));
  if (tabs.length < 2) return null;
  const here = pathname.split('/').slice(3).join('/').replace(/\/$/, '');
  return (
    <div className="mb-5 border-b print:hidden">
      {/* Not a navigation landmark: the menu stays the one place a screen reader and a test finds "the menu". */}
      {/* A phone scrolls the strip sideways instead of stacking its tabs in rows: Settings has seven (#3589). */}
      <ul aria-label={t('tabsLabel')} className="-mb-px flex gap-x-5 overflow-x-auto md:flex-wrap md:overflow-visible">
        {tabs.map((tab) => {
          const current = tab.path === here;
          const badge = badges[tab.label];
          return (
            <li key={tab.path} className="shrink-0">
              <Link
                to={`/o/$slug/${tab.path}` as NavItem['to']}
                params={{ slug }}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                className={`flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 text-sm md:min-h-9 ${current ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {t(tab.label)}
                {badge ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{badge}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
