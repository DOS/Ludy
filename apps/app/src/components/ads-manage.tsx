// SPDX-License-Identifier: AGPL-3.0-only
// Managing a running ad (ads W4, issue #3835, plan docs/plan/ads-write.md): the "Manage" section of a live launch on the Campaigns screen and the suggestion cards of the AI
// coworker of marketing. Owners and admins pause, resume or archive the campaign, the ad set and each ad, lower or raise the daily budget and shorten or extend the schedule;
// members see the state and no button. A pause, an archive, a lower budget and a shorter schedule only reduce spend, so they apply without approval (once the platform confirms
// them); a resume, a raise and an extension make a request for approval in the Inbox and change nothing until it is approved. A change stays "waiting for the platform" until the
// platform confirms it. The server decides every rule (the switches, the caps, the approval); the screen only offers what can work and words the refusals. The AI coworker only
// suggests, in a card with one button that asks for a confirm and is the person's own click: it never applies a change and never suggests a raise, and the core works with none.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { AdsLaunchView, AdsManageChangeView, AdsManageObjectView, AdsManageStateView, AdsManageSuggestion } from '@ludy/kernel-contract';
import { Alert } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { keyFor, type KeyHolder } from '../lib/ads.ts';
import { visibleBidi } from '../lib/ads-change.ts';
import { launchObjectLevelText } from '../lib/ads-campaigns.ts';
import {
  addsSpend,
  budgetInput,
  budgetProblemText,
  changeReasonText,
  changeSentence,
  changeStateText,
  changeStateVariant,
  endInput,
  endProblemText,
  heldBudgetHigher,
  heldEndLater,
  manageErrorText,
  manageOffers,
  objectStatusText,
  objectStatusVariant,
  plainDecimal,
  requestSignature,
  runManage,
  shiftDay,
  suggestionRequest,
  type ManageOffers,
  type ManageOutcome,
  type ManageRequest,
  type ObjectOffer,
} from '../lib/ads-manage.ts';
import { tidyMoneyInput } from '../lib/money-input.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ErrorText, Field, focusFirstInvalid } from './ui.tsx';

const H3 = 'text-sm font-medium text-foreground';

// What a change touches is read again after it: the drafts carry the launch's management state, the suggestions are worked out from the same launches, and a request for
// approval changes the waiting list on the Ads screen.
export const refreshManage = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDrafts.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDraft.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.committed.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.manageState.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.manageSuggestions.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.writeState.key() }),
  ]);

interface Attempt {
  request: ManageRequest;
  key: string;
}

// One call of a request, with the idempotency key of its attempt, and what to do after it. Shared by the Manage section and the suggestion cards.
function useManageCall(onDone: (outcome: ManageOutcome, request: ManageRequest) => void) {
  const attempt = useRef<KeyHolder | null>(null);
  const call = useMutation<ManageOutcome, Error, Attempt>({
    mutationFn: ({ request, key }) => runManage(client.ads, request, key),
    onSuccess: async (outcome, { request }) => {
      attempt.current = null;
      await refreshManage();
      onDone(outcome, request);
    },
  });
  // A retry of the same request after a lost answer is the same request (the same key); a changed one is another.
  const send = (request: ManageRequest, after?: () => void) => {
    attempt.current = keyFor(attempt.current, requestSignature(request));
    call.mutate({ request, key: attempt.current.key }, after ? { onSuccess: after } : undefined);
  };
  return { send, call };
}

const toastOf = (outcome: ManageOutcome, request: ManageRequest): 'cancelledToast' | 'askedToast' | 'sentToast' => (request.kind === 'cancel' ? 'cancelledToast' : outcome.proposalId !== null ? 'askedToast' : 'sentToast');

// ---- The Manage section of a live launch ----

