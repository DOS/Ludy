// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder's small rules (W1c, issue #2295, plan docs/plan/ads-write.md): the form a draft is edited in and its way back to the plan the
// server stores, the format problems found before a save, the largest amount a plan can spend (the sentence the approver signs), what a Social post
// pre-fills, and the words for what local validation and the AI coworker's refusals say. The server decides every rule (the checks against the dates,
// the caps and the switches included); these only choose what to show and what to send. Money is a decimal string, never a number.
import { ADS_GENDERS, ADS_PLAN_LIMITS, ADS_REQUEST_BRIEF_MAX, zAdsBudget, zLocalDate, type AdsAdVariant, type AdsCallToAction, type AdsCampaignDraftView, type AdsCampaignPlanDraft, type AdsObjective, type AdsPlanIssue } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';
import { fromUnits, toUnits } from './decimal.ts';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ?draft= is the draft open in the builder and ?account= the ad account shown; each is left out for its default (no draft, the first account).
export interface CampaignsSearch {
  draft?: string;
  account?: string;
}

// A param that fails its check is left out, so the screen falls back to its default instead of an error page (#1513).
export function parseCampaignsSearch(search: Record<string, unknown>): CampaignsSearch {
  const out: CampaignsSearch = {};
  if (typeof search.draft === 'string' && ID.test(search.draft)) out.draft = search.draft.toLowerCase();
  if (typeof search.account === 'string' && ID.test(search.account)) out.account = search.account.toLowerCase();
  return out;
}

export type AdsGender = (typeof ADS_GENDERS)[number];

// What the builder's form holds, each field as typed: '' is "not set yet" for the optional ones. A draft's plan goes in with `planToForm` and comes
// out with `formToPlan`; the same plan makes the same form, so a form that equals its draft's is not dirty.
export interface VariantForm {
  headline: string;
  primaryText: string;
  callToAction: AdsCallToAction;
}
export interface LocationForm {
  country: string;
  region: string;
}
export interface CampaignForm {
  name: string;
  objective: AdsObjective;
  dailyBudget: string;
  startOn: string;
  endOn: string;
  locations: LocationForm[];
  ageMin: string;
  ageMax: string;
  gender: AdsGender;
  interests: string;
  linkUrl: string;
  pageConnectionId: string;
  // Kept as it is (the post's id is an opaque reference; the builder never keeps the post's text).
  sourcePostId: string;
  mediaFileId: string;
  variants: VariantForm[];
}

// The button a new text starts with: a Messenger ad opens a conversation; the other two send people to a page or ask for nothing more.
export const defaultCallToAction = (objective: AdsObjective): AdsCallToAction => (objective === 'messenger' ? 'send_message' : objective === 'engagement' ? 'no_button' : 'learn_more');
export const blankVariant = (objective: AdsObjective): VariantForm => ({ headline: '', primaryText: '', callToAction: defaultCallToAction(objective) });

// A new draft's form: Vietnam, every adult age and gender, one empty text; the rest is left for the person (or the AI coworker) to fill in.
export function emptyForm(objective: AdsObjective = 'traffic'): CampaignForm {
  return {
    name: '',
    objective,
    dailyBudget: '',
    startOn: '',
    endOn: '',
    locations: [{ country: 'VN', region: '' }],
    ageMin: String(ADS_PLAN_LIMITS.ageLowest),
    ageMax: String(ADS_PLAN_LIMITS.ageHighest),
    gender: 'all',
    interests: '',
    linkUrl: '',
    pageConnectionId: '',
    sourcePostId: '',
    mediaFileId: '',
    variants: [blankVariant(objective)],
  };
}

