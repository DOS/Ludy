// SPDX-License-Identifier: AGPL-3.0-only
import type { Ref } from 'react';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { Logo } from './ui.tsx';

// The phone's header (issue #1245): the menu button, the org's name and the search; the rest is in the drawer. Sticky, so a control the
// keyboard focuses stops below it (#1575). A long company name takes two lines and has its full name as the tooltip, and the search is
// an icon (its words did not fit beside the name, #3588). Every control is 44px.
export function PhoneHeader({
  headerRef,
  orgName,
  attention,
  onOpenMenu,
  onOpenPalette,
}: {
  headerRef?: Ref<HTMLElement>;
  orgName: string | undefined;
  // A dot on the menu button when something waits in the inbox.
  attention: boolean;
  onOpenMenu: () => void;
  onOpenPalette: () => void;
}) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  return (
    <header ref={headerRef} className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3 py-2 md:hidden">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label={t('openMenu')}
        className="relative grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <NavIcon name="menu" className="size-5" />
        {attention && <span className="absolute top-2 right-2 size-2 rounded-full bg-primary" aria-hidden="true" />}
      </button>
      <span data-testid="phone-org-name" className="line-clamp-2 min-w-0 flex-1 text-sm leading-tight font-medium [overflow-wrap:anywhere]" title={orgName}>
        {orgName ?? <Logo />}
      </span>
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={tp('open')}
        title={tp('open')}
        data-testid="phone-search"
        className="grid size-11 shrink-0 place-items-center rounded-lg border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <NavIcon name="search" className="size-5" />
      </button>
    </header>
  );
}
