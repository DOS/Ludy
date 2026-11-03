// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder (W1c, issue #2295, plan docs/plan/ads-write.md section 10): one campaign, one ad set and one ad with up to three texts, written by
// a person or drafted by the AI coworker and edited here. A field the AI coworker drafted and nobody has changed since is marked as drafted. Saving checks
// the plan on the server against the dates, the spend caps and the switches of running ads, and the list says what is still to fix; the largest amount the
// plan can spend is one sentence under the form, the same one the approver signs. Owners and admins ask for approval; nothing is sent to an ad platform.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'use-intl';
import { ADS_CALLS_TO_ACTION, ADS_GENDERS, ADS_OBJECTIVES, ADS_PLAN_LIMITS, type AdAccountView, type AdsCampaignDraftView, type AdsObjective } from '@crove/kernel-contract';
import { Alert } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { keyFor, type KeyHolder } from '../lib/ads.ts';
import {
  blankVariant,
  callToActionText,
  defaultCallToAction,
  draftedFields,
  emptyForm,
  formProblems,
  formToPlan,
  genderText,
  isDirty,
  issueText,
  maxSpendOf,
  objectiveText,
  planToForm,
  problemText,
  type AdsGender,
  type AiField,
  type CampaignForm,
} from '../lib/ads-campaigns.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ErrorText, Field, focusFirstInvalid } from './ui.tsx';

const H2 = 'text-base font-semibold text-foreground';
const H3 = 'text-sm font-medium text-foreground';

// A Facebook Page of the org that a Messenger ad can open a conversation with (a channel connection).
export interface PageChoice {
  id: string;
  name: string;
}

// Drafts, and the requests the AI coworker answers with one, are read again after a save, a discard or a request for approval.
export const refreshCampaigns = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDrafts.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignDraft.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.ads.campaignRequests.key() }),
  ]);

// The label of a field, with a chip when the AI coworker drafted it and nobody has changed it since.
function Labelled({ text, ai }: { text: string; ai: boolean }) {
  const t = useTranslations('ads');
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {text}
      {ai && <Badge variant="proposal">{t('campaigns.drafted')}</Badge>}
    </span>
  );
}

