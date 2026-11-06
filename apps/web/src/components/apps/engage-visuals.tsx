// SPDX-License-Identifier: AGPL-3.0-only
import { Factory, Warehouse, Wheat } from 'lucide-react';
import type { EngageCopy } from '../../content/engage-vi';
import type { Dictionary } from '../../content/vi';
import { BookingConfirmed, BookingSlots, CalendarConnection, SalesSuggestion } from '../landing/sales-fragments';
import { Chip, toneOf } from '../landing/ui';

// The pieces of Ludy Engage the page draws, in HTML with the home page's sample company: each is something the product
// shows today. Panel titles are not headings, so the page's outline stays the section titles and the feature groups.
type Props = { dict: Dictionary; copy: EngageCopy };

function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="text-sm font-semibold">{title}</span>
      {sub ? <span className="text-xs text-subtle">{sub}</span> : null}
    </div>
  );
}

// Sales: the deal board, one column per stage with its card count and total, each card with its customer, amount and
// expected close date. The columns sit two to a row, so the page never scrolls sideways.
export function BoardVisual({ dict, copy }: Props) {
  const f = copy.fragments.board;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
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

// The hero: the app's menu with its four groups and their screens, so the page opens on what the app is made of.
export function EngageHero({ dict, copy }: Props) {
  const f = copy.fragments.menu;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {f.groups.map((group) => (
          <li key={group.name} className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-bg p-3">
            <span className="text-sm font-semibold">{group.name}</span>
            <ul className="flex flex-col gap-1.5 text-sm text-muted">
              {group.items.map((item) => (
                <li key={item} className="rounded-sm border border-line bg-surface px-2.5 py-1.5">
                  {item}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </figure>
  );
}

// Inbox: three conversations with their state and, where the coworker suggested one, the customer's intent (a draft reply
// is read in the conversation itself, not in the list).
export function InboxVisual({ copy }: Props) {
  const f = copy.fragments.inbox;
  return (
    <figure aria-label={f.label} className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.label} sub={f.channel} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-xs text-subtle">
        {f.tabs.map((tab, i) => (
          <li key={tab} className={i === 0 ? 'font-semibold text-fg' : ''}>
            {tab}
          </li>
        ))}
      </ul>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {f.rows.map((row) => (
          <li key={row.who} className="grid gap-1 px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{row.who}</span>
              <Chip tone={row.tone}>{row.state}</Chip>
            </div>
            <span className="text-muted">{row.preview}</span>
            {row.intent ? (
              <span className="mt-1 text-subtle">
                {f.intentLabel}: {row.intent}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </figure>
  );
}

// Booking: the public page a client picks a time on, the booking that reaches the host, the host's connected Google
// Calendar and the coworker's suggestion for a client's message (the home page's pieces).
export function BookingVisual({ dict, copy }: Props) {
  const { sales } = dict.modules;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <BookingSlots sales={sales} />
      <BookingConfirmed sales={sales} />
      <CalendarConnection sales={sales} />
      <SalesSuggestion sales={sales} />
    </div>
  );
}

const ART = { mill: Factory, rice: Wheat, warehouse: Warehouse } as const;

// Marketing: a week of posts, each with the channels it goes to and where it stands in the approval.
export function PostsVisual({ dict, copy }: Props) {
  const { social } = dict.modules;
  const f = copy.fragments.posts;
  const days = social.days.flatMap((day) => (day.post ? [{ label: day.label, post: day.post }] : []));
  return (
    <figure aria-label={f.label} className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={social.weekLabel} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ul className="divide-y divide-line">
        {days.map(({ label, post }) => {
          const Art = ART[post.art as keyof typeof ART];
          return (
            <li key={label} className="flex items-start gap-3 px-4 py-3 text-xs">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-muted" aria-hidden="true">
                {Art ? <Art className="size-4" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-subtle">{label}</span>
                <span className="block text-sm font-medium">{post.title}</span>
                <span className="num block text-subtle">
                  {post.time}, {post.channels.join(', ')}
                </span>
              </span>
              <Chip tone={toneOf(post.tone)} wrap className="self-start text-[10px] leading-snug">
                {post.state}
              </Chip>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-4 py-3 text-xs text-muted">{f.approval}</p>
    </figure>
  );
}

// Reports: the tabs of the parts that run, with the Sales tab open (deals by stage, the open and the won).
export function ReportsVisual({ copy }: Props) {
  const f = copy.fragments.reports;
  return (
    <figure aria-label={f.label} className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-xs text-subtle">
        {f.tabs.map((tab, i) => (
          <li key={tab} aria-current={i === f.current ? 'true' : undefined} className={i === f.current ? 'font-semibold text-fg' : ''}>
            {tab}
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 px-4 pt-3 text-xs sm:grid-cols-2">
        <div className="rounded-sm border border-line bg-surface p-2.5">
          <dt className="text-subtle">{f.openLabel}</dt>
          <dd className="num mt-0.5 text-sm font-semibold">{f.open}</dd>
        </div>
        <div className="rounded-sm border border-line bg-surface p-2.5">
          <dt className="text-subtle">{f.wonLabel}</dt>
          <dd className="num mt-0.5 text-sm font-semibold">{f.won}</dd>
        </div>
      </dl>
      <table className="mt-3 w-full text-left text-xs">
        <thead>
          <tr className="border-y border-line text-subtle">
            {f.head.map((cell, i) => (
              <th key={cell} scope="col" className={`px-4 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {f.rows.map((row) => (
            <tr key={row.stage}>
              <td className="px-4 py-2.5 font-medium">{row.stage}</td>
              <td className="num px-4 py-2.5 text-right">{row.count}</td>
              <td className="num px-4 py-2.5 text-right">{row.sum}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-3 text-xs text-muted">{f.readOnly}</p>
    </figure>
  );
}
