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
  }
}

// One line of the Ads screen's list of waiting requests: the sentence, and for a cap the amounts too.
export function adsChangeLine(change: AdsChange, t: Translate, money: (amount: string, currency: string) => string): string {
  const { title, detail } = adsChangeText(change, t, money);
  return change.change === 'cap_set' ? `${title} ${detail}` : title;
}
