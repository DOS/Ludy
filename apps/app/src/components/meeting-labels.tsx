// SPDX-License-Identifier: AGPL-3.0-only
// Labels on a meeting's page (#4955, plan docs/plan/meetings.md L28): up to five short plain-text labels the recorder put on the meeting, shown to everyone who may read it, and, for the recorder, a box to add one and a
// button to take one off. The text is checked by code before it is sent (no line break, no "@", no run of seven digits) and the page says to keep names of people out. Nothing here reads the transcript; no AI.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_LABELS_MAX, MEETING_LABEL_LENGTH_MAX, cleanLabelText, labelProblem } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const REFUSALS = ['MEETING_LABEL_INVALID', 'MEETING_LABEL_LIMIT', 'MEETING_LABEL_NOT_FOUND'] as const;

const refusalOf = (error: unknown): (typeof REFUSALS)[number] | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return REFUSALS.find((r) => r === code) ?? null;
};

/** Both the labels of a meeting and the rows of the meetings list, which carry the labels of their meetings (#4966), follow an add or a remove: the list does not wait for its stale time to show the change. */
export const refreshLabels = async (): Promise<void> => {
  await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.meetings.label.key() }), queryClient.invalidateQueries({ queryKey: orpc.meetings.list.key() })]);
};

/** The labels of a meeting the caller may read; absent for a reader of a meeting with none, and when the read failed (as after the text retention date). */
export function MeetingLabels({ meetingId, isRecorder }: { meetingId: string; isRecorder: boolean }) {
  const t = useTranslations('meetings.labels');
  const list = useQuery(orpc.meetings.label.list.queryOptions({ input: { meetingId } }));
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const add = useMutation({
    mutationFn: (label: string) => orpc.meetings.label.add.call({ meetingId, label }),
    onSuccess: () => {
      setText('');
      return refreshLabels();
    },
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (labelId: string) => orpc.meetings.label.remove.call({ meetingId, labelId }),
    onSuccess: refreshLabels,
    onError: setError,
  });
  if (list.error || !list.data) return null;
  const labels = list.data.labels;
  if (!isRecorder && labels.length === 0) return null;
  const full = labels.length >= MEETING_LABELS_MAX;
  const problem = text.trim() === '' ? null : labelProblem(text);
  const refusal = error === null || error === undefined ? null : refusalOf(error);
  const submit = () => {
    setError(null);
    if (text.trim() === '' || problem !== null || full) return;
    add.mutate(cleanLabelText(text));
  };
  return (
    <section className="space-y-2" data-testid="meeting-labels">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
        {labels.length === 0 && <span className="text-xs text-muted-foreground">{t('none')}</span>}
        <ul className="flex flex-wrap items-center gap-2" aria-label={t('title')}>
          {labels.map((l) => (
            <li key={l.id} className="flex items-center gap-1" data-testid="meeting-label">
              <Badge variant="outline">{l.label}</Badge>
              {isRecorder && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('remove', { label: l.label })}
                  loading={remove.isPending && remove.variables === l.id}
                  onClick={() => {
                    setError(null);
                    remove.mutate(l.id);
                  }}
                >
                  {'×'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {isRecorder && (
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor={`meeting-label-${meetingId}`} className="text-xs text-muted-foreground">
                {t('add')}
              </label>
              <Input
                id={`meeting-label-${meetingId}`}
                value={text}
                maxLength={MEETING_LABEL_LENGTH_MAX + 40}
                disabled={full}
                aria-describedby={`meeting-label-hint-${meetingId}${problem !== null || refusal !== null ? ` meeting-label-error-${meetingId}` : ''}`}
                aria-invalid={problem !== null}
                onChange={(e) => {
                  setError(null);
                  setText(e.target.value);
                }}
              />
            </div>
            <Button type="submit" size="sm" disabled={full || text.trim() === '' || problem !== null} loading={add.isPending}>
              {t('addButton')}
            </Button>
          </div>
          <p id={`meeting-label-hint-${meetingId}`} className="text-xs text-muted-foreground">
            {full ? t('full', { max: String(MEETING_LABELS_MAX) }) : t('hint', { max: String(MEETING_LABEL_LENGTH_MAX) })}
          </p>
          {problem !== null && <ErrorText id={`meeting-label-error-${meetingId}`}>{t(`problem.${problem}`, { max: String(MEETING_LABEL_LENGTH_MAX) })}</ErrorText>}
          {problem === null && error !== null && error !== undefined && <ErrorText id={`meeting-label-error-${meetingId}`}>{refusal ? t(`errors.${refusal}`) : errorMessage(error)}</ErrorText>}
        </form>
      )}
    </section>
  );
}
