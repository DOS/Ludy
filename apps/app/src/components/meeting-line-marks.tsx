// SPDX-License-Identifier: AGPL-3.0-only
// What the transcript's line buttons do for highlights (#4819): the marks of a meeting, the click that adds the caller's own mark or takes it away (Shift and a click marks a range), and the words of a
// refusal. Kept apart from the highlights card so the transcript panel can use it without importing the card (which imports the transcript's clock).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ownSingleAt, rangeBetween } from '../lib/highlights.ts';

const REFUSALS = ['HIGHLIGHT_LIMIT', 'HIGHLIGHT_NOT_ANCHORED'] as const;

const refusalOf = (error: unknown): (typeof REFUSALS)[number] | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return REFUSALS.find((r) => r === code) ?? null;
};

export const refreshHighlights = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.highlight.key() });

export function useHighlights(meetingId: string) {
  return useQuery(orpc.meetings.highlight.list.queryOptions({ input: { meetingId } }));
}

/**
 * The marks of a meeting and what a click on a line's button does: a click marks that line, or takes the caller's own single-line mark away; Shift and a click marks everything from the line last clicked
 * to this one. One request at a time, so a double click is one click.
 */
export function useLineMarks(meetingId: string) {
  const list = useHighlights(meetingId);
  const last = useRef<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const add = useMutation({
    mutationFn: (range: { startSeconds: number; endSeconds: number }) => orpc.meetings.highlight.add.call({ meetingId, ...range }),
    onSuccess: refreshHighlights,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (highlightId: string) => orpc.meetings.highlight.remove.call({ meetingId, highlightId }),
    onSuccess: refreshHighlights,
    onError: setError,
  });
  const highlights = list.data?.highlights ?? [];
  const busy = add.isPending || remove.isPending;
  const click = (startSeconds: number, shift: boolean) => {
    if (busy) return;
    setError(null);
    const from = last.current;
    if (shift && from !== null) {
      last.current = Math.floor(startSeconds);
      add.mutate(rangeBetween(from, startSeconds));
      return;
    }
    const own = ownSingleAt(highlights, startSeconds);
    if (own) {
      // Taking a mark away is not a place to start a range from.
      remove.mutate(own.id);
    } else {
      last.current = Math.floor(startSeconds);
      add.mutate(rangeBetween(startSeconds, startSeconds));
    }
  };
  return { highlights, busy, error, click };
}

export function MarkError({ error }: { error: unknown }) {
  const t = useTranslations('meetings.highlights');
  if (!error) return null;
  const refusal = refusalOf(error);
  return <ErrorText>{refusal ? t(`errors.${refusal}`) : errorMessage(error)}</ErrorText>;
}
