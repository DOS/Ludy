// SPDX-License-Identifier: AGPL-3.0-only
// Code-assisted draft PII review dialog and quiet pre-publish nudge (#4001 Slice 3, D1-D7):
// deterministic detection only (works with AI off), recorder-only, never blocks publish,
// zero original text kept on confirm, and drops the recorder's private Vy results and draft translations.
import { useMutation, useQuery } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import {
  REDACTION_CANDIDATES_MAX,
  REDACTION_SELECTIONS_MAX,
  type ActionItemView,
  type Chapter,
  type MeetingResults,
  type RedactionCandidate,
  type RedactionKind,
  type RedactionSelection,
  type RedactionSurface,
  type TranscriptRedactCandidates,
  type TranscriptRedacted,
  type TranscriptSegment,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { ErrorText, Notice } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// Sensitive read that records an audit row: avoid refetching on window focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const EMPTY_CANDIDATES: readonly RedactionCandidate[] = [];

const SURFACE_ORDER: readonly RedactionSurface[] = [
  'meeting.title',
  'transcript_segment.text',
  'transcript_segment.speaker_label',
  'meeting_result.summary',
  'meeting_result.decision',
  'action_item.title',
  'action_item.who_drafted',
  'action_item.when_drafted',
  'meeting_chapter.title',
];

const SURFACE_KEYS = {
  'meeting.title': 'meetingTitle',
  'transcript_segment.text': 'transcriptText',
  'transcript_segment.speaker_label': 'transcriptSpeaker',
  'meeting_result.summary': 'resultSummary',
  'meeting_result.decision': 'resultDecision',
  'action_item.title': 'actionTitle',
  'action_item.who_drafted': 'actionWho',
  'action_item.when_drafted': 'actionWhen',
  'meeting_chapter.title': 'chapterTitle',
} as const satisfies Record<RedactionSurface, string>;

const RELOADABLE_ERROR_CODES = new Set([
  'REDACTION_STALE',
  'REDACTION_SPAN_MISMATCH',
  'REDACTION_DUPLICATE_SELECTION',
  'REDACTION_PUBLISHED_IMMUTABLE',
]);

export interface RedactionSurfaceSources {
  meetingTitle?: string | undefined;
  segments?: readonly TranscriptSegment[] | undefined;
  draftResult?: MeetingResults['draft'] | undefined;
  items?: readonly ActionItemView[] | undefined;
  draftChapters?: readonly Chapter[] | undefined;
}

export interface RedactionExcerpt {
  before: string;
  match: string;
  after: string;
}

export function candidateKey(c: Pick<RedactionCandidate, 'surface' | 'targetId' | 'decisionIndex' | 'startPos'>): string {
  return `${c.surface}:${c.targetId}:${c.decisionIndex ?? ''}:${c.startPos}`;
}

function candidateSelectionToken(c: Pick<RedactionCandidate, 'surface' | 'targetId' | 'decisionIndex' | 'startPos' | 'version'>): string {
  return `${candidateKey(c)}@${c.version}`;
}

export function formatCandidateCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

export function formatRedactionTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export function canQueryRedactCandidates(input: {
  isRecorder: boolean;
  hasAnyPublished: boolean;
  hasAnyDraftSurface: boolean;
}): boolean {
  return input.isRecorder && (!input.hasAnyPublished || input.hasAnyDraftSurface);
}

export function isRedactionReloadableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RELOADABLE_ERROR_CODES.has(code);
}

export function defaultSelectedKeys(candidates: readonly RedactionCandidate[]): Set<string> {
  return new Set(candidates.slice(0, REDACTION_SELECTIONS_MAX).map(candidateKey));
}

