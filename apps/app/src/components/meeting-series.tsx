// SPDX-License-Identifier: AGPL-3.0-only
// A series of meetings on a meeting's page (#3542, owner decision 2026-11-17): "Việc còn dở từ buổi trước", the items of the previous meeting of the series that are still open (accepted ones
// with the live status of their task, ones nobody accepted as "chưa giao"), and, for the recorder, a click that carries an item into their own notes and a control that says this meeting
// follows an earlier one they recorded. Only what the caller may read arrives: a reader who did not read the previous meeting gets no block and no hint that there is one. No AI is used.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SeriesOpenItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { appendNoteLine, noteLineFor } from '../lib/series-notes.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { memberLabel } from './meeting-results.tsx';
import { useMe } from './conversation-inbox.tsx';
import { ErrorText } from './ui.tsx';

// Reading the items is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.series.key() });
};

export function MeetingSeries({ meetingId, isRecorder, startedAt }: { meetingId: string; isRecorder: boolean; startedAt: string | null }) {
  const t = useTranslations('meetings.series');
  const open = useQuery({ ...orpc.meetings.series.openItems.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const { members, userId } = useMe();
  const data = open.data;
  if (!data) return null;
  const items = data.items;
  return (
    <div className="space-y-3" data-testid="meeting-series">
      {data.previous && (
        <Card data-testid="series-open-items">
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('title')}</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">{t('from', { title: data.previous.title, date: data.previous.startedAt.slice(0, 10) })}</CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? null : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <OpenItem key={item.id} item={item} meetingId={meetingId} isRecorder={isRecorder} who={item.whoUserId ? memberLabel(members, item.whoUserId, item.who) : item.who} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {isRecorder && <Follow meetingId={meetingId} inSeries={data.inSeries} startedAt={startedAt} userId={userId} />}
    </div>
  );
}

function OpenItem({ item, meetingId, isRecorder, who }: { item: SeriesOpenItem; meetingId: string; isRecorder: boolean; who: string }) {
  const t = useTranslations('meetings.series');
  const [full, setFull] = useState(false);
  const carry = useMutation({
    // The recorder's own notes are read and saved by the existing commands: the line goes at the end of what they have, once, and nothing is cut.
    mutationFn: async () => {
      const notes = await orpc.meetings.results.notesGet.call({ meetingId });
      const next = appendNoteLine(notes.body, noteLineFor(item.title, who));
      if (next === null) {
        setFull(true);
        return null;
      }
      setFull(false);
      return orpc.meetings.results.notesSave.call({ meetingId, body: next });
    },
    onSuccess: (done) => {
      if (done) void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.notesGet.key() });
    },
  });
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm" data-testid="series-item" data-assigned={item.assigned}>
      <span className="font-medium">{item.title}</span>
      {who !== '' && <span className="text-muted-foreground">{who}</span>}
      {item.assigned ? item.taskStatus && <Badge variant="outline">{t(`status.${item.taskStatus}`)}</Badge> : <Badge variant="secondary">{t('unassigned')}</Badge>}
      {item.due && <span className="text-xs text-muted-foreground">{t('due', { date: item.due.slice(0, 10) })}</span>}
      {isRecorder &&
        (carry.isSuccess && carry.data ? (
          <span className="text-xs text-muted-foreground">{t('carried')}</span>
        ) : (
          <Button size="sm" variant="outline" loading={carry.isPending} onClick={() => carry.mutate()}>
            {t('carry')}
          </Button>
        ))}
      {full && <ErrorText>{t('notesFull')}</ErrorText>}
      {carry.error && <ErrorText>{errorMessage(carry.error)}</ErrorText>}
    </li>
  );
}

// The recorder says this meeting follows an earlier one they recorded (or leaves its series). The earlier meetings offered are the ones they recorded that started before this one.
function Follow({ meetingId, inSeries, startedAt, userId }: { meetingId: string; inSeries: boolean; startedAt: string | null; userId: string | null }) {
  const t = useTranslations('meetings.series');
  const list = useQuery({ ...orpc.meetings.list.queryOptions({ input: { limit: 100 } }), enabled: !inSeries, ...READ_ONCE });
  const [pick, setPick] = useState('');
  const set = useMutation({
    mutationFn: (previousMeetingId: string | null) => orpc.meetings.series.set.call({ meetingId, previousMeetingId }),
    onSuccess: () => {
      setPick('');
      refresh();
    },
  });
  const earlier = (list.data ?? []).filter((m) => m.id !== meetingId && m.recorderUserId === userId && m.startedAt !== null && (startedAt === null || m.startedAt < startedAt));
  if (inSeries) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="series-leave">
        <span>{t('inSeries')}</span>
        <Button size="sm" variant="outline" loading={set.isPending} onClick={() => set.mutate(null)}>
          {t('leave')}
        </Button>
        {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
      </div>
    );
  }
  if (earlier.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="series-follow">
      <p className="text-sm font-medium">{t('follow')}</p>
      <p className="text-xs text-muted-foreground">{t('followHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label={t('follow')} value={pick} onChange={(e) => setPick(e.target.value)}>
          <NativeSelectOption value="">{t('followPlaceholder')}</NativeSelectOption>
          {earlier.map((m) => (
            <NativeSelectOption key={m.id} value={m.id}>
              {`${m.title} (${(m.startedAt ?? '').slice(0, 10)})`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button size="sm" disabled={pick === ''} loading={set.isPending} onClick={() => set.mutate(pick)}>
          {t('followApply')}
        </Button>
      </div>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}
