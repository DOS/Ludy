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
        title: t('ads.change.campaignLaunch', { name: change.plan.name, account: change.adAccountName }),
        detail: ai === '' ? spend : `${spend} ${ai}`,
      };
  }
}

// One line of the Ads screen's list of waiting requests: the sentence, and for a cap the amounts too.
export function adsChangeLine(change: AdsChange, t: Translate, money: (amount: string, currency: string) => string): string {
  const { title, detail } = adsChangeText(change, t, money);
  return change.change === 'cap_set' || change.change === 'campaign_launch' ? `${title} ${detail}` : title;
}
