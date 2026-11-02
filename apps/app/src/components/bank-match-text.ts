// SPDX-License-Identifier: AGPL-3.0-only
// The words of the bank matches (#2385): why a line matched, why it needs a look, and how a posted voucher's party was found,
// from the tags of lib/bank-groups.ts. One switch per message, so every key is a literal the typed messages can check.
import type { BankLookWhy, BankMatchedBy, BankMatchReason } from '@crove/kernel-contract';
import { useTranslations } from 'use-intl';
import { matchedByTag, reasonTag, type MatchedByTag, type ReasonTag } from '../lib/bank-groups.ts';

export function useMatchText() {
  const t = useTranslations('bank.match');
  const reason = (tag: ReasonTag, number: string): string => {
    switch (tag) {
      case 'taxCodeInvoice':
        return t('reason.taxCodeInvoice', { number });
      case 'taxCode':
        return t('reason.taxCode');
      case 'invoice':
        return t('reason.invoice', { number });
      case 'name':
        return t('reason.name');
      case 'balance':
        return t('reason.balance');
      default:
        return t('reason.none');
    }
  };
  return {
    // Why a clean line matched.
    reason: (by: { reason?: BankMatchReason | undefined; invoice?: { number: string } | undefined }): string => {
      const found = reasonTag(by);
      return reason(found.tag, found.number);
    },
    // Why a line is not in the clean group.
    look: (why: BankLookWhy): string => {
      switch (why) {
        case 'several':
          return t('look.several');
        case 'weak':
          return t('look.weak');
        case 'no_invoice':
          return t('look.no_invoice');
        default:
          return t('look.duplicate');
      }
    },
    // How the party of a posted voucher was found.
    matchedBy: (by: BankMatchedBy | null): string => {
      const found: MatchedByTag = matchedByTag(by);
      if (found.tag === 'unknown') return t('matchedBy.unknown');
      if (found.tag === 'manual') return t('matchedBy.manual');
      return reason(found.reason, found.number);
    },
  };
}
