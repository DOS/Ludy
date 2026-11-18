// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post, on the screens (ads W3, issue #3834): the card on the post (the "Đẩy bài" action, and where the boost stands once there is one) and the
// posts the AI coworker of marketing suggests boosting on the Campaigns screen. Both read the post through Social's own query and Ads through its own; the post's id
// is the only thing Ads keeps. With running ads off there is no button (the options say so), and with ads or Social not installed there is nothing here at all. A
// suggestion is only that: the person opens the panel, changes what they like and sends it, and an approver approves the spend. No model call: the ranking is the counts
// Ludy already reads, so it works with the AI off.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { AdsBoostOptions, AdsBoostStateView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { cutAt } from '../lib/ads-campaigns.ts';
import { boostBlock, boostOver, boostStateText, boostStateTone, suggestBoosts, type BoostPost } from '../lib/ads-boost.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';
import { BoostPanel } from './ads-boost-panel.tsx';
import { RowsSkeleton } from './ui.tsx';

// While a boost is on its way (approved, being created, live) its state is read again every so often, so the post shows it without a reload.
const STATE_POLL_MS = 15_000;
const moving = (state: AdsBoostStateView | null): boolean => state !== null && state.state !== 'draft' && !boostOver(state.state);

// The role of the signed-in member in the org: owners and admins ask for approval, members draft.
function useBoostRole(slug: string): { canDraft: boolean; canManage: boolean; ready: boolean } {
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = role === 'owner' || role === 'admin';
  return { canDraft: canManage || role === 'member', canManage, ready: !me.isPending };
}

const useAdsAndSocial = (): { ads: boolean; social: boolean } => {
  useModulesVersion(); // the apps of the org can change while this screen is open
  const installed = installedModules();
  return { ads: installed.includes('ads'), social: installed.includes('social') };
};

// Where a boost stands, with the way to its request in the Inbox or its draft in Campaigns.
function BoostState({ slug, state }: { slug: string; state: AdsBoostStateView }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  return (
    <div className="space-y-1.5" data-testid="boost-state" data-state={state.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('boost.stateLabel')}</span>
        <Badge variant={boostStateTone(state.state)}>{boostStateText(state.state, state.step, root)}</Badge>
        <span className="text-xs text-muted-foreground">{state.adAccountName}</span>
      </div>
      {state.maxSpend !== null && state.currency !== null && state.days !== null && state.startOn !== null && state.endOn !== null && (
        <p className="text-xs text-muted-foreground">{t('boost.stateLine', { amount: f.money(state.maxSpend, state.currency), days: state.days, start: f.date(state.startOn), end: f.date(state.endOn) })}</p>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {state.proposalId !== null && (
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: state.proposalId }} className="text-link hover:underline">
            {t('boost.viewInbox')}
          </Link>
        )}
        <Link to="/o/$slug/ads/campaigns" params={{ slug }} search={{ draft: state.draftId }} className="text-link hover:underline">
          {t('boost.viewCampaign')}
        </Link>
      </p>
    </div>
  );
}

