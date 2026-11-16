// SPDX-License-Identifier: AGPL-3.0-only
// On-demand weekly status card for a project (projects P6, #2597): shows deterministic counts and bounded visible
// task lists computed by code first, plus Vy's 3 to 5 sentence summary marked as AI when permitted and verified.
// Nothing is stored or sent to other members; AI off, kill switch, budget exhaustion, refusal and viewer role degrade cleanly.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ProjectWeeklyStatus as ProjectWeeklyStatusData, ProjectWeeklyStatusTask } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { taskDueDay } from '../lib/agents.ts';
import { client, errorMessage } from '../lib/api.ts';

type BucketKey = 'doneThisWeek' | 'overdue' | 'waiting' | 'dueNextWeek';

const BUCKET_KEYS: readonly BucketKey[] = ['doneThisWeek', 'overdue', 'waiting', 'dueNextWeek'];

export function projectWeeklyStatusQueryKey(
  slug: string,
  projectId: string,
  language: 'vi' | 'en',
): readonly [string, string, string, string, 'vi' | 'en'] {
  return ['projects', 'weeklyStatus', slug, projectId, language];
}

function bucketTestId(key: BucketKey): string {
  if (key === 'doneThisWeek') return 'weekly-count-done';
  if (key === 'overdue') return 'weekly-count-overdue';
  if (key === 'waiting') return 'weekly-count-waiting';
  return 'weekly-count-next';
}

function WeeklyBucketList({
  bucketKey,
  tasks,
  title,
  commentLabel,
  formatDate,
  dueLabel,
}: {
  bucketKey: BucketKey;
  tasks: readonly ProjectWeeklyStatusTask[];
  title: string;
  commentLabel: (count: number) => string;
  formatDate: (value: string | null | undefined) => string;
  dueLabel: (date: string) => string;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid={`weekly-bucket-${bucketKey}`}>
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="space-y-1.5">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex flex-col gap-0.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">{task.title}</span>
              <div className="flex flex-wrap items-center gap-2 text-subtle-foreground tabular-nums">
                {task.due && <span>{dueLabel(formatDate(task.due))}</span>}
                {task.commentCount > 0 && <span>{commentLabel(task.commentCount)}</span>}
              </div>
            </div>
            {task.latestComment && (
              <p className="line-clamp-2 text-subtle-foreground">{task.latestComment}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectWeeklyStatus({
  slug,
  projectId,
  defaultOpen = false,
}: {
  slug: string;
  projectId: string;
  defaultOpen?: boolean;
}) {
  const t = useTranslations('projects.weeklyStatus');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';
  const [open, setOpen] = useState(defaultOpen);

  const weekly = useQuery<ProjectWeeklyStatusData>({
    queryKey: projectWeeklyStatusQueryKey(slug, projectId, language),
    queryFn: () => client.projects.weeklyStatus({ projectId, language }),
    placeholderData: keepPreviousData,
    enabled: open,
    staleTime: 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!open) {
    return (
      <div className="flex justify-start" data-testid="project-weekly-status-trigger">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="project-weekly-status-button"
        >
          <ProjectIcon name="calendar" />
          {t('ask')}
        </Button>
      </div>
    );
  }

  const data = weekly.data;

  return (
    <Card className="block border-border bg-card p-4" data-testid="project-weekly-status-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          {data && (
            <span className="text-xs text-subtle-foreground tabular-nums">
              {t('window', { from: f.date(data.window.from), to: f.date(data.window.to) })}
            </span>
          )}
          {data?.ai === 'used' && (
            <Badge variant="proposal" data-testid="project-weekly-status-ai-badge">
              {t('aiBadge')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={weekly.isFetching}
            onClick={() => void weekly.refetch()}
            data-testid="project-weekly-status-refresh"
          >
            {t('refresh')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            aria-label={t('close')}
            data-testid="project-weekly-status-close"
          >
            <NavIcon name="close" />
            {t('close')}
          </Button>
        </div>
      </div>

      {weekly.isPending && !data && (
        <div aria-busy="true" className="mt-3 h-24 animate-pulse rounded-lg border border-border bg-muted/40 motion-reduce:animate-none">
          <span className="sr-only">{t('loading')}</span>
        </div>
      )}

      {weekly.isError && !data && (
        <Alert className="mt-3 border-destructive/30 bg-destructive/10" data-testid="project-weekly-status-error">
          <NavIcon name="info" className="text-destructive" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
            <span>{errorMessage(weekly.error) || t('loadError')}</span>
            <Button type="button" variant="outline" size="xs" onClick={() => void weekly.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {data && (
        <div className="mt-3 space-y-4">
          <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {BUCKET_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-lg border border-border bg-muted/30 px-3 py-2"
                data-testid={bucketTestId(key)}
              >
                <dt className="text-xs text-subtle-foreground">{t(`counts.${key}`)}</dt>
                <dd className="mt-0.5 text-lg font-semibold text-foreground tabular-nums">
                  {f.number(data.counts[key])}
                </dd>
              </div>
            ))}
          </dl>

          {data.ai === 'used' && data.sentences.length > 0 ? (
            <div className="rounded-lg border border-border bg-muted/25 p-3" data-testid="project-weekly-status-summary">
              <p className="text-sm leading-relaxed text-foreground">{data.sentences.join(' ')}</p>
              <p className="mt-2 text-xs text-subtle-foreground">{t('byVy')}</p>
            </div>
          ) : (
            <p
              className="rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground"
              data-testid="project-weekly-status-unavailable"
            >
              {t(`unavailable.${data.ai === 'used' ? 'empty' : data.ai}`)}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {BUCKET_KEYS.map((key) => (
              <WeeklyBucketList
                key={key}
                bucketKey={key}
                tasks={data.tasks[key]}
                title={t(`buckets.${key}`)}
                commentLabel={(count) => t('commentCount', { count: String(count) })}
                formatDate={(due) => f.date(due ? (taskDueDay(due, data.window.timeZone) || due) : due)}
                dueLabel={(date) => t('dueLabel', { date })}
              />
            ))}
          </div>

          {data.hiddenByEntityCount > 0 && (
            <p className="text-xs text-subtle-foreground" data-testid="project-weekly-status-hidden-notice">
              {t('hiddenNotice', { count: String(data.hiddenByEntityCount) })}
            </p>
          )}

          {data.truncated && (
            <p className="text-xs text-subtle-foreground" data-testid="project-weekly-status-truncated">
              {t('truncatedNotice')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