export function planToForm(plan: AdsCampaignPlanDraft): CampaignForm {
  const base = emptyForm(plan.objective);
  const targeting = plan.targeting ?? null;
  const variants = plan.variants ?? [];
  return {
    ...base,
    name: plan.name,
    dailyBudget: plan.dailyBudget ?? '',
    startOn: plan.startOn ?? '',
    endOn: plan.endOn ?? '',
    ...(targeting === null
      ? {}
      : {
          locations: targeting.locations.map((l) => ({ country: l.country, region: l.region ?? '' })),
          ageMin: String(targeting.ageMin),
          ageMax: String(targeting.ageMax),
          gender: targeting.gender,
          interests: targeting.interests.join(', '),
        }),
    linkUrl: plan.linkUrl ?? '',
    pageConnectionId: plan.pageConnectionId ?? '',
    sourcePostId: plan.sourcePostId ?? '',
    mediaFileId: plan.mediaFileId ?? '',
    variants: variants.length > 0 ? variants.map((v) => ({ headline: v.headline, primaryText: v.primaryText, callToAction: v.callToAction })) : base.variants,
  };
}

// The interests as a list: split on commas and new lines, trimmed. A repeat is kept (local validation warns about it, the person decides).
export const parseInterests = (text: string): string[] => text.split(/[,\n]/).map((s) => s.trim()).filter((s) => s !== '');

const isBlankVariant = (v: VariantForm): boolean => v.headline.trim() === '' && v.primaryText.trim() === '';
const AGE = /^\d{1,3}$/;
const validAge = (text: string): boolean => AGE.test(text.trim()) && Number(text) >= ADS_PLAN_LIMITS.ageLowest && Number(text) <= ADS_PLAN_LIMITS.ageHighest;
const validLocation = (l: LocationForm): boolean => /^[A-Z]{2}$/.test(l.country.trim().toUpperCase()) && l.region.trim().length <= 100;
const validLink = (text: string): boolean => {
  if (text.trim() === '') return true;
  try {
    return new URL(text.trim()).protocol === 'https:' && text.trim().length <= 2000;
  } catch {
    return false;
  }
};

// The format problems a save would be refused for (the server's own input check), found before it so each sits under its field. They are not the
// plan's rules: a budget over a cap or an end date before the start is the server's list of issues.
export type FormProblem = 'nameNeeded' | 'budgetFormat' | 'countryFormat' | 'ageFormat' | 'interestsFormat' | 'linkFormat' | 'variantIncomplete';
export type ProblemField = 'name' | 'dailyBudget' | 'locations' | 'age' | 'interests' | 'linkUrl' | 'variants';

export function formProblems(form: CampaignForm): Partial<Record<ProblemField, FormProblem>> {
  const out: Partial<Record<ProblemField, FormProblem>> = {};
  if (form.name.trim() === '') out.name = 'nameNeeded';
  if (form.dailyBudget.trim() !== '' && !zAdsBudget.safeParse(form.dailyBudget.trim()).success) out.dailyBudget = 'budgetFormat';
  if (form.locations.some((l) => !validLocation(l) && !(l.country.trim() === '' && l.region.trim() === ''))) out.locations = 'countryFormat';
  if (!validAge(form.ageMin) || !validAge(form.ageMax)) out.age = 'ageFormat';
  const interests = parseInterests(form.interests);
  if (interests.length > ADS_PLAN_LIMITS.interestsMax || interests.some((i) => [...i].length > ADS_PLAN_LIMITS.interestMax)) out.interests = 'interestsFormat';
  if (!validLink(form.linkUrl)) out.linkUrl = 'linkFormat';
  if (form.variants.some((v) => !isBlankVariant(v) && (v.headline.trim() === '' || v.primaryText.trim() === ''))) out.variants = 'variantIncomplete';
  return out;
}

