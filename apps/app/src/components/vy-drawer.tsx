// SPDX-License-Identifier: AGPL-3.0-only
// Global Top Bar Vy quick drawer (#4926): opens a right-hand Sheet grounded in `vy.use` and AI meter state,
// providing a deterministic today summary and workflow shortcuts when AI is off or out of budget.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { todayCount, type AiMeter as AiMeterData, type TodayItem } from '@ludy/kernel-contract';
import { buttonVariants } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { Skeleton } from '@ludy/ui/components/skeleton';
import { cn } from '@ludy/ui/lib/utils';
import type { Role } from '../lib/members.ts';
import { countMatchingTodayForPrompt, matchHomeVyTargets } from '../lib/home-vy.ts';
import { resolveVyDrawerStatus } from '../lib/vy.ts';
import { AiMeter } from './ai-meter.tsx';
import { CoworkerAttribution, ProposalSurface } from './proposal-surface.tsx';
import { ErrorText } from './ui.tsx';

export function VyDrawerBody({
  slug,
  open,
  onClose,
  gmName,
  canUseVy,
  permissionsLoaded,
  canViewAiBudgets,
  aiMeter,
  todayItems,
  todayLoading = false,
  todayError = null,
  role,
  modules,
  prompt = null,
  canApproveFinance = false,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  gmName: string;
  canUseVy: boolean;
  permissionsLoaded: boolean;
  canViewAiBudgets: boolean;
  aiMeter: AiMeterData | undefined;
  todayItems: readonly TodayItem[];
  todayLoading?: boolean | undefined;
  todayError?: string | null | undefined;
  role: Role | undefined;
  modules: readonly string[];
  prompt?: string | null | undefined;
  canApproveFinance?: boolean | undefined;
}) {
  const t = useTranslations('nav.vyDrawer');
  const tv = useTranslations('overview.vy.chips');
  const status = resolveVyDrawerStatus({ canUseVy, permissionsLoaded, meter: aiMeter });
  const totalToday = todayCount(todayItems);
  const notesOn = modules.includes('notes');
  const financeOn = modules.includes('finance');
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const matchedTargets = prompt ? matchHomeVyTargets(prompt, { modules, role, canApproveFinance }) : [];
  const promptMatchCount = prompt
    ? countMatchingTodayForPrompt(prompt, todayItems, { modules, role, canApproveFinance })
    : 0;

  const linkClass = cn(
    buttonVariants({ variant: 'outline', size: 'sm' }),
    'w-full justify-start gap-2',
  );

  return (
    <SheetBody className="space-y-4">
      {prompt && (
        <ProposalSurface proposed={false} className="space-y-2 p-3" data-testid="vy-drawer-prompt">
          <h3 className="text-xs font-medium text-subtle-foreground">{t('promptHeading')}</h3>
          <p className="text-sm font-medium text-foreground">{prompt}</p>
          {!todayLoading && !todayError && (
            <p className="text-xs text-foreground" data-testid="vy-drawer-prompt-summary">
              {promptMatchCount > 0 ? t('promptMatches', { count: promptMatchCount }) : t('promptMatchesEmpty')}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('promptHint')}</p>
          {matchedTargets.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {matchedTargets.map((chip) => (
                <Link
                  key={chip.id}
                  to={chip.to}
                  params={{ slug }}
                  onClick={onClose}
                  className={buttonVariants({ variant: 'outline', size: 'xs' })}
                >
                  {tv(chip.id)}
                </Link>
              ))}
            </div>
          )}
        </ProposalSurface>
      )}
      <ProposalSurface proposed={false} className="space-y-2 p-3" data-testid="vy-drawer-status">
        {status === 'noPermission' ? (
          <p className="text-sm text-muted-foreground" data-testid="vy-drawer-no-permission">
            {t('noPermission', { name: gmName })}
          </p>
        ) : status === 'aiOff' ? (
          <p className="text-sm text-muted-foreground" data-testid="vy-drawer-ai-off">
            {t('aiOff')}
          </p>
        ) : status === 'budgetStop' ? (
          <>
            <p className="text-sm text-destructive" data-testid="vy-drawer-budget-stop">
              {t('budgetStop', { name: gmName })}
            </p>
            {open && <AiMeter />}
          </>
        ) : (
          <>
            <p className="text-sm text-foreground" data-testid="vy-drawer-ready">
              {t('readyHint', { name: gmName })}
            </p>
            {open && <AiMeter />}
          </>
        )}
      </ProposalSurface>

      <section className="space-y-2 rounded-xl border bg-card p-3" aria-label={t('todayHeading')}>
        <h3 className="text-sm font-semibold text-foreground">{t('todayHeading')}</h3>
        {todayError ? (
          <div data-testid="vy-drawer-today-error">
            <ErrorText>{todayError}</ErrorText>
          </div>
        ) : todayLoading ? (
          <Skeleton className="h-4 w-48" data-testid="vy-drawer-today-loading" />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="vy-drawer-today-summary">
            {totalToday > 0 ? t('todayCount', { count: totalToday }) : t('todayEmpty')}
          </p>
        )}
        <Link to="/o/$slug/overview" params={{ slug }} onClick={onClose} className={linkClass}>
          <NavIcon name="overview" />
          <span>{t('openOverview')}</span>
        </Link>
      </section>

      <section className="space-y-2" aria-label={t('shortcutsHeading')}>
        <h3 className="text-xs font-medium text-subtle-foreground">{t('shortcutsHeading')}</h3>
        <div className="space-y-1.5">
          {notesOn && canWrite && canUseVy && (
            <Link to="/o/$slug/my-work" params={{ slug }} onClick={onClose} className={linkClass}>
              <NavIcon name="myWork" />
              <span>{t('openMyWorkPlanner', { name: gmName })}</span>
            </Link>
          )}
          {notesOn && (
            <Link to="/o/$slug/notes" params={{ slug }} onClick={onClose} className={linkClass}>
              <NavIcon name="notes" />
              <span>{t('openNotes')}</span>
            </Link>
          )}
          {financeOn && (
            <Link to="/o/$slug/inbox" params={{ slug }} onClick={onClose} className={linkClass}>
              <NavIcon name="inbox" />
              <span>{t('openInbox')}</span>
            </Link>
          )}
          <Link to="/o/$slug/agents" params={{ slug }} onClick={onClose} className={linkClass}>
            <NavIcon name="agents" />
            <span>{t('openAgents')}</span>
          </Link>
          {canViewAiBudgets && (
            <Link to="/o/$slug/ai-usage" params={{ slug }} onClick={onClose} className={linkClass}>
              <NavIcon name="aiUsage" />
              <span>{t('openAiUsage')}</span>
            </Link>
          )}
        </div>
      </section>
    </SheetBody>
  );
}

