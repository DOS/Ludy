// The member's working hours and days off in Settings (issue #1313). Each member sets their own: the hours a booking
// page of theirs offers (crm, #1318), in their time zone, and the days they are off. Vietnamese public holidays are
// off without being listed. A viewer sees their hours and changes nothing. The server enforces every rule. Dates read
// dd/mm/yyyy and times 24-hour HH:mm whatever the browser's language (DESIGN.md §5.5, #1428).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { CALENDAR_RANGE_MAX_DAYS, type MyCalendar, type Weekday } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { DateInput } from '../components/date-input.tsx';
import { TimeInput } from '../components/time-input.tsx';
import { ExternalCalendars } from './calendar-connections.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { DuplicateHint } from '../components/form-panel.tsx';
import { ErrorText, Field, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { BOOKING_SETTINGS_ID } from '../lib/booking.ts';
import { WEEKDAY_KEYS, dayOffRange, daysOf, datesOf, hoursOf, overlappingDayOff, timeZones, zoneLabel, type DayHours } from '../lib/calendar.ts';
import { toast } from '../lib/toast.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.calendar.get.key() });

function HoursForm({ calendar, canEdit }: { calendar: MyCalendar; canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const [timeZone, setTimeZone] = useState(calendar.hours.timeZone);
  const [days, setDays] = useState<DayHours[]>(() => daysOf(calendar.hours));
  const [invalid, setInvalid] = useState<Weekday | null>(null);
  // The zones as people say them, Vietnam first and the rest by their names (#3650); made once, not on every keystroke in a time field.
  const vietnam = t('zoneVietnam');
  const savedZone = calendar.hours.timeZone;
  const zones = useMemo(() => {
    const all = timeZones(savedZone).map((zone) => ({ zone, label: zoneLabel(zone, vietnam) }));
    return [...all.slice(0, 1), ...all.slice(1).sort((a, b) => a.label.localeCompare(b.label))];
  }, [savedZone, vietnam]);
  // "Đã lưu giờ làm việc." (#3650): the save was silent before, and the button looked as it did.
  const save = useMutation(
    orpc.calendar.saveHours.mutationOptions({
      onSuccess: () => {
        toast(t('saved'));
        return refresh();
      },
    }),
  );
  const set = (i: number, patch: Partial<DayHours>) => setDays((all) => all.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = hoursOf(timeZone, days);
    if ('invalid' in result) {
      setInvalid(result.invalid);
      return;
    }
    setInvalid(null);
    save.mutate(result.hours);
  };
  return (
    <form className="mt-3 space-y-2" onSubmit={submit} aria-label={t('title')}>
      <NativeSelect className="w-full" value={timeZone} disabled={!canEdit} onChange={(e) => setTimeZone(e.target.value)} aria-label={t('timeZone')}>
        {zones.map(({ zone, label }) => (
          <NativeSelectOption key={zone} value={zone}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <ul className="space-y-1">
        {days.map((d, i) => (
          <li key={d.weekday} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex w-28 items-center gap-2">
              <Checkbox checked={d.on} disabled={!canEdit} onCheckedChange={(on) => set(i, { on: on === true })} />
              {t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`)}
            </label>
            {d.on ? (
              <>
                <TimeInput className="w-28" value={d.start} disabled={!canEdit} onChange={(start) => set(i, { start })} aria-label={t('startOf', { day: t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`) })} />
                <span className="text-subtle-foreground">-</span>
                {/* Midnight at the end of the day is "24:00", which no time field shows: it reads 00:00, which hoursOf takes back. */}
                <TimeInput className="w-28" value={d.end === '24:00' ? '00:00' : d.end} disabled={!canEdit} onChange={(end) => set(i, { end })} aria-label={t('endOf', { day: t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`) })} />
              </>
            ) : (
              <span className="text-subtle-foreground">{t('off')}</span>
            )}
          </li>
        ))}
      </ul>
      {invalid !== null && <ErrorText>{t('invalidDay', { day: t(`weekdays.${WEEKDAY_KEYS[invalid]}`) })}</ErrorText>}
      {canEdit && (
        <>
          <Button loading={save.isPending} type="submit" variant="outline" size="sm" disabled={save.isPending || !days.some((d) => d.on)} aria-describedby={days.some((d) => d.on) ? undefined : 'working-hours-save-hint'}>
            {t('save')}
          </Button>
          {/* Why the button is off, in words (#3650). */}
          {!days.some((d) => d.on) && (
            <p id="working-hours-save-hint" className="text-xs text-muted-foreground">
              {t('saveNeedsDay')}
            </p>
          )}
        </>
      )}
      {!calendar.saved && <p className="text-xs text-subtle-foreground">{t('defaultHint')}</p>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </form>
  );
}

// The dates of a day off, asked in a dialog (#3608); a range that overlaps one already listed is flagged while it is picked.
export function AddDayOffDialog({ tz, off, onClose }: { tz: string; off: ReadonlyArray<{ timeZone: string; startsAt: string; endsAt: string }>; onClose: () => void }) {
  const t = useTranslations('workingHours');
  const f = useFormat();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const add = useMutation(
    orpc.calendar.addEvent.mutationOptions({
      onSuccess: async () => {
        await refresh();
        onClose();
      },
    }),
  );
  // An end before the start is not turned into one day: the person is told and corrects it.
  const endBeforeStart = from !== '' && to !== '' && to < from;
  const overlap = from && !endBeforeStart ? overlappingDayOff(off, tz, from, to || from) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!from || endBeforeStart) return;
    add.mutate({ ...dayOffRange(tz, from, to || from), timeZone: tz, kind: 'time_off', title: null });
  };
  return (
    <FormDialog title={t('addDayOff')} busy={add.isPending} dirty={from !== '' || to !== ''} submitLabel={t('addDayOff')} submitDisabled={!from || endBeforeStart} onClose={onClose} onSubmit={submit}>
      <Field label={t('from')}>{(control) => <DateInput {...control} required value={from} onChange={setFrom} />}</Field>
      <Field label={t('to')} hint={t('toHint')}>
        {(control) => <DateInput {...control} min={from || undefined} value={to} onChange={setTo} />}
      </Field>
      {endBeforeStart && (
        <p role="alert" className="text-sm text-destructive" data-testid="day-off-order">
          {t('endBeforeStart')}
        </p>
      )}
      <DuplicateHint testId="day-off-duplicate">
        {overlap ? t('dayOffOverlap', { from: f.date(overlap.from), to: f.date(overlap.to) }) : null}
      </DuplicateHint>
      {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
    </FormDialog>
  );
}

function DaysOff({ calendar, canEdit }: { calendar: MyCalendar; canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const f = useFormat();
  const tz = calendar.hours.timeZone;
  const [adding, setAdding] = useState(false);
  const cancel = useMutation(orpc.calendar.cancelEvent.mutationOptions({ onSuccess: refresh }));
  const off = calendar.events.filter((e) => e.kind === 'time_off');
  const day = (date: string) => f.date(date);
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">{t('daysOff')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('holidaysHint')}</p>
      {off.length === 0 ? (
        <p className="mt-2 text-sm text-subtle-foreground">{t('noDaysOff')}</p>
      ) : (
        <ul className="mt-2 divide-y">
          {off.map((e) => {
            const range = datesOf(e.timeZone, e.startsAt, e.endsAt);
            const label = range.from === range.to ? day(range.from) : t('range', { from: day(range.from), to: day(range.to) });
            return (
              <li key={e.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span>{label}</span>
                {canEdit && (
                  <Button type="button" variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ eventId: e.id })} aria-label={t('removeOf', { day: label })}>
                    {t('remove')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('addDayOff')}
          </Button>
        </div>
      )}
      {adding && <AddDayOffDialog tz={tz} off={off} onClose={() => setAdding(false)} />}
      {cancel.error && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
    </div>
  );
}

// Every member, for their own calendar; canEdit is false for a viewer.
export function WorkingHoursCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('workingHours');
  // The days off ahead: from now to the farthest a calendar read reaches.
  const [range] = useState(() => {
    const now = Date.now();
    return { from: new Date(now).toISOString(), to: new Date(now + (CALENDAR_RANGE_MAX_DAYS - 1) * 86_400_000).toISOString() };
  });
  const calendar = useQuery(orpc.calendar.get.queryOptions({ input: range }));
  return (
    <Card id={BOOKING_SETTINGS_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {calendar.isLoading ? (
        <RowsSkeleton rows={7} />
      ) : calendar.error ? (
        <ErrorText>{errorMessage(calendar.error)}</ErrorText>
      ) : calendar.data ? (
        <>
          <HoursForm key={JSON.stringify(calendar.data.hours)} calendar={calendar.data} canEdit={canEdit} />
          <DaysOff calendar={calendar.data} canEdit={canEdit} />
          <ExternalCalendars canEdit={canEdit} />
        </>
      ) : null}
    </Card>
  );
}
