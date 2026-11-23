// SPDX-License-Identifier: AGPL-3.0-only
// The confirmation of a channel's disconnect on the Channels screen (owners and admins), with the choice to delete the channel's conversations
// too (#3299, plan docs/plan/conversations.md section 10). The choice is off by default: a disconnect keeps the stored conversations as the org's
// service history. Turning it on names how many threads and messages will be erased, and the button says so. This part only draws; the
// container (social-channel-disconnect.tsx) holds the state and makes the calls.
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';

export interface DisconnectCounts {
  threads: number;
  messages: number;
}

export interface DisconnectViewProps {
  erase: boolean;
  onErase: (on: boolean) => void;
  // What the erasure would remove; null while it is being counted.
  counts: DisconnectCounts | null;
  // The count could not be read: the erasure is not offered without the number it names.
  countsFailed: boolean;
  pending: boolean;
  onConfirm: () => void;
  onKeep: () => void;
  // The second factor prompt (the erasure asks for a fresh one) and any other error, drawn under the choice.
  stepUp: ReactNode;
  error: string | null;
}

export function DisconnectView({ erase, onErase, counts, countsFailed, pending, onConfirm, onKeep, stepUp, error }: DisconnectViewProps) {
  const t = useTranslations('social');
  const waiting = erase && counts === null;
  return (
    <div className="space-y-2" data-testid="channel-disconnect-confirm">
      {/* What happens comes first, then the choice, then the buttons (#3651). */}
      <p className="text-sm text-muted-foreground">{t('disconnectHint')}</p>
      <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
        <Checkbox className="mt-0.5" checked={erase} disabled={pending} data-testid="channel-erase-too" onCheckedChange={(checked) => onErase(checked === true)} />
        <span>
          {t('eraseToo')}
          <span className="block text-xs text-subtle-foreground">{t('eraseTooHint')}</span>
        </span>
      </label>
      {erase && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" role="alert" data-testid="channel-erase-warning">
          {counts ? t('eraseWarn', counts) : countsFailed ? t('eraseCountsFailed') : t('eraseCounting')}
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="destructive" size="sm" disabled={pending || waiting || (erase && countsFailed)} data-testid="channel-disconnect-yes" onClick={onConfirm}>
          {erase && counts ? t('disconnectAndErase', counts) : t('confirmDisconnect')}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onKeep}>
          {t('keep')}
        </Button>
      </div>
      {stepUp}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
