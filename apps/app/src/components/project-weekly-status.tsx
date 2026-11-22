// SPDX-License-Identifier: AGPL-3.0-only
// On-demand weekly status card for a project (projects P6, #2597): shows deterministic counts and bounded visible
// task lists computed by code first, plus Vy's 3 to 5 sentence summary marked as AI when permitted and verified.
// Nothing is stored or sent to other members; AI off, kill switch, budget exhaustion, refusal and viewer role degrade cleanly.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  NOTE_TITLE_MAX,
  PROJECT_WEEKLY_STATUS_SUMMARY_MAX,
  type ProjectWeeklyStatus as ProjectWeeklyStatusData,
  type ProjectWeeklyStatusSendMailResult,
  type ProjectWeeklyStatusTask,
} from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { taskDueDay } from '../lib/agents.ts';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { projectWeeklyStatusQueryKey } from '../lib/projects.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';
import { installedModules } from '../lib/org-modules.ts';

export interface WeeklyStatusDraftState {
  title: string;
  body: string;
  aiUnedited: boolean;
}

function truncateByCodePoint(value: string, max: number): string {
  const chars = Array.from(value);
  return (chars.length <= max ? value : chars.slice(0, max).join('')).trim();
}

export function buildWeeklyStatusDraftSeed(
  data: ProjectWeeklyStatusData,
  formatDate: (value: string) => string,
  copy: {
    defaultTitle: (values: { project: string; from: string; to: string }) => string;
    deterministicBody: (values: {
      from: string;
      to: string;
      done: string;
      overdue: string;
      waiting: string;
      nextFrom: string;
      nextTo: string;
      nextDue: string;
    }) => string;
  },
): WeeklyStatusDraftState {
  const from = formatDate(data.window.from);
  const to = formatDate(data.window.to);
  const nextFrom = formatDate(data.window.nextFrom);
  const nextTo = formatDate(data.window.nextTo);
  const title = truncateByCodePoint(
    copy.defaultTitle({
      project: data.project.name,
      from,
      to,
    }),
    NOTE_TITLE_MAX,
  );
  if (data.ai === 'used' && data.sentences.length > 0) {
    return {
      title,
      body: data.sentences.join(' '),
      aiUnedited: true,
    };
  }
  return {
    title,
    body: copy.deterministicBody({
      from,
      to,
      done: String(data.counts.doneThisWeek),
      overdue: String(data.counts.overdue),
      waiting: String(data.counts.waiting),
      nextFrom,
      nextTo,
      nextDue: String(data.counts.dueNextWeek),
    }),
    aiUnedited: false,
  };
}

export function updateWeeklyStatusDraftBody(draft: WeeklyStatusDraftState, body: string): WeeklyStatusDraftState {
  return {
    title: draft.title,
    body,
    aiUnedited: false,
  };
}

function isNotesModuleEnabled(): boolean {
  try {
    return installedModules().includes('notes');
  } catch {
    return true;
  }
}

type BucketKey = 'doneThisWeek' | 'overdue' | 'waiting' | 'dueNextWeek';

const BUCKET_KEYS: readonly BucketKey[] = ['doneThisWeek', 'overdue', 'waiting', 'dueNextWeek'];