// The plan a form stands for, ready to save (only after the format problems are cleared). A text with nothing typed is left out; a location with no
// country is too; the audience is a whole or nothing (the server then says it is missing).
export function formToPlan(form: CampaignForm): AdsCampaignPlanDraft {
  const locations = form.locations
    .filter((l) => l.country.trim() !== '')
    .map((l) => (l.region.trim() === '' ? { country: l.country.trim().toUpperCase() } : { country: l.country.trim().toUpperCase(), region: l.region.trim() }));
  const targeting =
    locations.length > 0 && validAge(form.ageMin) && validAge(form.ageMax)
      ? { locations, ageMin: Number(form.ageMin), ageMax: Number(form.ageMax), gender: form.gender, interests: parseInterests(form.interests) }
      : null;
  const variants: AdsAdVariant[] = form.variants.filter((v) => !isBlankVariant(v)).map((v) => ({ headline: v.headline.trim(), primaryText: v.primaryText.trim(), callToAction: v.callToAction }));
  return {
    name: form.name.trim(),
    objective: form.objective,
    dailyBudget: form.dailyBudget.trim() === '' ? null : form.dailyBudget.trim(),
    startOn: form.startOn === '' ? null : form.startOn,
    endOn: form.endOn === '' ? null : form.endOn,
    targeting,
    linkUrl: form.linkUrl.trim() === '' ? null : form.linkUrl.trim(),
    pageConnectionId: form.pageConnectionId === '' ? null : form.pageConnectionId,
    sourcePostId: form.sourcePostId === '' ? null : form.sourcePostId,
    mediaFileId: form.mediaFileId === '' ? null : form.mediaFileId,
    variants,
  };
}

// What a plan holds once it has been through the form: the form edits this, so a draft is dirty when its form's plan is not this one.
const settled = (plan: AdsCampaignPlanDraft): string => JSON.stringify(formToPlan(planToForm(plan)));
export const isDirty = (form: CampaignForm, plan: AdsCampaignPlanDraft): boolean => JSON.stringify(formToPlan(form)) !== settled(plan);

// The fields the AI coworker drafted that the form still has as drafted: one edited since is no longer the AI's, the way the server counts it.
const AI_FIELDS = ['name', 'dailyBudget', 'startOn', 'endOn', 'targeting', 'linkUrl', 'variants'] as const;
export type AiField = (typeof AI_FIELDS)[number];
export function draftedFields(form: CampaignForm, draft: Pick<AdsCampaignDraftView, 'plan' | 'aiFields'>): AiField[] {
  const now = formToPlan(form);
  const then = formToPlan(planToForm(draft.plan));
  return AI_FIELDS.filter((field) => draft.aiFields.includes(field) && JSON.stringify(now[field] ?? null) === JSON.stringify(then[field] ?? null));
}

// ---- The largest amount a plan can spend ----

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (day: string): number | null => (DAY.test(day) && zLocalDate.safeParse(day).success ? Date.parse(`${day}T00:00:00Z`) / 86_400_000 : null);

// The days of a flight, the first and the last included; null while a date is missing or the flight is backwards.
export function flightDays(startOn: string, endOn: string): number | null {
  const start = dayNumber(startOn);
  const end = dayNumber(endOn);
  return start === null || end === null || end < start ? null : end - start + 1;
}

// The daily budget times the days, exactly: the number the approver signs (the server works out the same one). Null while it cannot be told.
export function maxSpendOf(form: Pick<CampaignForm, 'dailyBudget' | 'startOn' | 'endOn'>): { amount: string; days: number } | null {
  const budget = form.dailyBudget.trim();
  const days = flightDays(form.startOn, form.endOn);
  if (days === null || days > ADS_PLAN_LIMITS.daysMax || !zAdsBudget.safeParse(budget).success) return null;
  return { amount: fromUnits(toUnits(budget) * BigInt(days)), days };
}

// ---- Starting from a Social post ----

