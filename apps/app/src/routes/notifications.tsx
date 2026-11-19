// In-app notifications of the kernel and finance (#671): the viewer's own, newest first. Opening one marks it read and
// goes to what it is about. The settings that turn kinds off for this member sit in Settings (NT-1, #3592), linked from here; a run of the same kind of notice is one row (NT-2).
// Social's have their own screen (#637).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { cn } from '@crove/ui/lib/utils';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { groupNotifications, groupSubjectCount, isKnownKind, NOTIFICATION_LIST_LIMIT, notificationTarget, periodParts, unreadIdChunks, type GroupableKind, type NotificationTarget } from '../lib/notifications.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { SETTINGS_CARD } from './settings/tabs.ts';

// The card of Settings that holds the preferences; test/settings-tabs.test.ts checks this link goes to the tab of that card.
const NOTIFICATION_SETTINGS_ID = SETTINGS_CARD.notifications;

export type WorkNotification = Awaited<ReturnType<typeof client.notifications.list>>['items'][number];

// The viewer's notifications; between stream hints they are read again every minute.
export function useWorkNotifications(enabled = true) {
  const live = useStreamLive();
  return useQuery({ ...orpc.notifications.list.queryOptions({ input: {} }), enabled, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notifications.list.key() });

function useLine() {
  const t = useTranslations('notifications');
  const period = (key: string | undefined) => {
    const parts = key ? periodParts(key) : null;
    if (!parts) return key ?? '';
    return t(parts.kind === 'month' ? 'month' : 'quarter', { label: parts.label });
  };
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
        return t('text.task_assigned', { title: n.detail.title ?? '' });
      case 'kernel.task_rerouted':
        return n.detail.count ? t('text.tasks_rerouted', { count: Number(n.detail.count) }) : t('text.task_rerouted', { title: n.detail.title ?? '' });
      case 'finance.bank_attention':
        return t('text.bank_attention', { account: n.detail.bankAccount ?? '', lines: Number(n.detail.lines ?? 0) });
      case 'finance.portal_attention':
        return n.detail.failed === 'true'
          ? t('text.portal_failed', { period: period(n.detail.period) })
          : t(n.detail.direction === 'sale' ? 'text.portal_attention_sale' : 'text.portal_attention', { period: period(n.detail.period), missing: Number(n.detail.missing ?? 0), mismatch: Number(n.detail.amountMismatch ?? 0) });
      case 'finance.period_closing':
        return t('text.period_closing', { period: period(n.detail.period), due: n.detail.dueDate ? f.date(n.detail.dueDate) : '' });
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
      case 'kernel.channel_expired':
        return t('text.channel_expired');
      case 'kernel.ai_budget':
        return n.detail.level === 'stop' ? t('text.ai_budget_stop') : t('text.ai_budget_warn', { percent: n.detail.percent ?? '' });
      case 'kernel.personal_data_notice':
        return [
          Number(n.detail.notes ?? 0) + Number(n.detail.todos ?? 0) > 0 ? t('text.personal_data_notice', { items: privateItems(Number(n.detail.notes ?? 0), Number(n.detail.todos ?? 0)) }) : null,
          Number(n.detail.meetings ?? 0) > 0 ? t('text.personal_data_notice_meetings', { count: Number(n.detail.meetings) }) : null,
        ]
          .filter(Boolean)
          .join(' ');
      default:
        return t('text.other');
    }
  };
}