export function VyDrawer({
  slug,
  open,
  onOpenChange,
  gmName,
  canUseVy,
  permissionsLoaded,
  canViewAiBudgets,
  aiMeter,
  todayItems,
  todayLoading = false,
  todayError = null,
  role,
  modules,
  prompt = null,
  canApproveFinance = false,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gmName: string;
  canUseVy: boolean;
  permissionsLoaded: boolean;
  canViewAiBudgets: boolean;
  aiMeter: AiMeterData | undefined;
  todayItems: readonly TodayItem[];
  todayLoading?: boolean | undefined;
  todayError?: string | null | undefined;
  role: Role | undefined;
  modules: readonly string[];
  prompt?: string | null | undefined;
  canApproveFinance?: boolean | undefined;
}) {
  const t = useTranslations('nav.vyDrawer');
  const tc = useTranslations('common');
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={tc('close')} className="sm:max-w-md" data-testid="vy-drawer">
        <SheetHeader>
          <CoworkerAttribution coworker="gm" name={gmName} showRole />
          <SheetTitle>{t('title', { name: gmName })}</SheetTitle>
          <SheetDescription>{t('subtitle')}</SheetDescription>
        </SheetHeader>
        <VyDrawerBody
          slug={slug}
          open={open}
          onClose={close}
          gmName={gmName}
          canUseVy={canUseVy}
          permissionsLoaded={permissionsLoaded}
          canViewAiBudgets={canViewAiBudgets}
          aiMeter={aiMeter}
          todayItems={todayItems}
          todayLoading={todayLoading}
          todayError={todayError}
          role={role}
          modules={modules}
          prompt={prompt}
          canApproveFinance={canApproveFinance}
        />
      </SheetContent>
    </Sheet>
  );
}