export function CampaignBuilder({
  slug,
  account,
  draft,
  seed,
  canManage,
  pages,
  onSaved,
  onDiscarded,
}: {
  slug: string;
  account: AdAccountView;
  draft: AdsCampaignDraftView | null;
  // The form of a new draft that starts from a post; a draft that exists starts from its own plan.
  seed: CampaignForm | null;
  canManage: boolean;
  pages: readonly PageChoice[];
  onSaved: (draft: AdsCampaignDraftView) => void;
  onDiscarded: () => void;
}) {
  const t = useTranslations('ads');
  const root = useTranslations();
  const f = useFormat();
  const headingId = useId();
  const [form, setForm] = useState<CampaignForm>(() => (draft ? planToForm(draft.plan) : (seed ?? emptyForm())));
  const [attempted, setAttempted] = useState(false);
  const saveAttempt = useRef<KeyHolder | null>(null);
  const submitAttempt = useRef<KeyHolder | null>(null);
  const discardAttempt = useRef<KeyHolder | null>(null);
  const set = (patch: Partial<CampaignForm>) => setForm((current) => ({ ...current, ...patch }));
  const currency = draft?.currency ?? account.currency;
  // A draft waiting for approval or already approved is frozen: nothing here changes it (the server refuses an edit too).
  const waiting = draft !== null && draft.pendingProposalId !== null;
  const approved = draft !== null && draft.status === 'approved';
  const frozen = waiting || approved;
  const dirty = draft === null || isDirty(form, draft.plan);
  const drafted: readonly AiField[] = draft ? draftedFields(form, draft) : [];
  const ai = (field: AiField) => drafted.includes(field);
  const problems = attempted ? formProblems(form) : {};
  const spend = maxSpendOf(form);

  const save = useMutation(
    orpc.ads.saveCampaignDraft.mutationOptions({
      onSuccess: async (saved) => {
        saveAttempt.current = null;
        await refreshCampaigns();
        toast(t('campaigns.saved'));
        onSaved(saved);
      },
    }),
  );
  const submit = useMutation(
    orpc.ads.requestChange.mutationOptions({
      onSuccess: async () => {
        submitAttempt.current = null;
        await refreshCampaigns();
        toast(t('campaigns.submitted'));
      },
    }),
  );
  const discard = useMutation(
    orpc.ads.discardCampaignDraft.mutationOptions({
      onSuccess: async () => {
        discardAttempt.current = null;
        await refreshCampaigns();
        toast(t('campaigns.discardedToast'));
        onDiscarded();
      },
    }),
  );

  const onSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    flushSync(() => setAttempted(true));
    if (Object.keys(formProblems(form)).length > 0) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    const input = { ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}), adAccountId: account.id, plan: formToPlan(form) };
    // A retry of the same form after a lost answer is the same request; a changed form is another.
    saveAttempt.current = keyFor(saveAttempt.current, JSON.stringify(input));
    save.mutate({ ...input, idempotencyKey: saveAttempt.current.key });
  };

  const onSubmit = () => {
    if (!draft) return;
    submitAttempt.current = keyFor(submitAttempt.current, `${draft.id}:${draft.revision}`);
    submit.mutate({ change: 'campaign_launch', draftId: draft.id, idempotencyKey: submitAttempt.current.key });
  };

  const errors = draft ? draft.issues.filter((i) => i.severity === 'error') : [];
  const warnings = draft ? draft.issues.filter((i) => i.severity === 'warning') : [];
  const canSubmit = canManage && draft !== null && !dirty && !frozen && errors.length === 0 && currency !== null;
  const objectiveChanged = (next: AdsObjective) =>
    set({
      objective: next,
      // A text still on the button its objective starts with follows the new objective.
      variants: form.variants.map((v) => (v.callToAction === defaultCallToAction(form.objective) ? { ...v, callToAction: defaultCallToAction(next) } : v)),
    });
  const setVariant = (index: number, patch: Partial<CampaignForm['variants'][number]>) => set({ variants: form.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)) });
  const setLocation = (index: number, patch: Partial<CampaignForm['locations'][number]>) => set({ locations: form.locations.map((l, i) => (i === index ? { ...l, ...patch } : l)) });

  const section = (title: string, children: ReactNode) => (
    <div className="space-y-3">
      <h3 className={H3}>{title}</h3>
      {children}
    </div>
  );

  return (
    <form className="space-y-5" onSubmit={onSave} aria-labelledby={headingId} noValidate data-testid="campaign-builder">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className={H2}>
          {draft ? t('campaigns.builderTitle') : t('campaigns.builderNew')}
        </h2>
        {draft && <Badge variant={approved ? 'success' : 'outline'}>{approved ? t('campaigns.status.approved') : t('campaigns.status.draft')}</Badge>}
        {draft?.origin === 'ai' && <Badge variant="proposal">{t('campaigns.drafted')}</Badge>}
      </div>
      {waiting && draft && (
        <Alert role="status">
          <span>{t('campaigns.waiting')} </span>
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: draft.pendingProposalId ?? '' }} className="text-link hover:underline">
            {t('campaigns.openInbox')}
          </Link>
        </Alert>
      )}
      {approved && <Alert role="status">{t('campaigns.approvedNote')}</Alert>}
      {draft?.origin === 'ai' && !frozen && <p className="text-sm text-muted-foreground">{t('campaigns.draftedHint')}</p>}

      <fieldset disabled={frozen || save.isPending} className="m-0 min-w-0 space-y-6 border-0 p-0">
        {section(
          t('campaigns.sectionBasics'),
          <div className="flex flex-wrap items-start gap-3">
            <Field label={<Labelled text={t('campaigns.name')} ai={ai('name')} />} error={problems.name ? problemText(problems.name, root) : undefined} className="min-w-64 flex-1">
              {(control) => <Input {...control} maxLength={ADS_PLAN_LIMITS.nameMax} value={form.name} onChange={(e) => set({ name: e.target.value })} />}
            </Field>
            <Field label={t('campaigns.objectiveLabel')} hint={t('campaigns.objectiveHint')} className="w-60">
              {(control) => (
                <NativeSelect {...control} className="w-full" value={form.objective} onChange={(e) => objectiveChanged(e.target.value as AdsObjective)}>
                  {ADS_OBJECTIVES.map((o) => (
                    <NativeSelectOption key={o} value={o}>
                      {objectiveText(o, root)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>,
        )}

        {section(
          t('campaigns.sectionBudget'),
          <div className="flex flex-wrap items-start gap-3">
            <Field
              label={<Labelled text={t('campaigns.dailyBudget')} ai={ai('dailyBudget')} />}
              hint={t('campaigns.budgetHint')}
              error={problems.dailyBudget ? problemText(problems.dailyBudget, root) : undefined}
              className="w-52"
            >
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input {...control} inputMode="decimal" autoComplete="off" value={form.dailyBudget} onChange={(e) => set({ dailyBudget: e.target.value.trim() })} />
                  <span className="text-sm text-muted-foreground">{currency ?? ''}</span>
                </div>
              )}
            </Field>
            <Field label={<Labelled text={t('campaigns.startOn')} ai={ai('startOn')} />} className="w-48">
              {(control) => <DateInput {...control} value={form.startOn} onChange={(startOn) => set({ startOn })} />}
            </Field>
            <Field label={<Labelled text={t('campaigns.endOn')} ai={ai('endOn')} />} className="w-48">
              {(control) => <DateInput {...control} value={form.endOn} min={form.startOn} onChange={(endOn) => set({ endOn })} />}
            </Field>
          </div>,
        )}

        {section(
          t('campaigns.sectionAudience'),
          <div className="space-y-3">
            {ai('targeting') && <Badge variant="proposal">{t('campaigns.drafted')}</Badge>}
            <div className="space-y-2" role="group" aria-label={t('campaigns.locations')}>
              {form.locations.map((location, index) => (
                <div key={index} className="flex flex-wrap items-start gap-3">
                  <Field label={index === 0 ? t('campaigns.country') : undefined} error={index === 0 && problems.locations ? problemText(problems.locations, root) : undefined} className="w-28">
                    {(control) => (
                      <Input {...control} maxLength={2} aria-label={t('campaigns.country')} value={location.country} onChange={(e) => setLocation(index, { country: e.target.value.toUpperCase() })} />
                    )}
                  </Field>
                  <Field label={index === 0 ? t('campaigns.region') : undefined} className="min-w-48 flex-1">
                    {(control) => <Input {...control} maxLength={100} aria-label={t('campaigns.region')} value={location.region} onChange={(e) => setLocation(index, { region: e.target.value })} />}
                  </Field>
                  {form.locations.length > 1 && (
                    <Button type="button" variant="ghost" size="lg" className={index === 0 ? 'mt-5' : ''} onClick={() => set({ locations: form.locations.filter((_, i) => i !== index) })}>
                      {t('campaigns.removeLocation')}
                    </Button>
                  )}
                </div>
              ))}
              {form.locations.length < ADS_PLAN_LIMITS.locationsMax && (
                <Button type="button" variant="outline" onClick={() => set({ locations: [...form.locations, { country: '', region: '' }] })}>
                  {t('campaigns.addLocation')}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <Field label={t('campaigns.ageMin')} error={problems.age ? problemText(problems.age, root) : undefined} className="w-28">
                {(control) => <Input {...control} inputMode="numeric" maxLength={3} value={form.ageMin} onChange={(e) => set({ ageMin: e.target.value.trim() })} />}
              </Field>
              <Field label={t('campaigns.ageMax')} className="w-28">
                {(control) => <Input {...control} inputMode="numeric" maxLength={3} value={form.ageMax} onChange={(e) => set({ ageMax: e.target.value.trim() })} />}
              </Field>
              <Field label={t('campaigns.gender')} className="w-40">
                {(control) => (
                  <NativeSelect {...control} className="w-full" value={form.gender} onChange={(e) => set({ gender: e.target.value as AdsGender })}>
                    {ADS_GENDERS.map((g) => (
                      <NativeSelectOption key={g} value={g}>
                        {genderText(g, root)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <Field label={t('campaigns.interests')} hint={t('campaigns.interestsHint')} error={problems.interests ? problemText(problems.interests, root) : undefined} className="max-w-xl">
              {(control) => <Input {...control} value={form.interests} onChange={(e) => set({ interests: e.target.value })} />}
            </Field>
          </div>,
        )}

        {section(
          form.objective === 'messenger' ? t('campaigns.sectionPage') : t('campaigns.sectionLink'),
          form.objective === 'messenger' ? (
            <Field label={t('campaigns.page')} className="max-w-sm">
              {(control) => (
                <NativeSelect {...control} className="w-full" value={form.pageConnectionId} onChange={(e) => set({ pageConnectionId: e.target.value })}>
                  <NativeSelectOption value="">{pages.length === 0 ? t('campaigns.pageNone') : t('campaigns.pageChoose')}</NativeSelectOption>
                  {pages.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          ) : (
            <Field label={<Labelled text={t('campaigns.link')} ai={ai('linkUrl')} />} error={problems.linkUrl ? problemText(problems.linkUrl, root) : undefined} className="max-w-xl">
              {(control) => <Input {...control} type="url" inputMode="url" placeholder="https://" maxLength={2000} value={form.linkUrl} onChange={(e) => set({ linkUrl: e.target.value })} />}
            </Field>
          ),
        )}

        {section(
          t('campaigns.variantsTitle'),
          <div className="space-y-3">
            {ai('variants') && <Badge variant="proposal">{t('campaigns.drafted')}</Badge>}
            {problems.variants && <ErrorText>{problemText(problems.variants, root)}</ErrorText>}
            {form.variants.map((variant, index) => (
              <Card key={index} className="block space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">{t('campaigns.variant', { number: String(index + 1) })}</p>
                  {form.variants.length > 1 && (
                    <Button type="button" variant="ghost" onClick={() => set({ variants: form.variants.filter((_, i) => i !== index) })}>
                      {t('campaigns.removeVariant')}
                    </Button>
                  )}
                </div>
                <Field label={t('campaigns.headline')}>
                  {(control) => <Input {...control} maxLength={ADS_PLAN_LIMITS.headlineMax} value={variant.headline} onChange={(e) => setVariant(index, { headline: e.target.value })} />}
                </Field>
                <Field label={t('campaigns.primaryText')}>
                  {(control) => <Textarea {...control} rows={3} maxLength={ADS_PLAN_LIMITS.primaryTextMax} value={variant.primaryText} onChange={(e) => setVariant(index, { primaryText: e.target.value })} />}
                </Field>
                <Field label={t('campaigns.callToAction')} className="w-56">
                  {(control) => (
                    <NativeSelect {...control} className="w-full" value={variant.callToAction} onChange={(e) => setVariant(index, { callToAction: e.target.value as typeof variant.callToAction })}>
                      {ADS_CALLS_TO_ACTION.map((c) => (
                        <NativeSelectOption key={c} value={c}>
                          {callToActionText(c, root)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </Card>
            ))}
            {form.variants.length < ADS_PLAN_LIMITS.variantsMax && (
              <Button type="button" variant="outline" onClick={() => set({ variants: [...form.variants, blankVariant(form.objective)] })}>
                {t('campaigns.addVariant')}
              </Button>
            )}
          </div>,
        )}
      </fieldset>

      <p className="text-sm font-medium text-foreground" data-testid="campaign-max-spend">
        {spend !== null && currency !== null
          ? t('campaigns.maxSpend', { amount: f.money(spend.amount, currency), days: spend.days, daily: f.money(form.dailyBudget.trim(), currency) })
          : t('campaigns.maxSpendNone')}
      </p>

      {draft === null || dirty ? (
        <p className="text-sm text-muted-foreground">{t('campaigns.issuesAfterSave')}</p>
      ) : errors.length === 0 && warnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('campaigns.issuesNone')}</p>
      ) : (
        <div className="space-y-3">
          {errors.length > 0 && (
            <Alert variant="destructive" className="border-destructive/30 bg-destructive/10" data-testid="campaign-issues">
              <p className="font-medium">{t('campaigns.issuesTitle')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {errors.map((issue, i) => (
                  <li key={`${issue.code}:${i}`}>{issueText(issue, root)}</li>
                ))}
              </ul>
            </Alert>
          )}
          {warnings.length > 0 && (
            <Alert data-testid="campaign-warnings">
              <p className="font-medium">{t('campaigns.warningsTitle')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {warnings.map((issue, i) => (
                  <li key={`${issue.code}:${i}`}>{issueText(issue, root)}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      )}

      {!frozen && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={save.isPending} type="submit" size="lg">
              {t('campaigns.save')}
            </Button>
            {canManage && (
              <Button type="button" size="lg" variant="outline" loading={submit.isPending} disabled={!canSubmit} onClick={onSubmit}>
                {t('campaigns.submit')}
              </Button>
            )}
            {draft && (
              <ConfirmDialog
                render={<Button loading={discard.isPending} type="button" variant="ghost" size="lg" />}
                destructive
                title={t('campaigns.discardTitle')}
                description={t('campaigns.discardBody', { name: draft.plan.name })}
                confirm={t('campaigns.discard')}
                onConfirm={() => {
                  discardAttempt.current = keyFor(discardAttempt.current, draft.id);
                  discard.mutate({ draftId: draft.id, idempotencyKey: discardAttempt.current.key });
                }}
              >
                {t('campaigns.discard')}
              </ConfirmDialog>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{!canManage ? t('campaigns.managersOnly') : draft !== null && dirty ? t('campaigns.unsaved') : t('campaigns.submitHint')}</p>
        </div>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {submit.error && <ErrorText>{errorMessage(submit.error)}</ErrorText>}
      {discard.error && <ErrorText>{errorMessage(discard.error)}</ErrorText>}
    </form>
  );
}
