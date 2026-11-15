// SPDX-License-Identifier: AGPL-3.0-only
// What a request to open the way to spend says, in the reader's language (ADR-0043, issue #2294). The Ads screen's "waiting for
// approval" list and the Inbox card of an ads proposal word the same change the same way, from the structured change the server
// read from the proposal's payload (ads.write.state, ads.proposal.change), never from the Vietnamese title the proposal was
// written with. The amounts are decimal strings and go through the money formatter, never a number.
import type { AdsChange } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';

// The change in one sentence, and the sentence that says what follows from it (for a cap, from which amount to which).
export interface AdsChangeText {
  title: string;
  detail: string;
}

// The plan fields the AI coworker may have drafted, in words (an unknown one is shown as it is). Each key is spelled out: a computed key would make the
// typed translator's key type unmanageable for the compiler.
function aiFieldText(field: string, t: Translate): string {
  switch (field) {
    case 'name':
      return t('ads.change.aiField.name');
    case 'dailyBudget':
      return t('ads.change.aiField.dailyBudget');
    case 'startOn':
      return t('ads.change.aiField.startOn');
    case 'endOn':
      return t('ads.change.aiField.endOn');
    case 'targeting':
      return t('ads.change.aiField.targeting');
    case 'linkUrl':
      return t('ads.change.aiField.linkUrl');
    case 'variants':
      return t('ads.change.aiField.variants');
    default:
      return field;
  }
}

export function adsChangeText(change: AdsChange, t: Translate, money: (amount: string, currency: string) => string): AdsChangeText {
  switch (change.change) {
    case 'write_enable':
      return { title: t('ads.change.writeEnable'), detail: t('ads.change.writeEnableDetail') };
    case 'account_enable':
      return { title: t('ads.change.accountEnable', { name: change.adAccountName }), detail: t('ads.change.accountEnableDetail') };
    case 'launches_unblock':
      return { title: t('ads.change.launchesUnblock'), detail: t('ads.change.launchesUnblockDetail') };
    case 'cap_set': {
      const period = change.period === 'daily' ? t('ads.write.capDaily') : t('ads.write.capMonthly');
      const amount = money(change.amount, change.currency);
      const title = change.scope === 'account' ? t('ads.change.capSetAccount', { period, name: change.adAccountName ?? '' }) : t('ads.change.capSetOrg', { period });
      // The cap in force when it was asked for, in its own currency (it may differ from the new one).
      const detail = change.previous === null ? t('ads.change.capFirst', { amount }) : t('ads.change.capFromTo', { previous: money(change.previous, change.previousCurrency ?? change.currency), amount });
      return { title, detail };
    }
    case 'campaign_launch':
      // The plan's name and account, and what the approver signs: the largest amount, the days and the daily budget, in the account's currency.
      // A plan the AI coworker drafted says so, with the fields it drafted that nobody has changed since (AI output is tainted: DESIGN.md 2).
      const spend = t('ads.change.campaignLaunchDetail', { amount: money(change.amount, change.currency), days: change.days, daily: money(change.plan.dailyBudget, change.currency) });
      const drafted = change.aiFields.map((field) => aiFieldText(field, t));
      const ai = change.origin === 'ai' ? (drafted.length > 0 ? t('ads.change.campaignAi', { fields: drafted.join(', ') }) : t('ads.change.campaignAiEdited')) : '';
      return {
        title: t('ads.change.campaignLaunch', { name: visibleBidi(change.plan.name), account: visibleBidi(change.adAccountName) }),
        detail: ai === '' ? spend : `${spend} ${ai}`,
      };
  }
}

// One line of the Ads screen's list of waiting requests: the sentence, and for a cap the amounts too.
export function adsChangeLine(change: AdsChange, t: Translate, money: (amount: string, currency: string) => string): string {
  const { title, detail } = adsChangeText(change, t, money);
  return change.change === 'cap_set' || change.change === 'campaign_launch' ? `${title} ${detail}` : title;
}

// The characters that change how text is ordered or hide where it ends: they are shown as a visible code, never applied, so that a hostile ad text
// cannot reorder the card around it or make a link read as another (the marks of right-to-left text, the embeddings and the overrides, the isolates).
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
export function visibleBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, (ch) => `\u27e8U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\u27e9`);
}

