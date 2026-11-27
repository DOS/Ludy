// SPDX-License-Identifier: AGPL-3.0-only
// Task-level GitHub issue/PR chips, tainted warning badges, and manual link editor (#5158, ADR-0060).
import { parseGithubItemUrl, type GithubExternalState } from '@ludy/kernel-contract';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { ErrorText, FieldError, RowsSkeleton, fieldControl } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

export function safeGithubItemUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function githubStateBadgeVariant(
  state: GithubExternalState,
): 'success' | 'secondary' | 'brand' | 'outline' {
  switch (state) {
    case 'open':
      return 'success';
    case 'draft':
      return 'secondary';
    case 'merged':
      return 'brand';
    case 'closed':
      return 'outline';
  }
}

export function ProjectTaskGithubLinks({
  projectId,
  taskId,
  githubEnabled = false,
  canWrite = false,
  onChanged,
}: {
  projectId: string;
  taskId: string;
  githubEnabled?: boolean;
  canWrite?: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const t = useTranslations('projects.github');
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const urlInputId = useId();
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  const linksQuery = useQuery({
    ...orpc.projects.github.taskLinks.queryOptions({ input: { projectId, taskId } }),
    enabled: githubEnabled,
  });

  const aiPrSummary = useMutation({
    mutationFn: () => client.projects.github.aiPrSummary({ projectId, taskId, language: locale }),
  });

  const aiIssueMatch = useMutation({
    mutationFn: () => client.projects.github.aiIssueMatch({ projectId, taskId, language: locale }),
  });

  const { reset: resetPrSummary } = aiPrSummary;
  const { reset: resetIssueMatch } = aiIssueMatch;

  useEffect(() => {
    resetPrSummary();
    resetIssueMatch();
  }, [projectId, taskId, resetPrSummary, resetIssueMatch]);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: orpc.projects.github.taskLinks.queryKey({ input: { projectId, taskId } }),
    });
    void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });
    onChanged?.();
  };

  const addLink = useMutation(
    orpc.projects.github.taskLinkAdd.mutationOptions({
      onSuccess: () => {
        setUrlDraft('');
        setUrlError(null);
        invalidate();
        if (aiIssueMatch.data) aiIssueMatch.reset();
      },
    }),
  );

  const removeLink = useMutation(
    orpc.projects.github.taskLinkRemove.mutationOptions({
      onSuccess: () => invalidate(),
    }),
  );

  // Strict opt-in: when GitHub integration is disabled, render nothing and perform zero API queries.
  if (!githubEnabled) return null;

  const links = linksQuery.data?.links ?? [];
  const taskKey = linksQuery.data?.taskKey ?? null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canWrite || addLink.isPending) return;
    const trimmed = urlDraft.trim();
    if (!parseGithubItemUrl(trimmed)) {
      setUrlError(t('linkUrlInvalid'));
      return;
    }
    setUrlError(null);
    addLink.mutate({
      projectId,
      taskId,
      url: trimmed,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <section
      aria-label={t('linksSectionTitle')}
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
      data-testid="project-task-github-links"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ProjectIcon name="link" className="size-4 text-muted-foreground" />
            <span>{t('linksSectionTitle')}</span>
          </h3>
          <p className="text-xs text-muted-foreground">{t('linksSectionHint')}</p>
        </div>
        {taskKey && (
          <Badge variant="outline" className="font-mono text-xs" data-testid="task-dialog-github-key">
            {t('taskKeyLabel', { key: taskKey })}
          </Badge>
        )}
      </div>

      {linksQuery.isPending ? (
        <RowsSkeleton rows={2} />
      ) : linksQuery.error ? (
        <ErrorText>{errorMessage(linksQuery.error)}</ErrorText>
      ) : links.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="github-links-empty">
          {t('linksEmpty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {links.map((link) => {
            const safeHref = safeGithubItemUrl(link.externalUrl);
            const stateKey =
              link.externalState === 'open'
                ? 'linkStateOpen'
                : link.externalState === 'draft'
                  ? 'linkStateDraft'
                  : link.externalState === 'merged'
                    ? 'linkStateMerged'
                    : 'linkStateClosed';
            const kindLabel = link.kind === 'pull_request' ? t('linkTypePr') : t('linkTypeIssue');

            return (
              <li
                key={link.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-background p-2.5 text-xs sm:flex-row sm:items-center sm:justify-between"
                data-testid="github-task-link-item"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="h-5 px-1.5 font-mono text-[11px]">
                      {`${kindLabel} #${link.externalNumber}`}
                    </Badge>
                    <Badge variant={githubStateBadgeVariant(link.externalState)} className="h-5 px-1.5 text-[11px]">
                      {t(stateKey)}
                    </Badge>
                    {link.hydrating && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                        {t('hydratingBadge')}
                      </Badge>
                    )}
                    <Badge
                      variant="warning"
                      className="h-5 px-1.5 text-[11px]"
                      title={t('taintedHint')}
                      data-testid="github-link-tainted-badge"
                    >
                      {t('taintedBadge')}
                    </Badge>
                  </div>
                  {safeHref ? (
                    <a
                      href={safeHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center break-words rounded font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-6"
                    >
                      {link.externalTitle}
                    </a>
                  ) : (
                    <p className="break-words font-medium text-foreground">{link.externalTitle}</p>
                  )}
                  <p className="truncate text-[11px] text-muted-foreground">
                    {link.repoFullName}
                    {link.branchName ? ` · ${link.branchName}` : ''}
                    {link.authorLogin ? ` · @${link.authorLogin}` : ''}
                  </p>
                </div>
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={removeLink.isPending}
                    onClick={() =>
                      removeLink.mutate({
                        projectId,
                        taskId,
                        linkId: link.id,
                        idempotencyKey: crypto.randomUUID(),
                      })
                    }
                    aria-label={`${t('linkRemoveBtn')}: #${link.externalNumber}`}
                    className="min-h-11 min-w-11 shrink-0 px-2.5"
                    data-testid="remove-github-link-btn"
                  >
                    <ProjectIcon name="unlink" className="size-3.5" />
                    <span className="sm:sr-only">{t('linkRemoveBtn')}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {links.length > 0 && (
        <div
          className="space-y-2 rounded-md border border-border/80 bg-background/80 p-2.5 text-xs"
          data-testid="github-pr-summary-panel"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Badge variant="brand" className="h-5 px-1.5 text-[11px]" data-testid="github-pr-summary-ai-badge">
                {t('aiBadge')}
              </Badge>
              <span className="font-medium text-foreground">{t('aiSummaryTitle')}</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={aiPrSummary.isPending}
              loading={aiPrSummary.isPending}
              onClick={() => aiPrSummary.mutate()}
              className="min-h-11 px-3 text-xs"
              data-testid="github-pr-summary-btn"
            >
              {aiPrSummary.data ? t('aiSummaryRefreshBtn') : t('aiSummaryBtn')}
            </Button>
          </div>
          {aiPrSummary.error && <ErrorText>{errorMessage(aiPrSummary.error)}</ErrorText>}
          {aiPrSummary.data && (
            <div className="space-y-1">
              {aiPrSummary.data.ai === 'used' && aiPrSummary.data.summary ? (
                <p className="break-words text-foreground" data-testid="github-pr-summary-text">
                  {aiPrSummary.data.summary}
                </p>
              ) : (
                <>
                  {aiPrSummary.data.fallbackSummary && (
                    <p className="break-words text-foreground" data-testid="github-pr-summary-fallback">
                      {aiPrSummary.data.fallbackSummary}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {aiPrSummary.data.ai === 'busy' ? t('aiBusyNotice') : t('aiFallbackNotice')}
                  </p>
                </>
              )}
              <p className="text-[11px] text-muted-foreground">{t('aiSummaryHint')}</p>
            </div>
          )}
        </div>
      )}

      {canWrite && (
        <form onSubmit={handleSubmit} className="space-y-2 border-t border-border/70 pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={urlInputId} className="text-xs font-medium text-foreground">
              {t('linkUrlLabel')}
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={aiIssueMatch.isPending}
              loading={aiIssueMatch.isPending}
              onClick={() => aiIssueMatch.mutate()}
              className="min-h-11 px-3 text-xs"
              data-testid="github-issue-match-btn"
            >
              <Badge variant="brand" className="mr-1.5 h-5 px-1.5 text-[11px]">
                {t('aiBadge')}
              </Badge>
              <span>{t('aiIssueMatchBtn')}</span>
            </Button>
          </div>
          {aiIssueMatch.error && <ErrorText>{errorMessage(aiIssueMatch.error)}</ErrorText>}
          {aiIssueMatch.data && (
            <div
              className="space-y-2 rounded-md border border-border/80 bg-background/80 p-2.5 text-xs"
              data-testid="github-issue-match-panel"
            >
              <p className="font-medium text-foreground">{t('aiIssueMatchTitle')}</p>
              {aiIssueMatch.data.ai !== 'used' && aiIssueMatch.data.candidates.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {aiIssueMatch.data.ai === 'busy' ? t('aiBusyNotice') : t('aiMatchFallbackNotice')}
                </p>
              )}
              {aiIssueMatch.data.candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="github-issue-match-empty">
                  {t('aiIssueMatchEmpty')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {aiIssueMatch.data.candidates.map((cand) => {
                    const safeHref = safeGithubItemUrl(cand.externalUrl);
                    return (
                      <li
                        key={cand.candidateId}
                        className="flex flex-col gap-2 rounded border border-border bg-background p-2 sm:flex-row sm:items-center sm:justify-between"
                        data-testid="github-issue-match-candidate"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="h-5 px-1.5 font-mono text-[11px]">
                              {`${t('linkTypeIssue')} #${cand.externalNumber}`}
                            </Badge>
                            <Badge
                              variant={cand.deterministic ? 'secondary' : 'brand'}
                              className="h-5 px-1.5 text-[11px]"
                            >
                              {cand.deterministic ? t('aiDeterministicBadge') : t('aiBadge')}
                            </Badge>
                          </div>
                          {safeHref ? (
                            <a
                              href={safeHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-11 items-center break-words font-medium text-foreground hover:text-link hover:underline"
                            >
                              {cand.externalTitle}
                            </a>
                          ) : (
                            <p className="break-words font-medium text-foreground">{cand.externalTitle}</p>
                          )}
                          {cand.reason && (
                            <p className="text-[11px] text-muted-foreground">{cand.reason}</p>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={addLink.isPending}
                          onClick={() =>
                            addLink.mutate({
                              projectId,
                              taskId,
                              url: cand.externalUrl,
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          className="min-h-11 shrink-0 px-3 text-xs"
                          data-testid="github-issue-match-confirm-btn"
                        >
                          {t('aiIssueMatchConfirmBtn')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              {...fieldControl(urlInputId, { error: Boolean(urlError) })}
              type="url"
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                if (urlError) setUrlError(null);
              }}
              placeholder={t('linkUrlPlaceholder')}
              className="min-h-11 flex-1 text-xs sm:min-h-9"
              data-testid="github-link-url-input"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!urlDraft.trim() || addLink.isPending}
              loading={addLink.isPending}
              className="min-h-11 shrink-0 px-3 sm:min-h-9"
              data-testid="github-link-add-btn"
            >
              <ProjectIcon name="plus" className="size-3.5" />
              <span>{t('linkAddBtn')}</span>
            </Button>
          </div>
          <FieldError id={urlInputId}>{urlError}</FieldError>
          {addLink.error && <ErrorText>{errorMessage(addLink.error)}</ErrorText>}
          {removeLink.error && <ErrorText>{errorMessage(removeLink.error)}</ErrorText>}
        </form>
      )}
    </section>
  );
}
