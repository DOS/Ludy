// SPDX-License-Identifier: AGPL-3.0-only
// Public 2-tab Roadmap & Ideas portal (/-/roadmap/:orgSlug/:boardSlug & ?embed=1, #4399, ADR-0057).
import type { RoadmapBoardStage, RoadmapPublicItem, RoadmapPublicViewResult } from '@ludy/kernel-contract';
import { ROADMAP_BOARD_STAGES } from '@ludy/kernel-contract';
import { useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { Textarea } from '@ludy/ui/components/textarea';
import { Empty, ErrorText, ListSkeleton, Logo, ScreenTitle } from '../components/ui.tsx';
import {
  forgetRoadmapVoterToken,
  loadRoadmapVoterToken,
  PublicRoadmapError,
  publicRoadmapApi,
  readRoadmapUnsubscribeTokenFromHash,
  scrubRoadmapUrlHash,
} from '../lib/roadmap-api.ts';
import { useFormat } from '../i18n/provider.tsx';
import { toast } from '../lib/toast.ts';

type RoadmapTab = 'ideas' | 'roadmap';
type IdeaSort = 'top' | 'newest';
type PendingOtpAction =
  | { type: 'vote'; itemId: string }
  | { type: 'open_submit' };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stageBadgeVariant(stage: RoadmapPublicItem['stage']): 'secondary' | 'outline' | 'default' {
  if (stage === 'shipped') return 'default';
  if (stage === 'in_progress' || stage === 'planned') return 'secondary';
  return 'outline';
}

export function isRoadmapEmbedQuery(search?: string): boolean {
  if (typeof window === 'undefined' && search === undefined) return false;
  const raw = search ?? window.location.search;
  return new URLSearchParams(raw).get('embed') === '1';
}

export function PublicRoadmapPage({
  orgSlug: propOrgSlug,
  boardSlug: propBoardSlug,
  embed: propEmbed,
}: {
  orgSlug?: string | undefined;
  boardSlug?: string | undefined;
  embed?: boolean | undefined;
} = {}) {
  const t = useTranslations('projects.roadmap.public');
  const tc = useTranslations('common');
  const f = useFormat();
  const params = useParams({ strict: false }) as { orgSlug?: string; boardSlug?: string };
  const orgSlug = (propOrgSlug ?? params.orgSlug ?? '').trim().toLowerCase();
  const boardSlug = (propBoardSlug ?? params.boardSlug ?? '').trim().toLowerCase();
  const embed = propEmbed ?? isRoadmapEmbedQuery();

  const [view, setView] = useState<RoadmapPublicViewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [unsubscribedBanner, setUnsubscribedBanner] = useState(false);
  const [activeTab, setActiveTab] = useState<RoadmapTab>('ideas');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<'all' | RoadmapPublicItem['stage']>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<IdeaSort>('top');
  const [notifyOnShip, setNotifyOnShip] = useState(false);
  const [votingItemId, setVotingItemId] = useState<string | null>(null);

  // OTP modal state
  const [otpOpen, setOtpOpen] = useState(false);
  const [otpStep, setOtpStep] = useState<'email' | 'code'>('email');
  const [otpEmail, setOtpEmail] = useState('');
  const [otpMaskedEmail, setOtpMaskedEmail] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingOtpAction | null>(null);

  // Submit Idea modal state
  const [submitOpen, setSubmitOpen] = useState(false);
  const [ideaTitle, setIdeaTitle] = useState('');
  const [ideaSummary, setIdeaSummary] = useState('');
  const [ideaCategory, setIdeaCategory] = useState('');
  const [ideaAuthor, setIdeaAuthor] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadBoard = useCallback(
    async (opts?: { isCancelled?: () => boolean; keepUnsubscribedFalse?: boolean }) => {
      if (!orgSlug || !boardSlug) {
        if (!opts?.isCancelled?.()) {
          setUnavailable(true);
          setLoading(false);
        }
        return;
      }
      if (!opts?.isCancelled?.()) {
        setLoading(true);
        setUnavailable(false);
      }
      try {
        const data = await publicRoadmapApi.view(orgSlug, boardSlug);
        if (opts?.isCancelled?.()) return;
        setView(data);
        setNotifyOnShip(opts?.keepUnsubscribedFalse ? false : data.viewer.notifyOnShip);
      } catch (error) {
        if (opts?.isCancelled?.()) return;
        if (error instanceof PublicRoadmapError && error.status === 404) {
          setUnavailable(true);
        } else {
          setUnavailable(true);
        }
        setView(null);
      } finally {
        if (!opts?.isCancelled?.()) {
          setLoading(false);
        }
      }
    },
    [orgSlug, boardSlug],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let unsubscribedNow = false;
      if (orgSlug && boardSlug) {
        const unsubToken = readRoadmapUnsubscribeTokenFromHash();
        if (unsubToken) {
          scrubRoadmapUrlHash();
          try {
            await publicRoadmapApi.unsubscribe(orgSlug, boardSlug, unsubToken);
            if (cancelled) return;
            unsubscribedNow = true;
            setUnsubscribedBanner(true);
            setNotifyOnShip(false);
          } catch {
            // Ignore invalid unsubscribe tokens silently.
          }
        }
      }
      if (!cancelled) {
        await loadBoard({ isCancelled: () => cancelled, keepUnsubscribedFalse: unsubscribedNow });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, boardSlug, loadBoard]);

  const isVerified = Boolean(view?.viewer.verified || loadRoadmapVoterToken(orgSlug, boardSlug));

  const performVote = useCallback(
    async (itemId: string) => {
      if (!orgSlug || !boardSlug) return;
      setVotingItemId(itemId);
      try {
        const res = await publicRoadmapApi.vote(orgSlug, boardSlug, {
          itemId,
          action: 'toggle',
          notifyOnShip,
        });
        setView((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            viewer: {
              ...prev.viewer,
              verified: true,
              notifyOnShip: res.notifyOnShip ?? prev.viewer.notifyOnShip,
            },
            items: prev.items.map((it) =>
              it.id === itemId
                ? {
                    ...it,
                    viewerHasVoted: Boolean(res.voted),
                    voteCount: res.voteCount ?? it.voteCount,
                  }
                : it,
            ),
          };
        });
      } catch (error) {
        if (error instanceof PublicRoadmapError && error.code === 'ROADMAP_OTP_REQUIRED') {
          forgetRoadmapVoterToken(orgSlug, boardSlug);
          setPendingAction({ type: 'vote', itemId });
          setOtpStep('email');
          setOtpError(null);
          setOtpOpen(true);
          return;
        }
        toast(error instanceof Error ? error.message : t('voteFailed'), 'error');
      } finally {
        setVotingItemId(null);
      }
    },
    [orgSlug, boardSlug, notifyOnShip, t],
  );

  const handleVoteClick = (itemId: string) => {
    if (!view?.board.allowVoting) return;
    if (!isVerified) {
      setPendingAction({ type: 'vote', itemId });
      setOtpStep('email');
      setOtpError(null);
      setOtpOpen(true);
      return;
    }
    void performVote(itemId);
  };

  const handleOpenSubmit = () => {
    if (!view?.board.allowSubmissions) return;
    if (!isVerified) {
      setPendingAction({ type: 'open_submit' });
      setOtpStep('email');
      setOtpError(null);
      setOtpOpen(true);
      return;
    }
    setSubmitError(null);
    setSubmitOpen(true);
  };

  const handleOtpEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanEmail = otpEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setOtpError(t('otpInvalidEmail'));
      return;
    }
    setOtpBusy(true);
    setOtpError(null);
    try {
      const res = await publicRoadmapApi.requestOtp(orgSlug, boardSlug, cleanEmail);
      setOtpMaskedEmail(res.maskedEmail);
      setOtpCode('');
      setOtpStep('code');
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : t('otpRequestFailed'));
    } finally {
      setOtpBusy(false);
    }
  };

  const handleOtpVerifySubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanCode = otpCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      setOtpError(t('otpInvalidCode'));
      return;
    }
    setOtpBusy(true);
    setOtpError(null);
    try {
      const res = await publicRoadmapApi.verifyOtp(orgSlug, boardSlug, {
        email: otpEmail.trim().toLowerCase(),
        code: cleanCode,
      });
      if (!res.ok) {
        if (res.locked) {
          setOtpError(t('otpLocked'));
        } else if (res.expired) {
          setOtpError(t('otpExpired'));
        } else if (res.notReady) {
          setOtpError(t('otpNotReady'));
        } else {
          setOtpError(t('otpWrongCode', { count: String(res.attemptsRemaining) }));
        }
        return;
      }
      setOtpOpen(false);
      await loadBoard();
      const action = pendingAction;
      setPendingAction(null);
      if (action?.type === 'vote') {
        void performVote(action.itemId);
      } else if (action?.type === 'open_submit') {
        setSubmitError(null);
        setSubmitOpen(true);
      }
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : t('otpVerifyFailed'));
    } finally {
      setOtpBusy(false);
    }
  };

  const handleIdeaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanTitle = ideaTitle.trim();
    if (!cleanTitle) {
      setSubmitError(t('submitTitleRequired'));
      return;
    }
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      const res = await publicRoadmapApi.submitIdea(orgSlug, boardSlug, {
        title: cleanTitle,
        summary: ideaSummary.trim() || null,
        category: ideaCategory.trim() || null,
        displayName: ideaAuthor.trim() || null,
      });
      setSubmitOpen(false);
      setIdeaTitle('');
      setIdeaSummary('');
      setIdeaCategory('');
      if (res.item.moderationStatus === 'published') {
        toast(t('submitPublishedToast'), 'success');
      } else {
        toast(t('submitPendingToast'), 'success');
      }
      await loadBoard();
    } catch (error) {
      if (error instanceof PublicRoadmapError && error.code === 'ROADMAP_OTP_REQUIRED') {
        forgetRoadmapVoterToken(orgSlug, boardSlug);
        setSubmitOpen(false);
        setPendingAction({ type: 'open_submit' });
        setOtpStep('email');
        setOtpOpen(true);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : t('submitFailed'));
    } finally {
      setSubmitBusy(false);
    }
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of view?.items ?? []) {
      if (item.category) set.add(item.category);
    }
    return [...set].sort();
  }, [view?.items]);

  const filteredIdeas = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (view?.items ?? []).filter((item) => {
      if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.publicTitle.toLowerCase().includes(q) ||
        (item.publicSummary ?? '').toLowerCase().includes(q) ||
        (item.category ?? '').toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [view?.items, search, stageFilter, categoryFilter, sortBy]);

  const itemsByBoardStage = useMemo(() => {
    const grouped: Record<RoadmapBoardStage, RoadmapPublicItem[]> = {
      planned: [],
      in_progress: [],
      shipped: [],
    };
    for (const item of view?.items ?? []) {
      if (item.stage === 'planned' || item.stage === 'in_progress' || item.stage === 'shipped') {
        grouped[item.stage].push(item);
      }
    }
    return grouped;
  }, [view?.items]);

  return (
    <div className="min-h-screen bg-background text-foreground" data-embed={embed ? '1' : '0'}>
      <ScreenTitle name={view?.board.title ?? t('unavailableTitle')} />

      {!embed && (
        <header className="border-b border-border bg-card px-4 py-3">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Logo />
              {view && <Badge variant="outline">{view.board.orgName}</Badge>}
            </div>
            {view && (
              <span className="text-xs text-muted-foreground">
                {view.viewer.verified && view.viewer.maskedEmail
                  ? t('verifiedAs', { email: view.viewer.maskedEmail })
                  : t('publicPortalBadge')}
              </span>
            )}
          </div>
        </header>
      )}

      <main className={embed ? 'mx-auto max-w-4xl px-3 py-3' : 'mx-auto max-w-5xl px-4 py-6 pb-20 sm:px-6'}>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : unavailable || !view ? (
          <Card data-testid="public-roadmap-unavailable">
            <CardHeader>
              <CardTitle>{t('unavailableTitle')}</CardTitle>
              <CardDescription>{t('unavailableHint')}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-5">
            {unsubscribedBanner && (
              <Alert data-testid="public-roadmap-unsubscribed-banner">
                <AlertDescription>{t('unsubscribedNotice')}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">{view.board.title}</h1>
                  {embed && <Badge variant="outline">{view.board.orgName}</Badge>}
                </div>
                {view.board.description && (
                  <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{view.board.description}</p>
                )}
              </div>
              {view.board.allowSubmissions && (
                <Button
                  type="button"
                  className="min-h-11 shrink-0"
                  onClick={handleOpenSubmit}
                  data-testid="public-roadmap-submit-idea-btn"
                >
                  {t('submitIdeaButton')}
                </Button>
              )}
            </div>

            <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as RoadmapTab)} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList aria-label={t('tabsLabel')}>
                  <TabsTrigger value="ideas" className="min-h-11" data-testid="public-roadmap-tab-ideas">
                    {t('tabIdeas')}
                  </TabsTrigger>
                  <TabsTrigger value="roadmap" className="min-h-11" data-testid="public-roadmap-tab-roadmap">
                    {t('tabRoadmap')}
                  </TabsTrigger>
                </TabsList>

                {view.board.allowVoting && (
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={notifyOnShip}
                      onCheckedChange={(checked) => setNotifyOnShip(checked === true)}
                      aria-label={t('notifyOnShipLabel')}
                      data-testid="public-roadmap-notify-checkbox"
                    />
                    <span>{t('notifyOnShipLabel')}</span>
                  </label>
                )}
              </div>

              <TabsContent value="ideas" className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <Input
                      type="search"
                      aria-label={t('searchLabel')}
                      placeholder={t('searchPlaceholder')}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="min-h-11"
                      data-testid="public-roadmap-search"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <NativeSelect
                      aria-label={t('filterStageLabel')}
                      value={stageFilter}
                      onChange={(e) => setStageFilter(e.target.value as 'all' | RoadmapPublicItem['stage'])}
                      className="min-h-11 [&_select]:min-h-11"
                    >
                      <NativeSelectOption value="all">{t('allStages')}</NativeSelectOption>
                      <NativeSelectOption value="under_review">{t('stages.under_review')}</NativeSelectOption>
                      <NativeSelectOption value="planned">{t('stages.planned')}</NativeSelectOption>
                      <NativeSelectOption value="in_progress">{t('stages.in_progress')}</NativeSelectOption>
                      <NativeSelectOption value="shipped">{t('stages.shipped')}</NativeSelectOption>
                    </NativeSelect>
                    {categories.length > 0 && (
                      <NativeSelect
                        aria-label={t('filterCategoryLabel')}
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        className="min-h-11 [&_select]:min-h-11"
                      >
                        <NativeSelectOption value="all">{t('allCategories')}</NativeSelectOption>
                        {categories.map((cat) => (
                          <NativeSelectOption key={cat} value={cat}>
                            {cat}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    )}
                    <NativeSelect
                      aria-label={t('sortLabel')}
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as IdeaSort)}
                      className="min-h-11 [&_select]:min-h-11"
                    >
                      <NativeSelectOption value="top">{t('sortTop')}</NativeSelectOption>
                      <NativeSelectOption value="newest">{t('sortNewest')}</NativeSelectOption>
                    </NativeSelect>
                  </div>
                </div>

                {filteredIdeas.length === 0 ? (
                  <Empty title={t('emptyIdeas')} hint={t('emptyIdeasHint')} />
                ) : (
                  <ul className="space-y-3" data-testid="public-roadmap-ideas-list">
                    {filteredIdeas.map((item) => (
                      <li key={item.id}>
                        <Card className="p-4" data-testid={`public-roadmap-item-${item.id}`}>
                          <div className="flex items-start gap-4">
                            <Button
                              type="button"
                              variant={item.viewerHasVoted ? 'default' : 'outline'}
                              className="flex min-h-11 min-w-14 shrink-0 flex-col items-center justify-center gap-0.5 px-3 py-2 tabular-nums"
                              disabled={!view.board.allowVoting || votingItemId === item.id}
                              aria-pressed={item.viewerHasVoted}
                              aria-label={t('voteAriaLabel', { title: item.publicTitle, count: String(item.voteCount) })}
                              onClick={() => handleVoteClick(item.id)}
                              data-testid={`public-roadmap-vote-${item.id}`}
                            >
                              <span aria-hidden="true" className="text-xs leading-none">▲</span>
                              <span className="text-sm font-semibold">{item.voteCount}</span>
                            </Button>

                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-base font-semibold leading-snug text-foreground">{item.publicTitle}</h2>
                                <Badge variant={stageBadgeVariant(item.stage)}>{t(`stages.${item.stage}`)}</Badge>
                                {item.category && <Badge variant="outline">{item.category}</Badge>}
                              </div>
                              {item.publicSummary && (
                                <p className="text-sm leading-relaxed text-muted-foreground">{item.publicSummary}</p>
                              )}
                              <div className="flex flex-wrap items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                                {item.submitterDisplayName && <span>{t('submittedBy', { name: item.submitterDisplayName })}</span>}
                                <span>{f.date(item.createdAt)}</span>
                              </div>
                            </div>
                          </div>
                        </Card>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="roadmap" data-testid="public-roadmap-board">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  {ROADMAP_BOARD_STAGES.map((stage) => {
                    const colItems = itemsByBoardStage[stage];
                    return (
                      <Card key={stage} className="flex flex-col gap-3 p-4" data-testid={`public-roadmap-col-${stage}`}>
                        <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
                          <h2 className="text-sm font-semibold text-foreground">{t(`stages.${stage}`)}</h2>
                          <Badge variant="secondary" className="tabular-nums">
                            {colItems.length}
                          </Badge>
                        </div>
                        {colItems.length === 0 ? (
                          <p className="py-4 text-xs text-muted-foreground">{t('emptyStage')}</p>
                        ) : (
                          <ul className="space-y-2.5">
                            {colItems.map((item) => (
                              <li key={item.id} className="rounded-lg border border-border bg-background p-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 space-y-1">
                                    <p className="text-sm font-medium leading-snug text-foreground">{item.publicTitle}</p>
                                    {item.category && <Badge variant="outline">{item.category}</Badge>}
                                  </div>
                                  <Button
                                    type="button"
                                    variant={item.viewerHasVoted ? 'default' : 'outline'}
                                    size="sm"
                                    className="min-h-11 min-w-11 shrink-0 tabular-nums"
                                    disabled={!view.board.allowVoting || votingItemId === item.id}
                                    aria-pressed={item.viewerHasVoted}
                                    aria-label={t('voteAriaLabel', { title: item.publicTitle, count: String(item.voteCount) })}
                                    onClick={() => handleVoteClick(item.id)}
                                  >
                                    <span aria-hidden="true">▲</span>
                                    <span>{item.voteCount}</span>
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>

      <Dialog open={otpOpen} onOpenChange={setOtpOpen}>
        <DialogContent closeLabel={tc('close')} data-testid="public-roadmap-otp-dialog">
          <DialogHeader>
            <DialogTitle>{t('otpTitle')}</DialogTitle>
            <DialogDescription>
              {otpStep === 'email'
                ? t('otpEmailDesc')
                : t('otpCodeDesc', { email: otpMaskedEmail ?? otpEmail.trim().toLowerCase() })}
            </DialogDescription>
          </DialogHeader>

          {otpStep === 'email' ? (
            <form onSubmit={(e) => void handleOtpEmailSubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="roadmap-otp-email">{t('otpEmailLabel')}</Label>
                <Input
                  id="roadmap-otp-email"
                  type="email"
                  required
                  value={otpEmail}
                  onChange={(e) => setOtpEmail(e.target.value)}
                  placeholder={t('otpEmailPlaceholder')}
                  className="min-h-11"
                  data-testid="public-roadmap-otp-email-input"
                />
              </div>
              {otpError && <ErrorText>{otpError}</ErrorText>}
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{t('cancel')}</DialogClose>
                <Button type="submit" disabled={otpBusy} className="min-h-11" data-testid="public-roadmap-otp-send-btn">
                  {otpBusy ? t('sending') : t('otpSendBtn')}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form onSubmit={(e) => void handleOtpVerifySubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="roadmap-otp-code">{t('otpCodeLabel')}</Label>
                <Input
                  id="roadmap-otp-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="123456"
                  className="min-h-11 tracking-widest"
                  data-testid="public-roadmap-otp-code-input"
                />
              </div>
              {otpError && <ErrorText>{otpError}</ErrorText>}
              <DialogFooter className="flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => {
                    setOtpStep('email');
                    setOtpError(null);
                  }}
                >
                  {t('otpChangeEmail')}
                </Button>
                <Button type="submit" disabled={otpBusy} className="min-h-11" data-testid="public-roadmap-otp-verify-btn">
                  {otpBusy ? t('verifying') : t('otpVerifyBtn')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent closeLabel={tc('close')} data-testid="public-roadmap-submit-dialog">
          <DialogHeader>
            <DialogTitle>{t('submitModalTitle')}</DialogTitle>
            <DialogDescription>{t('submitModalDesc')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleIdeaSubmit(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="roadmap-idea-title">{t('ideaTitleLabel')}</Label>
              <Input
                id="roadmap-idea-title"
                required
                maxLength={200}
                value={ideaTitle}
                onChange={(e) => setIdeaTitle(e.target.value)}
                placeholder={t('ideaTitlePlaceholder')}
                className="min-h-11"
                data-testid="public-roadmap-idea-title-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-idea-summary">{t('ideaSummaryLabel')}</Label>
              <Textarea
                id="roadmap-idea-summary"
                rows={4}
                maxLength={4000}
                value={ideaSummary}
                onChange={(e) => setIdeaSummary(e.target.value)}
                placeholder={t('ideaSummaryPlaceholder')}
                data-testid="public-roadmap-idea-summary-input"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="roadmap-idea-category">{t('ideaCategoryLabel')}</Label>
                <Input
                  id="roadmap-idea-category"
                  maxLength={60}
                  value={ideaCategory}
                  onChange={(e) => setIdeaCategory(e.target.value)}
                  placeholder={t('ideaCategoryPlaceholder')}
                  className="min-h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="roadmap-idea-author">{t('ideaAuthorLabel')}</Label>
                <Input
                  id="roadmap-idea-author"
                  maxLength={80}
                  value={ideaAuthor}
                  onChange={(e) => setIdeaAuthor(e.target.value)}
                  placeholder={t('ideaAuthorPlaceholder')}
                  className="min-h-11"
                />
              </div>
            </div>
            {submitError && <ErrorText>{submitError}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{t('cancel')}</DialogClose>
              <Button type="submit" disabled={submitBusy} className="min-h-11" data-testid="public-roadmap-idea-submit-btn">
                {submitBusy ? t('submitting') : t('submitIdeaConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
