import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ludy/ui/components/dropdown-menu';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@ludy/ui/components/popover';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { APP_ICON, menuIcon } from '../lib/menu-icons.ts';
import {
  ADMIN_ITEMS,
  BELL_ITEM,
  SETTINGS_ITEMS,
  TOP_ITEMS,
  currentMenuItem,
  isHeadedGroup,
  isSettingsPath,
  type AppId,
  type HeadedGroupId,
  type InstalledApp,
  type NavItem,
  type NavLabel,
  type SettingsNavItem,
} from '../lib/apps.ts';
import { installedItems } from '../lib/modules.ts';
import { installedModules } from '../lib/org-modules.ts';
import { signOut } from '../lib/session-actions.ts';
import { StatusLink } from './status-link.tsx';
import { SupportLink } from './support-link.tsx';
import { EntitySwitcher } from './entity-switcher.tsx';
import { ThemeSwitcher } from './theme-switcher.tsx';
import { Logo } from './ui.tsx';

// Clearer names inside the menu: Engage's posts item says what it holds, since the app itself is named "Engage" in the
// switcher. None may contain another item's name: a link is found by its name (e2e), and a name inside another matches both.
const IN_MENU_LABEL: Partial<Record<NavLabel, 'socialPosts'>> = { social: 'socialPosts' };

export interface ShellNavProps {
  slug: string;
  // The installed apps (#1528) and the one whose menu shows: the app of the screen. On the org's own screens (Overview,
  // Notifications, the activity log) `app` is null: no app is marked and no app menu shows (#3588), only the rail. On
  // Settings screens `app` is null too, while the Settings rail button and secondary menu show (#4499).
  apps: readonly InstalledApp[];
  app: AppId | null;
  // Installed Settings sub-pages (#4499); defaults from installedModules() when omitted in standalone component renders.
  settingsItems?: readonly SettingsNavItem[];
  // The count shown on an item (pending proposals on the inbox, unread notifications); an app with a count gets a dot.
  badges: Partial<Record<string, string | number | null | undefined>>;
  orgs: readonly { orgId: string; slug: string; name: string }[];
  email: string | undefined;
  onOpenPalette: () => void;
  paletteKeys: string;
  onOpenQuickCapture?: (() => void) | undefined;
  // Called after a link or the org switch navigates: the phone drawer closes then.
  onNavigate?: () => void;
}

const railItemClass = (selected: boolean) =>
  `relative flex min-h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-center text-[11px] leading-tight hover:bg-sidebar-accent hover:text-foreground ${selected ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`;

