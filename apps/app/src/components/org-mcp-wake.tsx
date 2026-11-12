// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook of one connected AI app (ADR-0051 decision 4, issue #3024), under its row in "Connected AI apps": an owner or admin gives one https address and
// an optional schedule, and Ludy posts a signed message there that carries ids, dates and amounts only. The secret that signs it is shown once, right after it is made
// or rotated, and kept nowhere in the clear. Off by default; nothing is sent until an address is saved. No AI takes part on this screen.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { mcpWakeUrlProblem, type McpWakeSchedule, type McpWakeView, type McpWakeWithSecret } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

const SCHEDULES: readonly McpWakeSchedule[] = ['off', 'daily', 'weekly'];
// Message keys are literals, so a weekday (ISO, 1 Monday to 7 Sunday) has its own.
const WEEKDAYS = [
  [1, 'weekdayOption.1'],
  [2, 'weekdayOption.2'],
  [3, 'weekdayOption.3'],
  [4, 'weekdayOption.4'],
  [5, 'weekdayOption.5'],
  [6, 'weekdayOption.6'],
  [7, 'weekdayOption.7'],
] as const;

// Minutes after midnight (Vietnam time) as the "HH:MM" an input holds, and back.
export function minuteToTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
export function timeToMinute(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? minute : null;
}

export function OrgMcpWake({ grantId, view }: { grantId: string; view: McpWakeView | undefined }) {
  const t = useTranslations('orgMcpWake');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(view?.url ?? '');
  const [schedule, setSchedule] = useState<McpWakeSchedule>(view?.schedule ?? 'off');
  const [time, setTime] = useState(minuteToTime(view?.minute ?? 8 * 60));
  const [weekday, setWeekday] = useState(view?.weekday ?? 1);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
  const got = (r: McpWakeWithSecret) => {
    setSecret(r.secret);
    refresh();
  };
  const save = useMutation(orpc.mcp.wake.set.mutationOptions({ onSuccess: got, onError: refresh }));
  const rotate = useMutation(orpc.mcp.wake.rotateSecret.mutationOptions({ onSuccess: got, onError: refresh }));
  const test = useMutation(orpc.mcp.wake.test.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const clear = useMutation(
    orpc.mcp.wake.clear.mutationOptions({
      onSuccess: () => {
        setConfirmClear(false);
        setSecret(null);
        setUrl('');
        setSchedule('off');
        refresh();
      },
      onError: refresh,
    }),
  );
  const urlProblem = url.trim() === '' ? null : mcpWakeUrlProblem(url.trim());
  const minute = timeToMinute(time);
  const canSave = url.trim() !== '' && urlProblem === null && (schedule === 'off' || minute !== null) && !save.isPending;
  const submit = (enabled: boolean) =>
    save.mutate({
      grantId,
      url: url.trim(),
      enabled,
      schedule,
      ...(schedule === 'off' || minute === null ? {} : { minute }),
      ...(schedule === 'weekly' ? { weekday } : {}),
    });
  const error = save.error ?? rotate.error ?? clear.error ?? test.error;
  return (
    <div className="mt-2 space-y-2 text-xs" data-testid="org-mcp-wake">
      <p className="flex flex-wrap items-center gap-2 text-subtle-foreground">
        <span className="font-medium text-foreground">{t('title')}</span>
        {!view && <span>{t('notSet')}</span>}
        {view && view.enabled && <Badge>{t('on')}</Badge>}
        {view && !view.enabled && <Badge variant="destructive">{view.pausedReason === 'failing' ? t('pausedFailing') : t('off')}</Badge>}
        {view?.lastDeliveryAt && <span>{t(view.lastStatus === 'failed' ? 'lastFailed' : 'lastSent', { at: f.dateTime(view.lastDeliveryAt) })}</span>}
        {view?.nextDueAt && view.enabled && <span>{t('next', { at: f.dateTime(view.nextDueAt) })}</span>}
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('close') : view ? t('edit') : t('set')}
        </Button>
      </p>
      {view && view.consecutiveFailures > 0 && view.enabled && <p className="text-destructive">{t('failing', { count: view.consecutiveFailures })}</p>}
      {secret && (
        <div className="space-y-1 rounded-md border border-border p-2" role="status" data-testid="org-mcp-wake-secret">
          <p className="font-medium text-foreground">{t('secretOnce')}</p>
          <code className="block break-all rounded bg-muted px-2 py-1 text-foreground">{secret}</code>
          <Button size="sm" variant="outline" onClick={() => setSecret(null)}>
            {t('secretSaved')}
          </Button>
        </div>
      )}
      {test.isSuccess && <p role="status" className="text-subtle-foreground">{t('testQueued')}</p>}
      {view?.previousUntil && <p className="text-subtle-foreground">{t('overlap', { at: f.dateTime(view.previousUntil) })}</p>}
      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) submit(true);
          }}
        >
          <label className="block space-y-1">
            <span className="text-foreground">{t('url')}</span>
            <Input type="url" inputMode="url" autoComplete="off" placeholder="https://" value={url} maxLength={2048} aria-invalid={urlProblem !== null} onChange={(e) => setUrl(e.target.value)} />
          </label>
          {urlProblem && <ErrorText>{t('urlRule')}</ErrorText>}
          <p className="text-subtle-foreground">{t('bodyNote')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block space-y-1">
              <span className="text-foreground">{t('schedule')}</span>
              <NativeSelect size="sm" value={schedule} onChange={(e) => setSchedule(e.target.value as McpWakeSchedule)}>
                {SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {t(`scheduleOption.${s}`)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {schedule === 'weekly' && (
              <label className="block space-y-1">
                <span className="text-foreground">{t('weekday')}</span>
                <NativeSelect size="sm" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map(([d, key]) => (
                    <option key={d} value={d}>
                      {t(key)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {schedule !== 'off' && (
              <label className="block space-y-1">
                <span className="text-foreground">{t('time')}</span>
                <Input type="time" value={time} className="w-28" onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
          </div>
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
              <Button size="sm" variant="outline" type="button" disabled={rotate.isPending} onClick={() => rotate.mutate({ grantId })}>
                {t('rotate')}
              </Button>
            )}
            {view && view.enabled && (
              <Button size="sm" variant="outline" type="button" disabled={test.isPending} onClick={() => test.mutate({ grantId })}>
                {t('test')}
              </Button>
            )}
            {view &&
              (confirmClear ? (
                <span className="flex gap-2" role="alertdialog" aria-label={t('confirmClear')}>
                  <Button size="sm" variant="destructive" type="button" disabled={clear.isPending} onClick={() => clear.mutate({ grantId })}>
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
          {view && <p className="text-subtle-foreground">{t('secretHint', { hint: view.secretHint })}</p>}
        </form>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}