export function ManageSection({ launch, canManage, slug }: { launch: AdsLaunchView; canManage: boolean; slug: string }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const headingId = useId();
  const [asked, setAsked] = useState<string | null>(null);
  // The forms are made again (empty) after a change went through; one that was refused keeps what was typed.
  const [round, setRound] = useState(0);
  const { send, call } = useManageCall((outcome, request) => {
    setAsked(outcome.proposalId);
    toast(t(`manage.${toastOf(outcome, request)}`));
  });
  const { manage } = launch;
  // Changes apply only to a live launch; a stopped or finished one has nothing to manage.
  if (launch.state !== 'live' || manage === undefined) return null;
  const offers = manageOffers({ canManage, launchState: launch.state, manage });
  const fmt = { money: (amount: string, currency: string) => f.money(amount, currency), date: (day: string) => f.date(day) };
  const busy = call.isPending;
  const request = (next: ManageRequest) => {
    setAsked(null);
    send(next, () => setRound((n) => n + 1));
  };
  const changes = [...manage.changes].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, SHOWN_CHANGES);
  const error = call.error ? (manageErrorText(call.error, root, fmt, manage.currency) ?? errorMessage(call.error)) : null;
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby={headingId} data-testid="campaign-manage">
      <div className="space-y-1">
        <h3 id={headingId} className="text-base font-semibold text-foreground">
          {t('manage.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{offers.controls ? t('manage.intro') : t('manage.readOnly')}</p>
      </div>

      <div className="space-y-1 text-sm" data-testid="manage-now">
        <p className="font-medium text-foreground">{t('manage.budgetNow', { amount: f.money(manage.dailyBudget, manage.currency) })}</p>
        <p className="font-medium text-foreground">{t('manage.endNow', { date: f.date(manage.endOn) })}</p>
        {heldBudgetHigher(manage) && (
          <p className="text-muted-foreground" data-testid="manage-held-budget">
            {t('manage.heldBudget', { amount: f.money(manage.heldDailyBudget, manage.currency) })}
          </p>
        )}
        {heldEndLater(manage) && (
          <p className="text-muted-foreground" data-testid="manage-held-end">
            {t('manage.heldEnd', { date: f.date(manage.heldEndOn) })}
          </p>
        )}
      </div>

      {offers.limited && (
        <Alert role="status" data-testid="manage-limited">
          {t('manage.limited')}
        </Alert>
      )}

      <div className="space-y-2">
        <h4 className={H3}>{t('manage.objectsTitle')}</h4>
        <ul className="space-y-2" data-testid="manage-objects">
          {manage.objects.map((object) => (
            <ObjectRow key={object.slot} object={object} offers={offers.objects[object.slot] ?? []} busy={busy} onRequest={(kind) => request({ kind, launchId: manage.launchId, slot: object.slot })} />
          ))}
        </ul>
        {offers.controls && !offers.limited && manage.objects.some((o) => (offers.objects[o.slot] ?? []).includes('resume')) && <p className="text-xs text-muted-foreground">{t('manage.resumeNote')}</p>}
      </div>

      {offers.controls && !offers.limited && <ManageForms key={round} manage={manage} offers={offers} busy={busy} busyKind={call.variables?.request.kind ?? null} onRequest={request} />}

      {asked !== null && <AskedNote slug={slug} proposalId={asked} />}
      {error !== null && <ErrorText>{error}</ErrorText>}

      <div className="space-y-2">
        <h4 className={H3}>{t('manage.changesTitle')}</h4>
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('manage.changesNone')}</p>
        ) : (
          <ul className="space-y-2" data-testid="manage-changes">
            {changes.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                objects={manage.objects}
                currency={manage.currency}
                canCancel={offers.controls}
                busy={busy}
                onCancel={() => request({ kind: 'cancel', changeId: change.id })}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// After a request for approval: it waits in the Inbox, and the link opens the item (like the launch's own "waiting for approval" note).
export function AskedNote({ slug, proposalId }: { slug: string; proposalId: string }) {
  const t = useTranslations('ads');
  return (
    <Alert role="status" data-testid="manage-asked">
      <span>{t('manage.asked')} </span>
      <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposalId }} className="text-link hover:underline">
        {t('manage.openInbox')}
      </Link>
    </Alert>
  );
}

// The newest changes the list keeps in view.
const SHOWN_CHANGES = 8;