// How much of an ad text the card shows before the expander, in characters (code points, so a surrogate pair is never cut in two).
export const ADS_PREVIEW_CHARS = 160;
export interface ClampedText {
  // The text with its control characters made visible, cut at ADS_PREVIEW_CHARS when longer, with the ellipsis; the whole text when short.
  shown: string;
  // The whole text when `shown` is cut, else null: the card puts it behind an expander.
  full: string | null;
}
export function clampText(text: string, limit: number = ADS_PREVIEW_CHARS): ClampedText {
  const whole = visibleBidi(text);
  const chars = Array.from(whole);
  return chars.length <= limit ? { shown: whole, full: null } : { shown: `${chars.slice(0, limit).join('').trimEnd()}\u2026`, full: whole };
}

export interface AdsAdPreview {
  headline: ClampedText;
  primaryText: ClampedText;
  button: string;
}

// The whole plan an approver signs, in the reader's words, read from the stored plan alone: nothing here is computed by a model, and every text is data (the card
// puts it in a text node, never in markup). `null` for a change that carries no plan.
export interface AdsPlanView {
  // The largest amount the plan can spend, the days and the daily budget: the first and loudest line of the card.
  amount: string;
  spend: string;
  objective: string;
  schedule: string;
  audience: { locations: string; age: string; gender: string; interests: string };
  placements: string;
  // Where the ad leads: the link as text (never a live anchor), or the words for a conversation with the Page.
  destination: ClampedText;
  ads: AdsAdPreview[];
}

export interface AdsPlanFormat {
  money: (amount: string, currency: string) => string;
  date: (isoDate: string) => string;
  // A country by its ISO 3166-1 alpha-2 code in the reader's language; the code itself when the name is unknown.
  country: (code: string) => string;
}

function objectiveText(objective: string, t: Translate): string {
  switch (objective) {
    case 'traffic':
      return t('ads.campaigns.objective.traffic');
    case 'engagement':
      return t('ads.campaigns.objective.engagement');
    case 'messenger':
      return t('ads.campaigns.objective.messenger');
    default:
      return objective;
  }
}

function genderText(gender: string, t: Translate): string {
  switch (gender) {
    case 'male':
      return t('ads.campaigns.genders.male');
    case 'female':
      return t('ads.campaigns.genders.female');
    default:
      return t('ads.campaigns.genders.all');
  }
}

function buttonText(cta: string, t: Translate): string {
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
    default:
      return cta;
  }
}

export function adsChangePlan(change: AdsChange, t: Translate, fmt: AdsPlanFormat): AdsPlanView | null {
  if (change.change !== 'campaign_launch') return null;
  const { plan } = change;
  const { targeting } = plan;
  const locations = targeting.locations.map((l) => visibleBidi(l.region ? `${l.region}, ${fmt.country(l.country)}` : fmt.country(l.country))).join('; ');
  return {
    amount: fmt.money(change.amount, change.currency),
    spend: t('ads.change.plan.spend', { days: change.days, daily: fmt.money(plan.dailyBudget, change.currency) }),
    objective: objectiveText(plan.objective, t),
    schedule: t('ads.change.plan.scheduleValue', { from: fmt.date(plan.startOn), until: fmt.date(plan.endOn) }),
    audience: {
      locations,
      age: t('ads.change.plan.ageValue', { min: String(targeting.ageMin), max: String(targeting.ageMax) }),
      gender: genderText(targeting.gender, t),
      interests: targeting.interests.length > 0 ? targeting.interests.map(visibleBidi).join(', ') : t('ads.change.plan.interestsNone'),
    },
    // The first slice has automatic placements only (plan section 3.2): the platform chooses where the ad shows.
    placements: t('ads.change.plan.placementsAutomatic'),
    destination: plan.linkUrl === null ? { shown: t('ads.change.plan.messenger'), full: null } : clampText(plan.linkUrl),
    ads: plan.variants.map((v) => ({ headline: clampText(v.headline), primaryText: clampText(v.primaryText), button: buttonText(v.callToAction, t) })),
  };
}