export function syncSelectedKeys(
  candidates: readonly RedactionCandidate[],
  previousSelected: ReadonlySet<string>,
  previousTokens: ReadonlyMap<string, string>,
): { selected: Set<string>; tokens: Map<string, string> } {
  const selected = new Set<string>();
  const tokens = new Map<string, string>();
  const pendingNewKeys: string[] = [];

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const token = candidateSelectionToken(candidate);
    tokens.set(key, token);
    if (previousTokens.get(key) === token) {
      if (previousSelected.has(key) && selected.size < REDACTION_SELECTIONS_MAX) {
        selected.add(key);
      }
    } else {
      pendingNewKeys.push(key);
    }
  }

  for (const key of pendingNewKeys) {
    if (selected.size >= REDACTION_SELECTIONS_MAX) break;
    selected.add(key);
  }

  return { selected, tokens };
}

export function toggleCandidateSelection(selected: ReadonlySet<string>, key: string, checked: boolean): Set<string> {
  const next = new Set(selected);
  if (checked) {
    if (next.size < REDACTION_SELECTIONS_MAX) next.add(key);
  } else {
    next.delete(key);
  }
  return next;
}

export function toRedactionSelections(
  candidates: readonly RedactionCandidate[],
  selected: ReadonlySet<string>,
): RedactionSelection[] {
  return candidates
    .filter((c) => selected.has(candidateKey(c)))
    .slice(0, REDACTION_SELECTIONS_MAX)
    .map((c) => ({
      surface: c.surface,
      targetId: c.targetId,
      decisionIndex: c.decisionIndex,
      kind: c.kind,
      startPos: c.startPos,
      version: c.version,
    }));
}

interface CandidateSourceLookup {
  meetingTitle: string | undefined;
  draftResult: MeetingResults['draft'] | undefined;
  getSegment: (id: string) => TranscriptSegment | undefined;
  getItem: (id: string) => ActionItemView | undefined;
  getChapter: (id: string) => Chapter | undefined;
}

function resolveFromLookup(
  candidate: RedactionCandidate,
  lookup: CandidateSourceLookup,
): { text?: string; speaker?: string } {
  switch (candidate.surface) {
    case 'meeting.title':
      return lookup.meetingTitle !== undefined ? { text: lookup.meetingTitle } : {};
    case 'transcript_segment.text': {
      const seg = lookup.getSegment(candidate.targetId);
      return seg ? { text: seg.text, speaker: seg.speakerLabel } : {};
    }
    case 'transcript_segment.speaker_label': {
      const seg = lookup.getSegment(candidate.targetId);
      return seg ? { text: seg.speakerLabel } : {};
    }
    case 'meeting_result.summary':
      return lookup.draftResult && lookup.draftResult.id === candidate.targetId ? { text: lookup.draftResult.summary } : {};
    case 'meeting_result.decision': {
      if (!lookup.draftResult || lookup.draftResult.id !== candidate.targetId || candidate.decisionIndex === null) return {};
      const decision = lookup.draftResult.decisions[candidate.decisionIndex];
      return decision !== undefined ? { text: decision } : {};
    }
    case 'action_item.title': {
      const item = lookup.getItem(candidate.targetId);
      if (!item) return {};
      return item.who ? { text: item.title, speaker: item.who } : { text: item.title };
    }
    case 'action_item.who_drafted': {
      const item = lookup.getItem(candidate.targetId);
      return item ? { text: item.who } : {};
    }
    case 'action_item.when_drafted': {
      const item = lookup.getItem(candidate.targetId);
      if (!item) return {};
      return item.who ? { text: item.when, speaker: item.who } : { text: item.when };
    }
    case 'meeting_chapter.title': {
      const chap = lookup.getChapter(candidate.targetId);
      return chap ? { text: chap.title } : {};
    }
  }
}

export function resolveCandidateSource(
  candidate: RedactionCandidate,
  sources: RedactionSurfaceSources,
): { text?: string; speaker?: string } {
  return resolveFromLookup(candidate, {
    meetingTitle: sources.meetingTitle,
    draftResult: sources.draftResult,
    getSegment: (id) => sources.segments?.find((s) => s.id === id),
    getItem: (id) => sources.items?.find((i) => i.id === id),
    getChapter: (id) => sources.draftChapters?.find((c) => c.id === id),
  });
}

