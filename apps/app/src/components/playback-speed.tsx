// SPDX-License-Identifier: AGPL-3.0-only
// The speed of a meeting's recording player (#4816): four buttons, 1x to 2x, the one in use pressed. The page applies the choice to its audio and video players (lib/playback.ts) and remembers it in this
// browser. Nothing here goes to the server.
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { PLAYBACK_RATES, rateLabel, type PlaybackRate } from '../lib/playback.ts';

export function PlaybackSpeed({ rate, onChange }: { rate: PlaybackRate; onChange: (rate: PlaybackRate) => void }) {
  const t = useTranslations('meetings.detail');
  return (
    <div role="group" aria-label={t('playbackSpeed')} className="flex flex-wrap items-center gap-1" data-testid="playback-speed">
      <span className="text-xs text-muted-foreground" aria-hidden="true">
        {t('playbackSpeed')}
      </span>
      {PLAYBACK_RATES.map((r) => (
        <Button key={r} type="button" size="sm" variant={r === rate ? 'secondary' : 'outline'} aria-pressed={r === rate} className="max-md:min-h-11" onClick={() => onChange(r)} data-testid={`playback-rate-${r}`}>
          {rateLabel(r)}
        </Button>
      ))}
    </div>
  );
}
