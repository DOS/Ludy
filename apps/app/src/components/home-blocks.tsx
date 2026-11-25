// SPDX-License-Identifier: AGPL-3.0-only
// Role x Enabled-App modular summary blocks for Global Home (#4923 Phase 4, #4928).
// Each block is gated by server eligibility + ADR-0053 effective modules and collapses zero-item states to one quiet line.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { HomeBlockId } from '@ludy/kernel-contract';
import { buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NavIcon, type NavIconName } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { errorMessage, orpc } from '../lib/api.ts';
import type { Role } from '../lib/members.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { TodayWeekly } from './today-weekly.tsx';
import { CardSkeleton, ErrorText } from './ui.tsx';

const LIST_CAP = 200;
const SIGN_ESIGN_LIST_CAP = 100;

export type HomeAppTarget =
  | '/o/$slug/vat'
  | '/o/$slug/inbox'
  | '/o/$slug/tasks'
  | '/o/$slug/notes'
  | '/o/$slug/social'
  | '/o/$slug/social/inbox'
  | '/o/$slug/bookings'
  | '/o/$slug/hr/employees'
  | '/o/$slug/hr/my'
  | '/o/$slug/sign/envelopes';

/** Quiet single-line collapsed empty block linking to the owning app. */
export function CollapsedHomeBlock({
  blockId,
  slug,
  to,
  icon,
  emptyLine,
  openLink,
  headingId,
  headingTitle,
}: {
  blockId: HomeBlockId;
  slug: string;
  to: HomeAppTarget;
  icon: NavIconName;
  emptyLine: string;
  openLink: string;
  headingId?: string;
  headingTitle?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      aria-label={headingId ? undefined : emptyLine}
      data-testid={`home-block-${blockId}`}
      data-block-collapsed="true"
    >
      {headingId && headingTitle && (
        <h2 id={headingId} className="sr-only">
          {headingTitle}
        </h2>
      )}
      <div
        data-testid={`home-block-empty-${blockId}`}
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm"
      >
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <NavIcon name={icon} className="size-4 text-muted-foreground" />
          <span>{emptyLine}</span>
          <span aria-hidden="true" className="text-subtle-foreground">
            ·
          </span>
          <Link to={to} params={{ slug }} className={cn('font-medium text-link hover:underline', PHONE_TARGET)}>
            {openLink}
          </Link>
        </span>
      </div>
    </section>
  );
}