// Cut at a word, with an ellipsis, where the text is longer than the limit; a text within it is returned as it is.
export function cutAt(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export interface PostStart {
  name: string;
  brief: string;
  headline: string;
  primaryText: string;
  linkUrl: string;
  sourcePostId: string;
}

// What a Social post pre-fills: its words in the request for the AI coworker's draft (up to what a request takes), and a first text of the ad within the
// platforms' soft limits. The post is read through Social's own query; only its id is kept in the plan, as an opaque reference.
export function startFromPost(post: { id: string; title: string | null; body: string; linkUrl: string | null }): PostStart {
  const title = (post.title ?? '').trim();
  const body = post.body.trim();
  const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? '';
  return {
    name: cutAt(title || firstLine, 60),
    brief: cutAt([title, body].filter((s) => s !== '').join('\n\n'), ADS_REQUEST_BRIEF_MAX),
    headline: cutAt(title || firstLine, ADS_PLAN_LIMITS.headlineSoft),
    primaryText: cutAt(body, ADS_PLAN_LIMITS.primaryTextSoft),
    linkUrl: post.linkUrl !== null && validLink(post.linkUrl) ? post.linkUrl.trim() : '',
    sourcePostId: post.id,
  };
}

// The builder's form for a new draft that starts from a post.
export function formFromPost(start: PostStart, objective: AdsObjective): CampaignForm {
  const form = emptyForm(objective);
  return { ...form, name: start.name, linkUrl: start.linkUrl, sourcePostId: start.sourcePostId, variants: [{ ...form.variants[0]!, headline: start.headline, primaryText: start.primaryText }] };
}

// ---- Words ----

// The plan fields a validation issue names, in words (an unknown one is shown as it is). Every key is spelled out: a computed key would make the typed
// translator's key type unmanageable for the compiler.
function fieldName(field: string | null, t: Translate): string {
  switch (field) {
    case 'dailyBudget':
      return t('ads.campaigns.fieldName.dailyBudget');
    case 'startOn':
      return t('ads.campaigns.fieldName.startOn');
    case 'endOn':
      return t('ads.campaigns.fieldName.endOn');
    case 'targeting':
      return t('ads.campaigns.fieldName.targeting');
    case 'variants':
      return t('ads.campaigns.fieldName.variants');
    case 'linkUrl':
      return t('ads.campaigns.fieldName.linkUrl');
    case 'pageConnectionId':
      return t('ads.campaigns.fieldName.pageConnectionId');
    default:
      return field ?? '';
  }
}

// A number of a finding as the text an argument of a message takes.
const text = (value: string | number | undefined): string => String(value ?? '');

// What local validation found, in one sentence each, from the machine code and its numbers (never a Vietnamese sentence the server wrote). A code this
// build does not know is shown as it is, so a newer server never hides a finding.
export function issueText(issue: AdsPlanIssue, t: Translate): string {
  const p = issue.params;
  switch (issue.code) {
    case 'missing_field':
      return t('ads.campaigns.issue.missing_field', { field: fieldName(issue.field, t) });
    case 'end_before_start':
      return t('ads.campaigns.issue.end_before_start');
    case 'start_in_past':
      return t('ads.campaigns.issue.start_in_past', { today: text(p.today) });
    case 'flight_too_long':
      return t('ads.campaigns.issue.flight_too_long', { max: text(p.max), days: text(p.days) });
    case 'age_range':
      return t('ads.campaigns.issue.age_range');
    case 'interests_repeated':
      return t('ads.campaigns.issue.interests_repeated');
    case 'headline_long':
      return t('ads.campaigns.issue.headline_long', { variant: text(p.variant), soft: text(p.soft) });
    case 'primary_text_long':
      return t('ads.campaigns.issue.primary_text_long', { variant: text(p.variant), soft: text(p.soft) });
    case 'messenger_call_to_action':
      return t('ads.campaigns.issue.messenger_call_to_action', { variant: text(p.variant) });
    case 'page_not_found':
      return t('ads.campaigns.issue.page_not_found');
    case 'account_currency_unknown':
      return t('ads.campaigns.issue.account_currency_unknown');
    case 'budget_decimals':
      return t('ads.campaigns.issue.budget_decimals', { currency: text(p.currency) });
    case 'cap_currency':
      return t('ads.campaigns.issue.cap_currency', { currency: text(p.currency) });
    case 'no_cap':
      return t('ads.campaigns.issue.no_cap');
    case 'daily_cap_exceeded':
      return t('ads.campaigns.issue.daily_cap_exceeded');
    case 'monthly_cap_exceeded':
      return t('ads.campaigns.issue.monthly_cap_exceeded', { month: text(p.month) });
    case 'writing_off':
      return t('ads.campaigns.issue.writing_off');
    case 'account_not_enabled':
      return t('ads.campaigns.issue.account_not_enabled');
    case 'launches_blocked':
      return t('ads.campaigns.issue.launches_blocked');
    default:
      return issue.code;
  }
}

// Why there is no draft, in the reader's language: the meter's refusal (AI_BUDGET) and the rest, each in words, never silent. A code this build does not
// know falls back to the general line.
export function refusalText(code: string | null, t: Translate): string {
  switch (code) {
    case 'AI_OFF':
      return t('ads.campaigns.refusal.AI_OFF');
    case 'AI_BUDGET':
      return t('ads.campaigns.refusal.AI_BUDGET');
    case 'RATE_LIMITED':
      return t('ads.campaigns.refusal.RATE_LIMITED');
    case 'AI_ERROR':
      return t('ads.campaigns.refusal.AI_ERROR');
    case 'INVALID':
      return t('ads.campaigns.refusal.INVALID');
    case 'EMPTY':
      return t('ads.campaigns.refusal.EMPTY');
    case 'FIGURES':
      return t('ads.campaigns.refusal.FIGURES');
    case 'LINK':
      return t('ads.campaigns.refusal.LINK');
    case 'EXPIRED':
      return t('ads.campaigns.refusal.EXPIRED');
    default:
      return t('ads.campaigns.requestNone');
  }
}

export const objectiveText = (objective: AdsObjective, t: Translate): string => {
  switch (objective) {
    case 'traffic':
      return t('ads.campaigns.objective.traffic');
    case 'engagement':
      return t('ads.campaigns.objective.engagement');
    case 'messenger':
      return t('ads.campaigns.objective.messenger');
  }
};

export const callToActionText = (cta: AdsCallToAction, t: Translate): string => {
  switch (cta) {
    case 'learn_more':
      return t('ads.campaigns.cta.learn_more');
    case 'shop_now':
      return t('ads.campaigns.cta.shop_now');
    case 'sign_up':
      return t('ads.campaigns.cta.sign_up');
    case 'contact_us':
      return t('ads.campaigns.cta.contact_us');
    case 'send_message':
      return t('ads.campaigns.cta.send_message');
    case 'no_button':
      return t('ads.campaigns.cta.no_button');
  }
};

export const genderText = (gender: AdsGender, t: Translate): string => {
  switch (gender) {
    case 'all':
      return t('ads.campaigns.genders.all');
    case 'male':
      return t('ads.campaigns.genders.male');
    case 'female':
      return t('ads.campaigns.genders.female');
  }
};

// The words of a format problem under its field.
export function problemText(problem: FormProblem, t: Translate): string {
  switch (problem) {
    case 'nameNeeded':
      return t('ads.campaigns.problem.nameNeeded');
    case 'budgetFormat':
      return t('ads.campaigns.problem.budgetFormat');
    case 'countryFormat':
      return t('ads.campaigns.problem.countryFormat');
    case 'ageFormat':
      return t('ads.campaigns.problem.ageFormat');
    case 'interestsFormat':
      return t('ads.campaigns.problem.interestsFormat');
    case 'linkFormat':
      return t('ads.campaigns.problem.linkFormat');
    case 'variantIncomplete':
      return t('ads.campaigns.problem.variantIncomplete');
  }
}
