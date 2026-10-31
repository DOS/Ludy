// Subscribing to one's own bookings from Google Calendar or Outlook (#1382), on the "Lịch hẹn" screen. A member who
// hosts makes the feed's address (shown once, to copy), makes a new one to cut off the old, or revokes it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const bookingFeedUrl = (origin: string, token: string) => `${origin}/cal/${token}.ics`;

export function BookingFeedCard() {
  const t = useTranslations('bookings.feed');
  const f = useFormat();
  const feed = useQuery(orpc.crm.bookingFeed.get.queryOptions({ input: {} }));
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.crm.bookingFeed.get.key() });
  const create = useMutation({
    mutationFn: () => client.crm.bookingFeed.create({}),
    onSuccess: (r) => {
      setMade(bookingFeedUrl(window.location.origin, r.token));
      setCopied(false);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => client.crm.bookingFeed.revoke({}),
    onSuccess: () => {
      setMade(null);
      refresh();
    },
  });
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const live = feed.data ?? null;
  const busy = create.isPending || revoke.isPending;
  return (
    <Card className="mb-4 block space-y-3 p-4" data-testid="booking-feed">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {feed.error ? (
        <ErrorText>{errorMessage(feed.error)}</ErrorText>
      ) : (
        feed.isSuccess && <p className="text-sm text-muted-foreground">{live ? t('live', { at: f.dateTime(live.createdAt) }) : t('none')}</p>
      )}
      {feed.isSuccess && (
        <div className="flex flex-wrap items-center gap-2">
          {live ? (
            <ConfirmDialog
              render={<Button size="sm" />}
              disabled={busy}
              title={t('recreateTitle')}
              description={t('recreateDescription')}
              confirm={t('recreateAction')}
              destructive
              onConfirm={() => create.mutate()}
            >
              {t('recreate')}
            </ConfirmDialog>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => create.mutate()}>
              {t('create')}
            </Button>
          )}
          {live && (
            <ConfirmDialog
              render={<Button size="sm" variant="ghost" />}
              disabled={busy}
              title={t('revokeTitle')}
              description={t('revokeDescription')}
              confirm={t('revokeAction')}
              destructive
              onConfirm={() => revoke.mutate()}
            >
              {t('revoke')}
            </ConfirmDialog>
          )}
        </div>
      )}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
      {made && (
        <div className="space-y-1.5 rounded-lg border border-primary/40 p-3">
          <p className="text-xs text-muted-foreground">{t('madeHint')}</p>
          <div className="flex gap-2">
            <Input readOnly value={made} aria-label={t('link')} onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
          <p className="text-xs text-subtle-foreground">{t('once')}</p>
        </div>
      )}
    </Card>
  );
}
