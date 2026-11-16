// SPDX-License-Identifier: AGPL-3.0-only
// The disconnect confirmation of one channel (#3299): the state and the calls behind DisconnectView. With the choice off it is the plain disconnect
// the screen always made. With it on, one call does both steps in one transaction (the kernel's person-only erase, which disconnects a channel that
// is still connected and then erases its conversations), and it asks for a fresh second factor before anything changes: the channel stays as it was
// while the prompt is open, a cancelled prompt changes nothing, and the retry after the second factor is the same call with the same key.
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
      if (erase) await client.conversations.eraseChannel({ connectionId, confirm: true, idempotencyKey: attempt });
      else await client.channels.disconnect({ connectionId, idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries();
    },
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
