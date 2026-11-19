// SPDX-License-Identifier: AGPL-3.0-only
// Sending to MISA AMIS Kế toán from the connection card (#3902, S3b-2b of #3854). Two parts. The confirm block under a preview with nothing blocked: an owner or admin confirms the batch they saw (bound to its
// digest; if the data changed since, the server queues nothing), after a second click that says plainly the send cannot be taken back. The list of what was sent, with the state MISA gave each request, MISA's
// own reason for a refusal (untrusted: shown as text, never as markup) and, for a request MISA never answered for, the two answers a person can give after looking in AMIS. Nothing is sent without the person.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MisaAmisPreview, MisaAmisPushConfirm, MisaAmisPushConfirmed, MisaAmisPushRow } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { canSettle, checkIsYoung, confirmedAnything, openRows, previewSendable, type PushOffer } from '../lib/misa-amis-push.ts';
import { ErrorText } from './ui.tsx';

// How often the list is read again while a request is open.
const PUSH_REFRESH_MS = 15_000;

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.misaAmis.pushes.list.key() });
};

/** Under a preview: the offer to send what the person just looked at. `ask` is the preview's own ask, which the server runs again and compares by digest. */
export function MisaAmisPushConfirm({ result, ask, connectionId, offer, checkRequired = true }: { result: MisaAmisPreview; ask: Omit<MisaAmisPushConfirm, 'connectionId' | 'digest'>; connectionId: string; offer: PushOffer; checkRequired?: boolean }) {
  const t = useTranslations('misaAmisPush');
  const [confirming, setConfirming] = useState(false);
  const send = useMutation<MisaAmisPushConfirmed>({
    mutationFn: () => client.vouchers.misaAmisPush({ ...ask, connectionId, digest: result.digest }),
    onSuccess: refresh,
  });
  if (offer === 'hidden' || !previewSendable(result)) return null;
  if (offer === 'needs_test') {
    return (
      <p className="mt-3 text-xs text-subtle-foreground" data-testid="misa-amis-push-needs-test">
        {t('needsTest')}
      </p>
    );
  }
  const done = send.data;
  return (
    <div className="mt-3 rounded-md border border-border p-2" data-testid="misa-amis-push-confirm">
      {/* A status region that exists before its text does, so a screen reader announces the result without moving focus. */}
      <div role="status">
        {done && (
          <p className="text-foreground" data-testid="misa-amis-push-done">
            {confirmedAnything(done) || done.revised > 0 ? t('done', { queued: String(done.queued), requeued: String(done.requeued), already: String(done.already), revised: String(done.revised) }) : t('nothingNew')}
          </p>
        )}
      </div>
      {!done &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="misa-amis-push-ask">
              {t('confirmAsk', { count: result.vouchers })}
            </span>
            <Button size="sm" loading={send.isPending} onClick={() => send.mutate()} data-testid="misa-amis-push-yes">
              {t('confirmYes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
          </div>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)} data-testid="misa-amis-push-start">
              {t('confirm', { count: result.vouchers })}
            </Button>
            <p className="mt-1 text-xs text-subtle-foreground">{t('confirmNote')}</p>
            {checkRequired && !checkIsYoung(result.matchCheck.checkedAt, Date.now()) && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="misa-amis-push-check-first">
                {t('checkFirst')}
              </p>
            )}
          </>
        ))}
      {send.error && (
        <div className="mt-1" data-testid="misa-amis-push-error">
          <ErrorText>{errorMessage(send.error)}</ErrorText>
        </div>
      )}
    </div>
  );
}

const STATE_VARIANT = { queued: 'outline', sending: 'outline', sent: 'outline', accepted: 'secondary', refused: 'destructive', ambiguous: 'outline', failed: 'destructive' } as const;

