// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder screen (W1c, issue #2295, plan docs/plan/ads-write.md section 10), the Campaigns item of the Quảng cáo group in Ludy Engage, with the
// ads module. A person drafts one campaign (one ad set, one ad with up to three texts), or starts from a Social post, or asks the AI coworker of marketing for
// a first version; every field is editable and the ones the AI coworker drafted are marked. Saving checks the plan against the dates and the spend caps, the
// largest amount it can spend is one sentence, and an owner or an admin asks for approval in the Inbox. Nothing here calls an ad platform: an approved plan is
// only marked approved until the launch step (W2). The server and the row policies decide each rule; the screen offers what can succeed and shows the reason otherwise.
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { AdsCampaignDraftView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { CampaignAsk, hasWaitingRequest } from '../components/ads-campaign-ask.tsx';
import { CampaignBuilder, type PageChoice } from '../components/ads-campaign-builder.tsx';
import { PostPicker } from '../components/ads-post-picker.tsx';
import { CardSkeleton, Empty, ErrorText, Field, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formFromPost, objectiveText, type CampaignsSearch, type PostStart } from '../lib/ads-campaigns.ts';
import { getConfig } from '../lib/auth.ts';

// While the AI coworker has a request open, the requests and the drafts are asked for again every few seconds; the worker answers within a minute or so,
// and the server closes a request nobody answered after a quarter of an hour, so the screen stops asking for one that is older than that.
const REQUEST_POLL_MS = 4_000;
const REQUEST_POLL_WINDOW_MS = 20 * 60_000;
const polling = (requests: readonly { state: string; requestedAt: string }[] | undefined): boolean =>
  requests !== undefined && requests.some((r) => r.state === 'requested' && Date.now() - Date.parse(r.requestedAt) < REQUEST_POLL_WINDOW_MS);

export function AdsCampaignsPage() {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: CampaignsSearch = useSearch({ strict: false });
  const config = getConfig();
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = role === 'owner' || role === 'admin';
  // Owners, admins and members draft; the server refuses the rest, so the screen does not offer it.
  const canDraft = canManage || role === 'member';
  const accounts = useQuery(orpc.ads.accounts.queryOptions());
  // The draft open in the builder (?draft=), read on its own: its account decides the account shown.
  const openDraft = useQuery({ ...orpc.ads.campaignDraft.queryOptions({ input: { draftId: search.draft ?? '' } }), enabled: canDraft && Boolean(search.draft) });
  const list = accounts.data ?? [];
  const account = list.find((a) => a.id === (openDraft.data?.adAccountId ?? search.account)) ?? list[0];
  const accountInput = account ? { adAccountId: account.id } : {};
  const requests = useQuery({
    ...orpc.ads.campaignRequests.queryOptions({ input: accountInput }),
    enabled: canDraft && Boolean(account),
    refetchInterval: (query) => (polling(query.state.data) ? REQUEST_POLL_MS : false),
  });
  const waiting = hasWaitingRequest(requests.data ?? []);
  const drafts = useQuery({
    ...orpc.ads.campaignDrafts.queryOptions({ input: accountInput }),
    enabled: canDraft && Boolean(account),
    refetchInterval: polling(requests.data) ? REQUEST_POLL_MS : false,
  });
  // A request that has just been answered made a draft: the list is read once more at that moment.
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (wasWaiting.current && !waiting) void queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDrafts.key() });
    wasWaiting.current = waiting;
  }, [waiting]);
  // The Facebook Pages a Messenger ad can open a conversation with.
  const channels = useQuery({ ...orpc.channels.list.queryOptions({ input: {} }), enabled: canDraft && Boolean(account) });
  const pages: PageChoice[] = (channels.data ?? []).filter((c) => c.provider === 'facebook_page' && c.status === 'active').map((c) => ({ id: c.id, name: c.displayName }));

  // A post the campaign starts from, and the words the AI coworker is asked with (the post's words go in first; the member edits them).
  const [start, setStart] = useState<PostStart | null>(null);
  const [brief, setBrief] = useState('');
  const [fresh, setFresh] = useState(0);
  const seed = useMemo(() => (start ? formFromPost(start, 'traffic') : null), [start]);

  const go = (next: CampaignsSearch) => void navigate({ to: '/o/$slug/ads/campaigns', params: { slug }, search: next });
  const openThe = (draftId: string) => go({ draft: draftId });
  const startNew = () => {
    setStart(null);
    setBrief('');
    setFresh((n) => n + 1);
    go(account ? { account: account.id } : {});
  };
  const picked = (next: PostStart) => {
    setStart(next);
    setBrief(next.brief);
    setFresh((n) => n + 1);
    go(account ? { account: account.id } : {});
  };
  const saved = (draft: AdsCampaignDraftView) => {
    setStart(null);
    go({ draft: draft.id });
  };

  const aiOn = config.aiEnabled;
  const socialOn = config.modules.includes('social');
  const shown = (drafts.data ?? []).filter((d) => d.status !== 'discarded');
  const open = openDraft.data && openDraft.data.status !== 'discarded' ? openDraft.data : null;

  return (
    <div>
      <PageHeader title={t('campaigns.title')} subtitle={t('campaigns.subtitle')} />
      {accounts.error || me.error ? (
        <ErrorText>{errorMessage(accounts.error ?? me.error)}</ErrorText>
      ) : !accounts.data || me.isPending ? (
        // The role decides what the screen offers, so it waits for it.
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : !canDraft ? (
        <Empty title={t('campaigns.membersOnly')} />
      ) : list.length === 0 || !account ? (
        <Empty
          title={t('campaigns.noAccount')}
          action={
            <Link to="/o/$slug/ads" params={{ slug }} className="text-link hover:underline">
              {t('campaigns.openAds')}
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          {list.length > 1 && (
            <Field label={t('campaigns.account')} className="max-w-sm">
              {(control) => (
                <NativeSelect {...control} className="w-full" value={account.id} onChange={(e) => go({ account: e.target.value })}>
                  {list.map((a) => (
                    <NativeSelectOption key={a.id} value={a.id}>
                      {a.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          {aiOn && <CampaignAsk key={account.id} account={account} brief={brief} onBrief={setBrief} sourcePostId={start?.sourcePostId ?? null} requests={requests.data ?? []} onOpenDraft={openThe} />}
          <section className="space-y-3" aria-labelledby="campaign-drafts-title">
            <h2 id="campaign-drafts-title" className="text-base font-semibold text-foreground">
              {t('campaigns.draftsTitle')}
            </h2>
            {drafts.error ? (
              <ErrorText>{errorMessage(drafts.error)}</ErrorText>
            ) : !drafts.data ? (
              <CardSkeleton />
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{aiOn ? t('campaigns.noDrafts') : t('campaigns.noDraftsPlain')}</p>
            ) : (
              <ul className="space-y-2" data-testid="campaign-drafts">
                {shown.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-medium text-foreground">{d.plan.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('campaigns.draftLine', { objective: objectiveText(d.plan.objective, root), revision: String(d.revision) })}
                        {d.maxSpend !== null && d.currency !== null && d.days !== null ? ` · ${t('campaigns.draftSpend', { amount: f.money(d.maxSpend, d.currency), days: d.days })}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {d.origin === 'ai' && <Badge variant="proposal">{t('campaigns.drafted')}</Badge>}
                      <Badge variant={d.status === 'approved' ? 'success' : d.pendingProposalId !== null ? 'warning' : 'outline'}>
                        {d.status === 'approved' ? t('campaigns.status.approved') : d.pendingProposalId !== null ? t('campaigns.status.waiting') : t('campaigns.status.draft')}
                      </Badge>
                      <Button type="button" size="sm" variant="outline" aria-label={`${t('campaigns.open')}: ${d.plan.name}`} onClick={() => openThe(d.id)}>
                        {t('campaigns.open')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-3" aria-label={t('campaigns.builderTitle')}>
            <div className="flex flex-wrap items-center gap-3">
              {socialOn && <PostPicker onPick={picked} />}
              {(open || search.draft) && (
                <Button type="button" variant="outline" size="lg" onClick={startNew}>
                  {t('campaigns.newDraft')}
                </Button>
              )}
              {start && !open && (
                <>
                  <span className="text-sm text-muted-foreground" data-testid="campaign-post-based">
                    {t('campaigns.postBased', { title: start.name || t('campaigns.postUntitled') })}
                  </span>
                  <Button type="button" variant="ghost" onClick={startNew}>
                    {t('campaigns.postClear')}
                  </Button>
                </>
              )}
            </div>
            {search.draft && !open ? (
              openDraft.error ? (
                <ErrorText>{errorMessage(openDraft.error)}</ErrorText>
              ) : openDraft.isPending ? (
                <CardSkeleton />
              ) : (
                <Empty title={t('campaigns.draftGone')} />
              )
            ) : (
              <Card className="block p-4">
                <CampaignBuilder
                  // The same builder follows its draft through saves (it keeps what the person typed); a draft that changes state, or another draft, is another builder.
                  key={open ? `${open.id}:${open.status}:${open.pendingProposalId ?? ''}` : `new:${account.id}:${fresh}`}
                  slug={slug}
                  account={list.find((a) => a.id === open?.adAccountId) ?? account}
                  draft={open}
                  seed={seed}
                  canManage={canManage}
                  pages={pages}
                  onSaved={saved}
                  onDiscarded={startNew}
                />
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
