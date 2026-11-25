// SPDX-License-Identifier: AGPL-3.0-only
import type { Ref } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { brandName } from '../i18n/brand.ts';
import type { QuickCreateItem } from '../lib/quick-create.ts';
import { QuickCreateMenu } from './quick-create-menu.tsx';
import { Logo } from './ui.tsx';

// The phone's header (issue #1245, updated #4926): menu button (44px), compact home mark + org name
// (two lines with full-name tooltip), optional quick-create `+` menu (44px), and icon-only Cmd+K search (44px).
export function PhoneHeader({
  headerRef,
  slug,
  orgName,
  attention,
  onOpenMenu,
  onOpenPalette,
  quickCreateItems,
  onOpenQuickCapture,
}: {
  headerRef?: Ref<HTMLElement>;
  slug?: string | undefined;
  orgName: string | undefined;
  // A dot on the menu button when something waits in the inbox.
  attention: boolean;
  onOpenMenu: () => void;
  onOpenPalette: () => void;
  quickCreateItems?: readonly QuickCreateItem[] | undefined;
  onOpenQuickCapture?: (() => void) | undefined;
}) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  return (
    <header ref={headerRef} className="flex items-center gap-1.5 border-b bg-sidebar px-2.5 py-2 md:hidden print:hidden">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label={t('openMenu')}
        className="relative grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <NavIcon name="menu" className="size-5" />
        {attention && <span className="absolute top-2 right-2 size-2 rounded-full bg-primary" aria-hidden="true" />}
      </button>
      {slug && (
        <Link
          to="/o/$slug/overview"
          params={{ slug }}
          aria-label={`${brandName()}, ${t('overview')}`}
          title={t('overview')}
          data-testid="phone-home-link"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-1 hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <svg viewBox="0 0 92 92" className="size-6" aria-hidden="true">
            <path className="fill-brand-lip" d="M0 15A11 11 0 0 1 11 4H32A11 11 0 0 1 43 15V32A11 11 0 0 1 32 43H11A11 11 0 0 1 0 32ZM49 15A11 11 0 0 1 60 4H81A11 11 0 0 1 92 15V32A11 11 0 0 1 81 43H60A11 11 0 0 1 49 32ZM0 64A11 11 0 0 1 11 53H32A11 11 0 0 1 43 64V81A11 11 0 0 1 32 92H11A11 11 0 0 1 0 81Z" />
            <path className="fill-brand-spark-lip" d="M49 64A11 11 0 0 1 60 53H81A11 11 0 0 1 92 64V81A11 11 0 0 1 81 92H60A11 11 0 0 1 49 81Z" />
            <path className="fill-brand" d="M0 11A11 11 0 0 1 11 0H32A11 11 0 0 1 43 11V28A11 11 0 0 1 32 39H11A11 11 0 0 1 0 28ZM49 11A11 11 0 0 1 60 0H81A11 11 0 0 1 92 11V28A11 11 0 0 1 81 39H60A11 11 0 0 1 49 28ZM0 60A11 11 0 0 1 11 49H32A11 11 0 0 1 43 60V77A11 11 0 0 1 32 88H11A11 11 0 0 1 0 77Z" />
            <path className="fill-brand-spark" d="M49 60A11 11 0 0 1 60 49H81A11 11 0 0 1 92 60V77A11 11 0 0 1 81 88H60A11 11 0 0 1 49 77Z" />
            <path className="fill-none stroke-brand-ink" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" d="M14.85 8.1V30.9H28.15M61.95 8.1V22.35A8.55 8.55 0 0 0 79.05 22.35V8.1M12 57.1H19.6A11.4 11.4 0 0 1 19.6 79.9H12Z" />
            <path className="fill-none stroke-brand-spark-ink" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" d="M61.95 57.1L70.5 69.1L79.05 57.1M70.5 69.1V79.9" />
          </svg>
        </Link>
      )}
      <span data-testid="phone-org-name" className="line-clamp-2 min-w-0 flex-1 text-sm leading-tight font-medium [overflow-wrap:anywhere]" title={orgName}>
        {orgName ?? (slug ? brandName() : <Logo />)}
      </span>
      {slug && quickCreateItems && (
        <QuickCreateMenu
          slug={slug}
          items={quickCreateItems}
          onOpenQuickCapture={onOpenQuickCapture}
          variant="phone"
          testId="phone-quick-create-btn"
        />
      )}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={tp('open')}
        title={tp('open')}
        data-testid="phone-search"
        className="grid size-11 shrink-0 place-items-center rounded-lg border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <NavIcon name="search" className="size-5" />
      </button>
    </header>
  );
}
