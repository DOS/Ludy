// SPDX-License-Identifier: AGPL-3.0-only
// The panel that boosts a published Social post (ads W3, issue #3834, plan docs/plan/ads-write.md section 10): the shared side panel (Sheet, DESIGN.md 4.5) with the
// goal, the most to spend, the days and the audience preset. It makes a draft from the post (`ads.draftBoost`, the very draft the campaign builder makes) and then shows
// what an approver will sign: the largest amount it can spend and what is still to fix. An owner or an admin asks for the approval with the same request as any plan
// (`ads.requestChange`, campaign_launch); a member only drafts. Nothing here calls an ad platform, and nothing is approved here. The AI coworker may have suggested
// the post and prefilled these fields; every field stays editable and a person sends it. The server decides every rule; the panel offers what can succeed.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ADS_BOOST_LIMITS, zAdsBudget, type AdsBoostAudience, type AdsBoostDrafted, type AdsBoostGoal, type AdsBoostOptions } from '@ludy/kernel-contract';
import { Alert } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { keyFor, type KeyHolder } from '../lib/ads.ts';
import { issueText } from '../lib/ads-campaigns.ts';
import { audienceText, BOOST_AUDIENCES, BOOST_DAYS, boostCopy, boostDefaults, boostGoals, boostLink, boostPage, goalHintText, goalText, type BoostDefaults, type BoostPost } from '../lib/ads-boost.ts';
import { parseMoneyInput } from '../lib/money-input.ts';
import { toast } from '../lib/toast.ts';
import { FormPanel } from './form-panel.tsx';
import { ErrorText, Field, focusFirstInvalid } from './ui.tsx';

// The boosts of posts, and the drafts and committed spend they make, are read again after a draft or a request.
export const refreshBoosts = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.ads.boostStates.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDrafts.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDraft.key() }),
  ]);

const budgetOk = (text: string): string | null => {
  const canonical = parseMoneyInput(text) ?? text.trim();
  return zAdsBudget.safeParse(canonical).success ? canonical : null;
};
const httpsOk = (text: string): boolean => {
  try {
    return new URL(text.trim()).protocol === 'https:' && text.trim().length <= 2000;
  } catch {
    return false;
  }
};