// One object of the launch: its level, name and status, and what can be done to it now. A pause and a resume go at once (a resume asks for approval, a pause applies without);
// an archive is permanent and asks first. While a change of the object waits for the platform it offers nothing.
export function ObjectRow({ object, offers, busy, onRequest }: { object: AdsManageObjectView; offers: readonly ObjectOffer[]; busy: boolean; onRequest: (kind: ObjectOffer) => void }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const name = visibleBidi(object.name);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="manage-object" data-slot={object.slot}>
      <div className="min-w-0 space-y-0.5">
        <p className="break-words text-foreground">
          {launchObjectLevelText(object.level, root)}: <span className="font-medium">{name}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={objectStatusVariant(object.status)}>{objectStatusText(object.status, root)}</Badge>
          {object.pending !== null && <span className="text-xs text-muted-foreground">{t('manage.objectWaiting')}</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {offers.includes('pause') && (
          <Button type="button" size="sm" variant="outline" loading={busy} aria-label={t('manage.pauseOf', { name })} data-testid="manage-pause" onClick={() => onRequest('pause')}>
            {t('manage.pause')}
          </Button>
        )}
        {offers.includes('resume') && (
          <Button type="button" size="sm" variant="outline" loading={busy} aria-label={t('manage.resumeOf', { name })} data-testid="manage-resume" onClick={() => onRequest('resume')}>
            {t('manage.resume')}
          </Button>
        )}
        {offers.includes('archive') && (
          <ConfirmDialog
            render={<Button type="button" size="sm" variant="outline" aria-label={t('manage.archiveOf', { name })} data-testid="manage-archive" />}
            destructive
            title={t('manage.archiveTitle', { name })}
            description={t('manage.archiveBody', { name })}
            confirm={t('manage.archiveConfirm')}
            onConfirm={() => onRequest('archive')}
          >
            {t('manage.archive')}
          </ConfirmDialog>
        )}
      </div>
    </li>
  );
}

