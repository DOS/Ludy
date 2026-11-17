// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy panel inside Notes (N8, #1677, ADR-0037, ADR-0049):
// lets readers/authors ask Vy to summarize the current note and suggest personal to-dos,
// then explicitly apply a summary (author only) or save editable personal to-dos.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { Textarea } from '@crove/ui/components/textarea';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  TODO_DETAILS_MAX,
  TODO_TITLE_MAX,
  type Note,
  type NoteAcceptSummaryMode,
  type NoteSuggestTodosResult,
  type NoteSummarizeResult,
  type NoteVyResults,
  type NoteVyStatus,
  type NoteWritten,
} from '@crove/kernel-contract';
import { useFormat } from '../i18n/provider.tsx';
import { clientForOrg, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { toast } from '../lib/toast.ts';
import { DateInput } from './date-input.tsx';
import { refreshNotes } from './notes-panel.tsx';
import { TimeInput } from './time-input.tsx';
import { ErrorText } from './ui.tsx';

export type NoteVyBlockedReason = 'off' | 'noModel' | 'forbidden' | 'paused' | 'budget';

export const NOTE_VY_ERROR_KEYS = [
  'NOTE_EMPTY',
  'NOTE_TOO_LONG',
  'NOTE_NOT_FOUND',
  'NOTE_IN_TRASH',
  'NOTE_SUMMARY_UNPARSABLE',
  'NOTE_TODO_SUGGEST_UNPARSABLE',
  'NOTE_AI_TIMEOUT',
  'NOTE_AI_FAILED',
  'NOTE_AUTHOR_ONLY',
  'NOTE_REVISION_CONFLICT',
  'AI_STOPPED',
  'AI_BUDGET_EXHAUSTED',
  'AI_BUSY',
  'VY_RUN_ALREADY_ACCEPTED',
  'VY_NOT_ALLOWED',
  'AI_OFF',
  'AI_PAUSED',
  'UNSAVED_NOTE',
  'default',
] as const;
export type NoteVyErrorKey = (typeof NOTE_VY_ERROR_KEYS)[number];

const KNOWN_ERROR_KEYS = new Set<string>(NOTE_VY_ERROR_KEYS);

export interface EditableTodoSuggestion {
  selected: boolean;
  title: string;
  details: string;
  dueOn: string;
  dueTime: string;
  reminder: 'auto' | 'off';
}

export function noteVyBlocked(
  status: NoteVyStatus | undefined,
  meter: { aiOn: boolean } | undefined,
): NoteVyBlockedReason | null {
  if (status && !status.available && status.reason) {
    return status.reason;
  }
  if (meter && !meter.aiOn) return 'noModel';
  return null;
}

export function noteVyErrorKey(code: string | null | undefined): NoteVyErrorKey {
  if (!code) return 'default';
  if (code === 'VY_RUN_BUSY') return 'AI_BUSY';
  return KNOWN_ERROR_KEYS.has(code) ? (code as NoteVyErrorKey) : 'default';
}

export function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === 'string' ? data.code : null;
}

export function toEditableTodoSuggestions(
  items: readonly NoteSuggestTodosResult['suggestions'][number][],
): EditableTodoSuggestion[] {
  return items.map((item) => ({
    selected: true,
    title: item.title,
    details: item.details,
    dueOn: item.dueOn ?? '',
    dueTime: '',
    reminder: 'auto',
  }));
}

export function bulletsToText(bullets: readonly string[]): string {
  return bullets.join('\n');
}

export function textToBullets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line.length > 0);
}

