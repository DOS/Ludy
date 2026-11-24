// SPDX-License-Identifier: AGPL-3.0-only
// Envelope contract playbook review card for /o/$slug/sign/envelopes/$id (Slice 5d, #4442).
// Supports both metered Vy checks ('sign.playbook_check') and 100% AI-off deterministic rule checks,
// clickable PDF page jumps, 1-click copy redline wording, and manual verdict overrides.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { errorMessage, queryClient } from '../../lib/api.ts';
import { isKernelErrorCode } from '../../lib/kernel-errors.ts';
import {
  downloadSignPdfBytes,
  signApi,
  type SignPlaybookAiOutcome,
  type SignPlaybookFindingContract,
  type SignPlaybookSeverityContract,
  type SignPlaybookVerdictContract,
} from '../../lib/sign-api.ts';
import type { SignInspectStatus } from '../../lib/sign-fields.ts';
import { copyTextToClipboard } from '../../lib/sign-hash.ts';
import { extractPdfPagesText } from '../../lib/sign-pdf.ts';
import { toast } from '../../lib/toast.ts';
import { ErrorText } from '../ui.tsx';

export interface EnvelopePlaybookCardProps {
  envelopeId: string;
  sourceFileId: string;
  inspectStatus: SignInspectStatus;
  pdfBytes: Uint8Array | null;
  onJumpToPage: (pageNumber: number) => void;
}

type PlaybookAiNoticeKey =
  | 'aiOffNotice'
  | 'aiBudgetNotice'
  | 'aiBusyNotice'
  | 'aiNoTextNotice'
  | 'aiEmptyNotice'
  | 'aiFailedNotice'
  | null;

function noticeKeyForAiOutcome(outcome: SignPlaybookAiOutcome, requestedAi: boolean): PlaybookAiNoticeKey {
  if (!requestedAi && outcome === 'off') return null;
  if (outcome === 'off') return 'aiOffNotice';
  if (outcome === 'budget') return 'aiBudgetNotice';
  if (outcome === 'busy') return 'aiBusyNotice';
  if (outcome === 'no_text') return 'aiNoTextNotice';
  if (outcome === 'empty') return 'aiEmptyNotice';
  if (outcome === 'failed') return 'aiFailedNotice';
  return null;
}

function verdictBadgeVariant(
  verdict: SignPlaybookVerdictContract,
): 'success' | 'warning' | 'destructive' | 'outline' {
  if (verdict === 'pass') return 'success';
  if (verdict === 'warn') return 'warning';
  if (verdict === 'fail') return 'destructive';
  return 'outline';
}

function severityBadgeVariant(
  severity: SignPlaybookSeverityContract,
): 'destructive' | 'warning' | 'secondary' {
  if (severity === 'critical') return 'destructive';
  if (severity === 'warn') return 'warning';
  return 'secondary';
}

type PlaybookOverrideDraft = {
  checkRevision: string;
  verdict: SignPlaybookVerdictContract;
  note: string;
};

