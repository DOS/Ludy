// SPDX-License-Identifier: AGPL-3.0-only
// Project Settings -> GitHub Integration dialog (App install, PAT fallback, task keys, <= 5 repos, sync log; #5158).
import {
  GITHUB_REPOS_PER_PROJECT_MAX,
  GITHUB_TASK_PREFIX_PATTERN,
  type GithubAvailableRepo,
  type GithubSyncStatus,
  type ProjectColumn,
  type ProjectDetail,
} from '@ludy/kernel-contract';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { ErrorText, FieldError, RowsSkeleton, fieldControl, fieldHintId } from './ui.tsx';
import { errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { rememberGithubOAuthAttempt } from '../lib/oauth.ts';

export function normalizeTaskKeyPrefixDraft(raw: string): string | null {
  const clean = raw.trim().toUpperCase();
  if (!clean) return null;
  return clean;
}

export function syncStatusBadgeVariant(
  status: GithubSyncStatus,
): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'applied':
      return 'success';
    case 'deferred':
      return 'warning';
    case 'failed':
      return 'destructive';
    case 'queued':
      return 'secondary';
    case 'skipped':
      return 'outline';
  }
}

export function sortAvailableGithubRepos(
  repos: readonly GithubAvailableRepo[],
): GithubAvailableRepo[] {
  return [...repos].sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

export function ProjectGithubSettingsDialog({
  open,
  onOpenChange,
  orgSlug,
  project,
  columns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug?: string;
  project: ProjectDetail;
  columns: readonly ProjectColumn[];
}) {
  const t = useTranslations('projects.github');
  const tc = useTranslations('common');
  const patTokenInputId = useId();
  const patSecretInputId = useId();
  const patDisplayInputId = useId();
  const prefixInputId = useId();
  const patRefreshInputId = useId();
  const colInProgressSelectId = useId();
  const colInReviewSelectId = useId();
  const colDoneSelectId = useId();
  const repoPickerSelectId = useId();

  const [authTab, setAuthTab] = useState<'app' | 'pat'>('app');
  const [patToken, setPatToken] = useState('');
  const [patSecret, setPatSecret] = useState('');
  const [patDisplayName, setPatDisplayName] = useState('');
  const [patRefreshToken, setPatRefreshToken] = useState('');
  const [webhookUrlOnce, setWebhookUrlOnce] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [availableRepos, setAvailableRepos] = useState<GithubAvailableRepo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [backfilledNotice, setBackfilledNotice] = useState<number | null>(null);

  const [githubEnabled, setGithubEnabled] = useState(false);
  const [taskKeyPrefix, setTaskKeyPrefix] = useState('');
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [backfillTaskNumbers, setBackfillTaskNumbers] = useState(true);
  const [autoSyncInbound, setAutoSyncInbound] = useState(true);
  const [autoLinkMentions, setAutoLinkMentions] = useState(true);
  const [autoLinkBranch, setAutoLinkBranch] = useState(true);
  const [inboundInProgressOnPr, setInboundInProgressOnPr] = useState(true);
  const [inboundDoneOnMerge, setInboundDoneOnMerge] = useState(true);
  const [inboundColInProgress, setInboundColInProgress] = useState('');
  const [inboundColInReview, setInboundColInReview] = useState('');
  const [inboundColDone, setInboundColDone] = useState('');

  const bindingQuery = useQuery({
    ...orpc.projects.github.bindingGet.queryOptions({ input: { projectId: project.id } }),
    enabled: open,
  });

  const syncLogQuery = useQuery({
    ...orpc.projects.github.syncLog.queryOptions({ input: { projectId: project.id, limit: 20 } }),
    enabled: open && Boolean(bindingQuery.data?.binding),
  });

  const binding = bindingQuery.data?.binding ?? null;

  useEffect(() => {
    if (!open) return;
    setCopiedUrl(false);
    setPrefixError(null);
    if (!binding) return;
    setGithubEnabled(binding.githubEnabled);
    setTaskKeyPrefix(binding.taskKeyPrefix ?? '');
    setAutoSyncInbound(binding.autoSyncInbound);
    setAutoLinkMentions(binding.autoLinkMentions);
    setAutoLinkBranch(binding.autoLinkBranch);
    setInboundInProgressOnPr(binding.inboundInProgressOnPr);
    setInboundDoneOnMerge(binding.inboundDoneOnMerge);
    setInboundColInProgress(binding.inboundColInProgress ?? '');
    setInboundColInReview(binding.inboundColInReview ?? '');
    setInboundColDone(binding.inboundColDone ?? '');
  }, [open, binding]);

  useEffect(() => {
    if (open && bindingQuery.data && !bindingQuery.data.appConfigured && !binding) {
      setAuthTab('pat');
    }
  }, [open, bindingQuery.data, binding]);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({
      queryKey: orpc.projects.github.bindingGet.queryKey({ input: { projectId: project.id } }),
    });
    void queryClient.invalidateQueries({
      queryKey: orpc.projects.github.syncLog.queryKey({ input: { projectId: project.id, limit: 20 } }),
    });
    void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });
  };

  const startAppOAuth = useMutation(
    orpc.projects.github.appOAuthStart.mutationOptions({
      onSuccess: (res) => {
        const slug = orgSlug ?? getCurrentOrg() ?? '';
        const normalizedPrefix = normalizeTaskKeyPrefixDraft(taskKeyPrefix);
        if (slug) {
          rememberGithubOAuthAttempt(res.state, {
            slug,
            projectId: project.id,
            taskKeyPrefix: normalizedPrefix,
            backfillTaskNumbers,
          });
        }
        window.location.assign(res.authorizeUrl);
      },
    }),
  );

  const connectPat = useMutation(
    orpc.projects.github.connectPat.mutationOptions({
      onSuccess: (res) => {
        setWebhookUrlOnce(res.webhookUrl);
        setAvailableRepos(sortAvailableGithubRepos(res.availableRepos));
        setSelectedRepoId(res.availableRepos[0]?.githubRepoId ?? '');
        setBackfilledNotice(res.backfilledCount);
        setPatToken('');
        setPatSecret('');
        invalidateAll();
      },
    }),
  );

  const rotateHook = useMutation(
    orpc.projects.github.rotatePatHook.mutationOptions({
      onSuccess: (res) => {
        setWebhookUrlOnce(res.webhookUrl);
        setCopiedUrl(false);
        invalidateAll();
      },
    }),
  );

  const loadRepos = useMutation(
    orpc.projects.github.listAvailableRepos.mutationOptions({
      onSuccess: (res) => {
        const sorted = sortAvailableGithubRepos(res.repos);
        setAvailableRepos(sorted);
        setSelectedRepoId(sorted[0]?.githubRepoId ?? '');
        setPatRefreshToken('');
      },
    }),
  );

  const saveBinding = useMutation(
    orpc.projects.github.bindingSave.mutationOptions({
      onSuccess: (res) => {
        setBackfilledNotice(res.backfilledCount);
        invalidateAll();
      },
    }),
  );

  const bindRepo = useMutation(
    orpc.projects.github.repoBind.mutationOptions({
      onSuccess: () => invalidateAll(),
    }),
  );

  const unbindRepo = useMutation(
    orpc.projects.github.repoUnbind.mutationOptions({
      onSuccess: () => invalidateAll(),
    }),
  );

  const handleStartAppOAuth = (e: FormEvent) => {
    e.preventDefault();
    const normalizedPrefix = normalizeTaskKeyPrefixDraft(taskKeyPrefix);
    if (normalizedPrefix && !GITHUB_TASK_PREFIX_PATTERN.test(normalizedPrefix)) {
      setPrefixError(t('taskPrefixInvalid'));
      return;
    }
    setPrefixError(null);
    startAppOAuth.mutate({ projectId: project.id });
  };

  const handleConnectPat = (e: FormEvent) => {
    e.preventDefault();
    if (!patToken.trim() || !patSecret.trim()) return;
    const normalizedPrefix = normalizeTaskKeyPrefixDraft(taskKeyPrefix);
    if (normalizedPrefix && !GITHUB_TASK_PREFIX_PATTERN.test(normalizedPrefix)) {
      setPrefixError(t('taskPrefixInvalid'));
      return;
    }
    setPrefixError(null);
    connectPat.mutate({
      projectId: project.id,
      accessToken: patToken.trim(),
      webhookSecret: patSecret.trim(),
      ...(patDisplayName.trim() ? { displayName: patDisplayName.trim() } : {}),
      ...(normalizedPrefix ? { taskKeyPrefix: normalizedPrefix, backfillTaskNumbers } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const handleSaveSettings = (e: FormEvent) => {
    e.preventDefault();
    if (!binding) return;
    const normalizedPrefix = normalizeTaskKeyPrefixDraft(taskKeyPrefix);
    if (normalizedPrefix && !GITHUB_TASK_PREFIX_PATTERN.test(normalizedPrefix)) {
      setPrefixError(t('taskPrefixInvalid'));
      return;
    }
    setPrefixError(null);
    saveBinding.mutate({
      projectId: project.id,
      channelConnectionId: binding.channelConnectionId,
      githubEnabled,
      taskKeyPrefix: normalizedPrefix,
      backfillTaskNumbers,
      autoSyncInbound,
      autoLinkMentions,
      autoLinkBranch,
      inboundInProgressOnPr,
      inboundDoneOnMerge,
      inboundColInProgress: inboundColInProgress || null,
      inboundColInReview: inboundColInReview || null,
      inboundColDone: inboundColDone || null,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const inProgressColumns = columns.filter((c) => c.taskStatus === 'in_progress' || c.id === inboundColInProgress);
  const inReviewColumns = columns.filter((c) => c.taskStatus === 'in_review' || c.id === inboundColInReview);
  const doneColumns = columns.filter((c) => c.taskStatus === 'done' || c.id === inboundColDone);

  const taskKeyPrefixSection = (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <p className="text-xs font-semibold text-foreground">{t('taskKeySectionTitle')}</p>
      <div className="space-y-1.5">
        <Label htmlFor={prefixInputId}>{t('taskPrefixLabel')}</Label>
        <Input
          {...fieldControl(prefixInputId, { hint: true, error: Boolean(prefixError) })}
          type="text"
          maxLength={8}
          value={taskKeyPrefix}
          onChange={(e) => {
            setTaskKeyPrefix(e.target.value.toUpperCase());
            if (prefixError) setPrefixError(null);
          }}
          placeholder={t('taskPrefixPlaceholder')}
          className="min-h-11 max-w-48 font-mono uppercase sm:min-h-9"
          data-testid="github-task-prefix-input"
        />
        <p id={fieldHintId(prefixInputId)} className="text-[11px] text-muted-foreground">{t('taskPrefixHint')}</p>
        <FieldError id={prefixInputId}>{prefixError}</FieldError>
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
        <Checkbox
          checked={backfillTaskNumbers}
          onCheckedChange={(checked) => setBackfillTaskNumbers(checked === true)}
          data-testid="github-backfill-checkbox"
        />
        <span>{t('backfillLabel')}</span>
      </label>
      {backfilledNotice !== null && backfilledNotice > 0 && (
        <p className="text-xs font-medium text-foreground">{t('backfilledNotice', { count: backfilledNotice })}</p>
      )}
    </div>
  );

  const boundIds = new Set((binding?.repos ?? []).map((r) => r.githubRepoId));
  const pickableRepos = availableRepos.filter((r) => !boundIds.has(r.githubRepoId));
  const repoCount = binding?.repos.length ?? 0;
  const repoLimitReached = repoCount >= GITHUB_REPOS_PER_PROJECT_MAX;
  const brokerConfigured = bindingQuery.data?.brokerConfigured ?? true;
  const appConfigured = bindingQuery.data?.appConfigured ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} className="max-h-[88vh] overflow-y-auto sm:max-w-2xl" data-testid="project-github-settings-dialog">
        <DialogHeader>
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
          <DialogDescription>{t('settingsSubtitle')}</DialogDescription>
        </DialogHeader>

        {bindingQuery.isPending ? (
          <RowsSkeleton rows={4} />
        ) : bindingQuery.error ? (
          <ErrorText>{errorMessage(bindingQuery.error)}</ErrorText>
        ) : (
          <div className="space-y-5">
            {!brokerConfigured && (
              <Alert>
                <AlertDescription className="text-xs">{t('brokerMissing')}</AlertDescription>
              </Alert>
            )}

            {binding && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="brand">
                      {binding.provider === 'github_app' ? t('providerApp') : t('providerPat')}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">{binding.connectionDisplayName}</span>
                    {binding.provider === 'github_pat' && (
                      <Badge
                        variant={
                          binding.hookStanding === 'active'
                            ? 'success'
                            : binding.hookStanding === 'stopped'
                              ? 'destructive'
                              : 'outline'
                        }
                        data-testid="github-pat-hook-standing"
                      >
                        {binding.hookStanding === 'active'
                          ? t('hookStandingActive')
                          : binding.hookStanding === 'stopped'
                            ? t('hookStandingStopped')
                            : t('hookStandingNone')}
                      </Badge>
                    )}
                  </div>
                  {binding.provider === 'github_pat' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rotateHook.isPending}
                      loading={rotateHook.isPending}
                      onClick={() =>
                        rotateHook.mutate({
                          projectId: project.id,
                          idempotencyKey: crypto.randomUUID(),
                        })
                      }
                      className="min-h-11 sm:min-h-9"
                      data-testid="rotate-pat-hook-button"
                    >
                      {t('rotateWebhookBtn')}
                    </Button>
                  )}
                </div>
                {binding.pausedReason && (
                  <p className="text-xs font-medium text-destructive">{t('pausedWarning', { reason: binding.pausedReason })}</p>
                )}
                {rotateHook.error && <ErrorText>{errorMessage(rotateHook.error)}</ErrorText>}
              </div>
            )}

            {webhookUrlOnce && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="github-webhook-url-banner">
                <p className="text-xs font-medium text-foreground">{t('webhookOnceAlert')}</p>
                <Label htmlFor="github-webhook-url-readonly" className="text-xs text-muted-foreground">
                  {t('webhookUrlLabel')}
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="github-webhook-url-readonly"
                    type="text"
                    readOnly
                    value={webhookUrlOnce}
                    className="min-h-11 flex-1 font-mono text-xs sm:min-h-9"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 shrink-0 sm:min-h-9"
                    onClick={async () => {
                      try {
                        if (typeof navigator !== 'undefined' && navigator.clipboard) {
                          await navigator.clipboard.writeText(webhookUrlOnce);
                          setCopiedUrl(true);
                        }
                      } catch {
                        // Clipboard permission unavailable or denied; keep input visible for manual copy.
                      }
                    }}
                  >
                    <span aria-live="polite">{copiedUrl ? t('copiedWebhook') : t('copyWebhookBtn')}</span>
                  </Button>
                </div>
              </div>
            )}

            {!binding && brokerConfigured && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-foreground">{t('connectHeading')}</h3>
                  <Tabs value={authTab} onValueChange={(v) => setAuthTab(v as 'app' | 'pat')}>
                    <TabsList>
                      <TabsTrigger value="app" className="min-h-11 px-3 sm:min-h-9" data-testid="github-tab-app">
                        {t('connectAppTab')}
                      </TabsTrigger>
                      <TabsTrigger value="pat" className="min-h-11 px-3 sm:min-h-9" data-testid="github-tab-pat">
                        {t('connectPatTab')}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {authTab === 'app' ? (
                  !appConfigured ? (
                    <p className="text-xs text-muted-foreground">{t('appNotConfigured')}</p>
                  ) : (
                    <form onSubmit={handleStartAppOAuth} className="space-y-3">
                      <p className="text-xs text-muted-foreground">{t('appInstallHint')}</p>
                      {taskKeyPrefixSection}
                      {startAppOAuth.error && <ErrorText>{errorMessage(startAppOAuth.error)}</ErrorText>}
                      <Button
                        type="submit"
                        disabled={startAppOAuth.isPending}
                        loading={startAppOAuth.isPending}
                        className="min-h-11 sm:min-h-9"
                        data-testid="github-connect-app-submit"
                      >
                        {t('connectAppBtn')}
                      </Button>
                    </form>
                  )
                ) : (
                  <form onSubmit={handleConnectPat} className="space-y-3">
                    <p className="text-xs text-muted-foreground">{t('patHelpHint')}</p>
                    <div className="space-y-1.5">
                      <Label htmlFor={patTokenInputId}>{t('patTokenLabel')}</Label>
                      <Input
                        id={patTokenInputId}
                        type="password"
                        value={patToken}
                        onChange={(e) => setPatToken(e.target.value)}
                        placeholder={t('patTokenPlaceholder')}
                        className="min-h-11 sm:min-h-9"
                        data-testid="github-pat-token-input"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={patSecretInputId}>{t('patSecretLabel')}</Label>
                      <Input
                        id={patSecretInputId}
                        type="password"
                        value={patSecret}
                        onChange={(e) => setPatSecret(e.target.value)}
                        placeholder={t('patSecretPlaceholder')}
                        className="min-h-11 sm:min-h-9"
                        data-testid="github-pat-secret-input"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={patDisplayInputId}>{t('patDisplayNameLabel')}</Label>
                      <Input
                        id={patDisplayInputId}
                        type="text"
                        value={patDisplayName}
                        onChange={(e) => setPatDisplayName(e.target.value)}
                        placeholder={t('patDisplayNamePlaceholder')}
                        className="min-h-11 sm:min-h-9"
                      />
                    </div>
                    {taskKeyPrefixSection}
                    {connectPat.error && <ErrorText>{errorMessage(connectPat.error)}</ErrorText>}
                    <Button
                      type="submit"
                      disabled={!patToken.trim() || !patSecret.trim() || connectPat.isPending}
                      loading={connectPat.isPending}
                      className="min-h-11 sm:min-h-9"
                      data-testid="github-connect-pat-submit"
                    >
                      {t('connectPatBtn')}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {binding && (
              <>
                <form onSubmit={handleSaveSettings} className="space-y-4 rounded-lg border border-border p-3">
                  <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs text-foreground">
                    <Checkbox
                      checked={githubEnabled}
                      onCheckedChange={(checked) => setGithubEnabled(checked === true)}
                      data-testid="github-enabled-checkbox"
                    />
                    <span className="space-y-0.5">
                      <span className="block font-medium">{t('enabledLabel')}</span>
                      <span className="block text-[11px] text-muted-foreground">{t('enabledHint')}</span>
                    </span>
                  </label>

                  {taskKeyPrefixSection}

                  <div className="space-y-2 border-t border-border/60 pt-3">
                    <p className="text-xs font-semibold text-foreground">{t('syncRulesTitle')}</p>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={autoSyncInbound}
                        onCheckedChange={(c) => setAutoSyncInbound(c === true)}
                      />
                      <span>{t('autoSyncInboundLabel')}</span>
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={autoLinkMentions}
                        onCheckedChange={(c) => setAutoLinkMentions(c === true)}
                      />
                      <span>{t('autoLinkMentionsLabel')}</span>
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={autoLinkBranch}
                        onCheckedChange={(c) => setAutoLinkBranch(c === true)}
                      />
                      <span>{t('autoLinkBranchLabel')}</span>
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={inboundInProgressOnPr}
                        onCheckedChange={(c) => setInboundInProgressOnPr(c === true)}
                      />
                      <span>{t('inboundPrLabel')}</span>
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
                      <Checkbox
                        checked={inboundDoneOnMerge}
                        onCheckedChange={(c) => setInboundDoneOnMerge(c === true)}
                      />
                      <span>{t('inboundMergeLabel')}</span>
                    </label>
                  </div>

                  {columns.length > 0 && (
                    <div className="space-y-2 border-t border-border/60 pt-3">
                      <p className="text-xs font-semibold text-foreground">{t('columnsTitle')}</p>
                      <div className="grid gap-2.5 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label htmlFor={colInProgressSelectId} className="text-xs">{t('colInProgressLabel')}</Label>
                          <NativeSelect
                            id={colInProgressSelectId}
                            value={inboundColInProgress}
                            onChange={(e) => setInboundColInProgress(e.target.value)}
                            className="w-full text-xs [&_select]:min-h-11"
                          >
                            <NativeSelectOption value="">{t('colDefaultOption')}</NativeSelectOption>
                            {inProgressColumns.map((c) => (
                              <NativeSelectOption key={c.id} value={c.id}>
                                {c.name}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={colInReviewSelectId} className="text-xs">{t('colInReviewLabel')}</Label>
                          <NativeSelect
                            id={colInReviewSelectId}
                            value={inboundColInReview}
                            onChange={(e) => setInboundColInReview(e.target.value)}
                            className="w-full text-xs [&_select]:min-h-11"
                          >
                            <NativeSelectOption value="">{t('colDefaultOption')}</NativeSelectOption>
                            {inReviewColumns.map((c) => (
                              <NativeSelectOption key={c.id} value={c.id}>
                                {c.name}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={colDoneSelectId} className="text-xs">{t('colDoneLabel')}</Label>
                          <NativeSelect
                            id={colDoneSelectId}
                            value={inboundColDone}
                            onChange={(e) => setInboundColDone(e.target.value)}
                            className="w-full text-xs [&_select]:min-h-11"
                          >
                            <NativeSelectOption value="">{t('colDefaultOption')}</NativeSelectOption>
                            {doneColumns.map((c) => (
                              <NativeSelectOption key={c.id} value={c.id}>
                                {c.name}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                      </div>
                    </div>
                  )}

                  {saveBinding.error && <ErrorText>{errorMessage(saveBinding.error)}</ErrorText>}
                  <Button
                    type="submit"
                    disabled={saveBinding.isPending}
                    loading={saveBinding.isPending}
                    className="min-h-11 sm:min-h-9"
                    data-testid="github-save-settings-btn"
                  >
                    {t('saveSettingsBtn')}
                  </Button>
                </form>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <h3 className="text-xs font-semibold text-foreground">
                        {t('reposTitle', { count: repoCount, max: GITHUB_REPOS_PER_PROJECT_MAX })}
                      </h3>
                      <p className="text-[11px] text-muted-foreground">{t('reposHint', { max: GITHUB_REPOS_PER_PROJECT_MAX })}</p>
                    </div>
                    {binding.provider === 'github_app' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={loadRepos.isPending}
                        loading={loadRepos.isPending}
                        onClick={() => loadRepos.mutate({ projectId: project.id })}
                        className="min-h-11 sm:min-h-9"
                        data-testid="github-load-repos-btn"
                      >
                        {t('loadReposBtn')}
                      </Button>
                    )}
                  </div>

                  {binding.repos.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('reposEmpty')}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {binding.repos.map((repo) => (
                        <li
                          key={repo.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                          data-testid="github-bound-repo-item"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono font-medium text-foreground">{repo.repoFullName}</p>
                            <p className="text-[11px] text-muted-foreground">{repo.defaultBranch}</p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={unbindRepo.isPending}
                            onClick={() =>
                              unbindRepo.mutate({
                                projectId: project.id,
                                repoId: repo.id,
                                idempotencyKey: crypto.randomUUID(),
                              })
                            }
                            className="min-h-11 shrink-0 px-2.5 sm:min-h-9"
                            data-testid="github-unbind-repo-btn"
                          >
                            {t('unbindRepoBtn')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {binding.provider === 'github_pat' && pickableRepos.length === 0 && !repoLimitReached && (
                    <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                      <Input
                        id={patRefreshInputId}
                        type="password"
                        value={patRefreshToken}
                        onChange={(e) => setPatRefreshToken(e.target.value)}
                        placeholder={t('patRefreshTokenPlaceholder')}
                        aria-label={t('patRefreshTokenLabel')}
                        className="min-h-11 flex-1 text-xs sm:min-h-9"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!patRefreshToken.trim() || loadRepos.isPending}
                        loading={loadRepos.isPending}
                        onClick={() =>
                          loadRepos.mutate({ projectId: project.id, accessToken: patRefreshToken.trim() })
                        }
                        className="min-h-11 shrink-0 sm:min-h-9"
                      >
                        {t('loadReposBtn')}
                      </Button>
                    </div>
                  )}

                  {loadRepos.error && <ErrorText>{errorMessage(loadRepos.error)}</ErrorText>}
                  {repoLimitReached && (
                    <p className="text-[11px] text-muted-foreground">
                      {t('reposLimitReached', { max: GITHUB_REPOS_PER_PROJECT_MAX })}
                    </p>
                  )}

                  {pickableRepos.length > 0 && !repoLimitReached && (
                    <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                      <Label htmlFor={repoPickerSelectId} className="sr-only">
                        {t('bindRepoBtn')}
                      </Label>
                      <NativeSelect
                        id={repoPickerSelectId}
                        value={pickableRepos.some((r) => r.githubRepoId === selectedRepoId) ? selectedRepoId : (pickableRepos[0]?.githubRepoId ?? '')}
                        onChange={(e) => setSelectedRepoId(e.target.value)}
                        className="flex-1 text-xs [&_select]:min-h-11"
                        data-testid="github-repo-picker"
                      >
                        {pickableRepos.map((repo) => (
                          <NativeSelectOption key={repo.githubRepoId} value={repo.githubRepoId}>
                            {repo.repoFullName}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Button
                        type="button"
                        size="sm"
                        disabled={bindRepo.isPending}
                        loading={bindRepo.isPending}
                        onClick={() => {
                          const chosen =
                            pickableRepos.find((r) => r.githubRepoId === selectedRepoId) ?? pickableRepos[0];
                          if (!chosen) return;
                          bindRepo.mutate({
                            projectId: project.id,
                            githubRepoId: chosen.githubRepoId,
                            repoFullName: chosen.repoFullName,
                            defaultBranch: chosen.defaultBranch,
                            webhookConfigured: true,
                            idempotencyKey: crypto.randomUUID(),
                          });
                        }}
                        className="min-h-11 shrink-0 sm:min-h-9"
                        data-testid="github-bind-repo-btn"
                      >
                        {t('bindRepoBtn')}
                      </Button>
                    </div>
                  )}
                  {bindRepo.error && <ErrorText>{errorMessage(bindRepo.error)}</ErrorText>}
                  {unbindRepo.error && <ErrorText>{errorMessage(unbindRepo.error)}</ErrorText>}
                </div>

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <h3 className="text-xs font-semibold text-foreground">{t('syncLogTitle')}</h3>
                  {syncLogQuery.isPending ? (
                    <RowsSkeleton rows={2} />
                  ) : (syncLogQuery.data?.entries ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('syncLogEmpty')}</p>
                  ) : (
                    <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
                      {(syncLogQuery.data?.entries ?? []).map((entry) => {
                        const statusKey =
                          entry.status === 'applied'
                            ? 'syncStatusApplied'
                            : entry.status === 'deferred'
                              ? 'syncStatusDeferred'
                              : entry.status === 'failed'
                                ? 'syncStatusFailed'
                                : entry.status === 'queued'
                                  ? 'syncStatusQueued'
                                  : 'syncStatusSkipped';
                        return (
                          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 px-2.5 py-1.5">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Badge variant={syncStatusBadgeVariant(entry.status)} className="h-5 px-1.5 text-[11px]">
                                  {t(statusKey)}
                                </Badge>
                                <span className="font-mono text-[11px] text-foreground">{entry.eventType}</span>
                                {entry.repoFullName && (
                                  <span className="text-[11px] text-muted-foreground">
                                    {entry.repoFullName}
                                    {entry.externalNumber ? `#${entry.externalNumber}` : ''}
                                  </span>
                                )}
                              </div>
                              {entry.summary && (
                                <p className="truncate text-[11px] text-muted-foreground">{entry.summary}</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" className="min-h-11 sm:min-h-9" />}>
            {tc('close')}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
