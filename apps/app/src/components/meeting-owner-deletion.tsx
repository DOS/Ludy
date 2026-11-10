// SPDX-License-Identifier: AGPL-3.0-only
// The owner's compliance deletion of meetings (#2703, ADR-0047), on the personal-data screen: every meeting of the org, the attendees-only
// ones the owner cannot read included, as metadata only (date, recorder, visibility, status, retention dates; never a title or any
// text), a page at a time, with a delete per row behind a confirmation. Listing is a command that leaves an audit row per call, so the
// page is asked once (no refetch on focus); a delete refreshes it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MeetingOwnerListItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { StepUpPrompt } from './two-factor.tsx';
import { DataTable, Empty, ErrorText, TableSkeleton } from './ui.tsx';

type Cursor = { afterStartedAt: string; afterId: string };

export function MeetingOwnerDeletion({ nameOf }: { nameOf: (userId: string) => string }) {
  const t = useTranslations('personalData.meetingDeletion');
  const f = useFormat();
  // The cursors of the pages opened after the first: the last one is the page shown.
  const [pages, setPages] = useState<Cursor[]>([]);
  const cursor = pages[pages.length - 1];
  const list = useQuery({
    ...orpc.meetings.ownerList.queryOptions({ input: cursor ?? {} }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [confirming, setConfirming] = useState<MeetingOwnerListItem | null>(null);
  // The meeting a delete was asked for, kept for the repeat after a fresh second factor.
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (meetingId: string) => orpc.meetings.ownerDelete.call({ meetingId }),
    onSuccess: () => {
      setDeleting(null);
      toast(t('deleted'), 'success');
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
    },
    onError: (err) => {
      // A fresh second factor is asked for below, and the same delete is repeated once it is verified.
      if (!isStepUpRequired(err)) toast(errorMessage(err), 'error');
    },
  });

  const items = list.data?.items ?? [];
  const next = list.data?.next ?? null;

  return (
    <section className="mt-10 max-w-5xl border-t pt-6" aria-labelledby="meeting-owner-deletion" data-testid="meeting-owner-deletion">
      <h2 id="meeting-owner-deletion" className="text-lg font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="mb-4 mt-1 max-w-3xl text-xs text-muted-foreground">{t('hint')}</p>
      {remove.error && isStepUpRequired(remove.error) && deleting && (
        <div className="mb-4">
          <StepUpPrompt
            action={t('stepUp')}
            onVerified={() => remove.mutate(deleting)}
            onCancel={() => {
              remove.reset();
              setDeleting(null);
            }}
          />
        </div>
      )}
      {list.isFetching && !list.data ? (
        <TableSkeleton columns={6} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <DataTable head={[t('columns.startedAt'), t('columns.recorder'), t('columns.visibility'), t('columns.status'), t('columns.retention'), t('columns.actions')]}>
          {items.map((m) => (
            <TableRow key={m.id} data-testid="meeting-owner-row">
              <TableCell className="px-4 py-3 text-sm text-foreground">{f.dateTime(m.startedAt)}</TableCell>
              <TableCell className="px-4 py-3 text-sm text-foreground">{nameOf(m.recorderUserId)}</TableCell>
              <TableCell className="px-4 py-3">
                <Badge variant={m.visibility === 'attendees' ? 'secondary' : 'outline'}>{t(`visibility.${m.visibility}`)}</Badge>
              </TableCell>
              <TableCell className="px-4 py-3 text-xs text-muted-foreground">{t(`status.${m.status}`)}</TableCell>
              <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                <span className="block">{t('retentionAudio', { date: f.date(m.audioRetentionDate) })}</span>
                {m.videoRetentionDate && <span className="block">{t('retentionVideo', { date: f.date(m.videoRetentionDate) })}</span>}
                <span className="block">{m.textRetentionDate ? t('retentionText', { date: f.date(m.textRetentionDate) }) : t('retentionTextKept')}</span>
              </TableCell>
              <TableCell className="px-4 py-3">
                <Button
                  variant="destructive"
                  size="sm"
                  loading={remove.isPending && deleting === m.id}
                  disabled={remove.isPending}
                  onClick={() => setConfirming(m)}
                >
                  {t('delete')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {(next || pages.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {pages.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setPages([])}>
              {t('first')}
            </Button>
          )}
          {next && (
            <Button variant="outline" size="sm" onClick={() => setPages((p) => [...p, next])}>
              {t('next')}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('confirmTitle')}
        description={confirming ? t('confirmBody', { date: f.dateTime(confirming.startedAt), recorder: nameOf(confirming.recorderUserId) }) : ''}
        confirm={t('confirm')}
        destructive
        onConfirm={() => {
          if (!confirming) return;
          setDeleting(confirming.id);
          remove.mutate(confirming.id);
          setConfirming(null);
        }}
      />
    </section>
  );
}