export function EnvelopePlaybookCard({
  envelopeId,
  sourceFileId,
  inspectStatus,
  pdfBytes,
  onJumpToPage,
}: EnvelopePlaybookCardProps) {
  const t = useTranslations('sign.playbook');
  const [aiNoticeKey, setAiNoticeKey] = useState<PlaybookAiNoticeKey>(null);
  const [runningKind, setRunningKind] = useState<'ai' | 'rule' | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<
    Record<string, PlaybookOverrideDraft>
  >({});

  const playbookQuery = useQuery({
    queryKey: ['sign', 'playbook-check', envelopeId],
    queryFn: () => signApi.getPlaybookCheck(envelopeId),
    enabled: Boolean(envelopeId),
  });

  const check = playbookQuery.data?.check ?? null;
  const canEdit = playbookQuery.data?.canEdit ?? false;
  const activeRulesCount = playbookQuery.data?.activeRulesCount ?? 0;
  const isPdfInspected = inspectStatus === 'passed';

  useEffect(() => {
    setAiNoticeKey(null);
    setOverrideDrafts({});
  }, [envelopeId]);

  const counts = useMemo(() => {
    const findings = check?.findings ?? [];
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    for (const item of findings) {
      if (item.verdict === 'pass') passCount += 1;
      else if (item.verdict === 'warn') warnCount += 1;
      else if (item.verdict === 'fail') failCount += 1;
    }
    return { passCount, warnCount, failCount };
  }, [check]);

  const evaluateMutation = useMutation({
    mutationFn: async (useAi: boolean) => {
      setRunningKind(useAi ? 'ai' : 'rule');
      setAiNoticeKey(null);
      let pages: Array<{ page: number; text: string }> = [];
      const bytes = pdfBytes ?? (await downloadSignPdfBytes(sourceFileId));
      try {
        pages = await extractPdfPagesText(bytes);
      } catch {
        pages = [];
      }
      return signApi.evaluatePlaybook({
        envelopeId,
        useAi,
        pages,
      });
    },
    onSuccess: async (res, useAi) => {
      setOverrideDrafts({});
      setAiNoticeKey(noticeKeyForAiOutcome(res.ai, useAi));
      await queryClient.invalidateQueries({ queryKey: ['sign', 'playbook-check', envelopeId] });
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setRunningKind(null),
  });

  const overrideMutation = useMutation({
    mutationFn: (input: {
      ruleId: string;
      checkRevision: string;
      verdict: SignPlaybookVerdictContract;
      manualNote: string | null;
    }) =>
      signApi.overridePlaybookFinding({
        envelopeId,
        ruleId: input.ruleId,
        checkRevision: input.checkRevision,
        verdict: input.verdict,
        manualNote: input.manualNote,
      }),
    onSuccess: async (updatedCheck, variables) => {
      setOverrideDrafts((prev) => {
        const next: typeof prev = {};
        let changed = variables.ruleId in prev;
        for (const [ruleId, draft] of Object.entries(prev)) {
          if (ruleId === variables.ruleId) continue;
          if (draft.checkRevision !== updatedCheck.revision) changed = true;
          next[ruleId] = { ...draft, checkRevision: updatedCheck.revision };
        }
        return changed ? next : prev;
      });
      toast(t('overrideSavedToast'));
      await queryClient.invalidateQueries({ queryKey: ['sign', 'playbook-check', envelopeId] });
    },
    onError: async (err) => {
      toast(errorMessage(err), 'error');
      const rawCode = (err as { code?: unknown } | null | undefined)?.code;
      if (typeof rawCode === 'string' && isKernelErrorCode(rawCode) && rawCode === 'SIGN_PLAYBOOK_STALE_CHECK') {
        setOverrideDrafts({});
        await queryClient.invalidateQueries({ queryKey: ['sign', 'playbook-check', envelopeId] });
      }
    },
  });

  const handleCopyRedline = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      toast(t('redlineCopiedToast'));
    } else {
      toast(t('redlineCopyFailedToast'), 'error');
    }
  };

  const getDraftForFinding = (
    finding: SignPlaybookFindingContract,
    currentRevision: string,
  ): PlaybookOverrideDraft => {
    const existing = overrideDrafts[finding.ruleId];
    if (existing) return existing;
    return {
      checkRevision: currentRevision,
      verdict: finding.verdict,
      note: finding.manualNote ?? '',
    };
  };

  return (
    <Card data-testid="envelope-playbook-card">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{t('cardTitle')}</CardTitle>
          {check ? (
            <Badge variant={check.mode === 'ai' ? 'proposal' : 'outline'}>
              {t(`mode.${check.mode}`)}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('cardHint', { count: String(activeRulesCount) })}
        </p>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              disabled={!isPdfInspected || activeRulesCount === 0 || evaluateMutation.isPending}
              onClick={() => evaluateMutation.mutate(false)}
              data-testid="playbook-run-rule-btn"
            >
              {runningKind === 'rule' ? t('runningRuleButton') : t('runRuleButton')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-h-11"
              disabled={!isPdfInspected || activeRulesCount === 0 || evaluateMutation.isPending}
              onClick={() => evaluateMutation.mutate(true)}
              data-testid="playbook-run-ai-btn"
            >
              {runningKind === 'ai' ? t('runningAiButton') : t('runAiButton')}
            </Button>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {playbookQuery.error ? (
          <ErrorText>{errorMessage(playbookQuery.error)}</ErrorText>
        ) : null}

        {!isPdfInspected ? (
          <p className="text-xs text-muted-foreground" data-testid="playbook-not-inspected">
            {t('notInspectedNotice')}
          </p>
        ) : activeRulesCount === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="playbook-no-rules">
            {t('noActiveRulesNotice')}
          </p>
        ) : null}

        {check?.isStale ? (
          <Alert data-testid="playbook-stale-notice">
            <AlertDescription>{t('staleNotice')}</AlertDescription>
          </Alert>
        ) : null}

        {aiNoticeKey ? (
          <Alert data-testid="playbook-ai-notice">
            <AlertDescription>{t(aiNoticeKey)}</AlertDescription>
          </Alert>
        ) : null}

        {check && check.findings.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground" data-testid="playbook-summary-counts">
              {t('summaryCounts', {
                passCount: String(counts.passCount),
                warnCount: String(counts.warnCount),
                failCount: String(counts.failCount),
              })}
            </p>
            <ul className="space-y-3" data-testid="playbook-findings-list">
              {check.findings.map((finding) => {
                const draft = getDraftForFinding(finding, check.revision);
                const selectId = `playbook-verdict-${finding.ruleId}`;
                const noteId = `playbook-note-${finding.ruleId}`;
                return (
                  <li
                    key={finding.ruleId}
                    className="space-y-2.5 rounded-lg border bg-muted/15 p-3 text-xs"
                    data-testid={`playbook-finding-${finding.ruleId}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="font-medium text-foreground">{finding.ruleTitle}</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={severityBadgeVariant(finding.severity)}>
                          {t(`severity.${finding.severity}`)}
                        </Badge>
                        <Badge variant={verdictBadgeVariant(finding.verdict)}>
                          {t(`verdict.${finding.verdict}`)}
                        </Badge>
                        {finding.proposedByAi ? (
                          <Badge variant="proposal" data-testid={`playbook-ai-badge-${finding.ruleId}`}>
                            {t('proposedBadge')}
                          </Badge>
                        ) : null}
                        {finding.overriddenAt ? (
                          <Badge variant="outline" data-testid={`playbook-overridden-badge-${finding.ruleId}`}>
                            {t('overriddenBadge')}
                          </Badge>
                        ) : null}
                      </div>
                    </div>

                    <p className="text-muted-foreground">{finding.rationale}</p>

                    {finding.quoteExcerpt ? (
                      <div className="space-y-1.5 rounded border bg-background p-2">
                        <div className="flex items-center justify-between gap-2">
                          <blockquote className="min-w-0 break-words italic text-muted-foreground line-clamp-4">
                            &ldquo;{finding.quoteExcerpt}&rdquo;
                          </blockquote>
                          {finding.pageNumber !== null ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 shrink-0"
                              onClick={() => {
                                if (finding.pageNumber !== null) {
                                  onJumpToPage(finding.pageNumber);
                                }
                              }}
                              data-testid={`playbook-jump-page-${finding.ruleId}`}
                            >
                              {t('jumpToPageButton', { page: String(finding.pageNumber) })}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {finding.suggestedRedline ? (
                      <div className="space-y-1.5 rounded border bg-background p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {t('suggestedRedlineLabel')}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11"
                            onClick={() => {
                              if (finding.suggestedRedline) {
                                void handleCopyRedline(finding.suggestedRedline);
                              }
                            }}
                            data-testid={`playbook-copy-redline-${finding.ruleId}`}
                          >
                            {t('copyRedlineButton')}
                          </Button>
                        </div>
                        <p className="whitespace-pre-line text-muted-foreground select-all">
                          {finding.suggestedRedline}
                        </p>
                      </div>
                    ) : null}

                    {finding.manualNote && !canEdit ? (
                      <p className="text-muted-foreground">
                        {t('manualNoteLabel')}: {finding.manualNote}
                      </p>
                    ) : null}

                    {canEdit ? (
                      <div className="grid gap-2 border-t pt-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label htmlFor={selectId} className="text-xs">
                            {t('overrideLabel')}
                          </Label>
                          <NativeSelect
                            id={selectId}
                            className="min-h-11 w-full [&_select]:min-h-11"
                            value={draft.verdict}
                            onChange={(e) => {
                              const nextVerdict = e.target.value as SignPlaybookVerdictContract;
                              setOverrideDrafts((prev) => {
                                const existing = prev[finding.ruleId];
                                return {
                                  ...prev,
                                  [finding.ruleId]: {
                                    checkRevision: existing?.checkRevision ?? check.revision,
                                    verdict: nextVerdict,
                                    note: existing?.note ?? (finding.manualNote ?? ''),
                                  },
                                };
                              });
                            }}
                            data-testid={`playbook-override-select-${finding.ruleId}`}
                          >
                            <NativeSelectOption value="pass">{t('verdict.pass')}</NativeSelectOption>
                            <NativeSelectOption value="warn">{t('verdict.warn')}</NativeSelectOption>
                            <NativeSelectOption value="fail">{t('verdict.fail')}</NativeSelectOption>
                            <NativeSelectOption value="unknown">{t('verdict.unknown')}</NativeSelectOption>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1 sm:col-span-2">
                          <Label htmlFor={noteId} className="text-xs">
                            {t('manualNoteLabel')}
                          </Label>
                          <div className="flex items-center gap-2">
                            <Input
                              id={noteId}
                              className="min-h-11 flex-1"
                              maxLength={500}
                              value={draft.note}
                              placeholder={t('manualNotePlaceholder')}
                              onChange={(e) => {
                                const nextNote = e.target.value;
                                setOverrideDrafts((prev) => {
                                  const existing = prev[finding.ruleId];
                                  return {
                                    ...prev,
                                    [finding.ruleId]: {
                                      checkRevision: existing?.checkRevision ?? check.revision,
                                      verdict: existing?.verdict ?? finding.verdict,
                                      note: nextNote,
                                    },
                                  };
                                });
                              }}
                              data-testid={`playbook-override-note-${finding.ruleId}`}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 shrink-0"
                              disabled={overrideMutation.isPending}
                              onClick={() =>
                                overrideMutation.mutate({
                                  ruleId: finding.ruleId,
                                  checkRevision: draft.checkRevision,
                                  verdict: draft.verdict,
                                  manualNote: draft.note.trim() || null,
                                })
                              }
                              data-testid={`playbook-override-save-${finding.ruleId}`}
                            >
                              {t('saveOverrideButton')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {canEdit ? t('emptyCheckHint') : t('viewerReadOnlyHint')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