export function NoteVyPanel({
  slug,
  note,
  canWrite = true,
  currentRevision,
  beforeRun,
  saveBlocked,
  onSummaryApplyingChange,
  onSummaryAccepted,
}: {
  slug: string;
  note: Pick<Note, 'id' | 'title' | 'body' | 'mine' | 'deletedAt' | 'revision'>;
  canWrite?: boolean | undefined;
  currentRevision?: (() => number) | undefined;
  beforeRun?: (() => Promise<boolean>) | undefined;
  saveBlocked?: boolean | undefined;
  onSummaryApplyingChange?: ((applying: boolean) => void) | undefined;
  onSummaryAccepted?: ((written: NoteWritten) => Promise<void>) | undefined;
}) {
  const t = useTranslations('notes.vy');
  const locale = useLocale();
  const f = useFormat();
  const api = clientForOrg(slug);

  const status = useQuery({ ...orpc.notes.vyStatus.queryOptions({ input: {} }), staleTime: 30_000 });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'notes' } }), staleTime: 30_000 });
  const blocked = noteVyBlocked(status.data, meter.data);

  const stored = useQuery<NoteVyResults>({
    ...orpc.notes.vyResults.queryOptions({ input: { noteId: note.id } }),
    enabled: note.deletedAt === null && status.isSuccess && blocked !== 'forbidden',
    staleTime: 30_000,
  });

  const [freshSummary, setFreshSummary] = useState<NoteSummarizeResult | null>(null);
  const [freshTodos, setFreshTodos] = useState<NoteSuggestTodosResult | null>(null);
  const [dismissedSummaryRunId, setDismissedSummaryRunId] = useState<string | null>(null);
  const [dismissedTodosRunId, setDismissedTodosRunId] = useState<string | null>(null);

  const activeSummary = blocked === 'forbidden' ? null : (freshSummary ?? stored.data?.summary ?? null);
  const visibleSummary =
    activeSummary && activeSummary.state === 'ready' && activeSummary.runId !== dismissedSummaryRunId ? activeSummary : null;

  const activeTodos = blocked === 'forbidden' ? null : (freshTodos ?? stored.data?.todoSuggest ?? null);
  const visibleTodos =
    activeTodos && activeTodos.state === 'ready' && activeTodos.runId !== dismissedTodosRunId ? activeTodos : null;

  const [errorCode, setErrorCode] = useState<NoteVyErrorKey | null>(null);

  const flushBeforeRun = async (): Promise<boolean> => {
    if (!beforeRun) return true;
    const saved = await beforeRun();
    if (!saved) {
      setErrorCode('UNSAVED_NOTE');
      return false;
    }
    return true;
  };

  const summarize = useMutation({
    mutationFn: async () => {
      setErrorCode(null);
      const ok = await flushBeforeRun();
      if (!ok) return null;
      return api.notes.summarize({
        noteId: note.id,
        language: locale.startsWith('en') ? 'en' : 'vi',
      });
    },
    onSuccess: (res) => {
      if (!res) return;
      if (res.state === 'failed') {
        setErrorCode(noteVyErrorKey(res.errorCode));
        return;
      }
      setDismissedSummaryRunId(null);
      setFreshSummary(res);
      void queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
    },
    onError: (err) => {
      setErrorCode(noteVyErrorKey(errorCodeOf(err)));
    },
  });

  const suggestTodos = useMutation({
    mutationFn: async () => {
      setErrorCode(null);
      const ok = await flushBeforeRun();
      if (!ok) return null;
      return api.notes.suggestTodos({
        noteId: note.id,
        timeZone: browserTimeZone(),
        language: locale.startsWith('en') ? 'en' : 'vi',
      });
    },
    onSuccess: (res) => {
      if (!res) return;
      if (res.state === 'failed') {
        setErrorCode(noteVyErrorKey(res.errorCode));
        return;
      }
      setDismissedTodosRunId(null);
      setFreshTodos(res);
      void queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
    },
    onError: (err) => {
      setErrorCode(noteVyErrorKey(errorCodeOf(err)));
    },
  });

  const acceptSummary = useMutation({
    mutationFn: async (draft: { summaryText: string; bulletsText: string; mode: NoteAcceptSummaryMode; runId: string }) => {
      setErrorCode(null);
      const summary = draft.summaryText.trim();
      const bullets = textToBullets(draft.bulletsText);
      if (!summary && bullets.length === 0) return null;
      onSummaryApplyingChange?.(true);
      try {
        const ok = await flushBeforeRun();
        if (!ok) return null;
        const revision = currentRevision ? currentRevision() : note.revision;
        const written = await api.notes.acceptSummary({
          noteId: note.id,
          revision,
          mode: draft.mode,
          summary: summary || bullets[0]!,
          bullets: summary ? bullets : bullets.slice(1),
          runId: draft.runId,
        });
        if (onSummaryAccepted) await onSummaryAccepted(written);
        return { runId: draft.runId, note: written };
      } finally {
        onSummaryApplyingChange?.(false);
      }
    },
    onSuccess: async (res) => {
      if (!res) return;
      setDismissedSummaryRunId(res.runId);
      setFreshSummary(null);
      toast(t('summaryAppliedToast'));
      await queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
    },
    onError: (err) => {
      const code = errorCodeOf(err);
      if (code === 'VY_RUN_ALREADY_ACCEPTED') {
        setFreshSummary(null);
        void queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
      }
      setErrorCode(noteVyErrorKey(code));
    },
  });

  const acceptTodos = useMutation({
    mutationFn: async (draft: { rows: EditableTodoSuggestion[]; runId: string }) => {
      const picked = draft.rows.filter((row) => row.selected);
      if (picked.length === 0) return null;
      if (picked.some((row) => row.title.trim().length === 0)) {
        throw new Error('EMPTY_TODO_TITLE');
      }
      setErrorCode(null);
      const ok = await flushBeforeRun();
      if (!ok) return null;
      const noteRevision = currentRevision ? currentRevision() : note.revision;
      const timeZone = browserTimeZone();
      return {
        runId: draft.runId,
        result: await api.notes.todos.acceptSuggestions({
          noteId: note.id,
          noteRevision,
          runId: draft.runId,
          items: picked.map((row) => {
            const dueOn = row.dueOn.trim() === '' ? null : row.dueOn.trim();
            const dueTime = dueOn && row.dueTime.trim() !== '' ? row.dueTime.trim() : null;
            return {
              title: row.title.trim(),
              details: row.details.trim(),
              dueOn,
              dueTime,
              timeZone,
              reminder: dueOn ? row.reminder : 'off',
            };
          }),
        }),
      };
    },
    onSuccess: async (res) => {
      if (!res) return;
      setDismissedTodosRunId(res.runId);
      setFreshTodos(null);
      toast(t('todosSavedToast', { created: res.result.created }));
      await refreshNotes();
      await queryClient.invalidateQueries({ queryKey: orpc.notes.todos.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'EMPTY_TODO_TITLE') {
        return;
      }
      const code = errorCodeOf(err);
      if (code === 'VY_RUN_ALREADY_ACCEPTED') {
        setFreshTodos(null);
        void queryClient.invalidateQueries({ queryKey: orpc.notes.vyResults.key({ input: { noteId: note.id } }) });
      }
      setErrorCode(noteVyErrorKey(code));
    },
  });

  if (note.deletedAt !== null) return null;

  const hasContent = note.body.trim().length > 0 || note.title.trim().length > 0;
  const resetOn = status.data?.resetOn;
  const blockedMessage =
    blocked === 'budget'
      ? resetOn
        ? t('blocked.budget', { resetOn: f.date(resetOn) })
        : t('blocked.budgetNoDate')
      : blocked
        ? t(`blocked.${blocked}`)
        : null;

  const statusReady = status.isSuccess && meter.isSuccess;
  const actionsDisabled =
    !statusReady ||
    blocked !== null ||
    !hasContent ||
    Boolean(saveBlocked) ||
    summarize.isPending ||
    suggestTodos.isPending ||
    acceptSummary.isPending ||
    acceptTodos.isPending;

  const summaryStale = visibleSummary ? visibleSummary.stale || visibleSummary.noteRevision !== note.revision : false;
  const todosStale = visibleTodos ? visibleTodos.stale || visibleTodos.noteRevision !== note.revision : false;

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-3"
      aria-label={t('title')}
      data-testid="note-vy-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <NavIcon name="appAi" className="text-proposal" />
          <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        </div>
        <Badge variant="proposal" data-testid="note-vy-ai-badge">
          {t('aiBadge')}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>

      {blockedMessage && (
        <p className="text-xs text-muted-foreground" data-testid="note-vy-blocked">
          {blockedMessage}
        </p>
      )}
      {!blockedMessage && statusReady && !hasContent && (
        <p className="text-xs text-muted-foreground" data-testid="note-vy-empty-note">
          {t('emptyNoteHint')}
        </p>
      )}

      {blocked !== 'forbidden' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={summarize.isPending}
            disabled={actionsDisabled}
            onClick={() => summarize.mutate()}
            data-testid="note-vy-summarize-btn"
          >
            {summarize.isPending ? t('summarizing') : t('summarizeBtn')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={suggestTodos.isPending}
            disabled={actionsDisabled}
            onClick={() => suggestTodos.mutate()}
            data-testid="note-vy-suggest-todos-btn"
          >
            {suggestTodos.isPending ? t('suggestingTodos') : t('suggestTodosBtn')}
          </Button>
        </div>
      )}

      {errorCode && (
        <ErrorText data-testid="note-vy-error">{t(`errors.${errorCode}`)}</ErrorText>
      )}

      {visibleSummary && (
        <NoteSummaryDraftBox
          key={visibleSummary.runId}
          note={note}
          canApply={note.mine && canWrite}
          visibleSummary={visibleSummary}
          stale={summaryStale}
          saveBlocked={Boolean(saveBlocked)}
          isPending={acceptSummary.isPending}
          onDismiss={() => setDismissedSummaryRunId(visibleSummary.runId)}
          onAccept={(draft) => acceptSummary.mutate({ ...draft, runId: visibleSummary.runId })}
        />
      )}

      {visibleTodos && (
        <NoteTodosDraftBox
          key={visibleTodos.runId}
          canSave={canWrite}
          visibleTodos={visibleTodos}
          stale={todosStale}
          saveBlocked={Boolean(saveBlocked)}
          isPending={acceptTodos.isPending}
          onDismiss={() => setDismissedTodosRunId(visibleTodos.runId)}
          onAccept={(rows) => acceptTodos.mutate({ rows, runId: visibleTodos.runId })}
        />
      )}
    </section>
  );
}