export function NotificationsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('notifications');
  const f = useFormat();
  const navigate = useNavigate();
  const line = useLine();
  const list = useWorkNotifications();
  const read = useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => client.notifications.read(input),
    onSettled: refresh,
  });
  const go = (target: NotificationTarget | null, detail: Record<string, string>) => {
    if (target?.to === 'proposal') void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: target.id } });
    else if (target?.to === 'inbox') void navigate({ to: '/o/$slug/inbox', params: { slug } });
    else if (target?.to === 'bank') void navigate({ to: '/o/$slug/bank', params: { slug }, search: target.account ? { account: target.account } : {} });
    else if (target?.to === 'portal') void navigate({ to: '/o/$slug/portal-invoices', params: { slug }, search: { ...(target.sale ? { direction: 'sale' as const } : {}), ...(typeof detail.period === 'string' && detail.period ? { period: detail.period } : {}) } });
    // The period-closing notice asks for a lock, which is on the ledger's Kết thúc kỳ tab (#3602).
    else if (target?.to === 'ledger') void navigate({ to: '/o/$slug/ledger', params: { slug }, search: { report: 'closing' as const } });
    else if (target?.to === 'myWork') void navigate({ to: '/o/$slug/my-work', params: { slug } });
    else if (target?.to === 'task') void navigate({ to: '/o/$slug/tasks/$id', params: { slug, id: target.id } });
    else if (target?.to === 'tasks') void navigate({ to: '/o/$slug/tasks', params: { slug } });
    else if (target?.to === 'project') void navigate({ to: '/o/$slug/projects/$id', params: { slug, id: target.id } });
    else if (target?.to === 'projects') void navigate({ to: '/o/$slug/projects', params: { slug } });
    else if (target?.to === 'conversation') void navigate({ to: '/o/$slug/social/inbox', params: { slug }, search: { c: target.id } });
    else if (target?.to === 'conversations') void navigate({ to: '/o/$slug/social/inbox', params: { slug }, search: { status: 'new' } });
    else if (target?.to === 'meeting') void navigate({ to: '/o/$slug/meetings/$id', params: { slug, id: target.id } });
    else if (target?.to === 'meetings') void navigate({ to: '/o/$slug/meetings', params: { slug } });
    else if (target?.to === 'ads') void navigate({ to: '/o/$slug/ads', params: { slug } });
    else if (target?.to === 'agents') void navigate({ to: '/o/$slug/agents', params: { slug } });
  };
  const open = (n: WorkNotification) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    go(notificationTarget(n), n.detail);
  };
  // A group row opens the screen that lists all of its kind, and marks the ones it stood for read (the read command takes 100 ids at a time).
  const openGroup = (kind: GroupableKind, group: WorkNotification[]) => {
    // One chunk after the other: a failed chunk stops the rest and shows its error (the list is 30 long, so there is one chunk in practice).
    void (async () => {
      for (const ids of unreadIdChunks(group)) await read.mutateAsync({ ids });
    })().catch(() => undefined);
    go(notificationTarget({ kind, subjectId: null, detail: {} }), {});
  };
  // A kind this version of the app does not know (a newer module) is left out rather than shown blank.
  const items = (list.data?.items ?? []).filter((n) => isKnownKind(n.kind));
  const rows = groupNotifications(items);
  // The server answers with the newest 30: a group at the end of a full list may stand for more.
  const capped = (list.data?.items.length ?? 0) >= NOTIFICATION_LIST_LIMIT;
  const rowClass = (unread: boolean) => cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none', unread && 'bg-primary/5');
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            {/* The preferences are a card of Settings (NT-1, #3592), the tab "Thông báo của tôi". */}
            <Link to="/o/$slug/settings/notifications" params={{ slug }} hash={NOTIFICATION_SETTINGS_ID} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('settingsLink')}
            </Link>
            <Button variant="outline" size="sm" disabled={!list.data?.unread || read.isPending} onClick={() => read.mutate({ all: true })}>
              {t('readAll')}
            </Button>
          </>
        }
      />
      {list.isLoading ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <Card className="block divide-y p-0">
          {rows.map((row) =>
            row.type === 'group' ? (
              // A run of the same kind (NT-2, #3592): one row with the count, opening the screen that lists them all.
              <button key={`group:${row.items[0]!.id}`} type="button" onClick={() => openGroup(row.kind, row.items)} className={rowClass(true)} data-testid="notification-group">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', 'bg-primary')} aria-hidden />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className={cn('block text-sm', 'font-medium text-foreground')}>
                    {t(`group.${row.kind.replace('kernel.', '') as 'approval_waiting'}`, { count: groupSubjectCount(row.items), more: capped && row === rows[rows.length - 1] ? 'yes' : 'no' })}
                    <span className="sr-only"> ({t('unread')})</span>
                  </span>
                  <span className="block text-xs text-subtle-foreground">{f.dateTime(row.items[0]!.createdAt)}</span>
                </span>
                <span className="shrink-0 self-center text-sm text-link">{t('groupOpen')}</span>
              </button>
            ) : (
              <button key={row.item.id} type="button" onClick={() => open(row.item)} className={rowClass(!row.item.read)}>
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', row.item.read ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className={cn('block text-sm', row.item.read ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                    {line(row.item)}
                    {!row.item.read && <span className="sr-only"> ({t('unread')})</span>}
                  </span>
                  <span className="block text-xs text-subtle-foreground">{f.dateTime(row.item.createdAt)}</span>
                </span>
              </button>
            ),
          )}
        </Card>
      )}
      {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
    </div>
  );
}