function buildExcerptFromChars(
  sourceText: string | undefined,
  startPos: number,
  endPos: number,
  matchText: string,
  radius: number,
  chars: readonly string[] | undefined,
): RedactionExcerpt {
  if (!sourceText || !chars) return { before: '', match: matchText, after: '' };
  const startIdx = startPos - 1;
  const endIdx = endPos - 1;
  if (startIdx >= 0 && endIdx <= chars.length && startIdx < endIdx && chars.slice(startIdx, endIdx).join('') === matchText) {
    const beforeStart = Math.max(0, startIdx - radius);
    const afterEnd = Math.min(chars.length, endIdx + radius);
    const before = `${beforeStart > 0 ? '...' : ''}${chars.slice(beforeStart, startIdx).join('')}`;
    const after = `${chars.slice(endIdx, afterEnd).join('')}${afterEnd < chars.length ? '...' : ''}`;
    return { before, match: matchText, after };
  }
  return { before: '', match: matchText, after: '' };
}

// Builds a bounded context excerpt around a 1-based Unicode code point span returned by ludy_kernel.text_detect.
export function buildCandidateExcerpt(
  sourceText: string | undefined,
  startPos: number,
  endPos: number,
  matchText: string,
  radius = 36,
): RedactionExcerpt {
  return buildExcerptFromChars(
    sourceText,
    startPos,
    endPos,
    matchText,
    radius,
    sourceText ? Array.from(sourceText) : undefined,
  );
}

export function useRedactCandidatesQuery(meetingId: string, enabled: boolean) {
  return useQuery({
    ...orpc.meetings.transcript.redactCandidates.queryOptions({ input: { meetingId } }),
    ...READ_ONCE,
    enabled,
  });
}

export function RedactionNudge({
  count,
  truncated,
  onOpen,
  testId,
  lastRedacted = null,
  showDone = false,
  doneRef,
}: {
  count: number;
  truncated: boolean;
  onOpen: () => void;
  testId: string;
  lastRedacted?: TranscriptRedacted | null;
  showDone?: boolean;
  doneRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations('meetings.redaction');
  const hasDone = Boolean(showDone && lastRedacted);
  if (count === 0 && !hasDone) return null;

  return (
    <div className="space-y-2">
      {hasDone && lastRedacted && (
        <div ref={doneRef} tabIndex={-1} className="outline-none" data-testid="redaction-done-status">
          <Notice>
            <div className="space-y-0.5 text-xs">
              <p className="font-medium">{t('doneSummary', { count: lastRedacted.redactedCount })}</p>
              {lastRedacted.droppedVyResults > 0 && <p>{t('doneVy', { count: lastRedacted.droppedVyResults })}</p>}
              {lastRedacted.cancelledVyRuns > 0 && <p>{t('doneVyCancelled', { count: lastRedacted.cancelledVyRuns })}</p>}
              {lastRedacted.droppedTranslations > 0 && <p>{t('doneTranslations', { count: lastRedacted.droppedTranslations })}</p>}
            </div>
          </Notice>
        </div>
      )}
      {count > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid={testId}>
          <div className="space-y-1">
            <p className="font-medium text-foreground">{t('nudgeTitle', { count: formatCandidateCount(count, truncated) })}</p>
            <p className="text-xs text-muted-foreground">{t('nudgeHint')}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onOpen} data-testid={`${testId}-open`}>
            {t('nudgeButton')}
          </Button>
        </div>
      )}
    </div>
  );
}

interface PreparedCandidate {
  key: string;
  candidate: RedactionCandidate;
  speaker: string | undefined;
  timeText: string | null;
  excerpt: RedactionExcerpt;
}