// One change asked: the sentence, its state in words and why when it did not go through, and a way to cancel one that still waits for the platform.
export function ChangeRow({ change, objects, currency, canCancel, busy, onCancel }: { change: AdsManageChangeView; objects: readonly AdsManageObjectView[]; currency: string; canCancel: boolean; busy: boolean; onCancel: () => void }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const sentence = changeSentence(change, objects, currency, root, { money: (amount, cur) => f.money(amount, cur), date: (day) => f.date(day) });
  return (
    <li className="space-y-1 rounded-lg border p-3 text-sm" data-testid="manage-change" data-state={change.state} data-kind={change.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-foreground">{sentence}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={changeStateVariant(change.state)}>{changeStateText(change.state, root)}</Badge>
          {change.state === 'queued' && canCancel && (
            <Button type="button" size="sm" variant="outline" loading={busy} aria-label={t('manage.cancelOf', { what: sentence })} data-testid="manage-cancel" onClick={onCancel}>
              {t('manage.cancel')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('manage.changeAsked', { when: f.dateTime(change.requestedAt) })}</p>
      {(change.state === 'failed' || change.state === 'cancelled') && change.code !== null && (
        <p className="text-xs text-muted-foreground" data-testid="manage-change-reason">
          {t('manage.changeReason', { reason: changeReasonText(change.code, root) })}
        </p>
      )}
      {change.state === 'unclear' && addsSpend(change.kind) && (
        <p className="text-xs text-muted-foreground" data-testid="manage-change-held">
          {t('manage.unclearHeld')}
        </p>
      )}
    </li>
  );
}

// The budget and the schedule are the ad set's: two forms for each, one that lowers (shortens) and applies without approval, and one that asks for approval.
function ManageForms({ manage, offers, busy, busyKind, onRequest }: { manage: AdsManageStateView; offers: ManageOffers; busy: boolean; busyKind: ManageRequest['kind'] | null; onRequest: (request: ManageRequest) => void }) {
  const t = useTranslations('ads');
  const budget = (kind: 'budget_lower' | 'budget_raise') => (
    <MoneyForm
      kind={kind}
      launchId={manage.launchId}
      currency={manage.currency}
      held={manage.heldDailyBudget}
      busy={busy && busyKind === kind}
      onRequest={onRequest}
    />
  );
  const schedule = (kind: 'schedule_shorten' | 'schedule_extend') => <DateForm kind={kind} launchId={manage.launchId} held={manage.heldEndOn} busy={busy && busyKind === kind} onRequest={onRequest} />;
  return (
    <div className="space-y-4">
      <div className="space-y-3" data-testid="manage-budget">
        <h4 className={H3}>{t('manage.budgetTitle')}</h4>
        {offers.budgetWaiting && <p className="text-sm text-muted-foreground">{t('manage.budgetWaiting')}</p>}
        {offers.lowerBudget && budget('budget_lower')}
        {offers.raiseBudget && budget('budget_raise')}
      </div>
      <div className="space-y-3" data-testid="manage-schedule">
        <h4 className={H3}>{t('manage.scheduleTitle')}</h4>
        {offers.scheduleWaiting && <p className="text-sm text-muted-foreground">{t('manage.scheduleWaiting')}</p>}
        {offers.shortenSchedule && schedule('schedule_shorten')}
        {offers.extendSchedule && schedule('schedule_extend')}
      </div>
    </div>
  );
}

const MONEY_COPY = {
  budget_lower: { title: 'lowerTitle', label: 'lowerLabel', hint: 'lowerHint', button: 'lowerButton' },
  budget_raise: { title: 'raiseTitle', label: 'raiseLabel', hint: 'raiseHint', button: 'raiseButton' },
} as const;

// A daily budget typed as people type money in Vietnam ("100.000", "1,5"), checked against the budget held now before it is sent: the same format as the plan's budget, at most the
// currency's decimals, below the held one to lower and above it to raise.
function MoneyForm({ kind, launchId, currency, held, busy, onRequest }: { kind: 'budget_lower' | 'budget_raise'; launchId: string; currency: string; held: string; busy: boolean; onRequest: (request: ManageRequest) => void }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<ReturnType<typeof budgetInput> | null>(null);
  const copy = MONEY_COPY[kind];
  const heldText = f.money(held, currency);
  const failure = problem !== null && !problem.ok ? budgetProblemText(problem.problem, root, { held: heldText, currency, ...(problem.decimals !== undefined ? { decimals: problem.decimals } : {}) }) : undefined;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    const checked = budgetInput(text, kind, held, currency);
    setProblem(checked);
    if (!checked.ok) {
      // The error is drawn on the next render; the focus goes to the field once it is marked.
      requestAnimationFrame(() => focusFirstInvalid(target));
      return;
    }
    onRequest({ kind, launchId, dailyBudget: checked.value });
  };
  return (
    <form className="space-y-2" onSubmit={submit} noValidate aria-label={t(`manage.${copy.title}`)} data-testid={`manage-form-${kind}`}>
      <div className="flex flex-wrap items-start gap-3">
        <Field label={t(`manage.${copy.label}`)} hint={t(`manage.${copy.hint}`, { amount: heldText })} error={failure} className="w-64">
          {(control) => (
            <div className="flex items-center gap-2">
              <Input
                {...control}
                inputMode="decimal"
                autoComplete="off"
                value={text}
                onChange={(e) => {
                  setText(e.target.value.trim());
                  setProblem(null);
                }}
                onBlur={() => setText(tidyMoneyInput(text))}
              />
              <span className="text-sm text-muted-foreground">{currency}</span>
            </div>
          )}
        </Field>
        <Button type="submit" size="lg" variant="outline" loading={busy} className="mt-5">
          {t(`manage.${copy.button}`)}
        </Button>
      </div>
    </form>
  );
}

const DATE_COPY = {
  schedule_shorten: { title: 'shortenTitle', label: 'shortenLabel', hint: 'shortenHint', button: 'shortenButton' },
  schedule_extend: { title: 'extendTitle', label: 'extendLabel', hint: 'extendHint', button: 'extendButton' },
} as const;

// A new end date, shorter or longer than the one held now. The date field refuses a day on the wrong side of it; the server checks it against today and the longest flight.
function DateForm({ kind, launchId, held, busy, onRequest }: { kind: 'schedule_shorten' | 'schedule_extend'; launchId: string; held: string; busy: boolean; onRequest: (request: ManageRequest) => void }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<ReturnType<typeof endInput> | null>(null);
  const copy = DATE_COPY[kind];
  const heldText = f.date(held);
  const failure = problem !== null && !problem.ok ? endProblemText(problem.problem, root, heldText) : undefined;
  const bounds = kind === 'schedule_shorten' ? { max: shiftDay(held, -1) } : { min: shiftDay(held, 1) };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    const checked = endInput(value, kind, held);
    setProblem(checked);
    if (!checked.ok || target.querySelector('[aria-invalid="true"]')) {
      requestAnimationFrame(() => focusFirstInvalid(target));
      return;
    }
    onRequest({ kind, launchId, endOn: checked.value });
  };
  return (
    <form className="space-y-2" onSubmit={submit} noValidate aria-label={t(`manage.${copy.title}`)} data-testid={`manage-form-${kind}`}>
      <div className="flex flex-wrap items-start gap-3">
        <Field label={t(`manage.${copy.label}`)} hint={t(`manage.${copy.hint}`, { date: heldText })} error={failure} className="w-56">
          {(control) => (
            <DateInput
              {...control}
              value={value}
              {...bounds}
              onChange={(next) => {
                setValue(next);
                setProblem(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" size="lg" variant="outline" loading={busy} className="mt-5">
          {t(`manage.${copy.button}`)}
        </Button>
      </div>
    </form>
  );
}

// ---- The AI coworker's suggestions ----

// A campaign that spends with poor results: the plain sentence with the figures and ONE button, behind a confirm, that makes the pause or the lower budget with the person's own
// click. The card never applies anything on its own and never offers a raise.
export function SuggestionCard({ suggestion, busy, onApply }: { suggestion: AdsManageSuggestion; busy: boolean; onApply: (request: ManageRequest) => void }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const request = suggestionRequest(suggestion);
  if (request === null) return null;
  const campaign = visibleBidi(suggestion.campaignName);
  const lower = request.kind === 'budget_lower';
  const amount = lower ? f.money(request.dailyBudget, suggestion.currency) : '';
  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm" data-testid="manage-suggestion" data-kind={suggestion.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="proposal">{t('manage.suggestion.title')}</Badge>
        <span className="font-medium text-foreground">{campaign}</span>
      </div>
      <p className="text-foreground">
        {t('manage.suggestion.text', {
          date: f.date(suggestion.day),
          campaign,
          recent: f.money(suggestion.recentCost, suggestion.currency),
          median: f.money(suggestion.medianCost, suggestion.currency),
          ratio: plainDecimal(suggestion.ratio),
          results: plainDecimal(suggestion.recentResults),
        })}{' '}
        {lower ? t('manage.suggestion.lowerSays', { amount }) : t('manage.suggestion.pauseSays')}
      </p>
      <ConfirmDialog
        render={<Button type="button" variant="outline" loading={busy} data-testid="manage-suggestion-apply" />}
        title={lower ? t('manage.suggestion.lowerTitle', { campaign }) : t('manage.suggestion.pauseTitle', { campaign })}
        description={lower ? t('manage.suggestion.lowerBody', { amount }) : t('manage.suggestion.pauseBody')}
        confirm={lower ? t('manage.suggestion.confirmLower') : t('manage.suggestion.confirmPause')}
        onConfirm={() => onApply(request)}
      >
        {lower ? t('manage.suggestion.lowerButton', { amount }) : t('manage.suggestion.pauseButton')}
      </ConfirmDialog>
    </li>
  );
}

// The list of cards, with the one sentence that says what the coworker does here. Nothing at all for no suggestion: the core of this screen works without any.
export function SuggestionList({ suggestions, busy, error, onApply }: { suggestions: readonly AdsManageSuggestion[]; busy: boolean; error: string | null; onApply: (request: ManageRequest) => void }) {
  const t = useTranslations('ads');
  const headingId = useId();
  if (suggestions.length === 0) return null;
  return (
    <Card className="block space-y-3 p-4" role="region" aria-labelledby={headingId} data-testid="manage-suggestions">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        {t('manage.suggestion.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('manage.suggestion.intro')}</p>
      <ul className="space-y-2">
        {suggestions.map((suggestion) => (
          <SuggestionCard key={`${suggestion.launchId}:${suggestion.kind}:${suggestion.slot}`} suggestion={suggestion} busy={busy} onApply={onApply} />
        ))}
      </ul>
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Card>
  );
}

// The suggestions for the ad account on show (owners and admins only: the server answers nobody else).
export function ManageSuggestions({ adAccountId, canManage }: { adAccountId: string; canManage: boolean }) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const suggestions = useQuery({ ...orpc.ads.manageSuggestions.queryOptions({ input: { adAccountId } }), enabled: canManage });
  const { send, call } = useManageCall(() => toast(t('manage.suggestion.appliedToast')));
  if (!canManage || !suggestions.data) return null;
  const currency = suggestions.data[0]?.currency ?? 'VND';
  const error = call.error ? (manageErrorText(call.error, root, { money: (amount, cur) => f.money(amount, cur), date: (day) => f.date(day) }, currency) ?? errorMessage(call.error)) : null;
  return <SuggestionList suggestions={suggestions.data} busy={call.isPending} error={error} onApply={(request) => send(request)} />;
}
