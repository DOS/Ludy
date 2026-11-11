// SPDX-License-Identifier: AGPL-3.0-only
// The links of one meeting to contacts, a deal and the calendar event it came from (L1, #2587). Every reader sees them; only the recorder adds or removes one.
// A contact is found by a search and linked with a click; a deal is chosen among the deals of the linked contacts and a meeting has at most one. Nothing here
// is set by the AI: Vy's suggestion (suggested-links.tsx) only proposes, and the recorder's click links.
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { MeetingLink } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect } from '@crove/ui/components/native-select';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { ErrorText } from './ui.tsx';

const crmInstalled = (): boolean => getConfig().modules.includes('crm');
const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.links.key() });

function DealName({ dealId, fallback }: { dealId: string; fallback: string }) {
  const deal = useQuery({ ...orpc.crm.deals.get.queryOptions({ input: { dealId } }), enabled: crmInstalled(), retry: false });
  return <>{deal.data ? `${deal.data.title} (${deal.data.partyName})` : fallback}</>;
}

function AddParty({ meetingId, onError }: { meetingId: string; onError: (message: string | null) => void }) {
  const t = useTranslations('meetings');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const found = useQuery({ ...orpc.crm.parties.search.queryOptions({ input: { q: query, limit: 5 } }), enabled: crmInstalled() && query.length >= 2 });
  const add = useMutation({
    mutationFn: (targetId: string) => orpc.meetings.links.add.call({ meetingId, kind: 'party', targetId }),
    onSuccess: () => {
      setQ('');
      onError(null);
      void refresh();
    },
    onError: (e) => onError(errorMessage(e)),
  });
  if (!crmInstalled()) return null;
  return (
    <div className="space-y-1">
      <Label htmlFor="link-party-search">{t('links.searchLabel')}</Label>
      <Input id="link-party-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('links.searchPlaceholder')} className="text-xs" />
      {query.length >= 2 && (found.data?.length ?? 0) > 0 && (
        <ul className="divide-y rounded border border-border text-xs">
          {found.data?.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-2 py-1">
              <span>{p.name}</span>
              <Button size="sm" variant="outline" loading={add.isPending && add.variables === p.id} disabled={add.isPending} onClick={() => add.mutate(p.id)}>
                {t('links.addParty')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddDeal({ meetingId, partyIds, onError }: { meetingId: string; partyIds: readonly string[]; onError: (message: string | null) => void }) {
  const t = useTranslations('meetings');
  const [dealId, setDealId] = useState('');
  const results = useQueries({ queries: partyIds.map((partyId) => ({ ...orpc.crm.deals.byParty.queryOptions({ input: { partyId } }), enabled: crmInstalled() })) });
  const deals = results.flatMap((r) => r.data ?? []);
  const add = useMutation({
    mutationFn: (targetId: string) => orpc.meetings.links.add.call({ meetingId, kind: 'deal', targetId }),
    onSuccess: () => {
      setDealId('');
      onError(null);
      void refresh();
    },
    onError: (e) => onError(errorMessage(e)),
  });
  if (!crmInstalled() || deals.length === 0) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dealId) add.mutate(dealId);
  };
  return (
    <form onSubmit={submit} className="space-y-1">
      <Label htmlFor="link-deal">{t('links.dealLabel')}</Label>
      <div className="flex gap-2">
        <NativeSelect id="link-deal" value={dealId} onChange={(e) => setDealId(e.target.value)} className="text-xs">
          <option value="">{t('links.dealPlaceholder')}</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} ({d.partyName})
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={!dealId} loading={add.isPending}>
          {t('links.addDeal')}
        </Button>
      </div>
    </form>
  );
}

export function MeetingLinks({ meetingId, isRecorder }: { meetingId: string; isRecorder: boolean }) {
  const t = useTranslations('meetings');
  const [error, setError] = useState<string | null>(null);
  const links = useQuery(orpc.meetings.links.list.queryOptions({ input: { meetingId } }));
  const remove = useMutation({
    mutationFn: (linkId: string) => orpc.meetings.links.remove.call({ meetingId, linkId }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const data: readonly MeetingLink[] = links.data ?? [];
  const partyIds = data.filter((l) => l.kind === 'party').map((l) => l.targetId);
  const label = (l: MeetingLink) => l.label ?? t('links.unnamed');
  return (
    <Card data-testid="meeting-links">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t('links.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {links.error && <ErrorText>{errorMessage(links.error)}</ErrorText>}
        {!links.isLoading && data.length === 0 && <p className="text-xs text-muted-foreground">{t('links.none')}</p>}
        <ul className="divide-y text-xs">
          {data.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2" data-testid="meeting-link">
              <span>
                <span className="text-muted-foreground">{t(`links.kind${l.kind[0]!.toUpperCase()}${l.kind.slice(1)}` as 'links.kindParty')}: </span>
                {l.kind === 'deal' ? <DealName dealId={l.targetId} fallback={t('links.unnamed')} /> : label(l)}
              </span>
              {isRecorder && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10"
                  aria-label={t('links.removeOf', { name: l.kind === 'deal' ? t('links.kindDeal') : label(l) })}
                  loading={remove.isPending && remove.variables === l.id}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(l.id)}
                >
                  {t('links.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {isRecorder && (
          <>
            <AddParty meetingId={meetingId} onError={setError} />
            {!data.some((l) => l.kind === 'deal') && <AddDeal meetingId={meetingId} partyIds={partyIds} onError={setError} />}
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}
