// SPDX-License-Identifier: AGPL-3.0-only
// Asking the AI coworker of marketing for a draft (W1c, issue #2295, on W1b's request): the member says in a few words what to promote (or starts from a Social
// post), the worker answers with a draft in the list or with the reason there is none, and the reason is shown in words, never silently: the AI budget of
// the month being used up is one of them (the meter), and the core of the builder works without any AI. The draft a request makes is read, edited and sent
// for approval like one a person wrote; a person approves every spend.
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ADS_OBJECTIVES, ADS_REQUEST_BRIEF_MAX, type AdAccountView, type AdsCampaignRequestAsked, type AdsCampaignRequestView, type AdsObjective } from '@crove/kernel-contract';
import { Alert } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { errorMessage, orpc } from '../lib/api.ts';
import { keyFor, type KeyHolder } from '../lib/ads.ts';
import { cutAt, objectiveText, refusalText } from '../lib/ads-campaigns.ts';
import { refreshCampaigns } from './ads-campaign-builder.tsx';
import { ErrorText, Field, focusFirstInvalid, Spinner } from './ui.tsx';

// The newest requests the list keeps in view (the server returns the caller's own, newest first).
const SHOWN_REQUESTS = 5;

// Whether the caller has a request the worker has not answered yet: asking again waits for it (one at a time).
export const hasWaitingRequest = (requests: readonly AdsCampaignRequestView[]): boolean => requests.some((r) => r.state === 'requested');

function RequestRow({ request, onOpenDraft }: { request: AdsCampaignRequestView; onOpenDraft: (draftId: string) => void }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  return (
    <li className="space-y-1 rounded-lg border p-3 text-sm" data-testid="campaign-request" data-state={request.state}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{objectiveText(request.objective, root)}</Badge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{cutAt(request.brief, 80)}</span>
      </div>
      {request.state === 'requested' ? (
        <p className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner />
          {t('campaigns.requestWaiting')}
        </p>
      ) : request.state === 'written' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground">{t('campaigns.requestWritten')}</span>
          {request.draftId !== null && (
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenDraft(request.draftId ?? '')}>
              {t('campaigns.openDraft')}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-destructive" data-testid="campaign-refusal">
          {refusalText(request.code, root)}
        </p>
      )}
    </li>
  );
}

export function CampaignAsk({
  account,
  brief,
  onBrief,
  sourcePostId,
  requests,
  onOpenDraft,
}: {
  account: AdAccountView;
  brief: string;
  onBrief: (text: string) => void;
  // The Social post the brief starts from, if one was picked: kept with the request as an opaque id.
  sourcePostId: string | null;
  requests: readonly AdsCampaignRequestView[];
  onOpenDraft: (draftId: string) => void;
}) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const [objective, setObjective] = useState<AdsObjective>('traffic');
  const [needed, setNeeded] = useState(false);
  const [asked, setAsked] = useState<AdsCampaignRequestAsked | null>(null);
  const attempt = useRef<KeyHolder | null>(null);
  const waiting = hasWaitingRequest(requests);
  const ask = useMutation(
    orpc.ads.requestCampaignDraft.mutationOptions({
      onSuccess: async (answer) => {
        attempt.current = null;
        setAsked(answer);
        await refreshCampaigns();
      },
    }),
  );
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (brief.trim() === '') {
      setNeeded(true);
      requestAnimationFrame(() => focusFirstInvalid(event.currentTarget));
      return;
    }
    setNeeded(false);
    const input = { adAccountId: account.id, objective, brief: brief.trim(), ...(sourcePostId ? { sourcePostId } : {}) };
    // A retry of the same request after a lost answer is the same request; a changed one is another.
    attempt.current = keyFor(attempt.current, JSON.stringify(input));
    ask.mutate({ ...input, idempotencyKey: attempt.current.key });
  };
  const newest = [...requests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, SHOWN_REQUESTS);
  return (
    <Card className="block space-y-3 p-4" data-testid="campaign-ask">
      <form className="space-y-3" onSubmit={send} noValidate>
        <h2 className="text-base font-semibold text-foreground">{t('campaigns.askTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('campaigns.askHint')}</p>
        <div className="flex flex-wrap items-start gap-3">
          <Field label={t('campaigns.objectiveLabel')} className="w-60">
            {(control) => (
              <NativeSelect {...control} className="w-full" value={objective} onChange={(e) => setObjective(e.target.value as AdsObjective)}>
                {ADS_OBJECTIVES.map((o) => (
                  <NativeSelectOption key={o} value={o}>
                    {objectiveText(o, root)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label={t('campaigns.brief')}
            hint={t('campaigns.briefCount', { count: String(brief.length), max: String(ADS_REQUEST_BRIEF_MAX) })}
            error={needed && brief.trim() === '' ? t('campaigns.briefNeeded') : undefined}
            className="min-w-64 flex-1"
          >
            {(control) => <Textarea {...control} rows={3} maxLength={ADS_REQUEST_BRIEF_MAX} placeholder={t('campaigns.briefPlaceholder')} value={brief} onChange={(e) => onBrief(e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={ask.isPending} disabled={waiting} type="submit" size="lg">
            {t('campaigns.ask')}
          </Button>
          {waiting && <span className="text-sm text-muted-foreground">{t('campaigns.requestWaiting')}</span>}
        </div>
        {/* Only until the list shows the request itself (its row then says whether it is being written, written or refused). */}
        {asked?.state === 'requested' && !requests.some((r) => r.id === asked.id) && <Alert role="status">{t('campaigns.asked')}</Alert>}
        {asked?.state === 'none' && !requests.some((r) => r.id === asked.id) && (
          <Alert variant="destructive" className="border-destructive/30 bg-destructive/10" data-testid="campaign-ask-refusal">
            {refusalText(asked.code, root)}
          </Alert>
        )}
        {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      </form>
      {newest.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('campaigns.requestsTitle')}</h3>
          <ul className="space-y-2">
            {newest.map((request) => (
              <RequestRow key={request.id} request={request} onOpenDraft={onOpenDraft} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
