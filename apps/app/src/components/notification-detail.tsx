// SPDX-License-Identifier: AGPL-3.0-only
// Inline detail pane and mobile Sheet body for a selected notification or grouped unread run (DESIGN.md §3.8, §5.5, §5.6).
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import { parseTrackerAlertTerms, WEEKLY_TRACKED_MAX } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { cn } from '@ludy/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';
import { orpc, type client } from '../lib/api.ts';
import {
  formatRelativeNotificationTime,
  groupSubjectCount,
  notificationApp,
  notificationRowId,
  notificationTarget,
  periodParts,
  type GroupableKind,
  type NotificationAppFilter,
  type NotificationRow,
  type NotificationTarget,
} from '../lib/notifications.ts';
import type { ProposalSourceTag } from '../lib/proposal-source.ts';
import { taskTitleText } from '../lib/task-title.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { CoworkerAttribution, type ProposalCoworkerKey } from './proposal-surface.tsx';
import { Empty } from './ui.tsx';

export type WorkNotification = Awaited<ReturnType<typeof client.notifications.list>>['items'][number];

const COWORKER_KEYS = new Set<ProposalCoworkerKey>(['gm', 'finance', 'sales', 'marketing']);
const SOURCE_TAGS = new Set<ProposalSourceTag>(['rule', 'exact', 'history', 'ai']);

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
};

function formatPeriod(period: string | undefined, t: ReturnType<typeof useTranslations<'notifications'>>): string {
  const parts = period ? periodParts(period) : null;
  if (!parts) return period ?? '';
  return t(parts.kind === 'month' ? 'month' : 'quarter', { label: parts.label });
}

