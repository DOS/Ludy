// SPDX-License-Identifier: AGPL-3.0-only
import { Check, ChevronDown, Lock, TriangleAlert, Users } from 'lucide-react';
import type { CrmCopy } from '../../content/crm-vi';
import type { Dictionary } from '../../content/vi';
import { BookingConfirmed, BookingSlots, CalendarConnection, VySuggestion } from '../landing/crm-fragments';
import { Chip } from '../landing/ui';

// The pieces of Ludy CRM the page draws, in HTML with the home page's sample company: each is something the product
// shows today. Panel titles are not headings, so the page's outline stays the section titles and the feature groups.
type Props = { dict: Dictionary; copy: CrmCopy };

function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="text-sm font-semibold">{title}</span>
      {sub ? <span className="text-xs text-subtle">{sub}</span> : null}
    </div>
  );
}

// The hero: the deal board, one column per stage with its card count and total, each card with its customer, amount and
// expected close date. The columns stack on a phone, so the page never scrolls sideways.
export function CrmHero({ dict, copy }: Props) {
  const f = copy.fragments.board;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {f.stages.map((stage) => (
          <li key={stage.name} className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-bg p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-0.5">
              <span className="min-w-0 text-sm font-semibold">{stage.name}</span>
              <Chip tone={stage.tone}>
                {stage.deals.length} {f.cards}
              </Chip>
            </div>
            <div className="num px-0.5 text-xs text-subtle">{stage.sum}</div>
            {stage.deals.length === 0 ? (
              <p className="rounded-sm border border-dashed border-line px-2 py-3 text-center text-xs text-subtle">{f.empty}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {stage.deals.map((deal) => (
                  <li key={deal.title} className="min-w-0 rounded-sm border border-line bg-surface p-2.5 text-xs">
                    <span className="block font-medium text-fg">{deal.title}</span>
                    <span className="mt-0.5 block text-muted">{deal.party}</span>
                    <span className="num mt-2 block text-sm font-semibold">{deal.amount}</span>
                    <span className="mt-1 block text-subtle">
                      {f.closeOn} <span className="num">{deal.close}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </figure>
  );
}

// Contacts: the preview step of an import, every row marked as new, duplicate or invalid before anything is written.
export function ContactsVisual({ copy }: Props) {
  const f = copy.fragments.import;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.file} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-xs text-subtle">
        {f.steps.map((step, i) => (
          <li key={step} aria-current={i === f.current ? 'step' : undefined} className={i === f.current ? 'font-semibold text-fg' : ''}>
            {i + 1}. {step}
          </li>
        ))}
      </ol>
      <p className="px-4 pt-3 text-xs text-muted">{f.hint}</p>
      <ul className="flex flex-wrap gap-2 px-4 pt-3">
        {f.counts.map((count) => (
          <li key={count.label}>
            <Chip tone={count.tone}>{count.label}</Chip>
          </li>
        ))}
      </ul>
      <table className="mt-3 w-full text-left text-xs">
        <thead>
          <tr className="border-y border-line text-subtle">
            {f.head.map((cell, i) => (
              <th key={cell} scope="col" className={`py-2 font-medium ${i === 1 ? 'pr-2' : 'px-4'} ${i === 2 ? 'text-right' : ''}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {f.rows.map((row) => (
            <tr key={row.n}>
              <td className="num px-4 py-2.5 align-top text-subtle">{row.n}</td>
              <td className="py-2.5 pr-2 align-top font-medium">
                {row.name}
                {row.note ? <span className="mt-0.5 block font-normal text-subtle">{row.note}</span> : null}
              </td>
              <td className="px-4 py-2.5 text-right align-top">
                <Chip tone={row.tone}>
                  {row.tone === 'ok' ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : <TriangleAlert className="size-3" aria-hidden="true" />}
                  {row.result}
                </Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="text-subtle">{f.choiceLabel}</div>
        <div className="mt-1 font-medium">{f.choice}</div>
        <span className="mt-3 flex h-9 items-center justify-center rounded-md border border-line-strong/70 bg-surface-2 text-sm font-medium" aria-hidden="true">
          {f.button}
        </span>
      </div>
    </figure>
  );
}

// Deals: the stages an owner or admin edits (Won and Lost fixed at the end), the filters, and the saved views.
export function DealsVisual({ copy }: Props) {
  const f = copy.fragments.pipeline;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="sr-only">{copy.fragments.sample}</figcaption>
      <div className="px-4 py-3">
        <PanelTitle title={f.title} />
        <p className="mt-1 text-xs text-subtle">{f.hint}</p>
        <ol className="mt-3 flex flex-col gap-1.5 text-sm">
          {f.stages.map((stage, i) => (
            <li key={stage} className="flex items-center gap-2 rounded-sm border border-line bg-surface px-3 py-1.5">
              <span className="num w-20 shrink-0 text-xs text-subtle">
                {f.stageLabel} {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{stage}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 rounded-sm border border-dashed border-line-strong/70 px-3 py-1.5 text-xs text-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            {f.won}
          </li>
          <li className="flex items-center gap-2 rounded-sm border border-dashed border-line-strong/70 px-3 py-1.5 text-xs text-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            {f.lost}
          </li>
        </ol>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="text-xs text-subtle">{f.filtersLabel}</div>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {f.filters.map((filter) => (
            <li key={filter} className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1">
              {filter}
              <ChevronDown className="size-3 text-subtle" aria-hidden="true" />
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="text-xs text-subtle">{f.viewsLabel}</div>
        <ul className="mt-2 flex flex-wrap gap-2">
          {f.views.map((view) => (
            <li key={view.name}>
              <Chip tone={view.shared ? 'neutral' : 'accent'}>
                {view.shared ? <Users className="size-3" aria-hidden="true" /> : <Lock className="size-3" aria-hidden="true" />}
                {view.name}, {view.shared ? f.shared : f.private}
              </Chip>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

// Booking: the public page a client picks a time on, and the booking that reaches the host (the home page's pieces).
export function BookingVisual({ dict, copy }: Props) {
  const { crm } = dict.modules;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <BookingSlots crm={crm} />
      <BookingConfirmed crm={crm} />
    </div>
  );
}

// Calendar and Vy: the host's connected Google Calendar and Vy's suggestion for a client's message.
export function CalendarVisual({ dict, copy }: Props) {
  const { crm } = dict.modules;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <CalendarConnection crm={crm} />
      <VySuggestion crm={crm} />
    </div>
  );
}
