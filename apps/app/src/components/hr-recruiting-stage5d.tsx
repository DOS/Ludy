// SPDX-License-Identifier: AGPL-3.0-only
// Stage 5D HR recruiting UI panels (#4446):
// 1. CvIntakePanel: uploads PDF/DOCX CV via crove-extract sandbox into a tainted editable proposal draft.
// 2. FunnelAnalyticsSection: pure SQL recruiting funnel BI metrics & source breakdown (0 LLM cost).
// 3. EngageInvitePanel: slot-backed Vietnamese interview invite draft for Zalo OA / Facebook (human copy & manual send only).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  HR_ENGAGE_CHANNELS,
  type HrCandidateView,
  type HrCvExtractDraft,
  type HrEngageChannel,
  type HrInterviewerOption,
  type HrInviteDraftResult,
  type HrOpeningView,
  type HrRecruitingAnalyticsResult,
} from '@ludy/kernel-contract';
import { Alert } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Textarea } from '@ludy/ui/components/textarea';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, extractRecruitingCv, orpc } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'text-right tabular-nums';

function isForbiddenQueryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { status?: unknown; code?: unknown; data?: { code?: unknown } };
  return err.status === 403 || err.code === 'FORBIDDEN' || err.data?.code === 'FORBIDDEN';
}