const CandidateRow = memo(function CandidateRow({
  entry,
  checked,
  disabled,
  onToggleKey,
}: {
  entry: PreparedCandidate;
  checked: boolean;
  disabled: boolean;
  onToggleKey: (key: string, checked: boolean) => void;
}) {
  const t = useTranslations('meetings.redaction');
  const { key, candidate, speaker, timeText, excerpt } = entry;
  const kindLabel = t(`kinds.${candidate.kind as RedactionKind}`);

  return (
    <li data-testid="redaction-candidate" data-surface={candidate.surface} data-kind={candidate.kind}>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onToggleKey(key, next === true)}
          aria-label={t('checkboxLabel', { kind: kindLabel, match: candidate.matchText })}
          className="mt-1 max-md:size-5"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{kindLabel}</Badge>
            {candidate.surface === 'meeting_result.decision' && candidate.decisionIndex !== null && (
              <span>{t('decisionLabel', { number: String(candidate.decisionIndex + 1) })}</span>
            )}
            {speaker && timeText !== null ? (
              <span>{t('speakerAt', { speaker, time: timeText })}</span>
            ) : speaker ? (
              <span>{speaker}</span>
            ) : timeText !== null ? (
              <span className="font-mono">{timeText}</span>
            ) : null}
          </div>
          <p className="break-words text-sm leading-relaxed text-foreground" data-testid="redaction-excerpt">
            {excerpt.before && <span className="text-muted-foreground">{excerpt.before}</span>}
            <mark className="rounded bg-warning/20 px-1 font-mono font-medium text-foreground">{excerpt.match}</mark>
            {excerpt.after && <span className="text-muted-foreground">{excerpt.after}</span>}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="redaction-mark">
            {t('markPrefix')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{candidate.mark}</code>
          </p>
        </div>
      </label>
    </li>
  );
});

