import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@crove/ui/components/dropdown-menu';
import { NavIcon, type NavIconName } from '@crove/ui/components/nav-icon';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { ADMIN_ITEMS, BELL_ITEM, TOP_ITEMS, currentMenuItem, isHeadedGroup, type AppId, type InstalledApp, type NavItem, type NavLabel } from '../lib/apps.ts';
import { signOut } from '../lib/session-actions.ts';
import { StatusLink } from './status-link.tsx';
import { SupportLink } from './support-link.tsx';
import { EntitySwitcher } from './entity-switcher.tsx';
import { ThemeSwitcher } from './theme-switcher.tsx';
import { Logo } from './ui.tsx';

// Clearer names inside the menu: Engage's posts item says what it holds, since the app itself is named "Engage" in the
// switcher. None may contain another item's name: a link is found by its name (e2e), and a name inside another matches both.
const IN_MENU_LABEL: Partial<Record<NavLabel, 'socialPosts'>> = { social: 'socialPosts' };

const APP_ICON: Record<AppId, NavIconName> = { teamwork: 'appTeamwork', finance: 'appAccounting', engage: 'appSocial', hr: 'appHr', sign: 'journal', ai: 'appAi' };

// A menu item's icon is the one named like its label (packages/ui nav-icon.tsx). Items without an icon of their own take
// the closest: Ads and the AI budgets the banknote of the vouchers (money spent), the Tài chính overview the dashboard of the
// overview, the reports and the tax the spreadsheet of the VAT return; the type fails to compile for a label that has neither.
const OWN_ICON = { accountingOverview: 'overview', ads: 'vouchers', aiUsage: 'vouchers', aiConnections: 'settings', socialInbox: 'inbox', socialNotifications: 'alerts', reports: 'vat', tax: 'vat', salesInvoices: 'documents', stock: 'fixedAssets', declarations: 'documents', recruiting: 'employees', meetings: 'comments', signEnvelopes: 'documents', signTemplates: 'notes', signVerify: 'portalList' } as const satisfies { [L in Exclude<NavLabel, NavIconName>]: NavIconName };
const menuIcon = (label: NavLabel): NavIconName => (label in OWN_ICON ? OWN_ICON[label as keyof typeof OWN_ICON] : (label as NavIconName));