function NoteSummaryDraftBox({
  note,
  canApply,
  visibleSummary,
  stale,
  saveBlocked,
  isPending,
  onDismiss,
  onAccept,
}: {
  note: Pick<Note, 'id'>;
  canApply: boolean;
  visibleSummary: NoteSummarizeResult;
  stale: boolean;
  saveBlocked: boolean;
  isPending: boolean;
  onDismiss: () => void;
  onAccept: (draft: { summaryText: string; bulletsText: string; mode: NoteAcceptSummaryMode }) => void;
}) {
  const t = useTranslations('notes.vy');
  const [summaryDraft, setSummaryDraft] = useState(visibleSummary.summary);
  const [bulletsDraft, setBulletsDraft] = useState(() => bulletsToText(visibleSummary.bullets));
  const [acceptMode, setAcceptMode] = useState<NoteAcceptSummaryMode>('append');
  const summaryHasContent = summaryDraft.trim().length > 0 || textToBullets(bulletsDraft).length > 0;

  return (
    <div
      className="space-y-2.5 rounded-lg border border-dashed border-proposal/60 bg-background p-3"
      data-testid="note-vy-summary-draft"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground">{t('summaryHeading')}</span>
          <Badge variant="proposal">{t('proposalMark')}</Badge>
        </div>
        <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={onDismiss}>
          {t('dismiss')}
        </Button>
      </div>
      {stale && (
        <p className="text-xs text-warning" data-testid="note-vy-summary-stale">
          {t('staleNotice')}
        </p>
      )}
      {visibleSummary.dropped > 0 && (
        <p className="text-xs text-muted-foreground">{t('droppedNotice', { count: visibleSummary.dropped })}</p>
      )}

      {canApply ? (
        <>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('summaryEditLabel')}</span>
            <Textarea
              rows={3}
              maxLength={4000}
              disabled={isPending}
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              className="mt-1"
              data-testid="note-vy-summary-input"
            />
          </label>
          <Textarea
            rows={3}
            maxLength={2000}
            disabled={isPending}
            value={bulletsDraft}
            onChange={(e) => setBulletsDraft(e.target.value)}
            aria-label={t('summaryHeading')}
            data-testid="note-vy-bullets-input"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name={`summary-mode-${note.id}`}
                disabled={isPending}
                checked={acceptMode === 'append'}
                onChange={() => setAcceptMode('append')}
              />
              <span>{t('acceptModeAppend')}</span>
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name={`summary-mode-${note.id}`}
                disabled={isPending}
                checked={acceptMode === 'replace'}
                onChange={() => setAcceptMode('replace')}
              />
              <span>{t('acceptModeReplace')}</span>
            </label>
            <Button
              type="button"
              size="sm"
              loading={isPending}
              disabled={!summaryHasContent || saveBlocked || isPending}
              onClick={() => onAccept({ summaryText: summaryDraft, bulletsText: bulletsDraft, mode: acceptMode })}
              className="ml-auto"
              data-testid="note-vy-accept-summary-btn"
            >
              {isPending ? t('applyingSummary') : t('acceptSummaryBtn')}
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-1.5 text-sm text-foreground">
          {visibleSummary.summary && <p>{visibleSummary.summary}</p>}
          {visibleSummary.bullets.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {visibleSummary.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground" data-testid="note-vy-summary-readonly">
            {t('summaryReadOnlyHint')}
          </p>
        </div>
      )}
    </div>
  );
}

function NoteTodosDraftBox({
  canSave,
  visibleTodos,
  stale,
  saveBlocked,
  isPending,
  onDismiss,
  onAccept,
}: {
  canSave: boolean;
  visibleTodos: NoteSuggestTodosResult;
  stale: boolean;
  saveBlocked: boolean;
  isPending: boolean;
  onDismiss: () => void;
  onAccept: (rows: EditableTodoSuggestion[]) => void;
}) {
  const t = useTranslations('notes.vy');
  const [todoRows, setTodoRows] = useState(() => toEditableTodoSuggestions(visibleTodos.suggestions));
  const selectedTodos = todoRows.filter((row) => row.selected);
  const emptyTitleSelected = selectedTodos.some((row) => row.title.trim().length === 0);

  return (
    <div
      className="space-y-2.5 rounded-lg border border-dashed border-proposal/60 bg-background p-3"
      data-testid="note-vy-todos-draft"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground">{t('todosHeading')}</span>
          <Badge variant="proposal">{t('proposalMark')}</Badge>
        </div>
        <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={onDismiss}>
          {t('dismiss')}
        </Button>
      </div>
      {stale && (
        <p className="text-xs text-warning" data-testid="note-vy-todos-stale">
          {t('staleNotice')}
        </p>
      )}
      {visibleTodos.dropped > 0 && (
        <p className="text-xs text-muted-foreground">{t('droppedNotice', { count: visibleTodos.dropped })}</p>
      )}
      {todoRows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="note-vy-empty-todos">
          {t('emptySuggestions')}
        </p>
      ) : !canSave ? (
        <>
          <ul className="space-y-1.5 text-sm text-foreground">
            {visibleTodos.suggestions.map((item, idx) => (
              <li key={idx} className="rounded-md border border-dashed border-proposal/60 bg-card p-2">
                <div className="font-medium">{item.title}</div>
                {item.details && <div className="text-xs text-muted-foreground">{item.details}</div>}
                {item.dueOn && <div className="text-xs text-subtle-foreground">{item.dueOn}</div>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground" data-testid="note-vy-todos-readonly">
            {t('todosReadOnlyHint')}
          </p>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('reviewTodosNotice')}</p>
          <ul className="space-y-2">
            {todoRows.map((row, idx) => (
              <li
                key={idx}
                className={`space-y-2 rounded-md border border-dashed border-proposal/60 bg-card p-2.5 transition-opacity ${row.selected ? '' : 'opacity-60'}`}
                data-testid="note-vy-suggested-todo"
              >
                <div className="flex items-start gap-2">
                  <Checkbox
                    checked={row.selected}
                    onCheckedChange={(checked) =>
                      setTodoRows((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, selected: checked === true } : item)),
                      )
                    }
                    aria-label={t('selectTodo', { n: String(idx + 1) })}
                    className="mt-2"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={row.title}
                        maxLength={TODO_TITLE_MAX}
                        onChange={(e) =>
                          setTodoRows((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                          )
                        }
                        aria-label={t('todoTitleLabel', { n: String(idx + 1) })}
                        className="min-w-0 flex-1"
                      />
                      <Badge variant="proposal">{t('proposalMark')}</Badge>
                    </div>
                    <Input
                      value={row.details}
                      maxLength={TODO_DETAILS_MAX}
                      placeholder={t('todoDetailsLabel', { n: String(idx + 1) })}
                      onChange={(e) =>
                        setTodoRows((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, details: e.target.value } : item)),
                        )
                      }
                      aria-label={t('todoDetailsLabel', { n: String(idx + 1) })}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <DateInput
                        value={row.dueOn}
                        onChange={(nextDueOn) =>
                          setTodoRows((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    dueOn: nextDueOn,
                                    dueTime: nextDueOn === '' ? '' : item.dueTime,
                                  }
                                : item,
                            ),
                          )
                        }
                        aria-label={t('todoDueOnLabel', { n: String(idx + 1) })}
                        className="w-40"
                      />
                      <TimeInput
                        value={row.dueTime}
                        disabled={row.dueOn.trim() === ''}
                        onChange={(nextDueTime) =>
                          setTodoRows((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, dueTime: nextDueTime } : item)),
                          )
                        }
                        aria-label={t('todoDueTimeLabel', { n: String(idx + 1) })}
                        className="w-28"
                      />
                      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={row.dueOn.trim() !== '' && row.reminder === 'auto'}
                          disabled={row.dueOn.trim() === ''}
                          onCheckedChange={(checked) =>
                            setTodoRows((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, reminder: checked === true ? 'auto' : 'off' } : item,
                              ),
                            )
                          }
                        />
                        <span>{t('todoRemindLabel')}</span>
                      </label>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {emptyTitleSelected && <ErrorText>{t('emptyTitleError')}</ErrorText>}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              loading={isPending}
              disabled={selectedTodos.length === 0 || emptyTitleSelected || saveBlocked || isPending}
              onClick={() => onAccept(todoRows)}
              data-testid="note-vy-accept-todos-btn"
            >
              {isPending ? t('savingTodos') : t('confirmTodosBtn', { count: selectedTodos.length })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
