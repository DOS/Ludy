// SPDX-License-Identifier: AGPL-3.0-only
// "Gửi biên bản tới địa chỉ của tôi" (Meetings A6, #3164): a member's own webhook for the minutes they publish. The owner of the organization turns the feature on (off by default);
// each member then gives one https address and ticks what goes there beyond the always-sent ids and times (title, summary, decisions, action items; never the transcript, audio, video
// or attendee contact details). The text leaves Ludy and cannot be recalled, and the screen says so before anything is saved. The secret that signs the message is shown once, right
// after it is made or rotated, and Ludy keeps it only sealed. No AI takes part on this screen; the minutes are what a person approved by publishing.
import { useQuery, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_HOOK_FIELDS, mcpWakeUrlProblem, type MeetingHookField, type MeetingHookWithSecret } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

// The host of an address (never its path, which can carry a token).
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function MeetingHookCard() {
  const t = useTranslations('meetings.hook');
  const f = useFormat();
  const query = useQuery(orpc.meetings.hook.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const isOwner = orgQuery.data?.role === 'owner';
  const view = query.data?.hook ?? null;
  const switchOn = query.data?.switchOn ?? false;
  const sealing = query.data?.sealing ?? true;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState<readonly MeetingHookField[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.meetings.hook.key() });
  const got = (r: MeetingHookWithSecret) => {
    if (r.secret) setSecret(r.secret);
    refresh();
  };
  const save = useMutation(orpc.meetings.hook.set.mutationOptions({ onSuccess: got, onError: refresh }));
  const rotate = useMutation(orpc.meetings.hook.rotateSecret.mutationOptions({ onSuccess: got, onError: refresh }));
  const test = useMutation(orpc.meetings.hook.test.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const flip = useMutation(orpc.meetings.hook.switch.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const clear = useMutation(
    orpc.meetings.hook.clear.mutationOptions({
      onSuccess: () => {
        setConfirmClear(false);
        setSecret(null);
        setUrl('');
        setFields(null);
        refresh();
      },
      onError: refresh,
    }),
  );

  if (query.isPending) return null;
  const shownUrl = url === '' && view ? view.url : url;
  const shownFields = fields ?? view?.fields ?? [];
  const urlProblem = shownUrl.trim() === '' ? null : mcpWakeUrlProblem(shownUrl.trim());
  const canSave = switchOn && sealing && shownUrl.trim() !== '' && urlProblem === null && !save.isPending;
  const submit = (enabled: boolean) => save.mutate({ url: shownUrl.trim(), fields: [...shownFields], enabled });
  const toggle = (field: MeetingHookField, on: boolean) => setFields(MEETING_HOOK_FIELDS.filter((x) => (x === field ? on : shownFields.includes(x))));
  const error = save.error ?? rotate.error ?? clear.error ?? test.error ?? flip.error;

  return (
    <Card data-testid="meeting-hook">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isOwner && (
          <div className="flex flex-wrap items-center gap-2" data-testid="meeting-hook-switch">
            <span className="font-medium text-foreground">{t('switchLabel')}</span>
            <Badge variant={switchOn ? 'default' : 'outline'}>{switchOn ? t('switchOn') : t('switchOff')}</Badge>
            <Button size="sm" variant="outline" disabled={flip.isPending} onClick={() => flip.mutate({ on: !switchOn })}>
              {switchOn ? t('switchTurnOff') : t('switchTurnOn')}
            </Button>
            {switchOn && <span className="text-xs text-muted-foreground">{t('switchOffNote')}</span>}
          </div>
        )}
        {!sealing && (
          <p role="alert" className="text-destructive" data-testid="meeting-hook-nosealing">
            {t('noSealing')}
          </p>
        )}
        {!switchOn ? (
          <div className="space-y-2">
            <p className="text-muted-foreground" data-testid="meeting-hook-disabled">
              {isOwner ? t('offOwner') : t('offMember')}
            </p>
            {view && (
              <p className="flex flex-wrap items-center gap-2 text-subtle-foreground" data-testid="meeting-hook-saved">
                <span>{t('savedWhileOff', { host: hostOf(view.url) })}</span>
                {confirmClear ? (
                  <span className="flex gap-2" role="alertdialog" aria-label={t('confirmClear')}>
                    <Button size="sm" variant="destructive" type="button" disabled={clear.isPending} onClick={() => clear.mutate({})}>
                      {t('clear')}
                    </Button>
                    <Button size="sm" variant="outline" type="button" onClick={() => setConfirmClear(false)}>
                      {t('cancel')}
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="outline" type="button" onClick={() => setConfirmClear(true)}>
                    {t('clear')}
                  </Button>
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="rounded-md border border-border p-2 text-foreground" data-testid="meeting-hook-warning">
              {t('outside')}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-subtle-foreground">
              {!view && <span>{t('notSet')}</span>}
              {view && view.enabled && <Badge>{t('on')}</Badge>}
              {view && !view.enabled && <Badge variant="destructive">{view.pausedReason === 'failing' ? t('pausedFailing') : t('off')}</Badge>}
              {view?.lastDeliveryAt && <span>{t(view.lastStatus === 'failed' ? 'lastFailed' : 'lastSent', { at: f.dateTime(view.lastDeliveryAt) })}</span>}
              <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? t('close') : view ? t('edit') : t('set')}
              </Button>
            </p>
            {view && view.enabled && view.consecutiveFailures > 0 && <p className="text-destructive">{t('failing', { count: view.consecutiveFailures })}</p>}
            {secret && (
              <div className="space-y-1 rounded-md border border-border p-2" role="status" data-testid="meeting-hook-secret">
                <p className="font-medium text-foreground">{t('secretOnce')}</p>
                <code className="block break-all rounded bg-muted px-2 py-1 text-foreground">{secret}</code>
                <Button size="sm" variant="outline" onClick={() => setSecret(null)}>
                  {t('secretSaved')}
                </Button>
              </div>
            )}
            {test.isSuccess && (
              <p role="status" className="text-subtle-foreground">
                {t('testQueued')}
              </p>
            )}
            {view?.previousUntil && <p className="text-subtle-foreground">{t('overlap', { at: f.dateTime(view.previousUntil) })}</p>}
            {open && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSave) submit(true);
                }}
              >
                <label className="block space-y-1">
                  <span className="text-foreground">{t('url')}</span>
                  <Input type="url" inputMode="url" autoComplete="off" placeholder="https://" value={shownUrl} maxLength={2048} aria-invalid={urlProblem !== null} onChange={(e) => setUrl(e.target.value)} />
                </label>
                {urlProblem && <ErrorText>{t('urlRule')}</ErrorText>}
                <fieldset className="space-y-1">
                  <legend className="text-foreground">{t('fieldsLegend')}</legend>
                  <p className="text-xs text-subtle-foreground">{t('alwaysSent')}</p>
                  {MEETING_HOOK_FIELDS.map((field) => (
                    <label key={field} className="flex items-center gap-2 text-foreground">
                      <Checkbox checked={shownFields.includes(field)} onCheckedChange={(on) => toggle(field, on === true)} aria-label={t(`field.${field}`)} />
                      <span>{t(`field.${field}`)}</span>
                    </label>
                  ))}
                  <p className="text-xs text-subtle-foreground">{t('neverSent')}</p>
                </fieldset>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" type="submit" disabled={!canSave}>
                    {t('save')}
                  </Button>
                  {view && view.enabled && (
                    <Button size="sm" variant="outline" type="button" disabled={!canSave} onClick={() => submit(false)}>
                      {t('pause')}
                    </Button>
                  )}
                  {view && (
                    <Button size="sm" variant="outline" type="button" disabled={rotate.isPending || !sealing} onClick={() => rotate.mutate({})}>
                      {t('rotate')}
                    </Button>
                  )}
                  {view && view.enabled && (
                    <Button size="sm" variant="outline" type="button" disabled={test.isPending} onClick={() => test.mutate({})}>
                      {t('test')}
                    </Button>
                  )}
                  {view &&
                    (confirmClear ? (
                      <span className="flex gap-2" role="alertdialog" aria-label={t('confirmClear')}>
                        <Button size="sm" variant="destructive" type="button" disabled={clear.isPending} onClick={() => clear.mutate({})}>
                          {t('clear')}
                        </Button>
                        <Button size="sm" variant="outline" type="button" onClick={() => setConfirmClear(false)}>
                          {t('cancel')}
                        </Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" type="button" onClick={() => setConfirmClear(true)}>
                        {t('clear')}
                      </Button>
                    ))}
                </div>
                {view && <p className="text-xs text-subtle-foreground">{t('secretHint', { hint: view.secretHint })}</p>}
              </form>
            )}
          </div>
        )}
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      </CardContent>
    </Card>
  );
}