export function CvIntakePanel({
  openings,
  defaultOpeningId,
  onDraftReady,
  onClose,
}: {
  openings: readonly HrOpeningView[];
  defaultOpeningId?: string;
  onDraftReady: (draft: HrCvExtractDraft) => void;
  onClose: () => void;
}) {
  const t = useTranslations('hrRecruiting');
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [openingId, setOpeningId] = useState(defaultOpeningId ?? '');
  const openOptions = openings.filter((o) => o.status === 'open');
  const extractAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      extractAbortRef.current?.abort();
      extractAbortRef.current = null;
    };
  }, []);

  const handleClose = () => {
    extractAbortRef.current?.abort();
    extractAbortRef.current = null;
    onClose();
  };

  const extract = useMutation({
    mutationFn: () => {
      if (!selectedFile) throw new Error('missing file');
      extractAbortRef.current?.abort();
      const controller = new AbortController();
      extractAbortRef.current = controller;
      return extractRecruitingCv(selectedFile, {
        ...(openingId ? { openingId } : {}),
        lang: locale,
        signal: controller.signal,
      });
    },
    onSettled: () => {
      extractAbortRef.current = null;
    },
  });

  return (
    <Card className="mb-6 block min-w-0 border-dashed border-proposal/70 p-4" data-testid="hr-cv-intake-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-medium text-foreground">{t('cvExtract.title')}</h2>
            <Badge variant="proposal">{t('cvExtract.proposalBadge')}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('cvExtract.subtitle')}</p>
        </div>
        <Button variant="ghost" size="sm" className="max-md:min-h-11" onClick={handleClose}>
          {t('close')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="hr-cv-file">{t('cvExtract.fileLabel')}</Label>
          <Input
            id="hr-cv-file"
            type="file"
            className="max-md:min-h-11"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={extract.isPending}
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            data-testid="hr-cv-file-input"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cv-opening">{t('cvExtract.openingLabel')}</Label>
          <NativeSelect
            id="hr-cv-opening"
            className="max-md:[&_select]:min-h-11"
            value={openingId}
            disabled={extract.isPending}
            onChange={(e) => setOpeningId(e.target.value)}
            data-testid="hr-cv-opening-select"
          >
            <NativeSelectOption value="">{t('fields.noOpening')}</NativeSelectOption>
            {openOptions.map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {extract.error && <ErrorText>{errorMessage(extract.error)}</ErrorText>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          className="max-md:min-h-11"
          loading={extract.isPending}
          disabled={!selectedFile || extract.isPending}
          onClick={() => extract.mutate(undefined, { onSuccess: (draft) => onDraftReady(draft) })}
          data-testid="hr-cv-extract-submit"
        >
          {extract.isPending ? t('cvExtract.extracting') : t('cvExtract.extractButton')}
        </Button>
        <Button variant="ghost" className="max-md:min-h-11" onClick={handleClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

export function FunnelAnalyticsSection({
  selectedOpeningId,
  analyticsOverride,
}: {
  selectedOpeningId?: string;
  analyticsOverride?: HrRecruitingAnalyticsResult;
}) {
  const t = useTranslations('hrRecruiting');
  const query = useQuery({
    ...orpc.hr.recruiting.analytics.queryOptions({
      input: selectedOpeningId ? { openingId: selectedOpeningId } : {},
    }),
    enabled: analyticsOverride === undefined,
    ...ONCE,
  });

  const data = analyticsOverride ?? query.data;

  if (analyticsOverride === undefined && query.error && isForbiddenQueryError(query.error)) {
    return null;
  }

  return (
    <section className="mb-6 min-w-0" data-testid="hr-recruiting-analytics">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-foreground">{t('analytics.title')}</h2>
            <Badge variant="outline">{t('analytics.zeroLlmBadge')}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t('analytics.subtitle')}</p>
        </div>
      </div>

      {analyticsOverride === undefined && query.isPending ? (
        <TableSkeleton columns={4} />
      ) : analyticsOverride === undefined && query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : !data ? null : (
        <div className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.totalCandidates')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-total">
                {data.totalCandidates}
              </p>
            </Card>
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.activeCandidates')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-active">
                {data.activeCandidates}
              </p>
            </Card>
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.hiredCount')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-hired">
                {data.hiredCount}
              </p>
            </Card>
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.avgTimeToHire')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-avg-days">
                {data.timeToHire.avgDays !== null ? t('analytics.daysUnit', { days: data.timeToHire.avgDays }) : t('analytics.noData')}
              </p>
            </Card>
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.medianTimeToHire')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-median-days">
                {data.timeToHire.medianDays !== null ? t('analytics.daysUnit', { days: data.timeToHire.medianDays }) : t('analytics.noData')}
              </p>
            </Card>
            <Card className="min-w-0 p-3">
              <p className="text-xs text-muted-foreground">{t('analytics.erasedExcluded')}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="hr-analytics-erased">
                {data.erasedExcludedCount}
              </p>
            </Card>
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-medium text-foreground">{t('analytics.funnelTitle')}</h3>
              <DataTable
                head={[
                  t('analytics.fromStage'),
                  t('analytics.toStage'),
                  t('analytics.enteredCount'),
                  t('analytics.reachedCount'),
                  t('analytics.conversionPct'),
                  t('analytics.dropOffPct'),
                ]}
                numeric={[2, 3, 4, 5]}
              >
                {data.funnel.map((step) => (
                  <TableRow key={`${step.fromStage}-${step.toStage}`} data-testid="hr-analytics-funnel-row">
                    <TableCell>{t(`stages.${step.fromStage}`)}</TableCell>
                    <TableCell>{t(`stages.${step.toStage}`)}</TableCell>
                    <TableCell className={NUM}>{step.enteredFromCount}</TableCell>
                    <TableCell className={NUM}>{step.reachedToCount}</TableCell>
                    <TableCell className={NUM}>{step.conversionPct !== null ? `${step.conversionPct}%` : t('analytics.noData')}</TableCell>
                    <TableCell className={NUM}>{step.dropOffPct !== null ? `${step.dropOffPct}%` : t('analytics.noData')}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>

            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-medium text-foreground">{t('analytics.sourcesTitle')}</h3>
              <DataTable
                head={[
                  t('analytics.sourceName'),
                  t('analytics.totalCandidates'),
                  t('analytics.hiredCount'),
                  t('analytics.hireRatePct'),
                  t('analytics.avgDaysCol'),
                ]}
                numeric={[1, 2, 3, 4]}
              >
                {data.sources.map((src) => (
                  <TableRow key={src.source} data-testid="hr-analytics-source-row">
                    <TableCell className="font-medium">{t(`sources.${src.source}`)}</TableCell>
                    <TableCell className={NUM}>{src.totalCount}</TableCell>
                    <TableCell className={NUM}>{src.hiredCount}</TableCell>
                    <TableCell className={NUM}>{src.hireRatePct !== null ? `${src.hireRatePct}%` : t('analytics.noData')}</TableCell>
                    <TableCell className={NUM}>{src.avgTimeToHireDays !== null ? t('analytics.daysUnit', { days: src.avgTimeToHireDays }) : t('analytics.noData')}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type InviteDraftRequestVars = {
  candidateId: string;
  channel: HrEngageChannel;
  interviewerUserId: string;
  lang: 'vi' | 'en';
  selectionKey: string;
  requestSeq: number;
};

export function buildInviteSelectionKey(
  contextKey: string,
  channel: HrEngageChannel,
  interviewerUserId: string,
  locale: 'vi' | 'en',
): string {
  return `${contextKey}|${channel}|${interviewerUserId}|${locale}`;
}

function resetInviteStateOnSelectionChange<K extends string, V, T>(
  currentValue: V,
  nextValue: V,
  fieldKey: K,
  state: { draft: T | null; messageText: string; copied: boolean },
): { changed: boolean; draft: T | null; messageText: string; copied: boolean } & Record<K, V> {
  if (nextValue === currentValue) {
    return { changed: false, ...state, [fieldKey]: currentValue } as { changed: boolean; draft: T | null; messageText: string; copied: boolean } & Record<K, V>;
  }
  return {
    changed: true,
    [fieldKey]: nextValue,
    draft: null,
    messageText: '',
    copied: false,
  } as { changed: boolean; draft: T | null; messageText: string; copied: boolean } & Record<K, V>;
}

export function applyInviteChannelChange<T>(
  state: { channel: HrEngageChannel; draft: T | null; messageText: string; copied: boolean },
  nextChannel: HrEngageChannel,
): { changed: boolean; channel: HrEngageChannel; draft: T | null; messageText: string; copied: boolean } {
  return resetInviteStateOnSelectionChange(state.channel, nextChannel, 'channel', state);
}

export function applyInviteInterviewerChange<T>(
  state: { interviewerUserId: string; draft: T | null; messageText: string; copied: boolean },
  nextInterviewerUserId: string,
): { changed: boolean; interviewerUserId: string; draft: T | null; messageText: string; copied: boolean } {
  return resetInviteStateOnSelectionChange(state.interviewerUserId, nextInterviewerUserId, 'interviewerUserId', state);
}

export function shouldAcceptInviteDraftResponse(
  current: { mounted: boolean; selectionKey: string; requestSeq: number },
  request: { selectionKey: string; requestSeq: number },
): boolean {
  return current.mounted && current.selectionKey === request.selectionKey && current.requestSeq === request.requestSeq;
}

export function EngageInvitePanel({
  candidate,
  initialDraft,
}: {
  candidate: HrCandidateView;
  initialDraft?: HrInviteDraftResult;
}) {
  const t = useTranslations('hrRecruiting');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const defaultChannel: HrEngageChannel = candidate.source === 'facebook' ? 'facebook' : 'zalo_oa';
  const contextKey = [
    candidate.id,
    candidate.displayName,
    candidate.openingId ?? '',
    candidate.openingTitle ?? '',
    candidate.interviewerUserId ?? '',
    candidate.source,
  ].join('|');
  const [lastContextKey, setLastContextKey] = useState(contextKey);
  const [channel, setChannel] = useState<HrEngageChannel>(initialDraft?.channel ?? defaultChannel);
  const [interviewerUserId, setInterviewerUserId] = useState<string>(candidate.interviewerUserId ?? '');
  const [draft, setDraft] = useState<HrInviteDraftResult | null>(initialDraft ?? null);
  const [messageText, setMessageText] = useState(initialDraft?.message ?? '');
  const [copied, setCopied] = useState(false);

  if (lastContextKey !== contextKey) {
    setLastContextKey(contextKey);
    setChannel(defaultChannel);
    setInterviewerUserId(candidate.interviewerUserId ?? '');
    setDraft(null);
    setMessageText('');
    setCopied(false);
  }

  const currentSelectionKey = buildInviteSelectionKey(contextKey, channel, interviewerUserId, locale);
  const selectionKeyRef = useRef(currentSelectionKey);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    selectionKeyRef.current = currentSelectionKey;
  }, [currentSelectionKey]);

  useEffect(() => {
    requestSeqRef.current += 1;
  }, [contextKey]);

  const interviewersQuery = useQuery({
    ...orpc.hr.recruiting.interviewers.list.queryOptions(),
    ...ONCE,
  });
  const interviewers: HrInterviewerOption[] = interviewersQuery.data ?? [];

  const generate = useMutation({
    mutationFn: (vars: InviteDraftRequestVars) =>
      client.hr.recruiting.inviteDraft({
        candidateId: vars.candidateId,
        channel: vars.channel,
        ...(vars.interviewerUserId ? { interviewerUserId: vars.interviewerUserId } : {}),
        lang: vars.lang,
      }),
  });

  const handleChannelChange = (nextChannel: HrEngageChannel) => {
    const next = applyInviteChannelChange({ channel, draft, messageText, copied }, nextChannel);
    if (!next.changed) return;
    setChannel(next.channel);
    setDraft(next.draft);
    setMessageText(next.messageText);
    setCopied(next.copied);
    generate.reset();
    requestSeqRef.current += 1;
    selectionKeyRef.current = buildInviteSelectionKey(contextKey, nextChannel, interviewerUserId, locale);
  };

  const handleInterviewerChange = (nextInterviewerId: string) => {
    const next = applyInviteInterviewerChange(
      { interviewerUserId, draft, messageText, copied },
      nextInterviewerId,
    );
    if (!next.changed) return;
    setInterviewerUserId(next.interviewerUserId);
    setDraft(next.draft);
    setMessageText(next.messageText);
    setCopied(next.copied);
    generate.reset();
    requestSeqRef.current += 1;
    selectionKeyRef.current = buildInviteSelectionKey(contextKey, channel, nextInterviewerId, locale);
  };

  const handleGenerate = () => {
    const nextSeq = requestSeqRef.current + 1;
    requestSeqRef.current = nextSeq;
    selectionKeyRef.current = currentSelectionKey;
    const vars: InviteDraftRequestVars = {
      candidateId: candidate.id,
      channel,
      interviewerUserId,
      lang: locale,
      selectionKey: currentSelectionKey,
      requestSeq: nextSeq,
    };
    generate.mutate(vars, {
      onSuccess: (res) => {
        if (
          !shouldAcceptInviteDraftResponse(
            {
              mounted: mountedRef.current,
              selectionKey: selectionKeyRef.current,
              requestSeq: requestSeqRef.current,
            },
            vars,
          )
        ) {
          return;
        }
        setDraft(res);
        setMessageText(res.message);
        setCopied(false);
      },
    });
  };

  const handleCopy = async () => {
    if (!messageText) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="mt-4 min-w-0 rounded-md border border-dashed border-proposal/60 bg-proposal/5 p-3" data-testid="hr-engage-invite-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{t('engageInvite.title')}</h3>
            <Badge variant="proposal">{t('cvExtract.proposalBadge')}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('engageInvite.subtitle')}</p>
        </div>
      </div>

      <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="hr-engage-channel-select">{t('engageInvite.channelLabel')}</Label>
          <NativeSelect
            id="hr-engage-channel-select"
            className="min-w-0 max-w-full max-md:[&_select]:min-h-11"
            value={channel}
            onChange={(e) => handleChannelChange(e.target.value as HrEngageChannel)}
            data-testid="hr-engage-channel"
          >
            {HR_ENGAGE_CHANNELS.map((ch) => (
              <NativeSelectOption key={ch} value={ch}>
                {t(`engageInvite.channels.${ch}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="hr-engage-interviewer">{t('interview.interviewer')}</Label>
          <NativeSelect
            id="hr-engage-interviewer"
            className="min-w-0 max-w-full max-md:[&_select]:min-h-11"
            value={interviewerUserId}
            onChange={(e) => handleInterviewerChange(e.target.value)}
            data-testid="hr-engage-interviewer"
          >
            <NativeSelectOption value="">{t('interview.defaultSelfInterviewer')}</NativeSelectOption>
            {interviewers.map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex items-end">
          <Button
            size="sm"
            variant="outline"
            className="max-md:min-h-11"
            loading={generate.isPending}
            onClick={handleGenerate}
            data-testid="hr-engage-draft-run"
          >
            {t('engageInvite.generate')}
          </Button>
        </div>
      </div>

      {generate.error && <ErrorText>{errorMessage(generate.error)}</ErrorText>}

      {draft && (
        <div className="mt-3 space-y-2">
          <Alert>{t('engageInvite.manualNotice')}</Alert>
          {draft.slots.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('engageInvite.availableSlots')}: </span>
              {draft.slots.map((s) => f.dateTime(s.startIso)).join(' · ')}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('engageInvite.noSlots')}</p>
          )}
          <div className="space-y-1">
            <Label htmlFor="hr-engage-message-box">{t('engageInvite.messageLabel')}</Label>
            <Textarea
              id="hr-engage-message-box"
              rows={6}
              value={messageText}
              onChange={(e) => {
                setMessageText(e.target.value);
                setCopied(false);
              }}
              data-testid="hr-engage-draft-message"
            />
          </div>
          <Button size="sm" variant="secondary" className="max-md:min-h-11" onClick={() => void handleCopy()} data-testid="hr-engage-draft-copy">
            {copied ? t('engageInvite.copied') : t('engageInvite.copy')}
          </Button>
          <span className="sr-only" aria-live="polite">
            {copied ? t('engageInvite.copied') : ''}
          </span>
        </div>
      )}
    </section>
  );
}
