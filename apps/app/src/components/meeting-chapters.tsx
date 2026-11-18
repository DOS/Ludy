// SPDX-License-Identifier: AGPL-3.0-only
// The table of contents of a meeting on its page (#3844): chapters, each a short title and the time of the transcript line it starts at. Every reader of the meeting sees the published set and a click
// takes the transcript to that line; the recorder also writes their own draft by hand (a title and the line it starts at, picked from the transcript), which is shared with the minutes when they
// press Publish in the minutes box. Nothing here needs AI. Titles are shown as plain text.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { CHAPTER_TITLE_MAX, CHAPTERS_MAX, type Chapter } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// Reading chapters and the transcript are sensitive reads that leave an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

// The refusals the editor can explain in the person's language; any other error shows the generic message.
const REFUSALS = ['CHAPTER_NOT_ANCHORED', 'CHAPTER_DUPLICATE_SECOND', 'CHAPTER_TITLE_EMPTY', 'CHAPTER_TITLE_TOO_LONG', 'CHAPTER_TITLE_MULTILINE', 'CHAPTER_TITLE_CONTACT', 'CHAPTER_TITLE_CONTROL', 'CHAPTERS_ALREADY_COPIED', 'CHAPTERS_STALE', 'DRAFT_CHAPTERS_EXIST', 'DRAFT_NOT_REVIEWED'] as const;
type Refusal = (typeof REFUSALS)[number];
const refusalOf = (error: unknown): Refusal | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return REFUSALS.find((r) => r === code) ?? null;
};

interface Row {
  // True while the row is Vy's, unread (the badge only; the mark itself is the database's).
  vy: boolean;
  title: string;
  // The whole second of the line the chapter starts at, as the select holds it; '' while none is picked.
  second: string;
}

