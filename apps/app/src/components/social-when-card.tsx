// SPDX-License-Identifier: AGPL-3.0-only
// "Khi nào đăng?" of the composer (#3653): a specific time, the next free slot of the channels' queues (offered only when
// every chosen channel has slots), or a draft with no time yet. The person chooses; the default is a time, so the first
// post of a new channel never meets an empty queue.
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { cn } from '@crove/ui/lib/utils';
import { DateTimeInput } from './date-time-input.tsx';
import type { WhenMode } from '../lib/social-when.ts';

export function WhenCard({
  mode,
  onMode,
  queueAvailable,
  noSlots,
  value,
  onValue,
  min,
  disabled,
  timeInPast,
}: {
  mode: WhenMode;
  onMode: (mode: WhenMode) => void;
  // Every chosen channel has queue slots: only then is "the next free slot" offered.
  queueAvailable: boolean;
  // Channels are chosen and their queues read, and one has no slots: why "the next free slot" is not offered.
  noSlots: boolean;
  // A datetime-local string; "" while a half is missing.
  value: string;
  onValue: (value: string) => void;
  min: string;
  disabled?: boolean;
  // The time typed is not ahead of now.
  timeInPast: boolean;
}) {
  const t = useTranslations('social');
  const modes: readonly WhenMode[] = queueAvailable ? ['time', 'queue', 'draft'] : ['time', 'draft'];
  const names: Record<WhenMode, 'atTime' | 'nextSlot' | 'whenLater'> = { time: 'atTime', queue: 'nextSlot', draft: 'whenLater' };
  return (
    <Card className="block space-y-3 p-4">
      <p id="compose-when-title" className="text-sm font-medium text-foreground">
        {t('whenTitle')}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="compose-when-title">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            disabled={disabled}
            onClick={() => onMode(m)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              mode === m ? 'border-primary/50 bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(names[m])}
          </button>
        ))}
      </div>
      {mode === 'time' && (
        <div className="space-y-1">
          <DateTimeInput aria-label={t('whenTimeLabel')} value={value} min={min} disabled={disabled ?? false} onChange={onValue} />
          {timeInPast && <p role="alert" className="text-xs text-destructive">{t('whenPast')}</p>}
        </div>
      )}
      {mode === 'queue' && <p className="text-xs text-subtle-foreground">{t('whenQueueHint')}</p>}
      {mode === 'draft' && <p className="text-xs text-subtle-foreground">{t('whenDraftHint')}</p>}
      {noSlots && mode === 'time' && <p className="text-xs text-subtle-foreground">{t('whenNoSlotsHint')}</p>}
    </Card>
  );
}