export function RedactionReviewContent({
  data,
  isLoading,
  queryError,
  sources,
  selectedKeys,
  onToggleKey,
  onSelectAll,
  onClearAll,
  onRescan,
  onConfirm,
  onCancel,
  onReload,
  isSubmitting,
  submitError,
  rescanPending = false,
}: {
  data: TranscriptRedactCandidates | undefined;
  isLoading: boolean;
  queryError: unknown;
  sources: RedactionSurfaceSources;
  selectedKeys: ReadonlySet<string>;
  onToggleKey: (key: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onRescan: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onReload: () => void;
  isSubmitting: boolean;
  submitError: unknown;
  rescanPending?: boolean;
}) {
  const t = useTranslations('meetings.redaction');
  const common = useTranslations('common');
  const candidates = data?.candidates ?? EMPTY_CANDIDATES;
  const { grouped, preparedKeys } = useMemo(() => {
    const segmentsById = new Map((sources.segments ?? []).map((s) => [s.id, s]));
    const itemsById = new Map((sources.items ?? []).map((i) => [i.id, i]));
    const chaptersById = new Map((sources.draftChapters ?? []).map((c) => [c.id, c]));
    const lookup: CandidateSourceLookup = {
      meetingTitle: sources.meetingTitle,
      draftResult: sources.draftResult,
      getSegment: (id) => segmentsById.get(id),
      getItem: (id) => itemsById.get(id),
      getChapter: (id) => chaptersById.get(id),
    };
    const charsCache = new Map<string, readonly string[]>();
    const bySurface = new Map<RedactionSurface, PreparedCandidate[]>();
    const keys: string[] = [];

    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      const source = resolveFromLookup(candidate, lookup);
      let chars: readonly string[] | undefined;
      if (source.text) {
        chars = charsCache.get(source.text);
        if (!chars) {
          chars = Array.from(source.text);
          charsCache.set(source.text, chars);
        }
      }
      const entry: PreparedCandidate = {
        key,
        candidate,
        speaker: source.speaker,
        timeText: candidate.startSeconds !== null ? formatRedactionTimestamp(candidate.startSeconds) : null,
        excerpt: buildExcerptFromChars(source.text, candidate.startPos, candidate.endPos, candidate.matchText, 36, chars),
      };
      keys.push(key);
      const list = bySurface.get(candidate.surface);
      if (list) list.push(entry);
      else bySurface.set(candidate.surface, [entry]);
    }

    const groups = SURFACE_ORDER.flatMap((surface) => {
      const list = bySurface.get(surface);
      return list && list.length > 0 ? [{ surface, items: list }] : [];
    });

    return { grouped: groups, preparedKeys: keys };
  }, [candidates, sources.meetingTitle, sources.segments, sources.draftResult, sources.items, sources.draftChapters]);

  const selectedCount = useMemo(
    () => preparedKeys.reduce((acc, key) => (selectedKeys.has(key) ? acc + 1 : acc), 0),
    [preparedKeys, selectedKeys],
  );

  const activeError = submitError ?? queryError;
  const showReload = Boolean(queryError) || isRedactionReloadableError(submitError);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground" data-testid="redaction-disclosures">
        <p className="font-medium text-foreground">{t('disclosuresTitle')}</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>{t('disclosureNoUndo')}</li>
          <li>{t('disclosureDropsCopies')}</li>
          <li>{t('disclosureMedia')}</li>
          <li>{t('disclosureCodeOnly')}</li>
        </ul>
      </div>

      {data?.titleEditable === false && (
        <p className="text-xs text-muted-foreground" data-testid="redaction-title-locked">
          {t('titleLockedNotice')}
        </p>
      )}
      {data?.truncated && (
        <p className="text-xs text-muted-foreground" data-testid="redaction-truncated">
          {t('truncatedNotice', { max: String(REDACTION_CANDIDATES_MAX) })}
        </p>
      )}
      {candidates.length > REDACTION_SELECTIONS_MAX && (
        <p className="text-xs text-muted-foreground" data-testid="redaction-batch-cap">
          {t('batchCapNotice', { max: String(REDACTION_SELECTIONS_MAX) })}
        </p>
      )}

      {isLoading && !data ? (
        <p role="status" className="text-xs text-muted-foreground">
          {common('loading')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-2">
        <span className="text-xs text-muted-foreground" data-testid="redaction-selected-count">
          {t('selectedCount', { selected: String(selectedCount), total: String(candidates.length) })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={isSubmitting || candidates.length === 0} onClick={onSelectAll} data-testid="redaction-select-all">
            {t('selectAll')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={isSubmitting || selectedCount === 0} onClick={onClearAll} data-testid="redaction-clear-all">
            {t('clearAll')}
          </Button>
          <Button type="button" size="sm" variant="outline" loading={rescanPending} disabled={isSubmitting} onClick={onRescan} data-testid="redaction-rescan">
            {t('rescan')}
          </Button>
        </div>
      </div>

      {!isLoading && candidates.length === 0 && !activeError ? (
        <p className="py-4 text-center text-sm text-muted-foreground" data-testid="redaction-empty">
          {t('empty')}
        </p>
      ) : null}

      {grouped.length > 0 && (
        <div className="space-y-4">
          {grouped.map(({ surface, items }) => (
            <section key={surface} className="space-y-2" data-testid={`redaction-group-${surface}`}>
              <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>{t(`surfaces.${SURFACE_KEYS[surface]}`)}</span>
                <Badge variant="secondary">{items.length}</Badge>
              </h3>
              <ul className="space-y-2">
                {items.map((entry) => {
                  const checked = selectedKeys.has(entry.key);
                  const disabled = isSubmitting || (!checked && selectedCount >= REDACTION_SELECTIONS_MAX);
                  return (
                    <CandidateRow
                      key={entry.key}
                      entry={entry}
                      checked={checked}
                      disabled={disabled}
                      onToggleKey={onToggleKey}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {activeError ? (
        <div className="space-y-2" data-testid="redaction-error">
          <ErrorText>{errorMessage(activeError)}</ErrorText>
          {showReload && (
            <Button type="button" size="sm" variant="outline" loading={rescanPending} disabled={isSubmitting} onClick={onReload} data-testid="redaction-reload">
              {t('reloadPrompt')}
            </Button>
          )}
        </div>
      ) : null}

      <DialogFooter className="border-t border-border pt-3">
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={onCancel} data-testid="redaction-cancel">
          {common('cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={isSubmitting}
          disabled={isSubmitting || selectedCount === 0}
          onClick={onConfirm}
          data-testid="redaction-confirm"
        >
          {t('confirm', { count: String(selectedCount) })}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function DraftRedactionDialog({
  meetingId,
  open,
  onOpenChange,
  sources,
  enabled,
  onRedacted,
  doneRef,
}: {
  meetingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: RedactionSurfaceSources;
  enabled: boolean;
  onRedacted: (result: TranscriptRedacted) => void;
  doneRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations('meetings.redaction');
  const common = useTranslations('common');
  const candidatesQuery = useRedactCandidatesQuery(meetingId, enabled || open);

  const [selection, setSelection] = useState<{ selected: Set<string>; tokens: Map<string, string> }>(() => ({
    selected: new Set(),
    tokens: new Map(),
  }));
  const confirmedCloseRef = useRef(false);

  const candidates = candidatesQuery.data?.candidates ?? EMPTY_CANDIDATES;
  const candidateFingerprint = useMemo(
    () => candidates.map(candidateSelectionToken).join('|'),
    [candidates],
  );

  const redactMutation = useMutation({
    mutationFn: () =>
      orpc.meetings.transcript.redact.call({
        meetingId,
        confirmed: true,
        items: toRedactionSelections(candidates, selection.selected),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      confirmedCloseRef.current = true;
      onRedacted(result);
      onOpenChange(false);
    },
  });

  // Initialize cleanly on open and sync user toggles purely when candidates refetch (React StrictMode-safe).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (justOpened) {
      confirmedCloseRef.current = false;
      redactMutation.reset();
      setSelection(syncSelectedKeys(candidates, new Set(), new Map()));
      void candidatesQuery.refetch({ cancelRefetch: false });
      return;
    }
    setSelection((prev) => syncSelectedKeys(candidates, prev.selected, prev.tokens));
  }, [open, candidateFingerprint, candidatesQuery.dataUpdatedAt]);

  const handleToggleKey = useCallback((key: string, checked: boolean) => {
    setSelection((prev) => ({
      selected: toggleCandidateSelection(prev.selected, key, checked),
      tokens: prev.tokens,
    }));
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelection((prev) => ({
      selected: defaultSelectedKeys(candidates),
      tokens: prev.tokens,
    }));
  }, [candidates]);

  const handleClearAll = useCallback(() => {
    setSelection((prev) => ({
      selected: new Set(),
      tokens: prev.tokens,
    }));
  }, []);

  const handleRescan = () => {
    redactMutation.reset();
    void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
  };

  const handleReload = () => {
    redactMutation.reset();
    setSelection({ selected: new Set(), tokens: new Map() });
    void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!redactMutation.isPending) onOpenChange(next);
      }}
    >
      <DialogContent
        closeLabel={common('close')}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="redaction-dialog"
        finalFocus={() => (confirmedCloseRef.current ? (doneRef?.current ?? true) : true)}
      >
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDesc')}</DialogDescription>
        </DialogHeader>
        <RedactionReviewContent
          data={candidatesQuery.data}
          isLoading={candidatesQuery.isPending}
          queryError={candidatesQuery.error}
          sources={sources}
          selectedKeys={selection.selected}
          onToggleKey={handleToggleKey}
          onSelectAll={handleSelectAll}
          onClearAll={handleClearAll}
          onRescan={handleRescan}
          onConfirm={() => {
            if (!redactMutation.isPending && selection.selected.size > 0) redactMutation.mutate();
          }}
          onCancel={() => onOpenChange(false)}
          onReload={handleReload}
          isSubmitting={redactMutation.isPending}
          submitError={redactMutation.error}
          rescanPending={candidatesQuery.isFetching}
        />
      </DialogContent>
    </Dialog>
  );
}
