// SPDX-License-Identifier: AGPL-3.0-only
// The address customers write to, to reach the Inbox by email (#2439): its own address, apart from the one invoices go to, shown to the owners and
// admins of an org on a server that receives mail. It is made the first time the Inbox is opened (no setup), a customer writes to it or the org
// forwards its own mailbox to it, and the owner can replace it (the old one stops receiving for good).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ErrorText } from './ui.tsx';
import { StepUpPrompt } from './two-factor.tsx';

export function EmailAddressCard() {
  const t = useTranslations('conversations.inbox.email');
  const tc = useTranslations('common');
  const org = useQuery(orpc.org.get.queryOptions());
  const issue = useMutation(orpc.org.issueConversationAddress.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  const [confirming, setConfirming] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const rotate = useMutation(
    orpc.org.rotateConversationAddress.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries();
      },
    }),
  );
  const rotateNow = () => rotate.mutate({ idempotencyKey });
  const address = org.data?.conversationAddress ?? null;
  // The server shows the invoice address to owners and admins of a server that receives mail: that is who may have the Inbox's address made.
  const canIssue = Boolean(org.data?.inboundAddress) && !address;
  const { mutate: makeAddress, isIdle } = issue;
  useEffect(() => {
    if (canIssue && isIdle) makeAddress({});
  }, [canIssue, isIdle, makeAddress]);

  if (!address) return issue.error ? <ErrorText>{t('issueFailed')}</ErrorText> : null;
  const copy = () =>
    void navigator.clipboard.writeText(address).then(
      () => toast(t('copied')),
      () => toast(t('copyRefused'), 'error'),
    );
  return (
    <Card className="block space-y-2 p-3" data-testid="email-address-card">
      <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-xs break-all text-foreground" data-testid="email-address">
          {address}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {t('copy')}
        </Button>
        {org.data?.role === 'owner' && !confirming && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="email-address-rotate"
            onClick={() => {
              rotate.reset();
              setConfirming(true);
            }}
          >
            {t('rotate')}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={t('rotateTitle')}>
          <p className="font-medium text-foreground">{t('rotateTitle')}</p>
          <p className="text-muted-foreground">{t('rotateBody')}</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={rotate.isPending} onClick={rotateNow}>
              {t('rotateConfirm')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={rotate.isPending}
              onClick={() => {
                rotate.reset();
                setConfirming(false);
              }}
            >
              {tc('cancel')}
            </Button>
          </div>
          {rotate.error &&
            (isStepUpRequired(rotate.error) ? <StepUpPrompt enroll={false} action={t('stepUp')} onVerified={rotateNow} /> : <ErrorText>{errorMessage(rotate.error)}</ErrorText>)}
        </div>
      )}
    </Card>
  );
}