// The published list: a time and a title, each a button that takes the transcript to its line.
function ChapterList({ chapters, onJump, jumpLabel }: { chapters: readonly Chapter[]; onJump: (seconds: number) => void; jumpLabel: string }) {
  return (
    <ol className="space-y-1 text-sm" data-testid="chapter-list">
      {chapters.map((c) => (
        <li key={c.id}>
          <button type="button" className="flex w-full items-baseline gap-3 rounded px-1 py-1 text-left hover:bg-muted" title={jumpLabel} onClick={() => onJump(c.startSeconds)}>
            <span className="font-mono text-xs text-muted-foreground">{clock(c.startSeconds)}</span>
            <span>{c.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// The recorder's editor: one row for each chapter, a title and the line it starts at.
function ChapterEditor({ meetingId, base }: { meetingId: string; base: readonly Chapter[] }) {
  const t = useTranslations('meetings.chapters');
  const transcript = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  // The lines a chapter may start at: the first line of each whole second.
  const lines: Array<{ second: number; label: string }> = [];
  for (const segment of transcript.data?.segments ?? []) {
    const second = Math.floor(segment.startSeconds);
    if (lines.some((l) => l.second === second)) continue;
    lines.push({ second, label: `${clock(second)} · ${segment.text.length > 60 ? `${segment.text.slice(0, 60)}…` : segment.text}` });
  }
  const initial: Row[] = base.map((c) => ({ vy: c.tainted, title: c.title, second: String(c.startSeconds) }));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState(false);
  const current = rows ?? initial;
  const change = (next: Row[]) => {
    setSaved(false);
    setRows(next);
  };
  const save = useMutation({
    mutationFn: () =>
      orpc.meetings.results.chaptersSave.call({
        meetingId,
        chapters: current.map((r) => ({ title: r.title, startSeconds: Number(r.second) })),
      }),
    onSuccess: () => {
      setRows(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.chaptersGet.key() });
    },
  });
  const complete = current.every((r) => r.title.trim() !== '' && r.second !== '');
  const refusal = save.error ? refusalOf(save.error) : null;
  return (
    <div className="space-y-3" data-testid="chapter-editor">
      {current.length === 0 && <p className="text-sm text-muted-foreground">{lines.length === 0 ? t('noTranscript') : t('none')}</p>}
      {current.map((row, i) => (
        // The rows have no identity of their own: they are edited in place by position.
        <div key={i} className="flex flex-wrap items-center gap-2" data-testid="chapter-row">
          <Input
            aria-label={t('titleLabel')}
            placeholder={t('titlePlaceholder')}
            value={row.title}
            maxLength={CHAPTER_TITLE_MAX}
            className="min-w-48 flex-1"
            onChange={(e) => change(current.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))}
          />
          <NativeSelect aria-label={t('lineLabel')} value={row.second} className="max-w-xs" onChange={(e) => change(current.map((r, j) => (j === i ? { ...r, second: e.target.value } : r)))}>
            <NativeSelectOption value="">{t('lineLabel')}</NativeSelectOption>
            {lines.map((l) => (
              <NativeSelectOption key={l.second} value={String(l.second)}>
                {l.label}
              </NativeSelectOption>
            ))}
            {/* A chapter saved at a second this transcript no longer has stays visible, so it can be moved or removed. */}
            {row.second !== '' && !lines.some((l) => String(l.second) === row.second) && <NativeSelectOption value={row.second}>{clock(Number(row.second))}</NativeSelectOption>}
          </NativeSelect>
          {row.vy && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="chapter-vy-badge">{t('unreadBadge')}</span>}
          <Button type="button" size="sm" variant="ghost" aria-label={t('remove')} onClick={() => change(current.filter((_, j) => j !== i))}>
            ×
          </Button>
        </div>
      ))}
      {refusal ? <ErrorText>{t(`errors.${refusal}`)}</ErrorText> : save.error ? <ErrorText>{errorMessage(save.error)}</ErrorText> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={current.length >= CHAPTERS_MAX || lines.length === 0} onClick={() => change([...current, { vy: false, title: '', second: '' }])}>
          {t('add')}
        </Button>
        <Button type="button" size="sm" loading={save.isPending} disabled={rows === null || !complete} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-sm empty:hidden">{saved ? t('saved') : null}</p>
    </div>
  );
}

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'CHAPTERS_TIMEOUT', 'CHAPTERS_FAILED', 'CHAPTERS_UNPARSABLE', 'CHAPTERS_EMPTY', 'CHAPTERS_TOO_LONG', 'CHAPTERS_NO_TRANSCRIPT'] as const;
const runCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

// The recorder's own Vy writing the chapters: ask, wait for the one answer, then copy it into the draft with a click of their own. Shown to the recorder only, and only when this system lets Vy
// write (the status says so); nothing is shared from here, and the copied chapters stay marked as Vy's until the recorder confirms they read them.
function VyChapters({ meetingId, hasModelDraft }: { meetingId: string; hasModelDraft: boolean }) {
  const t = useTranslations('meetings.chapters');
  const status = useQuery(orpc.meetings.results.chaptersStatus.queryOptions({ input: { meetingId } }));
  const ask = useMutation({ mutationFn: () => orpc.meetings.results.chaptersRun.call({ meetingId }) });
  const copy = useMutation({
    mutationFn: (runId: string) => orpc.meetings.results.chaptersCopy.call({ meetingId, runId }),
    onSuccess: () => {
      ask.reset();
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.chaptersGet.key() });
    },
  });
  if (!status.data?.enabled) return null;
  const answer = ask.data;
  const copyRefusal = copy.error ? refusalOf(copy.error) : null;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="vy-chapters">
      <p className="text-sm font-medium">{t('vy.title')}</p>
      <p className="text-xs text-muted-foreground">{t('vy.desc')}</p>
      {/* One live region that is always in the page, so the changes are announced. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:mb-0">
        {ask.isPending && <p>{t('vy.running')}</p>}
        {answer?.state === 'ready' && !copy.isSuccess && <p data-testid="vy-chapters-ready">{t('vy.ready')}</p>}
        {copy.isSuccess && <p>{t('vy.copied')}</p>}
      </div>
      {answer?.state === 'ready' && !copy.isSuccess && (
        <div className="space-y-2">
          {hasModelDraft && <p className="text-xs text-muted-foreground">{t('vy.copyReplaces')}</p>}
          <Button size="sm" loading={copy.isPending} onClick={() => copy.mutate(answer.runId)}>
            {t('vy.copy')}
          </Button>
        </div>
      )}
      {answer?.state === 'failed' && <ErrorText>{`${t('vy.failed')} ${t(`vy.codes.${runCodeOf(answer.errorCode)}`)}`}</ErrorText>}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      {copyRefusal ? <ErrorText>{t(`errors.${copyRefusal}`)}</ErrorText> : copy.error ? <ErrorText>{errorMessage(copy.error)}</ErrorText> : null}
      {!ask.isPending && answer?.state !== 'ready' && (
        <Button size="sm" variant={answer ? 'outline' : 'default'} onClick={() => ask.mutate()}>
          {answer ? t('vy.restart') : t('vy.start')}
        </Button>
      )}
    </div>
  );
}

// The recorder's own confirmation that they read the chapters Vy wrote: the rows on screen that carry the mark, named exactly, lose it, and only then can the minutes be published.
function ConfirmRead({ meetingId, ids }: { meetingId: string; ids: string[] }) {
  const t = useTranslations('meetings.chapters');
  const review = useMutation({
    mutationFn: () => orpc.meetings.results.review.call({ meetingId, confirmed: true, ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.meetings.results.chaptersGet.key() }),
  });
  return (
    <div className="space-y-2" data-testid="chapters-unread">
      <p className="text-xs text-muted-foreground">{t('unreadNote')}</p>
      <Button type="button" size="sm" variant="outline" loading={review.isPending} onClick={() => review.mutate()}>
        {t('confirm')}
      </Button>
      {review.error && <ErrorText>{errorMessage(review.error)}</ErrorText>}
    </div>
  );
}

export function MeetingChapters({ meetingId, isRecorder, onJump }: { meetingId: string; isRecorder: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.chapters');
  const chapters = useQuery({ ...orpc.meetings.results.chaptersGet.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  if (chapters.isPending) return null;
  if (chapters.error) return <ErrorText>{errorMessage(chapters.error)}</ErrorText>;
  const { draft, published } = chapters.data;
  // The draft rows on screen that Vy wrote and the recorder has not read: the confirmation names exactly these.
  const unreadIds = draft.filter((c) => c.tainted).map((c) => c.id);
  // A reader of a meeting with no published chapters sees no card at all.
  if (!isRecorder && published.length === 0) return null;
  return (
    <Card data-testid="meeting-chapters">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{isRecorder ? t('draftNote') : t('readerNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {published.length > 0 && (
          <div className="space-y-1">
            {isRecorder && <h3 className="text-xs font-medium text-muted-foreground">{t('publishedTitle')}</h3>}
            <ChapterList chapters={published} onJump={onJump} jumpLabel={t('jump')} />
          </div>
        )}
        {isRecorder && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t('draftTitle')}</h3>
            <VyChapters meetingId={meetingId} hasModelDraft={draft.some((c) => c.tainted)} />
            {unreadIds.length > 0 && <ConfirmRead meetingId={meetingId} ids={unreadIds} />}
            {/* The draft if there is one, else a copy of the published set to edit (the next publish replaces it). */}
            <ChapterEditor meetingId={meetingId} base={draft.length > 0 ? draft : published} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
