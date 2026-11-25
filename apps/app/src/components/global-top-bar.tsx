// SPDX-License-Identifier: AGPL-3.0-only
// Persistent 48px HubSpot-style Global Top Bar for desktop (>= md) across every org screen (#4923 Phase 2, #4926):
// left Logo (Overview home link) + optional `[` collapse toggle, center Cmd+K search trigger, and fixed right utility
// cluster (Vy quick drawer, universal `+` quick-create menu, Notifications bell, Settings gear, compact AI meter, AccountPopover).
import type { Ref } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { AiMeter } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { isSettingsPath } from '../lib/apps.ts';
import type { QuickCreateItem } from '../lib/quick-create.ts';
import { showTopBarAiPill } from '../lib/vy.ts';
import { AccountPopover } from './app-nav.tsx';
import { QuickCreateMenu } from './quick-create-menu.tsx';
import { Logo } from './ui.tsx';

export interface GlobalTopBarProps {
  slug: string;
  pathname: string;
  hasSecondary: boolean;
  secondaryCollapsed: boolean;
  onToggleSecondary?: (() => void) | undefined;
  onOpenPalette: () => void;
  paletteKeys: string;
  quickCreateItems: readonly QuickCreateItem[];
  onOpenQuickCapture?: (() => void) | undefined;
  vyOpen: boolean;
  onOpenVy: () => void;
  canUseVy: boolean;
  gmName: string;
  unreadNotices: string | null;
  aiMeter?: AiMeter | undefined;
  canViewAiBudgets: boolean;
  orgs: readonly { orgId: string; slug: string; name: string }[];
  email: string | undefined;
  headerRef?: Ref<HTMLElement>;
  toggleRef?: Ref<HTMLButtonElement>;
}

const iconLinkClass = (active: boolean) =>
  cn(
    'relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors motion-reduce:transition-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
    active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
  );