export { projectWeeklyStatusQueryKey };

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
  projectStatus,
  canManage = false,
  otherMemberCount,
  notesEnabled,
  defaultOpen = false,
  defaultComposerOpen = false,
}: {
  slug: string;
  projectId: string;
  projectStatus?: string | undefined;
  canManage?: boolean | undefined;
  otherMemberCount?: number | undefined;
  notesEnabled?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  defaultComposerOpen?: boolean | undefined;
}) {
  const t = useTranslations('projects.weeklyStatus');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';
  const titleInputId = useId();
  const bodyInputId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [composerOpen, setComposerOpen] = useState(defaultComposerOpen);
  const [draft, setDraft] = useState<WeeklyStatusDraftState | null>(null);
  const [shareResult, setShareResult] = useState<{ noteId: string } | null>(null);
  const [mailResult, setMailResult] = useState<ProjectWeeklyStatusSendMailResult | null>(null);
  const shareKeyRef = useRef<string>(crypto.randomUUID());
  const mailKeyRef = useRef<string>(crypto.randomUUID());

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

  const shareNote = useMutation({
    mutationFn: (vars: { title: string; body: string; tainted: boolean; idempotencyKey: string }) =>
      client.projects.weeklyStatusShareNote({
        projectId,
        title: vars.title,
        body: vars.body,
        tainted: vars.tainted,
        idempotencyKey: vars.idempotencyKey,
      }),
    onSuccess: (res) => {
      shareKeyRef.current = crypto.randomUUID();
      setShareResult(res);
      const notesApi = (orpc as { notes?: { key?: () => unknown[] } } | undefined)?.notes;
      void queryClient.invalidateQueries({
        queryKey: typeof notesApi?.key === 'function' ? notesApi.key() : ['notes'],
      });
    },
  });

  const sendMail = useMutation({
    mutationFn: (vars: { subject: string; summary: string; language: 'vi' | 'en'; tainted: boolean; idempotencyKey: string }) =>
      client.projects.weeklyStatusSendMail({
        projectId,
        subject: vars.subject,
        summary: vars.summary,
        language: vars.language,
        tainted: vars.tainted,
        confirmed: true,
        idempotencyKey: vars.idempotencyKey,
      }),
    onSuccess: (res) => {
      mailKeyRef.current = crypto.randomUUID();
      setMailResult(res);
    },
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

          {canManage && projectStatus !== 'archived' && data.project.status !== 'archived' && (() => {
            const notesOn = notesEnabled ?? isNotesModuleEnabled();
            const currentDraft =
              draft ??
              buildWeeklyStatusDraftSeed(data, (day) => f.date(day), {
                defaultTitle: (values) => t('composer.defaultTitle', values),
                deterministicBody: (values) => t('composer.deterministicBody', values),
              });
            const trimmedTitle = currentDraft.title.trim();
            const trimmedBody = currentDraft.body.trim();
            const canSubmit =
              trimmedTitle.length > 0 &&
              trimmedTitle.length <= NOTE_TITLE_MAX &&
              trimmedBody.length > 0 &&
              trimmedBody.length <= PROJECT_WEEKLY_STATUS_SUMMARY_MAX;
            const busy = shareNote.isPending || sendMail.isPending;
            const noOtherMembers = otherMemberCount === 0;
            const confirmMailDescription =
              otherMemberCount !== undefined && otherMemberCount > 0
                ? t('composer.confirmMailDescCount', {
                    count: String(otherMemberCount),
                    subject: trimmedTitle,
                  })
                : t('composer.confirmMailDesc', { subject: trimmedTitle });

            return (
              <div className="border-t border-border pt-3" data-testid="project-weekly-status-share-section">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const next = !composerOpen;
                      setComposerOpen(next);
                      if (next) {
                        setDraft(null);
                        setShareResult(null);
                        setMailResult(null);
                        shareNote.reset();
                        sendMail.reset();
                        shareKeyRef.current = crypto.randomUUID();
                        mailKeyRef.current = crypto.randomUUID();
                      }
                    }}
                    data-testid="project-weekly-status-share-toggle"
                  >
                    {composerOpen ? t('composer.close') : t('shareAction')}
                  </Button>
                </div>

                {composerOpen && (
                  <div
                    className={
                      currentDraft.aiUnedited
                        ? 'mt-3 space-y-3 rounded-lg border border-dashed border-proposal/60 bg-proposal/5 p-3'
                        : 'mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3'
                    }
                    data-testid="project-weekly-status-composer"
                    data-ai-unedited={currentDraft.aiUnedited ? 'true' : 'false'}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {currentDraft.aiUnedited ? (
                        <Badge variant="proposal" data-testid="project-weekly-status-composer-ai-badge">
                          {t('composer.aiUneditedBadge')}
                        </Badge>
                      ) : (
                        <span />
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setDraft(null);
                          shareKeyRef.current = crypto.randomUUID();
                          mailKeyRef.current = crypto.randomUUID();
                        }}
                        data-testid="project-weekly-status-reset-draft"
                      >
                        {t('composer.resetDraft')}
                      </Button>
                    </div>

                    {currentDraft.aiUnedited && (
                      <p className="text-xs text-muted-foreground" data-testid="project-weekly-status-composer-ai-hint">
                        {t('composer.aiUneditedHint')}
                      </p>
                    )}

                    <div className="space-y-1">
                      <Label htmlFor={titleInputId} className="text-xs">
                        {t('composer.titleLabel')}
                      </Label>
                      <Input
                        id={titleInputId}
                        value={currentDraft.title}
                        maxLength={NOTE_TITLE_MAX}
                        onChange={(e) => {
                          setDraft({ ...currentDraft, title: e.target.value });
                          setShareResult(null);
                          setMailResult(null);
                          shareKeyRef.current = crypto.randomUUID();
                          mailKeyRef.current = crypto.randomUUID();
                        }}
                        disabled={busy}
                        data-testid="project-weekly-status-composer-title"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={bodyInputId} className="text-xs">
                        {t('composer.bodyLabel')}
                      </Label>
                      <Textarea
                        id={bodyInputId}
                        rows={4}
                        value={currentDraft.body}
                        maxLength={PROJECT_WEEKLY_STATUS_SUMMARY_MAX}
                        onChange={(e) => {
                          setDraft(updateWeeklyStatusDraftBody(currentDraft, e.target.value));
                          setShareResult(null);
                          setMailResult(null);
                          shareKeyRef.current = crypto.randomUUID();
                          mailKeyRef.current = crypto.randomUUID();
                        }}
                        disabled={busy}
                        data-testid="project-weekly-status-composer-body"
                      />
                    </div>

                    {shareNote.error ? <ErrorText>{errorMessage(shareNote.error)}</ErrorText> : null}
                    {sendMail.error ? <ErrorText>{errorMessage(sendMail.error)}</ErrorText> : null}

                    <div className="flex flex-wrap items-center gap-2">
                      {notesOn ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={shareNote.isPending}
                          disabled={!canSubmit || busy}
                          onClick={() =>
                            shareNote.mutate({
                              title: trimmedTitle,
                              body: trimmedBody,
                              tainted: currentDraft.aiUnedited,
                              idempotencyKey: shareKeyRef.current,
                            })
                          }
                          data-testid="project-weekly-status-share-note"
                        >
                          {shareNote.isPending ? t('composer.sharingNote') : t('composer.shareNoteBtn')}
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground" data-testid="project-weekly-status-notes-off">
                          {t('composer.notesOff')}
                        </p>
                      )}

                      {noOtherMembers ? (
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          disabled
                          data-testid="project-weekly-status-send-mail"
                        >
                          {t('composer.sendMailBtn')}
                        </Button>
                      ) : (
                        <ConfirmDialog
                          title={t('composer.confirmMailTitle')}
                          description={confirmMailDescription}
                          confirm={t('composer.confirmMailAction')}
                          disabled={!canSubmit || busy}
                          onConfirm={() =>
                            sendMail.mutate({
                              subject: trimmedTitle,
                              summary: trimmedBody,
                              language,
                              tainted: currentDraft.aiUnedited,
                              idempotencyKey: mailKeyRef.current,
                            })
                          }
                          render={
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              loading={sendMail.isPending}
                              disabled={!canSubmit || busy}
                              data-testid="project-weekly-status-send-mail"
                            />
                          }
                        >
                          {sendMail.isPending ? t('composer.sendingMail') : t('composer.sendMailBtn')}
                        </ConfirmDialog>
                      )}
                    </div>

                    {noOtherMembers && (
                      <p className="text-xs text-muted-foreground" data-testid="project-weekly-status-no-other-members">
                        {t('composer.noOtherMembers')}
                      </p>
                    )}

                    {shareResult && (
                      <p className="text-xs text-foreground" data-testid="project-weekly-status-share-result">
                        {t('composer.sharedSuccess')}
                      </p>
                    )}

                    {mailResult && (
                      <p className="text-xs text-foreground" data-testid="project-weekly-status-mail-result">
                        {mailResult.sentCount === 0 && mailResult.skippedCount === 0
                          ? t('composer.sentZeroMembers')
                          : mailResult.sentCount === 0
                            ? t('composer.sentNone', { skipped: String(mailResult.skippedCount) })
                            : mailResult.skippedCount > 0
                              ? t('composer.sentWithSkipped', {
                                  sent: String(mailResult.sentCount),
                                  skipped: String(mailResult.skippedCount),
                                })
                              : t('composer.sentSuccess', { sent: String(mailResult.sentCount) })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </Card>
  );
}
