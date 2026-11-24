// SPDX-License-Identifier: AGPL-3.0-only
// "Ký biên bản họp" (Meetings, #4703): the org setting that lets recorders send published minutes for eSign. Off by default; every member reads it (the minutes page shows the "Gửi ký" handoff only
// while it is on), an owner or admin turns it on or off. The server refuses a new minutes envelope while it is off (SIGN_MINUTES_SIGNING_OFF), so this screen only hides the handoff and says why.
// Envelopes made earlier stay readable and signed ones downloadable. No AI part: the core works with AI off, and a person still presses "Gửi ký" for every envelope.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ErrorText } from './ui.tsx';

// Whether the org lets minutes be sent for eSign; false while it loads or when it cannot be read (the server decides in any case).
export function useMinutesEsign(): boolean {
  const query = useQuery(orpc.meetings.minutesEsign.get.queryOptions({ input: {} }));
  return query.data?.enabled === true;
}

export function MinutesEsignCard() {
  const t = useTranslations('meetings.minutesEsign');
  const query = useQuery(orpc.meetings.minutesEsign.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const enabled = query.data?.enabled === true;
  const flip = useMutation({
    mutationFn: (next: boolean) => orpc.meetings.minutesEsign.set.call({ enabled: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesEsign.key() });
      toast(t('saved'), 'success');
    },
  });

  if (query.isPending) return null;
  return (
    <Card data-testid="minutes-esign-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? 'default' : 'outline'} data-testid="minutes-esign-state">
            {enabled ? t('stateOn') : t('stateOff')}
          </Badge>
          {canEdit ? (
            <Button size="sm" variant="outline" disabled={flip.isPending} onClick={() => flip.mutate(!enabled)} data-testid="minutes-esign-toggle">
              {enabled ? t('turnOff') : t('turnOn')}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
          )}
        </div>
        {flip.error ? <ErrorText>{errorMessage(flip.error)}</ErrorText> : null}
      </CardContent>
    </Card>
  );
}