/** Finance approvals summary block: pending proposals + failed files -> /o/$slug/inbox. */
export function FinanceApprovalsBlock({
  slug,
  isPending,
  error,
  pendingProposals,
  failedFiles,
}: {
  slug: string;
  isPending: boolean;
  error: unknown;
  pendingProposals: number | undefined;
  failedFiles: number | undefined;
}) {
  const t = useTranslations('overview.blocks.finance_approvals');

  if (isPending) {
    return (
      <section aria-label={t('title')} data-testid="home-block-finance_approvals">
        <CardSkeleton />
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label={t('title')} data-testid="home-block-finance_approvals">
        <ErrorText>{errorMessage(error)}</ErrorText>
      </section>
    );
  }

  const proposals = pendingProposals ?? 0;
  const failed = failedFiles ?? 0;
  if (proposals + failed === 0) {
    return (
      <CollapsedHomeBlock
        blockId="finance_approvals"
        slug={slug}
        to="/o/$slug/inbox"
        icon="inbox"
        emptyLine={t('emptyLine')}
        openLink={t('openLink')}
      />
    );
  }

  return (
    <section aria-labelledby="home-block-heading-finance_approvals" data-testid="home-block-finance_approvals">
      <Card className="block p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="home-block-heading-finance_approvals" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <NavIcon name="inbox" className="size-4 text-muted-foreground" />
              <span>{t('title')}</span>
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {[
                proposals > 0 ? t('pendingCount', { count: proposals }) : null,
                failed > 0 ? t('failedCount', { count: failed }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link to="/o/$slug/inbox" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
            {t('openLink')}
          </Link>
        </div>
      </Card>
    </section>
  );
}

/** Teamwork block: open tasks, read-only notes for viewers, and TodayWeekly when settled. */
export function TeamworkMyWorkBlock({
  slug,
  role,
  notesOn,
  tasksPending,
  tasksError,
  openTaskCount,
  showWeekly,
  hasWeeklySummary,
}: {
  slug: string;
  role: Role | undefined;
  notesOn: boolean;
  tasksPending: boolean;
  tasksError: unknown;
  openTaskCount: number;
  showWeekly: boolean;
  hasWeeklySummary: boolean;
}) {
  const t = useTranslations('overview.blocks.teamwork_my_work');

  if (role === 'viewer') {
    if (!notesOn) return null;
    return (
      <section aria-labelledby="home-block-heading-teamwork_my_work" data-testid="home-block-teamwork_my_work">
        <Card className="block p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 id="home-block-heading-teamwork_my_work" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <NavIcon name="notes" className="size-4 text-muted-foreground" />
                <span>{t('title')}</span>
              </h2>
              <p className="text-sm text-muted-foreground">{t('viewerNotes')}</p>
            </div>
            <Link to="/o/$slug/notes" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
              {t('openNotesLink')}
            </Link>
          </div>
        </Card>
      </section>
    );
  }

  if (tasksPending && !hasWeeklySummary) {
    return (
      <section aria-label={t('title')} data-testid="home-block-teamwork_my_work">
        <CardSkeleton />
      </section>
    );
  }
  if (tasksError && !hasWeeklySummary) {
    return (
      <section aria-label={t('title')} data-testid="home-block-teamwork_my_work">
        <ErrorText>{errorMessage(tasksError)}</ErrorText>
      </section>
    );
  }

  const collapsed = !tasksPending && !tasksError && openTaskCount === 0 && (!showWeekly || !hasWeeklySummary);
  if (collapsed) {
    return (
      <CollapsedHomeBlock
        blockId="teamwork_my_work"
        slug={slug}
        to="/o/$slug/tasks"
        icon="tasks"
        emptyLine={t('emptyLine')}
        openLink={t('openLink')}
      />
    );
  }

  return (
    <section aria-label={t('title')} className="space-y-3" data-testid="home-block-teamwork_my_work">
      {tasksPending ? (
        <CardSkeleton />
      ) : tasksError ? (
        <ErrorText>{errorMessage(tasksError)}</ErrorText>
      ) : openTaskCount > 0 ? (
        <Card className="block p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <NavIcon name="tasks" className="size-4 text-muted-foreground" />
                <span>{t('title')}</span>
              </h2>
              <p className="text-sm text-muted-foreground tabular-nums">{t('openCount', { count: openTaskCount })}</p>
            </div>
            <Link to="/o/$slug/tasks" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
              {t('openLink')}
            </Link>
          </div>
        </Card>
      ) : null}
      {showWeekly && <TodayWeekly slug={slug} />}
    </section>
  );
}

/** Engage pipeline block: upcoming CRM bookings, Social scheduled posts, and inbox conversation counts. */
export function EngagePipelineBlock({
  slug,
  crmOn,
  socialOn,
  weekWindow,
  enabled,
}: {
  slug: string;
  crmOn: boolean;
  socialOn: boolean;
  weekWindow: { from: string; to: string };
  enabled: boolean;
}) {
  const t = useTranslations('overview.blocks.engage_pipeline');

  const bookings = useQuery({
    ...orpc.crm.bookings.list.queryOptions({ input: { scope: 'mine', period: 'upcoming' } }),
    enabled: enabled && crmOn,
  });
  const posts = useQuery({
    ...orpc.social.posts.list.queryOptions({ input: { ...weekWindow, limit: LIST_CAP } }),
    enabled: enabled && socialOn,
  });
  const conversations = useQuery({
    ...orpc.conversations.counts.queryOptions({ input: {} }),
    enabled: enabled && socialOn,
  });

  if (!enabled || (!crmOn && !socialOn)) return null;

  const isPending = (crmOn && bookings.isPending) || (socialOn && (posts.isPending || conversations.isPending));
  if (isPending) {
    return (
      <section aria-label={t('title')} data-testid="home-block-engage_pipeline">
        <CardSkeleton />
      </section>
    );
  }

  const queryError = (crmOn && bookings.error) || (socialOn && (posts.error || conversations.error)) || null;
  if (queryError) {
    return (
      <section aria-label={t('title')} data-testid="home-block-engage_pipeline">
        <ErrorText>{errorMessage(queryError)}</ErrorText>
      </section>
    );
  }

  const upcomingCount = crmOn
    ? (bookings.data ?? []).filter((b) => b.status === 'pending' || b.status === 'confirmed').length
    : 0;
  const scheduledCount = socialOn
    ? (posts.data ?? []).filter((p) => p.status === 'scheduled').length
    : 0;
  const unreadInboxCount = socialOn ? (conversations.data?.unread ?? 0) : 0;
  const newInboxCount = socialOn ? (conversations.data?.new ?? 0) : 0;
  const primaryTo: HomeAppTarget = socialOn ? '/o/$slug/social' : '/o/$slug/bookings';

  if (upcomingCount === 0 && scheduledCount === 0 && unreadInboxCount === 0 && newInboxCount === 0) {
    return (
      <CollapsedHomeBlock
        blockId="engage_pipeline"
        slug={slug}
        to={primaryTo}
        icon="appSocial"
        emptyLine={socialOn ? t('emptyLine') : t('emptyCrmOnly')}
        openLink={t('openLink')}
      />
    );
  }

  return (
    <section aria-labelledby="home-block-heading-engage_pipeline" data-testid="home-block-engage_pipeline">
      <Card className="block p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="home-block-heading-engage_pipeline" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <NavIcon name="appSocial" className="size-4 text-muted-foreground" />
              <span>{t('title')}</span>
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {[
                scheduledCount > 0 ? t('postsCount', { count: scheduledCount }) : null,
                unreadInboxCount > 0
                  ? t('inboxUnreadCount', { count: unreadInboxCount })
                  : newInboxCount > 0
                    ? t('inboxNewCount', { count: newInboxCount })
                    : null,
                upcomingCount > 0 ? t('bookingsCount', { count: upcomingCount }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {crmOn && socialOn && upcomingCount > 0 && (
              <Link to="/o/$slug/bookings" params={{ slug }} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), PHONE_TARGET)}>
                {t('openBookingsLink')}
              </Link>
            )}
            <Link to={primaryTo} params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
              {t('openLink')}
            </Link>
          </div>
        </div>
      </Card>
    </section>
  );
}

/**
 * HR pending block:
 * - Managers (`owner` / `admin`) read the aggregate `leave-approvals` count from `today.list` (zero employee PII or row cap) -> `/o/$slug/hr/employees`
 * - Members render a compact `Cổng nhân viên` shortcut -> `/o/$slug/hr/my`
 */
export function HrPendingBlock({
  slug,
  role,
  enabled,
  isPending,
  error,
  pendingLeaveCount,
}: {
  slug: string;
  role: Role | undefined;
  enabled: boolean;
  isPending: boolean;
  error: unknown;
  pendingLeaveCount: number;
}) {
  const t = useTranslations('overview.blocks.hr_pending');
  const isHrManager = role === 'owner' || role === 'admin';

  if (!enabled || !role || role === 'viewer') return null;

  if (!isHrManager) {
    return (
      <section aria-labelledby="home-block-heading-hr_pending" data-testid="home-block-hr_pending">
        <Card className="block p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 id="home-block-heading-hr_pending" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <NavIcon name="hrMy" className="size-4 text-muted-foreground" />
                <span>{t('memberTitle')}</span>
              </h2>
              <p className="text-sm text-muted-foreground">{t('memberHint')}</p>
            </div>
            <Link to="/o/$slug/hr/my" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
              {t('openPortalLink')}
            </Link>
          </div>
        </Card>
      </section>
    );
  }

  if (isPending) {
    return (
      <section aria-label={t('title')} data-testid="home-block-hr_pending">
        <CardSkeleton />
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label={t('title')} data-testid="home-block-hr_pending">
        <ErrorText>{errorMessage(error)}</ErrorText>
      </section>
    );
  }

  if (pendingLeaveCount === 0) {
    return (
      <CollapsedHomeBlock
        blockId="hr_pending"
        slug={slug}
        to="/o/$slug/hr/employees"
        icon="appHr"
        emptyLine={t('emptyLine')}
        openLink={t('openLink')}
      />
    );
  }

  return (
    <section aria-labelledby="home-block-heading-hr_pending" data-testid="home-block-hr_pending">
      <Card className="block p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="home-block-heading-hr_pending" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <NavIcon name="appHr" className="size-4 text-muted-foreground" />
              <span>{t('title')}</span>
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">{t('pendingCount', { count: pendingLeaveCount })}</p>
          </div>
          <Link to="/o/$slug/hr/employees" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
            {t('openLink')}
          </Link>
        </div>
      </Card>
    </section>
  );
}

/** eSign pending envelopes summary block -> /o/$slug/sign/envelopes. */
export function EsignPendingBlock({
  slug,
  enabled,
}: {
  slug: string;
  enabled: boolean;
}) {
  const t = useTranslations('overview.blocks.esign_pending');
  const sentEnvelopes = useQuery({
    ...orpc.sign.envelope.list.queryOptions({ input: { status: 'sent', limit: SIGN_ESIGN_LIST_CAP } }),
    enabled,
  });
  const inProgressEnvelopes = useQuery({
    ...orpc.sign.envelope.list.queryOptions({ input: { status: 'in_progress', limit: SIGN_ESIGN_LIST_CAP } }),
    enabled,
  });

  if (!enabled) return null;

  if (sentEnvelopes.isPending || inProgressEnvelopes.isPending) {
    return (
      <section aria-label={t('title')} data-testid="home-block-esign_pending">
        <CardSkeleton />
      </section>
    );
  }
  const queryError = sentEnvelopes.error ?? inProgressEnvelopes.error;
  if (queryError) {
    return (
      <section aria-label={t('title')} data-testid="home-block-esign_pending">
        <ErrorText>{errorMessage(queryError)}</ErrorText>
      </section>
    );
  }

  const byId = new Map((sentEnvelopes.data?.items ?? []).map((item) => [item.id, item]));
  for (const item of inProgressEnvelopes.data?.items ?? []) {
    byId.set(item.id, item);
  }
  const waiting = [...byId.values()];
  if (waiting.length === 0) {
    return (
      <CollapsedHomeBlock
        blockId="esign_pending"
        slug={slug}
        to="/o/$slug/sign/envelopes"
        icon="signEnvelopes"
        emptyLine={t('emptyLine')}
        openLink={t('openLink')}
      />
    );
  }

  const isCountCapped =
    (sentEnvelopes.data?.items.length ?? 0) >= SIGN_ESIGN_LIST_CAP ||
    (inProgressEnvelopes.data?.items.length ?? 0) >= SIGN_ESIGN_LIST_CAP;
  const waitingForMe = waiting.filter((item) => item.signerSummary.waitingForMe).length;
  return (
    <section aria-labelledby="home-block-heading-esign_pending" data-testid="home-block-esign_pending">
      <Card className="block p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="home-block-heading-esign_pending" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <NavIcon name="signEnvelopes" className="size-4 text-muted-foreground" />
              <span>{t('title')}</span>
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {[
                isCountCapped
                  ? t('pendingCountAtLeast', { count: String(waiting.length) })
                  : t('pendingCount', { count: waiting.length }),
                !isCountCapped && waitingForMe > 0 ? t('waitingForMeCount', { count: waitingForMe }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link to="/o/$slug/sign/envelopes" params={{ slug }} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), PHONE_TARGET)}>
            {t('openLink')}
          </Link>
        </div>
      </Card>
    </section>
  );
}
