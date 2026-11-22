// SPDX-License-Identifier: AGPL-3.0-only
// "Báo giá" in Settings (#3645): the letterhead, the bank note, the default VAT and validity and the logo of every quote of the org, which sat inside each deal's quote
// panel. Owners and admins write them; a deal's quote panel links here when the letterhead is empty.
import { useTranslations } from 'use-intl';
import { Card } from '@ludy/ui/components/card';
import { QuoteSettingsForm } from './quote-send.tsx';

// The card's address (`#quote-settings`), as the booking cards have theirs.
export const QUOTE_SETTINGS_ID = 'quote-settings';

export function QuoteSettingsCard() {
  const t = useTranslations('quotes.settings');
  return (
    <Card id={QUOTE_SETTINGS_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none lg:col-span-2" aria-label={t('card')}>
      <p className="text-sm font-medium text-muted-foreground">{t('card')}</p>
      <p className="mt-2 mb-4 text-sm text-muted-foreground">{t('intro')}</p>
      <QuoteSettingsForm />
    </Card>
  );
}
