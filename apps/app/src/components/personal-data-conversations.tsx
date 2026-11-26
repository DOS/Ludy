// SPDX-License-Identifier: AGPL-3.0-only
// Matching customer conversations on Settings > Personal data (#3669): shows bounded per-identity previews (direct email/WhatsApp
// or via a linked contact) and erases one matched customer at a time via kernel.conversation.erase_contact (R3 step-up).
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ConversationPersonalDataItem, ConversationPersonalDataResult } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { cn } from '@ludy/ui/lib/utils';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { channelKindLabel } from '../lib/conversation-labels.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';
import { providerName } from '../lib/social.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { StepUpPrompt } from './two-factor.tsx';
import { CardSkeleton, ErrorText } from './ui.tsx';

type EraseAttempt = { item: ConversationPersonalDataItem; idempotencyKey: string };

export function PersonalDataConversations({
  data,
  isFetching,
  error,
}: {
  data: ConversationPersonalDataResult | undefined;
  isFetching: boolean;
  error: unknown;
}) {
  const t = useTranslations('personalData.conversationsSection');
  const tc = useTranslations('conversations');
  const [confirming, setConfirming] = useState<ConversationPersonalDataItem | null>(null);
  // One idempotency key per confirmed attempt, kept across the MFA step-up retry so a lost response never double-acts.
  const [activeAttempt, setActiveAttempt] = useState<EraseAttempt | null>(null);

  const labelOf = (item: ConversationPersonalDataItem) => item.displayName ?? tc('anonymous', { tail: item.idTail });
  const channelLabelOf = (item: ConversationPersonalDataItem) =>
    channelKindLabel(item.channelName, item.provider === 'email' ? 'Email' : providerName(item.provider));

  const erase = useMutation({
    mutationFn: (attempt: EraseAttempt) =>
      client.conversations.eraseContact({
        conversationId: attempt.item.eraseTarget.conversationId,
        ...(attempt.item.eraseTarget.messageId ? { messageId: attempt.item.eraseTarget.messageId } : {}),
        confirm: true,
        idempotencyKey: attempt.idempotencyKey,
      }),
    onSuccess: (done, attempt) => {
      setActiveAttempt(null);
      toast(t('erased', { name: labelOf(attempt.item), threads: done.threads, messages: done.messages }), 'success');
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.org.personalData.key() });
    },
    onError: (err) => {
      // Step-up renders an inline prompt below so the verified retry repeats the exact same idempotencyKey.
      if (!isStepUpRequired(err)) toast(errorMessage(err), 'error');
    },
  });

  if (isFetching && !data) {
    return (
      <div className="mt-6 max-w-3xl">
        <CardSkeleton />
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-6 max-w-3xl">
        <ErrorText>{errorMessage(error)}</ErrorText>
      </div>
    );
  }
  if (!data || data.items.length === 0) return null;

  const totals = data.items.reduce(
    (acc, item) => ({
      threads: acc.threads + item.threads,
      messages: acc.messages + item.messages,
      notes: acc.notes + item.notes,
    }),
    { threads: 0, messages: 0, notes: 0 },
  );

  const stepUpAttempt = erase.error && isStepUpRequired(erase.error) ? activeAttempt : null;
  const nonStepUpError = erase.error && !isStepUpRequired(erase.error) ? erase.error : null;

  const confirmDescription = (item: ConversationPersonalDataItem): string => {
    const name = labelOf(item);
    const channel = channelLabelOf(item);
    const at = item.address ? ` (${item.address})` : '';
    const base =
      item.threads > 0
        ? t('confirmOwn', { name, at, channel, threads: item.threads, messages: item.messages, notes: item.notes })
        : t('confirmAuthor', { name, at, channel, messages: item.messages });
    const parts = [base];
    if (item.inComments) parts.push(t('confirmComments'));
    if (item.matchSource === 'linked_contact' && item.linkedContactNames.length > 0) {
      parts.push(t('confirmLinkedNotice', { names: item.linkedContactNames.join(', ') }));
    }
    parts.push(t('confirmStays'));
    return parts.join(' ');
  };

  return (
    <section aria-labelledby="personal-data-conversations-heading" className="mt-6 max-w-3xl space-y-3" data-testid="personal-data-conversations-results">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="personal-data-conversations-heading" className="text-base font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-xs text-muted-foreground" data-testid="personal-data-conversations-summary">
            {t('summary', { identities: data.items.length, threads: totals.threads, messages: totals.messages, notes: totals.notes })}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
        {data.truncated && (
          <p className="text-xs font-medium text-warning" data-testid="personal-data-conversations-truncated">
            {t('truncated')}
          </p>
        )}
      </div>

      {stepUpAttempt && (
        <StepUpPrompt
          action={t('stepUp', { name: labelOf(stepUpAttempt.item) })}
          onVerified={() => erase.mutate(stepUpAttempt)}
          onCancel={() => {
            erase.reset();
            setActiveAttempt(null);
          }}
        />
      )}
      {nonStepUpError && <ErrorText>{errorMessage(nonStepUpError)}</ErrorText>}

      <ul className="divide-y divide-border rounded-xl border bg-card">
        {data.items.map((item) => {
          const customerLabel = labelOf(item);
          const channelLabel = channelLabelOf(item);
          const erasingThis = erase.isPending && activeAttempt?.item.identityId === item.identityId;
          return (
            <li key={item.identityId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="personal-data-conversation-row">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{customerLabel}</span>
                  {item.address ? (
                    <span className="font-mono text-xs text-muted-foreground">{item.address}</span>
                  ) : (
                    item.displayName !== null && item.idTail && <span className="font-mono text-xs text-muted-foreground">…{item.idTail}</span>
                  )}
                  <Badge variant={item.matchSource === 'direct' ? 'outline' : 'warning'}>
                    {t(item.matchSource === 'direct' ? 'matchDirect' : 'matchLinked')}
                  </Badge>
                  {item.inComments && <Badge variant="secondary">{t('includesCommentThreads')}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{channelLabel}</p>
                {item.linkedContactNames.length > 0 && (
                  <p className="text-xs text-muted-foreground">{t('linkedContact', { names: item.linkedContactNames.join(', ') })}</p>
                )}
                <p className="text-xs text-muted-foreground tabular-nums">
                  {item.threads > 0
                    ? t('rowCounts', { threads: item.threads, messages: item.messages, notes: item.notes })
                    : t('commenterOnlyCounts', { messages: item.messages })}
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                loading={erasingThis}
                disabled={erase.isPending}
                className={cn(TOUCH_BUTTON, 'shrink-0 max-sm:w-full')}
                aria-label={t('eraseAria', { name: customerLabel, channel: channelLabel })}
                data-testid="personal-data-conversation-erase"
                onClick={() => {
                  erase.reset();
                  setActiveAttempt(null);
                  setConfirming(item);
                }}
              >
                {t('erase')}
              </Button>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        destructive
        title={confirming ? t('confirmTitle', { name: labelOf(confirming) }) : ''}
        description={confirming ? confirmDescription(confirming) : ''}
        confirm={t('confirmButton')}
        cancel={t('cancel')}
        onConfirm={() => {
          if (!confirming) return;
          const attempt: EraseAttempt = { item: confirming, idempotencyKey: crypto.randomUUID() };
          setConfirming(null);
          setActiveAttempt(attempt);
          erase.mutate(attempt);
        }}
      />
    </section>
  );
}