export function BoostPanel({
  slug,
  post,
  options,
  canManage,
  prefill,
  accountId: startAccountId,
  suggestedBy = false,
  onClose,
}: {
  slug: string;
  post: BoostPost;
  options: AdsBoostOptions;
  canManage: boolean;
  // What the form starts with, when something (the AI coworker's suggestion) chose it; else the defaults for the post.
  prefill?: Partial<BoostDefaults>;
  // The ad account to start with: the one a draft being continued belongs to (else the first).
  accountId?: string;
  // Whether the AI coworker suggested this post, so the panel says so.
  suggestedBy?: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const accounts = options.accounts;
  const [accountId, setAccountId] = useState(accounts.find((a) => a.id === startAccountId)?.id ?? accounts[0]?.id ?? '');
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const currency = account?.currency ?? 'VND';
  const start = { ...boostDefaults(post, currency), ...prefill };
  const copy = boostCopy(post);
  const ownPage = boostPage(post, options.pages);
  const goals = boostGoals(post);
  const [goal, setGoal] = useState<AdsBoostGoal>(goals.includes(start.goal) ? start.goal : (goals[0] ?? 'messages'));
  const [budget, setBudget] = useState(start.budget);
  const [days, setDays] = useState<number>(start.days);
  const [audience, setAudience] = useState<AdsBoostAudience>(start.audience);
  const [pageId, setPageId] = useState(ownPage ?? options.pages[0]?.id ?? '');
  const [headline, setHeadline] = useState(copy.headline);
  const [primaryText, setPrimaryText] = useState(copy.primaryText);
  const [link, setLink] = useState(boostLink(post) ?? '');
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<AdsBoostDrafted | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const draftAttempt = useRef<KeyHolder | null>(null);
  const sendAttempt = useRef<KeyHolder | null>(null);

  const needsLink = goal !== 'messages';
  const problems = {
    budget: budgetOk(budget) === null,
    link: needsLink && !httpsOk(link),
    page: pageId === '',
    text: headline.trim() === '' || primaryText.trim() === '',
  };

  const draft = useMutation(
    orpc.ads.draftBoost.mutationOptions({
      onSuccess: async (made) => {
        draftAttempt.current = null;
        setResult(made);
        setProposalId(made.draft.pendingProposalId);
        await refreshBoosts();
      },
    }),
  );
  const send = useMutation(
    orpc.ads.requestChange.mutationOptions({
      onSuccess: async ({ proposalId: id }) => {
        sendAttempt.current = null;
        setProposalId(id);
        await refreshBoosts();
        toast(t('boost.sent'));
      },
    }),
  );

  const onMake = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    setAttempted(true);
    if (account === undefined || Object.values(problems).some(Boolean)) {
      // The fields marked invalid are painted on the next render; the first takes the focus after it.
      requestAnimationFrame(() => focusFirstInvalid(target));
      return;
    }
    const body = {
      adAccountId: account.id,
      postId: post.id,
      goal,
      budget: budgetOk(budget) as string,
      days,
      audience,
      creative: { headline: headline.trim(), primaryText: primaryText.trim() },
      linkUrl: needsLink ? link.trim() : null,
      pageConnectionId: pageId,
    };
    // A retry of the same form after a lost answer is the same request; a changed form is another.
    draftAttempt.current = keyFor(draftAttempt.current, JSON.stringify(body));
    draft.mutate({ ...body, idempotencyKey: draftAttempt.current.key });
  };

  const onSend = () => {
    if (!result) return;
    sendAttempt.current = keyFor(sendAttempt.current, `${result.draft.id}:${result.draft.revision}`);
    send.mutate({ change: 'campaign_launch', draftId: result.draft.id, idempotencyKey: sendAttempt.current.key });
  };

  if (result) {
    const d = result.draft;
    const errors = d.issues.filter((i) => i.severity === 'error');
    const warnings = d.issues.filter((i) => i.severity === 'warning');
    const waiting = proposalId !== null;
    const daily = d.plan.dailyBudget ?? null;
    return (
      <FormPanel
        title={t('boost.resultTitle')}
        description={t('boost.resultHint')}
        onClose={onClose}
        busy={send.isPending}
        footer={
          <>
            {!waiting && (
              <Button type="button" variant="outline" onClick={() => setResult(null)} disabled={send.isPending}>
                {t('boost.back')}
              </Button>
            )}
            {canManage && !waiting && (
              <Button type="button" onClick={onSend} disabled={errors.length > 0 || send.isPending || d.currency === null} data-testid="boost-send">
                {send.isPending ? t('boost.sending') : t('boost.send')}
              </Button>
            )}
            <Button type="button" variant={waiting ? 'default' : 'outline'} onClick={onClose}>
              {t('boost.close')}
            </Button>
          </>
        }
      >
        <div className="space-y-4" data-testid="boost-result">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{d.plan.name}</p>
            <Badge variant={waiting ? 'warning' : 'outline'}>{waiting ? t('boost.state.waiting_approval') : t('boost.state.draft')}</Badge>
          </div>
          {d.maxSpend !== null && d.currency !== null && d.days !== null && daily !== null ? (
            <p className="text-sm text-foreground" data-testid="boost-max-spend">
              {t('boost.maxSpend', { amount: f.money(d.maxSpend, d.currency), days: d.days, daily: f.money(daily, d.currency) })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('boost.noStart')}</p>
          )}
          {d.plan.startOn && d.plan.endOn && <p className="text-xs text-muted-foreground">{t('boost.starts', { start: f.date(d.plan.startOn), end: f.date(d.plan.endOn) })}</p>}
          {!waiting && errors.length > 0 && (
            <Alert variant="destructive" className="border-destructive/30 bg-destructive/10" data-testid="boost-issues">
              <p className="font-medium">{t('boost.issuesTitle')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {errors.map((issue, i) => (
                  <li key={`${issue.code}:${i}`}>{issueText(issue, root, f.date)}</li>
                ))}
              </ul>
            </Alert>
          )}
          {!waiting && warnings.length > 0 && (
            <Alert data-testid="boost-warnings">
              <p className="font-medium">{t('boost.warningsTitle')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {warnings.map((issue, i) => (
                  <li key={`${issue.code}:${i}`}>{issueText(issue, root, f.date)}</li>
                ))}
              </ul>
            </Alert>
          )}
          {waiting ? (
            <Alert role="status" data-testid="boost-waiting">
              <span>{t('boost.waitingNote')} </span>
              <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposalId }} className="text-link hover:underline">
                {t('boost.viewInbox')}
              </Link>
            </Alert>
          ) : (
            !canManage && <p className="text-sm text-muted-foreground">{t('boost.memberNote')}</p>
          )}
          {send.error && <ErrorText>{errorMessage(send.error)}</ErrorText>}
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel
      title={t('boost.panelTitle')}
      description={t('boost.panelHint')}
      onClose={onClose}
      busy={draft.isPending}
      onSubmit={onMake}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={draft.isPending}>
            {t('boost.close')}
          </Button>
          <Button type="submit" disabled={draft.isPending || account === undefined} data-testid="boost-make">
            {draft.isPending ? t('boost.making') : t('boost.makeDraft')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="boost-form">
        {suggestedBy && (
          <p>
            <Badge variant="proposal">{t('boost.suggestedBy')}</Badge>
          </p>
        )}
        {accounts.length > 1 && (
          <Field label={t('boost.account')}>
            {(control) => (
              <NativeSelect {...control} className="w-full" value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label={t('boost.goal')} hint={goalHintText(goal, root)}>
          {(control) => (
            <NativeSelect {...control} className="w-full" value={goal} onChange={(e) => setGoal(e.target.value as AdsBoostGoal)}>
              {goals.map((g) => (
                <NativeSelectOption key={g} value={g}>
                  {goalText(g, root)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('boost.budget')} hint={t('boost.budgetHint', { currency })} error={attempted && problems.budget ? t('boost.budgetFormat') : undefined}>
          {(control) => <Input {...control} inputMode="decimal" autoComplete="off" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={attempted && problems.budget ? true : undefined} />}
        </Field>
        <Field label={t('boost.days')}>
          {(control) => (
            <NativeSelect {...control} className="w-full" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {BOOST_DAYS.map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {t('boost.daysOption', { days: n })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('boost.audience')}>
          {(control) => (
            <NativeSelect {...control} className="w-full" value={audience} onChange={(e) => setAudience(e.target.value as AdsBoostAudience)}>
              {BOOST_AUDIENCES.map((a) => (
                <NativeSelectOption key={a} value={a}>
                  {audienceText(a, root)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        {ownPage !== null ? (
          <p className="text-xs text-muted-foreground">{t('boost.pageOwn', { name: options.pages.find((p) => p.id === ownPage)?.name ?? '' })}</p>
        ) : options.pages.length === 0 ? (
          <Alert role="status">{t('boost.pageNone')}</Alert>
        ) : (
          <Field label={t('boost.page')} error={attempted && problems.page ? t('boost.pageNeeded') : undefined}>
            {(control) => (
              <NativeSelect {...control} className="w-full" value={pageId} onChange={(e) => setPageId(e.target.value)} aria-invalid={attempted && problems.page ? true : undefined}>
                {options.pages.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label={t('boost.headline')} error={attempted && problems.text && headline.trim() === '' ? t('boost.textNeeded') : undefined}>
          {(control) => <Input {...control} maxLength={ADS_BOOST_LIMITS.headlineMax} value={headline} onChange={(e) => setHeadline(e.target.value)} aria-invalid={attempted && headline.trim() === '' ? true : undefined} />}
        </Field>
        <Field label={t('boost.primaryText')} hint={t('boost.textHint')} error={attempted && problems.text && primaryText.trim() === '' ? t('boost.textNeeded') : undefined}>
          {(control) => <Textarea {...control} rows={4} maxLength={ADS_BOOST_LIMITS.primaryTextMax} value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} aria-invalid={attempted && primaryText.trim() === '' ? true : undefined} />}
        </Field>
        {needsLink && (
          <Field label={t('boost.link')} error={attempted && problems.link ? (link.trim() === '' ? t('boost.linkNeeded') : t('boost.linkFormat')) : undefined}>
            {(control) => <Input {...control} type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} aria-invalid={attempted && problems.link ? true : undefined} />}
          </Field>
        )}
        {draft.error && <ErrorText>{errorMessage(draft.error)}</ErrorText>}
      </div>
    </FormPanel>
  );
}