function PushRow({ row, connectionId, canManage, now }: { row: MisaAmisPushRow; connectionId: string; canManage: boolean; now: number }) {
  const t = useTranslations('misaAmisPush');
  const f = useFormat();
  const [outcome, setOutcome] = useState<'in_amis' | 'not_in_amis' | null>(null);
  const resolve = useMutation({
    mutationFn: (o: 'in_amis' | 'not_in_amis') => client.misaAmis.pushes.resolve({ connectionId, orgRefid: row.orgRefid, outcome: o }),
    onSuccess: async () => {
      setOutcome(null);
      await refresh();
    },
  });
  const settle = canManage && canSettle(row, now);
  return (
    <li className="py-2" data-testid="misa-amis-push-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{row.orgRefno}</span>
        {row.part > 1 && <span className="text-xs text-muted-foreground">{t('part', { part: String(row.part) })}</span>}
        <Badge variant={STATE_VARIANT[row.state]} data-testid="misa-amis-push-state">
          {t(`state.${row.state}`)}
        </Badge>
        {row.attempts > 1 && <span className="text-xs text-muted-foreground">{t('attempts', { count: String(row.attempts) })}</span>}
        <span className="ml-auto text-xs text-subtle-foreground">{t('changedAt', { when: f.dateTime(row.changedAt) })}</span>
      </div>
      {row.reason && (row.state === 'refused' || row.state === 'failed') && (
        <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="misa-amis-push-reason">
          {row.state === 'refused' ? `${t('refusedNote')} ` : ''}
          {row.reason === 'MATCH_STALE' ? t('reasons.MATCH_STALE') : row.reason === 'MATCH_UNREAD' ? t('reasons.MATCH_UNREAD') : row.reason === 'STALE' ? t('reasons.STALE') : row.reason}
        </p>
      )}
      {settle && (
        <div className="mt-1" data-testid="misa-amis-push-settle">
          <p className="text-xs text-muted-foreground">{t('settleHint')}</p>
          {outcome === null ? (
            <div className="mt-1 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" aria-label={`${t('inAmis')}: ${row.orgRefno}`} onClick={() => setOutcome('in_amis')}>
                {t('inAmis')}
              </Button>
              <Button size="sm" variant="outline" aria-label={`${t('notInAmis')}: ${row.orgRefno}`} onClick={() => setOutcome('not_in_amis')}>
                {t('notInAmis')}
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('settleAsk', { no: row.orgRefno, outcome: t(`outcome.${outcome}`) })}</span>
              <Button size="sm" loading={resolve.isPending} onClick={() => resolve.mutate(outcome)}>
                {t('settleYes')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>
                {t('cancel')}
              </Button>
            </div>
          )}
        </div>
      )}
      {resolve.error && <ErrorText>{errorMessage(resolve.error)}</ErrorText>}
    </li>
  );
}

/** What was sent through one connection, newest first (the server's order), read by every member. Only an owner or admin sees the buttons that settle a row. */
export function MisaAmisPushList({ connectionId, canManage }: { connectionId: string; canManage: boolean }) {
  const t = useTranslations('misaAmisPush');
  // States change in the worker, not on this screen: while a row is waiting for MISA the list is read again every 15 seconds.
  const rows = useQuery({ ...orpc.misaAmis.pushes.list.queryOptions({ input: { connectionId } }), refetchInterval: (query) => (openRows(query.state.data ?? []) > 0 ? PUSH_REFRESH_MS : false) });
  const list = rows.data ?? [];
  // Read once per render of the list: a row crossing the 24 hours while the screen is open shows its buttons at the next refetch, and the server checks the age again anyway.
  const now = Date.now();
  return (
    <details className="mt-3 rounded-md border border-border p-3 text-sm" data-testid="misa-amis-pushes">
      <summary className="cursor-pointer font-medium text-foreground">
        {t('listTitle')}
        {openRows(list) > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{t('listOpen', { count: String(openRows(list)) })}</span>}
      </summary>
      <p className="mt-2 text-muted-foreground">{t('listHint')}</p>
      {rows.error ? (
        <ErrorText>{errorMessage(rows.error)}</ErrorText>
      ) : list.length === 0 ? (
        <p className="mt-2 text-subtle-foreground" data-testid="misa-amis-pushes-empty">
          {t('listEmpty')}
        </p>
      ) : (
        <ul className="mt-2 divide-y">
          {list.map((row) => (
            <PushRow key={row.id} row={row} connectionId={connectionId} canManage={canManage} now={now} />
          ))}
        </ul>
      )}
    </details>
  );
}