function portalDetailCount(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

// `wantsTrackerWords`: the page shows a tracker alert, whose words are written from the live list of tracked words (the notice keeps ids and counts only, so a deleted word is simply left out; #4873).
export function useNotificationLine(wantsTrackerWords = false) {
  const t = useTranslations('notifications');
  const trackerList = useQuery({ ...orpc.meetings.tracker.list.queryOptions({ input: {} }), enabled: wantsTrackerWords, staleTime: 60_000 });
  const f = useFormat();
  // An owner's notice before a personal-data erasure (#1678): how many of my private items, in the finder's words.
  const p = useTranslations('personalData');
  const privateItems = (notes: number, todos: number) =>
    [notes > 0 ? p('privateNotes', { count: notes }) : null, todos > 0 ? p('privateTodos', { count: todos }) : null].filter(Boolean).join(` ${p('and')} `);

  return (n: WorkNotification): string => {
    switch (n.kind) {
      case 'kernel.approval_waiting':
        return t('text.approval_waiting', { title: n.detail.title ?? '' });
      case 'kernel.original_flagged':
        return t(n.detail.differs === 'true' ? 'text.original_differs' : 'text.original_unverified', { title: n.detail.title ?? '' });
      case 'kernel.file_unreadable':
        return t('text.file_unreadable', { filename: n.detail.filename ?? '' });
      case 'kernel.conversation_new':
        return t('text.conversation_new');
      case 'kernel.task_assigned':
        return t('text.task_assigned', { title: taskTitleText({ title: n.detail.title ?? '', tainted: n.tainted }) });
      case 'kernel.task_rerouted':
        return n.detail.count
          ? t('text.tasks_rerouted', { count: Number(n.detail.count) })
          : t('text.task_rerouted', { title: taskTitleText({ title: n.detail.title ?? '', tainted: n.tainted }) });
      case 'finance.bank_attention': {
        const lines = Number(n.detail.lines ?? 0);
        const conflicts = Number(n.detail.conflicts ?? 0);
        // Some of the lines are references that came back with another date or amount (#2197): the text says so, with the number.
        return conflicts > 0 ? t('text.bank_attention_conflicts', { account: n.detail.bankAccount ?? '', lines, conflicts }) : t('text.bank_attention', { account: n.detail.bankAccount ?? '', lines });
      }
      case 'finance.portal_attention': {
        const period = formatPeriod(n.detail.period, t);
        if (n.detail.failed === 'true') return t('text.portal_failed', { period });
        const sale = n.detail.direction === 'sale';
        const missing = portalDetailCount(n.detail.missing);
        const mismatch = portalDetailCount(n.detail.amountMismatch);
        const voidInLudy = portalDetailCount(n.detail.voidInLudy);
        const clauses = [
          missing > 0 ? t(sale ? 'text.portal_attention_sale_missing' : 'text.portal_attention_missing', { count: missing }) : null,
          mismatch > 0 ? t(sale ? 'text.portal_attention_sale_mismatch' : 'text.portal_attention_mismatch', { count: mismatch }) : null,
          voidInLudy > 0 ? t(sale ? 'text.portal_attention_sale_void' : 'text.portal_attention_void', { count: voidInLudy }) : null,
        ].filter((part): part is string => part !== null);
        if (clauses.length === 0) {
          return period ? t(sale ? 'text.portal_attention_sale_empty' : 'text.portal_attention_empty', { period }) : t('detail.titles.finance_portal_attention');
        }
        return t(sale ? 'text.portal_attention_sale' : 'text.portal_attention', {
          period,
          summary: clauses.join(', '),
        });
      }
      case 'finance.period_closing':
        return t('text.period_closing', { period: formatPeriod(n.detail.period, t), due: n.detail.dueDate ? f.date(n.detail.dueDate) : '' });
      case 'notes.todo_due':
        return t('text.todo_due');
      case 'projects.weekly_status':
        return t('text.projects_weekly_status', { title: n.detail.title ?? '' });
      case 'meetings.series_open_items':
        return t('text.series_open_items', { count: Number(n.detail.count ?? 0) });
      case 'meetings.summary_ready':
        return t('text.summary_ready');
      case 'meetings.morning':
        return t('text.morning', { count: Number(n.detail.count ?? 0) });
      case 'meetings.weekly':
        return t('text.weekly', {
          meetings: Number(n.detail.meetings ?? 0),
          decisions: Number(n.detail.decisions ?? 0),
          open: Number(n.detail.open ?? 0),
          overdue: Number(n.detail.overdue ?? 0),
          cut: n.detail.cut === '1' ? 'yes' : 'no',
          // The tracked-word number (#5019), only when the notice holds one (0 drops the clause). 999 is the most the definer says, written "999+" and nothing more; below it, a number the 50 meeting limit cut is written "at least".
          tracked: Math.min(Number(n.detail.tracked ?? 0), WEEKLY_TRACKED_MAX),
          trackedMore: Number(n.detail.tracked ?? 0) >= WEEKLY_TRACKED_MAX ? 'max' : n.detail.cut === '1' ? 'atleast' : 'no',
        });
      case 'meetings.tracker_alert': {
        const names = new Map((trackerList.data?.terms ?? []).map((w) => [w.id, w.term]));
        const listed = parseTrackerAlertTerms(n.detail)
          .flatMap((w) => (names.has(w.termId) ? [`${names.get(w.termId)} (${w.count})`] : []))
          .join(', ');
        return listed ? t('text.tracker_alert', { words: listed }) : t('text.tracker_alert_plain');
      }
      case 'kernel.channel_expired':
        return t('text.channel_expired');
      case 'kernel.telegram_chat_displaced':
        return t('text.telegram_chat_displaced');
      case 'kernel.ai_budget':
        return n.detail.level === 'stop' ? t('text.ai_budget_stop') : t('text.ai_budget_warn', { percent: n.detail.percent ?? '' });
      case 'kernel.mcp_engage_reads':
        return t(n.detail.grants === 'member' ? 'text.mcp_engage_reads_member' : n.detail.grants === 'both' ? 'text.mcp_engage_reads_both' : 'text.mcp_engage_reads');
      case 'kernel.personal_data_notice':
        return [
          Number(n.detail.notes ?? 0) + Number(n.detail.todos ?? 0) > 0
            ? t('text.personal_data_notice', { items: privateItems(Number(n.detail.notes ?? 0), Number(n.detail.todos ?? 0)) })
            : null,
          Number(n.detail.meetings ?? 0) > 0 ? t('text.personal_data_notice_meetings', { count: Number(n.detail.meetings) }) : null,
        ]
          .filter(Boolean)
          .join(' ');
      default:
        return t('text.other');
    }
  };
}

export function useNotificationAppLabel() {
  const tNav = useTranslations('nav');
  const tMod = useTranslations('modules');
  return (app: NotificationAppFilter): string => {
    if (app === 'kernel') return tMod('kernel');
    return tNav(`apps.${app}`);
  };
}

export function useNotificationTitle() {
  const t = useTranslations('notifications');
  const titles = useTranslations('notifications.detail.titles');
  return (n: WorkNotification): string => {
    switch (n.kind) {
      case 'kernel.approval_waiting':
        return titles('kernel_approval_waiting');
      case 'kernel.file_unreadable':
        return titles('kernel_file_unreadable');
      case 'kernel.task_assigned':
        return titles('kernel_task_assigned');
      case 'kernel.task_rerouted':
        return titles('kernel_task_rerouted');
      case 'kernel.original_flagged':
        return titles('kernel_original_flagged');
      case 'kernel.ai_budget':
        return titles('kernel_ai_budget');
      case 'kernel.conversation_new':
        return titles('kernel_conversation_new');
      case 'kernel.channel_expired':
        return titles('kernel_channel_expired');
      case 'kernel.telegram_chat_displaced':
        return titles('kernel_telegram_chat_displaced');
      case 'kernel.mcp_engage_reads':
        return titles('kernel_mcp_engage_reads');
      case 'kernel.personal_data_notice':
        return titles('kernel_personal_data_notice');
      case 'finance.bank_attention':
        return titles('finance_bank_attention');
      case 'finance.portal_attention':
        return titles('finance_portal_attention');
      case 'finance.period_closing':
        return titles('finance_period_closing');
      case 'notes.todo_due':
        return titles('notes_todo_due');
      case 'projects.weekly_status':
        return titles('projects_weekly_status');
      case 'meetings.series_open_items':
        return titles('meetings_series_open_items');
      case 'meetings.summary_ready':
        return titles('meetings_summary_ready');
      case 'meetings.morning':
        return titles('meetings_morning');
      case 'meetings.weekly':
        return titles('meetings_weekly');
      case 'meetings.tracker_alert':
        return titles('meetings_tracker_alert');
      default:
        return t('text.other');
    }
  };
}

export function NotificationTargetLink({
  slug,
  target,
  detail,
  className,
  onClick,
  testId,
  children,
}: {
  slug: string;
  target: NotificationTarget;
  detail: Record<string, string>;
  className?: string;
  onClick?: () => void;
  testId?: string;
  children: ReactNode;
}) {
  const shared = { className, onClick, ...(testId ? { 'data-testid': testId } : {}) };
  switch (target.to) {
    case 'proposal':
      return (
        <Link to="/o/$slug/inbox/$id" params={{ slug, id: target.id }} {...shared}>
          {children}
        </Link>
      );
    case 'inbox':
      return (
        <Link to="/o/$slug/inbox" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'bank':
      return (
        <Link to="/o/$slug/bank" params={{ slug }} search={target.account ? { account: target.account } : {}} {...shared}>
          {children}
        </Link>
      );
    case 'portal':
      return (
        <Link
          to="/o/$slug/portal-invoices"
          params={{ slug }}
          search={{
            ...(target.sale ? { direction: 'sale' as const } : {}),
            ...(typeof detail.period === 'string' && detail.period ? { period: detail.period } : {}),
          }}
          {...shared}
        >
          {children}
        </Link>
      );
    case 'ledger':
      return (
        <Link to="/o/$slug/ledger" params={{ slug }} search={{ report: 'closing' as const }} {...shared}>
          {children}
        </Link>
      );
    case 'myWork':
      return (
        <Link to="/o/$slug/my-work" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'task':
      return (
        <Link to="/o/$slug/tasks/$id" params={{ slug, id: target.id }} {...shared}>
          {children}
        </Link>
      );
    case 'tasks':
      return (
        <Link to="/o/$slug/tasks" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'project':
      return (
        <Link to="/o/$slug/projects/$id" params={{ slug, id: target.id }} {...shared}>
          {children}
        </Link>
      );
    case 'projects':
      return (
        <Link to="/o/$slug/projects" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'conversation':
      return (
        <Link to="/o/$slug/social/inbox" params={{ slug }} search={{ c: target.id }} {...shared}>
          {children}
        </Link>
      );
    case 'conversations':
      return (
        <Link to="/o/$slug/social/inbox" params={{ slug }} search={{ status: 'new' as const }} {...shared}>
          {children}
        </Link>
      );
    case 'meeting':
      return (
        <Link to="/o/$slug/meetings/$id" params={{ slug, id: target.id }} {...shared}>
          {children}
        </Link>
      );
    case 'meetings':
      return (
        <Link to="/o/$slug/meetings" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'ads':
      return (
        <Link to="/o/$slug/ads" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'channels':
      return (
        <Link to="/o/$slug/social/channels" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'agents':
      return (
        <Link to="/o/$slug/agents" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
    case 'aiConnections':
      return (
        <Link to="/o/$slug/ai-connections" params={{ slug }} {...shared}>
          {children}
        </Link>
      );
  }
}

interface MetadataEntry {
  key: string;
  label: string;
  value: ReactNode;
}

function useMetadataEntries(item: WorkNotification): MetadataEntry[] {
  const t = useTranslations('notifications');
  const f = useFormat();
  const d = item.detail;
  const entries: MetadataEntry[] = [];

  if (d.title) {
    entries.push({
      key: 'title',
      label: t('detail.fields.title'),
      value: taskTitleText({ title: d.title, tainted: item.tainted }),
    });
  }
  if (d.filename) {
    entries.push({ key: 'filename', label: t('detail.fields.filename'), value: d.filename });
  }
  const moneyValue = d.amount || d.total;
  if (moneyValue) {
    entries.push({
      key: 'amount',
      label: t('detail.fields.amount'),
      value: <span className="font-medium tabular-nums">{f.money(moneyValue, d.currency || 'VND')}</span>,
    });
  }
  if (d.bankAccount) {
    entries.push({
      key: 'bankAccount',
      label: t('detail.fields.bankAccount'),
      value: <span className="font-mono tabular-nums">{d.bankAccount}</span>,
    });
  }
  if (d.lines && !Number.isNaN(Number(d.lines))) {
    entries.push({
      key: 'lines',
      label: t('detail.fields.lines'),
      value: <span className="tabular-nums">{f.number(Number(d.lines))}</span>,
    });
  }
  if (d.period) {
    entries.push({
      key: 'period',
      label: t('detail.fields.period'),
      value: formatPeriod(d.period, t),
    });
  }
  if (d.dueDate) {
    entries.push({
      key: 'dueDate',
      label: t('detail.fields.dueDate'),
      value: <span className="tabular-nums">{f.date(d.dueDate)}</span>,
    });
  }
  if (d.direction) {
    entries.push({
      key: 'direction',
      label: t('detail.fields.direction'),
      value: d.direction === 'sale' ? t('detail.fields.directionSale') : t('detail.fields.directionPurchase'),
    });
  }
  if (item.kind === 'finance.portal_attention' && d.failed !== 'true') {
    const portalCounts = [
      { key: 'missing', label: t('detail.fields.missing'), raw: d.missing, showZero: true },
      { key: 'amountMismatch', label: t('detail.fields.amountMismatch'), raw: d.amountMismatch, showZero: true },
      { key: 'voidInLudy', label: t('detail.fields.voidInLudy'), raw: d.voidInLudy, showZero: false },
    ] as const;
    for (const entry of portalCounts) {
      if (!entry.raw?.trim()) continue;
      const value = Number(entry.raw);
      if (!Number.isFinite(value) || value < 0) continue;
      const truncated = Math.trunc(value);
      if (!entry.showZero && truncated === 0) continue;
      entries.push({
        key: entry.key,
        label: entry.label,
        value: <span className="tabular-nums">{f.number(truncated)}</span>,
      });
    }
  }
  if (item.kind === 'kernel.original_flagged') {
    entries.push({
      key: 'originalFlag',
      label: t('detail.fields.originalFlag'),
      value: d.differs === 'true' ? t('detail.fields.originalDiffers') : t('detail.fields.originalUnverified'),
    });
  }
  if (d.provider) {
    entries.push({
      key: 'provider',
      label: t('detail.fields.provider'),
      value: PROVIDER_LABELS[d.provider] ?? d.provider,
    });
  }
  if (d.percent) {
    entries.push({
      key: 'percent',
      label: t('detail.fields.aiUsage'),
      value: <span className="tabular-nums">{d.percent}%</span>,
    });
  }
  if (d.grants) {
    entries.push({
      key: 'grants',
      label: t('detail.fields.grants'),
      value:
        d.grants === 'member'
          ? t('detail.fields.grantsMember')
          : d.grants === 'both'
            ? t('detail.fields.grantsBoth')
            : t('detail.fields.grantsCompany'),
    });
  }
  if (d.count && !Number.isNaN(Number(d.count))) {
    entries.push({
      key: 'count',
      label: t('detail.fields.count'),
      value: <span className="tabular-nums">{f.number(Number(d.count))}</span>,
    });
  }
  if (d.notes && Number(d.notes) > 0) {
    entries.push({
      key: 'notes',
      label: t('detail.fields.privateNotes'),
      value: <span className="tabular-nums">{f.number(Number(d.notes))}</span>,
    });
  }
  if (d.todos && Number(d.todos) > 0) {
    entries.push({
      key: 'todos',
      label: t('detail.fields.privateTodos'),
      value: <span className="tabular-nums">{f.number(Number(d.todos))}</span>,
    });
  }
  if (d.meetings && Number(d.meetings) > 0) {
    entries.push({
      key: 'meetings',
      label: t('detail.fields.meetings'),
      value: <span className="tabular-nums">{f.number(Number(d.meetings))}</span>,
    });
  }
  if (d.rule) {
    entries.push({ key: 'rule', label: t('detail.fields.rule'), value: d.rule });
  }
  return entries;
}

function NotificationProvenance({ item }: { item: WorkNotification }) {
  const t = useTranslations('notifications');
  const d = item.detail;
  const rawCoworker = d.coworker as ProposalCoworkerKey | undefined;
  const coworker = rawCoworker && COWORKER_KEYS.has(rawCoworker) ? rawCoworker : undefined;
  const agentName = d.agentName?.trim() || undefined;
  const rawTag = d.sourceTag as ProposalSourceTag | undefined;
  const tag = rawTag && SOURCE_TAGS.has(rawTag) ? rawTag : undefined;

  if (coworker || agentName) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <CoworkerAttribution coworker={coworker} name={agentName} source={d.source ?? d.rule ?? null} tag={tag} />
      </div>
    );
  }
  if (item.kind === 'meetings.summary_ready') {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <CoworkerAttribution coworker="gm" source={t('detail.summaryAttribution')} />
      </div>
    );
  }
  if (item.tainted) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <CoworkerAttribution coworker="gm" source={t('detail.aiTaskAttribution')} />
      </div>
    );
  }
  return null;
}

export function NotificationDetailActions({
  slug,
  row,
  onMarkSingleRead,
  onMarkGroupRead,
  markPending,
}: {
  slug: string;
  row: NotificationRow<WorkNotification>;
  onMarkSingleRead: (id: string) => void;
  onMarkGroupRead: (items: WorkNotification[], options?: { clearGroupSearch?: boolean }) => void;
  markPending: boolean;
}) {
  const t = useTranslations('notifications');
  if (row.type === 'group') {
    const groupTarget = notificationTarget({ kind: row.kind, subjectId: null, detail: {} });
    const hasUnread = row.items.some((item) => !item.read);
    return (
      <>
        {hasUnread && (
          <Button
            type="button"
            variant="outline"
            loading={markPending}
            data-testid="notification-mark-group-read"
            onClick={() => onMarkGroupRead(row.items, { clearGroupSearch: true })}
          >
            {t('markGroupRead')}
          </Button>
        )}
        {groupTarget && (
          <NotificationTargetLink
            slug={slug}
            target={groupTarget}
            detail={{}}
            testId="notification-primary-cta"
            className={cn(buttonVariants({ variant: 'default', size: 'default' }), PHONE_TARGET)}
            onClick={() => onMarkGroupRead(row.items, { clearGroupSearch: false })}
          >
            {t(`detail.actions.${groupTarget.to}`)}
          </NotificationTargetLink>
        )}
      </>
    );
  }

  const item = row.item;
  const target = notificationTarget(item);
  return (
    <>
      {!item.read && (
        <Button
          type="button"
          variant="outline"
          loading={markPending}
          data-testid="notification-mark-read"
          onClick={() => onMarkSingleRead(item.id)}
        >
          {t('markRead')}
        </Button>
      )}
      {target && (
        <NotificationTargetLink
          slug={slug}
          target={target}
          detail={item.detail}
          testId="notification-primary-cta"
          className={cn(buttonVariants({ variant: 'default', size: 'default' }), PHONE_TARGET)}
          onClick={() => {
            if (!item.read) onMarkSingleRead(item.id);
          }}
        >
          {t(`detail.actions.${target.to}`)}
        </NotificationTargetLink>
      )}
    </>
  );
}

export function NotificationDetailHeaderMeta({
  row,
  cappedAtEnd = false,
}: {
  row: NotificationRow<WorkNotification>;
  cappedAtEnd?: boolean;
}) {
  const t = useTranslations('notifications');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const appLabel = useNotificationAppLabel();
  const sample = row.type === 'group' ? row.items[0]! : row.item;
  const app = appLabel(notificationApp(sample.kind));
  const unread = row.type === 'group' ? row.items.some((item) => !item.read) : !row.item.read;
  const relative = formatRelativeNotificationTime(sample.createdAt, locale);
  const absolute = f.dateTime(sample.createdAt);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
      <Badge variant="outline">{app}</Badge>
      <Badge variant={unread ? 'brand' : 'secondary'}>
        {row.type === 'group'
          ? `${groupSubjectCount(row.items)}${cappedAtEnd ? '+' : ''} ${t('unread').toLowerCase()}`
          : unread
            ? t('unread')
            : t('read')}
      </Badge>
      <time dateTime={sample.createdAt} title={absolute} className="tabular-nums">
        {absolute}
        {relative ? ` (${relative})` : ''}
      </time>
    </div>
  );
}

export function NotificationGroupHeading({
  kind,
  items,
  cappedAtEnd = false,
}: {
  kind: GroupableKind;
  items: readonly WorkNotification[];
  cappedAtEnd?: boolean;
}) {
  const t = useTranslations('notifications');
  const key = kind.replace('kernel.', '') as 'approval_waiting';
  return <>{t(`group.${key}`, { count: groupSubjectCount(items), plus: cappedAtEnd ? '+' : '' })}</>;
}

export function NotificationDetailBody({
  slug,
  row,
  cappedAtEnd = false,
  onMarkSingleRead,
}: {
  slug: string;
  row: NotificationRow<WorkNotification>;
  cappedAtEnd?: boolean;
  onMarkSingleRead: (id: string) => void;
}) {
  const t = useTranslations('notifications');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const line = useNotificationLine(row.type === 'group' ? row.items.some((n) => n.kind === 'meetings.tracker_alert') : row.item.kind === 'meetings.tracker_alert');

  if (row.type === 'group') {
    const count = groupSubjectCount(row.items);
    const plus = cappedAtEnd ? '+' : '';
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('detail.groupSummary', { count, plus })}</p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-background" data-testid="notification-group-items">
          {row.items.map((item) => {
            const target = notificationTarget(item);
            const moneyValue = item.detail.amount || item.detail.total;
            const absolute = f.dateTime(item.createdAt);
            const relative = formatRelativeNotificationTime(item.createdAt, locale);
            return (
              <li key={item.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={cn('text-sm leading-snug', item.read ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                    {line(item)}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle-foreground">
                    <time dateTime={item.createdAt} title={absolute}>
                      {relative || absolute}
                    </time>
                    {moneyValue && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-foreground tabular-nums">{f.money(moneyValue, item.detail.currency || 'VND')}</span>
                      </>
                    )}
                  </div>
                </div>
                {target && (
                  <NotificationTargetLink
                    slug={slug}
                    target={target}
                    detail={item.detail}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), PHONE_TARGET, 'shrink-0')}
                    onClick={() => {
                      if (!item.read) onMarkSingleRead(item.id);
                    }}
                  >
                    {t('detail.actions.openItem')}
                  </NotificationTargetLink>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return <SingleNotificationBody item={row.item} />;
}

function SingleNotificationBody({ item }: { item: WorkNotification }) {
  const line = useNotificationLine(item.kind === 'meetings.tracker_alert');
  const metadata = useMetadataEntries(item);
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-foreground" data-testid="notification-detail-message">
        {line(item)}
      </p>
      <NotificationProvenance item={item} />
      {metadata.length > 0 && (
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="notification-detail-metadata">
          {metadata.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-xs font-medium text-subtle-foreground">{entry.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function NotificationDetailPane({
  slug,
  row,
  cappedAtEnd = false,
  onMarkSingleRead,
  onMarkGroupRead,
  markPending,
}: {
  slug: string;
  row: NotificationRow<WorkNotification> | null;
  cappedAtEnd?: boolean;
  onMarkSingleRead: (id: string) => void;
  onMarkGroupRead: (items: WorkNotification[], options?: { clearGroupSearch?: boolean }) => void;
  markPending: boolean;
}) {
  const t = useTranslations('notifications');
  const titleOf = useNotificationTitle();

  if (!row) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center p-6">
        <Empty compact title={t('detail.selectPrompt')} />
      </div>
    );
  }

  const rowKey = notificationRowId(row);
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border p-5">
        <NotificationDetailHeaderMeta row={row} cappedAtEnd={cappedAtEnd} />
        <h2 className="text-base font-semibold leading-snug text-foreground" data-testid="notification-detail-title">
          {row.type === 'group' ? (
            <NotificationGroupHeading kind={row.kind} items={row.items} cappedAtEnd={cappedAtEnd} />
          ) : (
            titleOf(row.item)
          )}
        </h2>
      </div>
      <div key={rowKey} className="min-h-0 flex-1 overflow-y-auto p-5">
        <NotificationDetailBody slug={slug} row={row} cappedAtEnd={cappedAtEnd} onMarkSingleRead={onMarkSingleRead} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4 empty:hidden">
        <NotificationDetailActions
          slug={slug}
          row={row}
          onMarkSingleRead={onMarkSingleRead}
          onMarkGroupRead={onMarkGroupRead}
          markPending={markPending}
        />
      </div>
    </div>
  );
}
