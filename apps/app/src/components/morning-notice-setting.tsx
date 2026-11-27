// SPDX-License-Identifier: AGPL-3.0-only
// The member's opt-in to the morning notice and daily briefing of the day's meetings (#3955 part B, #5080), in their notification settings: off by default, theirs alone, at a time of day they pick in their own time zone.
// Content mode defaults to count-only ('count'); switching to 'full' explicitly opts in to sending meeting titles, org reader names, external invitee counts, open items, and open CRM deals via email.
// A separate 'vyLines' checkbox (off by default, requires 'full') opts in to Vy's short prep lines for up to 5 meetings a day; the full factual briefing still works when AI is off.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  MORNING_CONTENT_MODES,
  MORNING_DEFAULT_MINUTE,
  MORNING_KIND,
  type MorningContentMode,
  type MorningState,
} from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { toast } from '../lib/toast.ts';

// "07:30" and 450 are the same time of day.
export const minuteToTime = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function timeToMinute(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

// The browser's zone, else Vietnam's: the notice is for people working in Vietnam first.
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

export function MorningNoticeSetting({ muted = false }: { muted?: boolean }) {
  const t = useTranslations('notifications.morningNotice');
  const queryClient = useQueryClient();
  const radioGroupRef = useRef<HTMLDivElement>(null);
  // The mail is written in the language the member uses in the app when they turn it on.
  const language = useLocale() === 'en' ? 'en' : 'vi';
  const setting = useQuery(orpc.meetings.morning.get.queryOptions({ input: {} }));
  const set = useMutation({
    mutationFn: async (input: { enabled: boolean; minute: number; content: MorningContentMode; vyLines: boolean }) => {
      // One switch: turning the notice on also lifts an earlier mute of its kind in the notification settings, or nothing would ever be sent.
      if (input.enabled && muted) await client.notifications.mute({ kind: MORNING_KIND, muted: false });
      const nextVyLines = input.enabled && input.content === 'full' ? input.vyLines : false;
      return client.meetings.morning.set({
        enabled: input.enabled,
        minute: input.minute,
        timeZone: browserZone(),
        language,
        content: input.content,
        vyLines: nextVyLines,
      });
    },
    // Saving is silent otherwise (the switch moves, a time is saved when its field is left): the toaster is a live region, so a screen reader hears that it was kept (WCAG 4.1.3).
    onSuccess: () => toast(t('saved'), 'success'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.morning.get.queryOptions({ input: {} }).queryKey });
      void queryClient.invalidateQueries({ queryKey: orpc.notifications.list.key() });
    },
  });
  const state: MorningState | undefined = setting.data;
  const minute = set.isPending ? set.variables.minute : (state?.minute ?? MORNING_DEFAULT_MINUTE);
  const enabled = set.isPending ? set.variables.enabled : (state?.enabled ?? false);
  const content: MorningContentMode = (set.isPending ? set.variables.content : state?.content) ?? 'count';
  const vyLines = enabled && content === 'full' && (set.isPending ? set.variables.vyLines : (state?.vyLines ?? false));
  const busy = setting.isPending || set.isPending;
  const mailOn = getConfig().mailEnabled;
  // The time is saved when the field is left (a browser fires a change for each part of a time while it is typed).
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft === null ? null : timeToMinute(draft);
    setDraft(null);
    if (next !== null && next !== minute) set.mutate({ enabled: true, minute: next, content, vyLines });
  };

  const selectContent = (nextMode: MorningContentMode) => {
    if (!enabled || busy || nextMode === content) return;
    set.mutate({
      enabled: true,
      minute,
      content: nextMode,
      vyLines: nextMode === 'full' ? vyLines : false,
    });
  };

  const handleContentKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!enabled || busy) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % MORNING_CONTENT_MODES.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + MORNING_CONTENT_MODES.length) % MORNING_CONTENT_MODES.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = MORNING_CONTENT_MODES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const targetMode = MORNING_CONTENT_MODES[nextIndex];
    if (!targetMode) return;
    radioGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
    selectContent(targetMode);
  };

  return (
    <Card className="block space-y-3 p-4" data-testid="morning-notice-setting">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p id="morning-notice-hint" className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={enabled}
          aria-describedby="morning-notice-hint"
          disabled={busy}
          onCheckedChange={(checked) => set.mutate({ enabled: checked === true, minute, content, vyLines })}
        />
        {t('label')}
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
        {t('at')}
        <Input
          type="time"
          aria-label={t('at')}
          aria-describedby={enabled ? 'morning-notice-zone' : undefined}
          className="min-h-11 w-32"
          value={draft ?? minuteToTime(minute)}
          disabled={!enabled || setting.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          data-testid="morning-notice-time"
        />
      </label>
      {enabled && <p id="morning-notice-zone" className="text-xs text-subtle-foreground">{t('zone', { zone: state?.timeZone ?? browserZone() })}</p>}
      <div className="space-y-2 border-t border-border/60 pt-3">
        <p id="morning-notice-content-label" className="text-xs font-medium text-foreground">
          {t('contentLabel')}
        </p>
        <div
          ref={radioGroupRef}
          role="radiogroup"
          aria-labelledby="morning-notice-content-label"
          aria-disabled={!enabled || busy || undefined}
          className="grid gap-2 sm:grid-cols-2"
        >
          {MORNING_CONTENT_MODES.map((mode, index) => {
            const chosen = content === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={chosen}
                tabIndex={enabled && chosen ? 0 : -1}
                disabled={!enabled || busy}
                data-value={mode}
                data-testid={`morning-notice-content-${mode}`}
                onClick={() => selectContent(mode)}
                onKeyDown={(event) => handleContentKeyDown(event, index)}
                className={`flex min-h-11 flex-col items-start justify-center gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                  chosen ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/40'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span
                    aria-hidden="true"
                    className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                      chosen ? 'border-primary' : 'border-field-border'
                    }`}
                  >
                    {chosen && <span className="size-2 rounded-full bg-primary" />}
                  </span>
                  {t(`content.${mode}.title`)}
                </span>
                <span className="text-xs text-subtle-foreground">{t(`content.${mode}.hint`)}</span>
              </button>
            );
          })}
        </div>
        {enabled && content === 'full' && (
          <p className="text-xs text-subtle-foreground" data-testid="morning-notice-full-notice">
            {t('fullNotice')}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className="flex min-h-11 items-start gap-2.5 py-1 text-sm text-muted-foreground">
          <Checkbox
            className="mt-0.5"
            checked={vyLines}
            aria-describedby="morning-notice-vy-hint"
            disabled={!enabled || content !== 'full' || busy}
            data-testid="morning-notice-vy-lines"
            onCheckedChange={(checked) => {
              if (!enabled || content !== 'full' || busy) return;
              set.mutate({ enabled: true, minute, content: 'full', vyLines: checked === true });
            }}
          />
          <span className="space-y-0.5">
            <span className="block font-medium text-foreground">{t('vyLinesLabel')}</span>
            <span id="morning-notice-vy-hint" className="block text-xs text-subtle-foreground">
              {t('vyLinesHint')}
            </span>
          </span>
        </label>
      </div>
      {!mailOn && <p className="text-xs text-subtle-foreground">{t('noMail')}</p>}
      {(setting.error || set.error) && <ErrorText>{errorMessage(setting.error ?? set.error)}</ErrorText>}
    </Card>
  );
}
