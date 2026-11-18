// SPDX-License-Identifier: AGPL-3.0-only
// A card of the Ads settings that could not be read (#3640, Engage audit AD-14): what went wrong and a button that reads it again, instead of a line that fails silently.
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';

export function AdsCardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslations('ads.adsSettings');
  return (
    <div className="space-y-2" data-testid="ads-card-error">
      <ErrorText>{message}</ErrorText>
      <Button type="button" variant="outline" size="lg" data-testid="ads-card-retry" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}