// The card on a published post: the action that boosts it, or where its boost stands. Nothing when the post cannot be boosted, when running ads is off and there is no
// boost to show, or when the caller does not draft ads.
export function BoostCard({ slug, post }: { slug: string; post: BoostPost }) {
  const t = useTranslations('ads');
  const { ads } = useAdsAndSocial();
  const { canDraft, canManage } = useBoostRole(slug);
  const asked = ads && canDraft && boostBlock(post) === null;
  const options = useQuery({ ...orpc.ads.boostOptions.queryOptions(), enabled: asked, retry: false });
  const states = useQuery({
    ...orpc.ads.boostStates.queryOptions({ input: { postIds: [post.id] } }),
    enabled: asked,
    retry: false,
    refetchInterval: (query) => (moving(query.state.data?.[0] ?? null) ? STATE_POLL_MS : false),
  });
  const [open, setOpen] = useState(false);
  const state = states.data?.[0] ?? null;
  const available = options.data?.enabled === true;
  if (!asked || (state === null && !available)) return null;
  const over = state !== null && boostOver(state.state);
  // A boost still being built or going is opened from here; a boost that is over may be made again.
  const action = state === null ? t('boost.button') : state.state === 'draft' ? t('boost.openDraft') : over ? t('boost.boostAgain') : null;
  return (
    <>
      <Card className="mb-6 block space-y-3 p-4" data-testid="boost-card">
        <h2 className="text-sm font-semibold text-foreground">{t('boost.cardTitle')}</h2>
        {state === null && <p className="text-xs text-muted-foreground">{t('boost.cardHint')}</p>}
        {state !== null && <BoostState slug={slug} state={state} />}
        {action !== null && available && (
          <div>
            <Button type="button" variant={state === null ? 'default' : 'outline'} onClick={() => setOpen(true)} data-testid="boost-open">
              {action}
            </Button>
          </div>
        )}
      </Card>
      {open && options.data && <BoostPanel slug={slug} post={post} options={options.data} canManage={canManage} onClose={() => setOpen(false)} />}
    </>
  );
}

// The most posts the list asks Social for: the recent ones that went out (the suggestion looks at the last two weeks).
const SUGGEST_LIST = 30;

// The posts the AI coworker of marketing suggests boosting: the best of the last two weeks by what people did with them, not boosted yet. Each opens the same panel.
export function BoostSuggestions({ slug }: { slug: string }) {
  const t = useTranslations('ads');
  const { ads, social } = useAdsAndSocial();
  const { canDraft, canManage } = useBoostRole(slug);
  const asked = ads && social && canDraft;
  const options = useQuery({ ...orpc.ads.boostOptions.queryOptions(), enabled: asked, retry: false });
  const live = asked && options.data?.enabled === true;
  const posts = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { stage: 'done', limit: SUGGEST_LIST } }), enabled: live, retry: false });
  const metrics = useQuery({ ...orpc.social.metrics.summary.queryOptions({ input: { days: 14 } }), enabled: live, retry: false });
  const ids = (posts.data ?? []).map((p) => p.id).slice(0, 50);
  const boosts = useQuery({ ...orpc.ads.boostStates.queryOptions({ input: { postIds: ids.length > 0 ? ids : ['00000000-0000-4000-8000-000000000000'] } }), enabled: live && ids.length > 0, retry: false });
  const suggested = useMemo(
    () => suggestBoosts(posts.data ?? [], metrics.data ?? [], new Set((boosts.data ?? []).filter((b) => !boostOver(b.state)).map((b) => b.postId)), Date.now()),
    [posts.data, metrics.data, boosts.data],
  );
  const [picked, setPicked] = useState<BoostPost | null>(null);
  if (!live) return null;
  const loading = posts.isPending || metrics.isPending || (ids.length > 0 && boosts.isPending);
  return (
    <section className="space-y-3" aria-labelledby="boost-suggest-title" data-testid="boost-suggestions">
      <h2 id="boost-suggest-title" className="text-base font-semibold text-foreground">
        {t('boost.suggestTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('boost.suggestHint')}</p>
      {loading && !posts.error ? (
        <RowsSkeleton rows={2} />
      ) : suggested.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('boost.suggestNone')}</p>
      ) : (
        <ul className="space-y-2">
          {suggested.map(({ post, engagement }) => (
            <li key={post.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3" data-testid="boost-suggestion">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{cutAt((post.title ?? '').trim() || post.body.trim().split('\n')[0] || t('boost.untitled'), 80)}</p>
                <p className="text-xs text-muted-foreground">{t('boost.suggestCount', { count: engagement })}</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setPicked(post)}>
                {t('boost.suggestOpen')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {picked !== null && options.data && <BoostPanel slug={slug} post={picked} options={options.data as AdsBoostOptions} canManage={canManage} suggestedBy onClose={() => setPicked(null)} />}
    </section>
  );
}