export interface ShellNavProps {
  slug: string;
  // The installed apps (#1528) and the one whose menu shows: the app of the screen, or the last one used on the org's
  // own screens (Settings, the chart).
  apps: readonly InstalledApp[];
  app: AppId;
  // Whether the screen belongs to an app; on the org's own screens no app is marked current.
  inApp: boolean;
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

// What the sidebar and the phone drawer both hold (#1245, #1528): the app switcher down the left edge, with the org's
// own screens at its foot; beside it the org switch, the palette button, the current app's menu and the account menu.
// Every control is at least 44px tall in the phone drawer (below md) and 24px in the sidebar.
export function ShellNav({ slug, apps, app, inApp, badges, orgs, email, onOpenPalette, paletteKeys, onOpenQuickCapture, onNavigate }: ShellNavProps) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  const tmw = useTranslations('myWork');
  const groupIdBase = useId();
  const current = apps.find((a) => a.id === app) ?? apps[0];
  const hasBadge = (items: readonly NavItem[]) => items.some((item) => Boolean(badges[item.label]));
  // Exactly one item is marked current: the one of the longest path that holds the screen, a tab keeping its menu item (#3225).
  // The router's own fuzzy match would also mark Engage's Posts (`social`) on the Inbox (`social/inbox`), so it is turned off below.
  const { pathname } = useLocation();
  const currentTo = currentMenuItem(pathname);
  // The shell's own places in the switcher: the overview on top, the bell and Settings at the foot.
  const railLink = (item: NavItem, name: string, badge?: string | number | null) => (
    <li key={item.to}>
      <Link
        to={item.to}
        params={{ slug }}
        onClick={onNavigate}
        className={`relative flex min-h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-center text-[11px] leading-tight hover:bg-sidebar-accent hover:text-foreground ${item.to === currentTo ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}
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
    <nav aria-label={t('menu')} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-16 shrink-0 flex-col border-r py-3 md:py-4">
        <ul aria-label={t('appsLabel')} className="flex flex-col items-center gap-1">
          {TOP_ITEMS.map((item) => railLink(item, t(item.label)))}
          {apps.map((a) => {
            const selected = inApp && a.id === current?.id;
            return (
              <li key={a.id}>
                <Link
                  to={a.home}
                  params={{ slug }}
                  // Switching apps keeps the phone drawer open, so the new app's menu is there to pick from.
                  aria-current={selected ? 'true' : undefined}
                  className={`relative flex min-h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-center text-[11px] leading-tight hover:bg-sidebar-accent hover:text-foreground ${selected ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}
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
          {ADMIN_ITEMS.map((item) => railLink(item, t(item.label)))}
        </ul>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-0 md:py-4">
        <div className="mb-4 hidden px-2 md:block">
          <Logo />
        </div>
        <div className="px-2">
          {orgs.length > 1 && (
            <Link to="/clients" onClick={onNavigate} className="mb-2 flex min-h-11 items-center text-sm text-link hover:underline md:min-h-6">
              {t('allClients')}
            </Link>
          )}
          <OrgMenu slug={slug} orgs={orgs} onNavigate={onNavigate} />
          {/* The legal entity of the finance books (#1486), when the caller sees more than one. */}
          <EntitySwitcher slug={slug} />
        </div>
        <div className="mt-2 flex items-center gap-1.5">
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
        {/* The menu scrolls only on a very short window, so the account menu below it always stays on screen. */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto">
          {current && (
            <p className="px-3 pb-1.5 text-sm font-semibold text-foreground">{t(`appNames.${current.id}`)}</p>
          )}
          {current?.groups.map((group, index) => {
            const labelId = `${groupIdBase}-${group.id}`;
            // A group named by the app itself (the first of the other apps) needs no heading, and neither does the reports item.
            const heading = isHeadedGroup(group.id) ? group.id : null;
            return (
              <section
                key={group.id}
                className={index === 0 ? '' : 'mt-3 md:mt-2'}
                {...(heading ? { 'aria-labelledby': labelId } : { 'aria-label': group.id === 'reports' ? t('reports') : t(`appNames.${current.id}`) })}
              >
                {heading && (
                  // A label, not a heading: the page's own heading stays the only one with a screen's name ("Khách hàng").
                  <p id={labelId} className="px-3 pb-1 text-xs font-medium text-subtle-foreground">
                    {t(`groups.${heading}`)}
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
                          <span className="min-w-0 flex-1 truncate">{t(IN_MENU_LABEL[item.label] ?? item.label)}</span>
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
        <AccountMenu email={email} />
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
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="org-menu"
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-field-border bg-transparent px-2.5 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent md:min-h-8 md:py-1 dark:bg-input/30"
        >
          <span className="sr-only">{t('org')}: </span>
          <span className="min-w-0 flex-1 truncate">{current?.name ?? slug}</span>
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

// The account at the foot of the menu: the support link (#310) stays in view, the email opens status, language and
// theme, and sign out stays in view (#516) under it.
function AccountMenu({ email }: { email: string | undefined }) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  return (
    <div className="mt-3 shrink-0 border-t pt-2">
      <SupportLink className="mb-1 flex min-h-11 items-center px-2 text-sm text-link md:min-h-6" />
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 md:min-h-0 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span className="sr-only">{t('account')}: </span>
          <span className="min-w-0 flex-1 truncate">{email}</span>
          <NavIcon name="expand" className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="mt-2 flex flex-col gap-2 px-2 pb-1 text-xs text-subtle-foreground">
          <StatusLink className="flex min-h-11 items-center text-sm text-link md:min-h-6" />
          {/* One per row: side by side, both names were cut off at the sidebar's width. */}
          <LocaleSwitcher className="w-full text-muted-foreground" />
          <ThemeSwitcher className="w-full text-muted-foreground" />
        </div>
      </details>
      <button type="button" className="mt-1 inline-flex min-h-11 items-center px-2 text-xs text-subtle-foreground hover:text-muted-foreground md:min-h-6" onClick={() => void signOut()}>
        {tc('signOut')}
      </button>
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