const AI_PILL_TONE = {
  ok: 'border-border bg-background text-muted-foreground hover:text-foreground',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  stop: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

function isNotificationsPath(pathname: string): boolean {
  const [, o, slug, screen] = pathname.replace(/\/+$/, '').split('/');
  return o === 'o' && Boolean(slug) && screen?.toLowerCase() === 'notifications';
}

export function GlobalTopBar({
  slug,
  pathname,
  hasSecondary,
  secondaryCollapsed,
  onToggleSecondary,
  onOpenPalette,
  paletteKeys,
  quickCreateItems,
  onOpenQuickCapture,
  vyOpen,
  onOpenVy,
  canUseVy,
  gmName,
  unreadNotices,
  aiMeter,
  canViewAiBudgets,
  orgs,
  email,
  headerRef,
  toggleRef,
}: GlobalTopBarProps) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  const navigate = useNavigate();
  const settingsSelected = isSettingsPath(pathname);
  const notificationsSelected = isNotificationsPath(pathname);
  const aiState = aiMeter?.aiOn ? aiMeter.state : 'off';
  const showAiPill = showTopBarAiPill(aiMeter);

  const aiPillTitle = showAiPill
    ? t(
        aiMeter.state === 'stop'
          ? 'aiPill.stop'
          : aiMeter.state === 'warn'
            ? 'aiPill.warn'
            : 'aiPill.label',
        { percent: String(aiMeter.percent) },
      )
    : undefined;

  const aiPillTone =
    showAiPill && aiMeter.state !== 'none'
      ? AI_PILL_TONE[aiMeter.state]
      : AI_PILL_TONE.ok;

  return (
    <header
      ref={headerRef}
      data-testid="global-top-bar"
      className="hidden h-12 shrink-0 items-center justify-between gap-3 border-b bg-sidebar px-3 md:flex print:hidden"
    >
      {/* Left slot: persistent Logo -> /overview + optional `[` secondary menu toggle */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          to="/o/$slug/overview"
          params={{ slug }}
          title={t('overview')}
          data-testid="topbar-home-link"
          className="inline-flex h-8 items-center rounded-lg px-2 hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Logo />
          <span className="sr-only">, {t('overview')}</span>
        </Link>
        {hasSecondary && onToggleSecondary && (
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleSecondary}
            aria-label={secondaryCollapsed ? t('expandSidebar') : t('collapseSidebar')}
            title={secondaryCollapsed ? t('expandSidebar') : t('collapseSidebar')}
            aria-expanded={!secondaryCollapsed}
            data-testid="sidebar-toggle-btn"
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <NavIcon name={secondaryCollapsed ? 'sidebarExpand' : 'sidebarCollapse'} className="size-4" />
          </Button>
        )}
      </div>

      {/* Center slot: global Cmd+K / Ctrl K search trigger */}
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <button
          type="button"
          onClick={onOpenPalette}
          title={`${tp('open')} (${paletteKeys})`}
          data-testid="topbar-search-btn"
          className="flex h-8 w-full max-w-md items-center justify-between gap-2 rounded-lg border border-field-border bg-background px-3 text-left text-sm text-subtle-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-2">
            <NavIcon name="search" className="size-4 shrink-0" />
            <span className="truncate">{tp('open')}</span>
            <span className="sr-only"> ({paletteKeys})</span>
          </span>
          <kbd aria-hidden="true" className="shrink-0 rounded-sm border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] leading-none whitespace-nowrap text-muted-foreground">
            {paletteKeys}
          </kbd>
        </button>
      </div>

      {/* Right fixed utility cluster: Vy -> + -> Bell -> Settings -> AI budget pill -> AccountPopover */}
      <div className="flex shrink-0 items-center gap-1" data-testid="topbar-utility-cluster">
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={onOpenVy}
          aria-expanded={vyOpen}
          title={t('vyDrawer.trigger', { name: gmName })}
          data-testid="topbar-vy-btn"
          data-vy-allowed={canUseVy ? 'true' : 'false'}
          data-ai-state={aiState}
          className="h-8 gap-1.5 px-2.5 text-xs font-medium text-foreground hover:bg-sidebar-accent"
        >
          <NavIcon
            name="appAi"
            className={cn(
              'size-4',
              canUseVy && aiMeter?.aiOn && aiMeter.state !== 'stop' ? 'text-proposal' : 'text-muted-foreground',
            )}
          />
          <span aria-hidden="true">{gmName}</span>
          <span className="sr-only">{t('vyDrawer.trigger', { name: gmName })}</span>
        </Button>

        <QuickCreateMenu
          slug={slug}
          items={quickCreateItems}
          onOpenQuickCapture={onOpenQuickCapture}
          variant="topbar"
          testId="shell-quick-capture-btn"
        />

        <Link
          to="/o/$slug/notifications"
          params={{ slug }}
          activeOptions={{ exact: true }}
          title={unreadNotices ? `${t('bell')} (${unreadNotices})` : t('bell')}
          aria-current={notificationsSelected ? 'page' : undefined}
          data-testid="topbar-notifications-link"
          className={iconLinkClass(notificationsSelected)}
        >
          <span className="sr-only">{unreadNotices ? `${t('bell')} (${unreadNotices})` : t('bell')}</span>
          <NavIcon name="alerts" className="size-4" />
          {unreadNotices && (
            <span
              aria-hidden="true"
              data-testid="topbar-notifications-badge"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
            >
              {unreadNotices}
            </span>
          )}
        </Link>

        {/* Plain anchor with router navigate preserves aria-current="true" on /settings and /settings/* (#4499). */}
        <a
          href={`/o/${encodeURIComponent(slug)}/settings`}
          aria-label={t('settings')}
          title={t('settings')}
          aria-current={settingsSelected ? 'true' : undefined}
          data-testid="topbar-settings-link"
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            void navigate({ to: '/o/$slug/settings', params: { slug } });
          }}
          className={iconLinkClass(settingsSelected)}
        >
          <NavIcon name="settings" className="size-4" />
        </a>

        {showAiPill &&
          (canViewAiBudgets ? (
            <Link
              to="/o/$slug/ai-usage"
              params={{ slug }}
              title={aiPillTitle}
              data-testid="topbar-ai-meter"
              data-state={aiMeter.state}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-[11px] font-medium tabular-nums transition-colors motion-reduce:transition-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                aiPillTone,
              )}
            >
              <NavIcon name="appAi" className="size-3.5" />
              <span aria-hidden="true">{t('aiPill.short', { percent: String(aiMeter.percent) })}</span>
              <span className="sr-only">{aiPillTitle}</span>
            </Link>
          ) : (
            <span
              title={aiPillTitle}
              data-testid="topbar-ai-meter"
              data-state={aiMeter.state}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-[11px] font-medium tabular-nums',
                aiPillTone,
              )}
            >
              <NavIcon name="appAi" className="size-3.5" />
              <span aria-hidden="true">{t('aiPill.short', { percent: String(aiMeter.percent) })}</span>
              <span className="sr-only">{aiPillTitle}</span>
            </span>
          ))}

        <AccountPopover slug={slug} orgs={orgs} email={email} variant="topbar" />
      </div>
    </header>
  );
}
