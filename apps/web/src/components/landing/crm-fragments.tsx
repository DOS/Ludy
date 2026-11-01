// SPDX-License-Identifier: AGPL-3.0-only
import { Bot, CalendarCheck, CalendarDays } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Chip, toneOf } from './ui';

type Crm = Dictionary['modules']['crm'];

// The pieces of Ludy CRM's booking side, drawn from the real screens with the sample company's data: the public page a
// client picks a time on, the booking that reaches the host, the host's connected calendar, and Vy's suggestion for a
// client's message. Used by the home page's Ludy CRM card and by the Ludy CRM page.
export function BookingSlots({ crm }: { crm: Crm }) {
  return (
    <figure className="min-w-0 rounded-md border border-line bg-bg p-3">
      <figcaption>
        <div className="text-sm font-semibold">{crm.pageTitle}</div>
        <div className="text-xs text-subtle">{crm.pageSub}</div>
      </figcaption>
      <div className="mt-3 text-xs text-subtle">{crm.slotsLabel}</div>
      <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {crm.days.map((day) => (
          <li key={day.label} className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[11px] text-subtle">{day.label}</span>
            {day.slots.length === 0 ? (
              <span className="rounded-sm border border-dashed border-line px-1.5 py-1 text-center text-[11px] text-subtle">{crm.noSlots}</span>
            ) : (
              day.slots.map((slot) => {
                const picked = 'picked' in day && day.picked === slot;
                return (
                  <span
                    key={slot}
                    className={`num rounded-sm border px-1.5 py-1 text-center text-xs ${picked ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface'}`}
                  >
                    {slot}
                    {picked ? <span className="sr-only">, {crm.pickedLabel}</span> : null}
                  </span>
                );
              })
            )}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function BookingConfirmed({ crm }: { crm: Crm }) {
  return (
    <div className="rounded-md border border-line bg-bg p-3 text-xs">
      <div className="flex items-center gap-2">
        <CalendarCheck className="size-4 shrink-0 text-ok" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{crm.booked.title}</span>
        <Chip tone={toneOf('ok')}>{crm.booked.state}</Chip>
      </div>
      <div className="mt-2 font-medium">{crm.booked.who}</div>
      <div className="num text-subtle">{crm.booked.when}</div>
    </div>
  );
}

export function CalendarConnection({ crm }: { crm: Crm }) {
  return (
    <div className="rounded-md border border-line bg-bg p-3 text-xs">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{crm.calendar.provider}</span>
          <span className="block truncate text-subtle">{crm.calendar.title}</span>
        </span>
        <Chip tone={toneOf('ok')}>{crm.calendar.state}</Chip>
      </div>
      <dl className="mt-3 flex flex-col gap-1.5">
        {crm.calendar.rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-subtle">{label}</dt>
            <dd className="num shrink-0 text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function VySuggestion({ crm }: { crm: Crm }) {
  return (
    <p className="flex gap-2 rounded-md border border-dashed border-accent/50 bg-bg p-3 text-xs text-muted">
      <Bot className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden="true" />
      <span>{crm.suggest}</span>
    </p>
  );
}
