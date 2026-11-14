// SPDX-License-Identifier: AGPL-3.0-only
// "Ghi chú của tôi" (Meetings A5, #3163): the recorder's own rough notes of a meeting, theirs alone, saved without any AI. "Viết lại đầy đủ" asks the recorder's own Vy to expand them with the
// transcript into the sections of the meeting's template (or one block); what comes back is read here first, the recorder's own lines in one style and every line Vy added in another, "Vy thêm
// từ bản ghi", with the time of the transcript line it rests on, and only the recorder's own click copies it into their draft (where it stays Vy's text until the recorder has read it).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { codeText } from './meeting-results.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// Reading the notes and the expansion are sensitive reads that leave an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const NOTES_MAX = 6000;

export function NotesPreviewPanel({ meetingId, runId, onCopied }: { meetingId: string; runId: string; onCopied: () => void }) {
  const t = useTranslations('meetings');
  const tr = useTranslations('meetings.results');
  const preview = useQuery({ ...orpc.meetings.results.enhancePreview.queryOptions({ input: { meetingId, runId } }), ...READ_ONCE });
  const copy = useMutation({
    mutationFn: () => orpc.meetings.results.copySummary.call({ meetingId, runId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.key() });
      onCopied();
    },
  });
  if (preview.isPending) return null;
  if (preview.error) return <ErrorText>{errorMessage(preview.error)}</ErrorText>;
  const { enhanced, template, dropped } = preview.data;
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="notes-preview">
      <p className="text-sm">{t('notes.ready')}</p>
      {enhanced.sections.map((section) => (
        <div key={section.key ?? 'all'} className="space-y-1">
          {section.key !== null && <h4 className="text-xs font-medium text-muted-foreground">{t(`templates.sections.${template}.${section.key}` as never)}</h4>}
          <ul className="space-y-1 text-sm">
            {section.lines.map((line, i) => (
              <li key={`${i}-${line.text}`} className={line.own ? 'text-foreground' : 'rounded border border-dashed px-2 py-1 italic text-muted-foreground'} data-own={line.own ? 'true' : 'false'}>
                {line.own ? (
                  <span>{line.text}</span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{t('notes.added')}</Badge>
                    <span>{line.text}</span>
                    {line.seconds !== null && (
                      <span className="rounded bg-muted px-1.5 font-mono text-xs not-italic" title={t('notes.chipTitle')}>
                        {clock(line.seconds)}
                      </span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {dropped > 0 && <p className="text-xs text-muted-foreground">{t('notes.dropped', { count: String(dropped) })}</p>}
      <p className="text-xs text-muted-foreground">{t('notes.copyReplaces')}</p>
      {copy.error && <ErrorText>{errorMessage(copy.error)}</ErrorText>}
      {copy.isSuccess ? <p role="status">{tr('vy.copied')}</p> : (
        <Button size="sm" loading={copy.isPending} onClick={() => copy.mutate()}>
          {tr('vy.copy')}
        </Button>
      )}
    </div>
  );
}

export function MeetingNotes({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings');
  const tr = useTranslations('meetings.results');
  const notes = useQuery({ ...orpc.meetings.results.notesGet.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const status = useQuery(orpc.meetings.results.summaryStatus.queryOptions({ input: { meetingId } }));
  const [draft, setDraft] = useState<string | null>(null);
  const saved = notes.data?.body ?? '';
  const text = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved.trim();
  const save = useMutation({
    mutationFn: () => orpc.meetings.results.notesSave.call({ meetingId, body: text.trim() }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.notesGet.key() });
    },
  });
  const enhance = useMutation({ mutationFn: () => orpc.meetings.results.enhance.call({ meetingId }) });
  if (notes.isPending || notes.error) return notes.error ? <ErrorText>{errorMessage(notes.error)}</ErrorText> : null;
  const answer = enhance.data;
  const canEnhance = status.data?.enabled === true;
  return (
    <Card data-testid="meeting-notes">
      <CardHeader>
        <CardTitle className="text-base font-medium">{t('notes.title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('notes.private')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea aria-label={t('notes.title')} placeholder={t('notes.placeholder')} value={text} maxLength={NOTES_MAX} rows={6} onChange={(e) => setDraft(e.target.value)} />
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            {t('notes.save')}
          </Button>
          {canEnhance && (
            <Button size="sm" loading={enhance.isPending} disabled={saved.trim() === '' || dirty} onClick={() => enhance.mutate()}>
              {t('notes.enhance')}
            </Button>
          )}
        </div>
        {canEnhance && <p className="text-xs text-muted-foreground">{dirty ? t('notes.saveFirst') : t('notes.enhanceHint')}</p>}
        {enhance.isPending && <p role="status">{tr('vy.running')}</p>}
        {enhance.error && <ErrorText>{errorMessage(enhance.error)}</ErrorText>}
        {answer?.state === 'failed' && <ErrorText>{`${tr('vy.failed')} ${codeText(tr, answer.errorCode) ?? tr('vy.codes.default')}`}</ErrorText>}
        {answer?.state === 'ready' && <NotesPreviewPanel key={answer.runId} meetingId={meetingId} runId={answer.runId} onCopied={() => enhance.reset()} />}
      </CardContent>
    </Card>
  );
}
