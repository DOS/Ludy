// SPDX-License-Identifier: AGPL-3.0-only
// The disconnect confirmation of one channel (#3299): the state and the calls behind DisconnectView. With the choice off it is the disconnect
// the screen always made. With it on it disconnects first (a disconnected channel takes in no new message), then erases the channel's
// conversations by the kernel's person-only command, which asks for a fresh second factor; the step-up retry runs the same attempt again.
// The disconnect is safe to run again (a revoked channel stays revoked), so a retry after a lost answer or a second factor is the whole call.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { DisconnectView } from './social-channel-disconnect-view.tsx';
import { StepUpPrompt } from './two-factor.tsx';

export function ChannelDisconnectConfirm({ connectionId, onDone, onKeep }: { connectionId: string; onDone: () => void; onKeep: () => void }) {
  const t = useTranslations('social');
  const [erase, setErase] = useState(false);
  // One key per confirmed attempt, kept across the step-up retry, so a lost answer is retried to the same result.
  const [attempt] = useState(() => crypto.randomUUID());
  const counts = useQuery({ ...orpc.conversations.channelCounts.queryOptions({ input: { connectionId } }), enabled: erase });
  const run = useMutation({
    mutationFn: async () => {
      await client.channels.disconnect({ connectionId, idempotencyKey: crypto.randomUUID() });
      if (erase) await client.conversations.eraseChannel({ connectionId, confirm: true, idempotencyKey: attempt });
    },
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries();
    },
    // The channel is already disconnected when only the erasure failed: the screen shows it as such.
    onError: () => void queryClient.invalidateQueries({ queryKey: orpc.channels.list.key() }),
  });
  const stepUp = isStepUpRequired(run.error);
  return (
    <DisconnectView
      erase={erase}
      onErase={(on) => {
        setErase(on);
        run.reset();
      }}
      counts={counts.data ?? null}
      countsFailed={counts.isError}
      pending={run.isPending}
      onConfirm={() => run.mutate()}
      onKeep={onKeep}
      stepUp={stepUp ? <StepUpPrompt action={t('eraseStepUp')} onVerified={() => run.mutate()} onCancel={() => run.reset()} /> : null}
      error={run.error && !stepUp ? errorMessage(run.error) : null}
    />
  );
}
