// SPDX-License-Identifier: AGPL-3.0-only
// The address customers write to, to reach the Inbox by email (#2439): shown to the owners and admins of an org on a server that receives mail
// (the server sends it to nobody else). A customer writes to it, or the org forwards its own mailbox to it; no setup beyond that.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { orpc } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

export function EmailAddressCard() {
  const t = useTranslations('conversations.inbox.email');
  const org = useQuery(orpc.org.get.queryOptions());
  const address = org.data?.conversationAddress ?? null;
  if (!address) return null;
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
      </div>
    </Card>
  );
}
