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
const REFUSALS = ['CHAPTER_NOT_ANCHORED', 'CHAPTER_DUPLICATE_SECOND', 'CHAPTER_TITLE_EMPTY', 'CHAPTER_TITLE_TOO_LONG', 'CHAPTER_TITLE_MULTILINE', 'CHAPTER_TITLE_CONTACT'] as const;
type Refusal = (typeof REFUSALS)[number];
const refusalOf = (error: unknown): Refusal | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return REFUSALS.find((r) => r === code) ?? null;
};

interface Row {
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
  const initial: Row[] = base.map((c) => ({ title: c.title, second: String(c.startSeconds) }));
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
          <Button type="button" size="sm" variant="ghost" aria-label={t('remove')} onClick={() => change(current.filter((_, j) => j !== i))}>
            ×
          </Button>
        </div>
      ))}
      {refusal ? <ErrorText>{t(`errors.${refusal}`)}</ErrorText> : save.error ? <ErrorText>{errorMessage(save.error)}</ErrorText> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={current.length >= CHAPTERS_MAX || lines.length === 0} onClick={() => change([...current, { title: '', second: '' }])}>
          {t('add')}
        </Button>
        <Button type="button" size="sm" loading={save.isPending} disabled={rows === null || !complete} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      </div>
      {saved && <p role="status" className="text-sm">{t('saved')}</p>}
    </div>
  );
}

export function MeetingChapters({ meetingId, isRecorder, onJump }: { meetingId: string; isRecorder: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.chapters');
  const chapters = useQuery({ ...orpc.meetings.results.chaptersGet.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  if (chapters.isPending) return null;
  if (chapters.error) return <ErrorText>{errorMessage(chapters.error)}</ErrorText>;
  const { draft, published } = chapters.data;
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
            {/* The draft if there is one, else a copy of the published set to edit (the next publish replaces it). */}
            <ChapterEditor meetingId={meetingId} base={draft.length > 0 ? draft : published} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