// What the sidebar and the phone drawer both hold (#1245, #1528): the app switcher down the left edge, with the org's
// own screens at its foot; beside it the org switch, the palette button, the current app or Settings menu and the account menu.
// Every control is at least 44px tall in the phone drawer (below md) and 24px in the sidebar.
export function ShellNav({ slug, apps, app, settingsItems, badges, orgs, email, onOpenPalette, paletteKeys, onOpenQuickCapture, onNavigate }: ShellNavProps) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  const tmw = useTranslations('myWork');
  const navigate = useNavigate();
  const groupIdBase = useId();
  const current = app === null ? undefined : apps.find((a) => a.id === app);
  const hasBadge = (items: readonly NavItem[]) => items.some((item) => Boolean(badges[item.label]));
  // Exactly one item is marked current: the one of the longest path that holds the screen, a tab keeping its menu item (#3225).
  // The router's own fuzzy match would also mark Engage's Posts (`social`) on the Inbox (`social/inbox`), so it is turned off below.
  const { pathname } = useLocation();
  const currentTo = currentMenuItem(pathname);
  const settingsSelected = current === undefined && isSettingsPath(pathname);
  const menuTitle = current ? t(`appNames.${current.id}`) : settingsSelected ? t('settings') : null;
  const menuGroups: ReadonlyArray<{ id: string; heading: HeadedGroupId | null; ariaLabel?: string; items: readonly (NavItem | SettingsNavItem)[] }> = current
    ? current.groups.map((group) => {
        const heading = isHeadedGroup(group.id) ? group.id : null;
        return {
          id: group.id,
          heading,
          ...(heading ? {} : { ariaLabel: group.id === 'reports' ? t('reports') : t(`appNames.${current.id}`) }),
          items: group.items,
        };
      })
    : settingsSelected
      ? [{ id: 'settings', heading: null, ariaLabel: t('settings'), items: settingsItems ?? installedItems(installedModules(), SETTINGS_ITEMS) }]
      : [];
  // The shell's own places in the switcher: the overview on top, the bell and Settings at the foot.
  const railLink = (item: NavItem, name: string, badge?: string | number | null) => (
    <li key={item.to}>
      <Link
        to={item.to}
        params={{ slug }}
        onClick={onNavigate}
        className={railItemClass(item.to === currentTo)}
        activeOptions={{ exact: true }}
        {...(item.to === currentTo ? { 'aria-current': 'page' as const } : {})}
      >
        <NavIcon name={menuIcon(item.label)} className="size-5" />
        <span>{name}</span>
        {badge ? <span className="absolute top-1.5 right-2.5 size-2 rounded-full bg-primary" aria-hidden="true" /> : null}
      </Link>
    </li>
  );
  return (
    // One landmark for the whole menu, the switcher included, so "the menu" is one place for a screen reader.
    // On a phone the whole column scrolls as one (rail, menu, account; #3588): the nav scrolls, and the row inside it is at least as high as
    // the drawer and as high as its content, so a long menu (Tài chính has four groups) is never cut off behind the account block. From md
    // up the row vanishes (`contents`) and the sidebar is laid out as before.
    <nav aria-label={t('menu')} className="flex min-h-0 min-w-0 flex-1 max-md:items-start max-md:overflow-y-auto">
      <div className="flex min-w-0 flex-1 max-md:min-h-full md:contents">
        <div className="flex w-16 shrink-0 flex-col border-r py-3 md:py-4">
          <ul aria-label={t('appsLabel')} className="flex flex-col items-center gap-1">
            {TOP_ITEMS.map((item) => railLink(item, t(item.label)))}
            {apps.map((a) => {
              const selected = a.id === current?.id;
              return (
                <li key={a.id}>
                  <Link
                    to={a.home}
                    params={{ slug }}
                    // Switching apps keeps the phone drawer open, so the new app's menu is there to pick from.
                    aria-current={selected ? 'true' : undefined}
                    className={railItemClass(selected)}
                  >
                    <NavIcon name={APP_ICON[a.id]} className="size-5" />
                    <span>{t(`apps.${a.id}`)}</span>
                    {hasBadge(a.groups.flatMap((g) => g.items)) && <span className="absolute top-1.5 right-2.5 size-2 rounded-full bg-primary" aria-hidden="true" />}
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul className="mt-auto flex flex-col items-center gap-1 pt-3">
            {BELL_ITEM && railLink(BELL_ITEM, t('bell'), badges[BELL_ITEM.label] as string | number | null | undefined)}
            {ADMIN_ITEMS.map((item) => {
              if (item.to !== '/o/$slug/settings') return railLink(item, t(item.label));
              // Use a plain anchor with router navigate so TanStack Router does not overwrite aria-current="true"
              // to "page" on /o/<slug>/settings, and omit onNavigate so the phone drawer stays open (#4499).
              return (
                <li key={item.to}>
                  <a
                    href={`/o/${encodeURIComponent(slug)}/settings`}
                    aria-current={settingsSelected ? 'true' : undefined}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                      event.preventDefault();
                      void navigate({ to: item.to, params: { slug } });
                    }}
                    className={railItemClass(settingsSelected)}
                  >
                    <NavIcon name={menuIcon(item.label)} className="size-5" />
                    <span>{t(item.label)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-0 md:py-4">
          <div className="mb-3 hidden px-2 md:block">
            <Logo />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenPalette}
              className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-left text-sm text-subtle-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-0"
            >
              <span className="min-w-0 truncate">{tp('open')}</span>
              <kbd className="shrink-0 rounded-sm border px-1 font-mono text-[11px] whitespace-nowrap">{paletteKeys}</kbd>
            </button>
            {onOpenQuickCapture && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={onOpenQuickCapture}
                aria-label={tmw('quickCaptureTrigger')}
                title={tmw('quickCaptureTrigger')}
                data-testid="shell-quick-capture-btn"
                className="min-h-11 min-w-11 shrink-0 md:size-8 md:min-h-0 md:min-w-0"
              >
                <ProjectIcon name="plus" className="size-4" />
              </Button>
            )}
          </div>
          {/* The legal entity of the finance books (#1486), when the caller sees more than one. */}
          <EntitySwitcher slug={slug} />
          {/* The menu scrolls only on a very short window, so the account menu below it always stays on screen. On Overview,
              Notifications, and Audit there is no menu, only the rail (#3588); Settings shows its sub-pages (#4499). On a phone the nav scrolls instead (above). */}
          <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto max-md:overflow-y-visible">
            {menuTitle && (
              <p className="px-3 pb-1.5 text-sm font-semibold text-foreground">{menuTitle}</p>
            )}
            {menuGroups.map((group, index) => {
              const labelId = `${groupIdBase}-${group.id}`;
              return (
                <section
                  key={group.id}
                  className={index === 0 ? '' : 'mt-3 md:mt-2'}
                  {...(group.heading ? { 'aria-labelledby': labelId } : { 'aria-label': group.ariaLabel })}
                >
                  {group.heading && (
                    // A label, not a heading: the page's own heading stays the only one with a screen's name ("Khách hàng").
                    <p id={labelId} className="px-3 pb-1 text-xs font-medium text-subtle-foreground">
                      {t(`groups.${group.heading}`)}
                    </p>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const badge = badges[item.label];
                      const isCurrent = item.to === currentTo;
                      return (
                        <li key={item.to}>
                          <Link
                            to={item.to}
                            params={{ slug }}
                            onClick={onNavigate}
                            className={`flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm hover:bg-sidebar-accent hover:text-foreground md:min-h-0 md:py-0.5 ${isCurrent ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}
                            activeOptions={{ exact: true }}
                            {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
                          >
                            <NavIcon name={menuIcon(item.label)} />
                            <span className="min-w-0 flex-1 truncate">{t(IN_MENU_LABEL[item.label as NavLabel] ?? item.label)}</span>
                            {badge ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{badge}</span> : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
          <AccountPopover slug={slug} orgs={orgs} email={email} onNavigate={onNavigate} />
        </div>
      </div>
    </nav>
  );
}

type ShellOrg = ShellNavProps['orgs'][number];

// Picking an org in the org menu: the phone drawer closes first, then the org's overview opens, as the native select did.
export function switchOrg(navigate: (to: { to: '/o/$slug/overview'; params: { slug: string } }) => unknown, onNavigate: (() => void) | undefined, slug: string): void {
  onNavigate?.();
  void navigate({ to: '/o/$slug/overview', params: { slug } });
}

// The org switch (#3579): a button with the current org's name opens a menu of every org the caller belongs to, the
// current one checked, and "Thêm tổ chức" at its foot, where a firm adds its next client company (#324). It replaced a
// native select, whose OS popup covered the field on macOS, and the separate link under it. The popup renders next to
// the button, inside the nav, so it also works in the phone drawer (a modal dialog).
export function OrgMenu({ slug, orgs, onNavigate }: { slug: string; orgs: readonly ShellOrg[]; onNavigate?: (() => void) | undefined }) {
  const t = useTranslations('nav');
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const current = orgs.find((o) => o.slug === slug);
  return (
    <div ref={host}>
      <DropdownMenu
        onOpenChange={(open, details) => {
          // Restore focus to the trigger immediately on Escape before MenuPopup unmounts, so a parent
          // PopoverPopup (restoreFocus="popup") never sees a transient document.body focus and steal focus.
          if (!open && details.reason === 'escape-key') {
            host.current?.querySelector<HTMLButtonElement>('[data-testid="org-menu"]')?.focus({ preventScroll: true });
          }
        }}
      >
        <DropdownMenuTrigger
          data-testid="org-menu"
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-field-border bg-transparent px-2.5 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent md:min-h-8 md:py-1 dark:bg-input/30"
        >
          <span className="sr-only">{t('org')}: </span>
          {/* The full name is the tooltip when a long company name is cut off (#3588). */}
          <span className="min-w-0 flex-1 truncate" title={current?.name ?? slug}>
            {current?.name ?? slug}
          </span>
          <NavIcon name="expand" className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        {/* Base UI names the menu by its button ("Tổ chức: DOS"). */}
        <DropdownMenuContent container={host}>
          <DropdownMenuRadioGroup value={slug} onValueChange={(next: string) => next !== slug && switchOrg(navigate, onNavigate, next)}>
            {orgs.map((o) => (
              <DropdownMenuRadioItem key={o.orgId} value={o.slug} label={o.name}>
                {/* A long company name wraps here, so two similar names stay told apart; the button cuts it off. */}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLinkItem render={<Link to="/onboarding" onClick={onNavigate} />} className="text-link">
            <NavIcon name="add" />
            {t('addOrg')}
          </DropdownMenuLinkItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// The account popover body (DESIGN.md 3.8, #4502): identity, active org switcher, segmented theme and language
// toggles, help/status links, and sign-out. Exported separately so SSR unit tests can inspect the panel contents.
export function AccountPanel({
  slug,
  orgs,
  email,
  onNavigate,
  onSignOut,
}: {
  slug: string;
  orgs: readonly ShellOrg[];
  email: string | undefined;
  onNavigate?: (() => void) | undefined;
  onSignOut: () => void;
}) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  return (
    <div className="space-y-3">
      {email && (
        <div className="border-b px-1 pb-2.5">
          <p className="text-xs font-medium text-foreground [overflow-wrap:anywhere]" title={email}>
            {email}
          </p>
        </div>
      )}
      <div className="space-y-1.5">
        <p aria-hidden="true" className="px-1 text-xs font-medium text-muted-foreground">
          {t('org')}
        </p>
        <OrgMenu slug={slug} orgs={orgs} onNavigate={onNavigate} />
        {orgs.length > 1 && (
          <Link
            to="/clients"
            onClick={onNavigate}
            className="flex min-h-11 items-center rounded-md px-2 text-sm text-link hover:bg-accent hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8"
          >
            {t('allClients')}
          </Link>
        )}
      </div>
      <div className="space-y-2 border-t pt-2.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
            {tc('theme')}
          </span>
          <ThemeSwitcher />
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
            {tc('language')}
          </span>
          <LocaleSwitcher />
        </div>
      </div>
      <div className="space-y-0.5 border-t pt-2">
        <SupportLink className="flex min-h-11 items-center rounded-md px-2 text-sm text-link hover:bg-accent hover:text-link hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8" />
        <StatusLink className="flex min-h-11 items-center rounded-md px-2 text-sm text-link hover:bg-accent hover:text-link hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8" />
        <button
          type="button"
          className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8"
          onClick={onSignOut}
        >
          {tc('signOut')}
        </button>
      </div>
    </div>
  );
}

// The account menu at the foot of the navigation (#4502): keeps subtle active-org context visible on the trigger and
// houses OrgMenu, theme/language segmented controls, support/status links, and sign-out inside a clean Popover.
export function AccountPopover({
  slug,
  orgs,
  email,
  onNavigate,
}: {
  slug: string;
  orgs: readonly ShellOrg[];
  email: string | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const t = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const current = orgs.find((o) => o.slug === slug);
  const orgName = current?.name ?? slug;
  const initial = (email?.trim()[0] ?? orgName.trim()[0] ?? 'L').toUpperCase();
  const closeAndNavigate = () => {
    setOpen(false);
    onNavigate?.();
  };
  return (
    <div ref={host} className="mt-3 shrink-0 border-t pt-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-testid="account-menu-trigger"
          className="group/account flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent md:min-h-10"
        >
          <span className="sr-only">{t('account')}: </span>
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {initial}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground" title={email}>
              {email ?? t('account')}
            </span>{' '}
            <span className="block truncate text-xs text-muted-foreground" title={orgName}>
              {orgName}
            </span>
          </span>
          <NavIcon
            name="expand"
            className="shrink-0 text-muted-foreground transition-transform group-data-popup-open/account:rotate-180 motion-reduce:transition-none"
          />
        </PopoverTrigger>
        <PopoverContent
          container={host}
          side="top"
          align="start"
          sideOffset={8}
          aria-label={t('account')}
          className="w-72 p-3"
          data-testid="account-popover"
        >
          <AccountPanel
            slug={slug}
            orgs={orgs}
            email={email}
            onNavigate={closeAndNavigate}
            onSignOut={() => {
              setOpen(false);
              void signOut();
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// The phone's menu (issue #1245): a modal drawer from the left with the same content as the sidebar. Esc and a click
// on the backdrop close it; the browser returns focus to the menu button.
export function NavDrawer({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const t = useTranslations('nav');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  // Leaving the org layout with the drawer open closes it first, so the browser ends the modal state cleanly.
  useEffect(() => {
    const el = dialog.current;
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={t('menu')}
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      className="m-0 h-dvh max-h-none w-[min(20rem,90vw)] max-w-none overflow-hidden bg-sidebar p-0 text-foreground backdrop:bg-foreground/30"
    >
      <div className="flex h-full flex-col px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-4 flex items-center justify-between px-2">
          <Logo />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            aria-label={t('closeMenu')}
          >
            <NavIcon name="close" className="size-5" />
          </button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}
