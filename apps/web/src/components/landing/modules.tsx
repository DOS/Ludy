import { ArrowRight, Bot, Check, Factory, Warehouse, Wheat } from 'lucide-react';
import type { ReactNode } from 'react';
import { appPagePath } from '../../content/site';
import type { Dictionary } from '../../content/vi';
import { BookingConfirmed, BookingSlots, CalendarConnection, VySuggestion } from './crm-fragments';
import { SalesNumberGaps, VatBreakdown } from './finance-fragments';
import { NotesList, TodoList } from './notes-fragments';
import { Chip, Section, SectionHead, toneOf } from './ui';

type Modules = Dictionary['modules'];

// A person or an agent, the way the app names who did or owns something: initials for people, the bot mark for agents.
function Who({ name, initials, agent }: { name: string; initials: string; agent: boolean }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-xs font-medium ${
        agent ? 'border-dashed border-accent/60 text-accent-ink' : 'border-line bg-surface text-fg'
      }`}
    >
      <span
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${agent ? 'bg-accent-soft' : 'bg-surface-2 text-muted'}`}
        aria-hidden="true"
      >
        {agent ? <Bot className="size-3" /> : initials}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <article className={`flex min-w-0 flex-col rounded-lg border border-line bg-surface p-5 ${className}`}>{children}</article>;
}

function CardHead({
  name,
  body,
  people,
  points,
  deptLabel,
  more,
}: {
  name: string;
  body: string;
  people?: Modules['finance']['people'];
  points?: readonly string[];
  deptLabel: string;
  more?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-display text-xl font-semibold">{name}</h3>
      <p className="max-w-[60ch] text-sm text-muted">{body}</p>
      {points ? (
        <ul className="mt-1 flex max-w-[60ch] flex-col gap-1.5 text-sm text-muted">
          {points.map((point) => (
            <li key={point} className="flex gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {more ? (
        <a href={more.href} className="mt-1 inline-flex items-center gap-1 self-start text-sm font-medium text-accent-ink hover:underline">
          {more.label}
          <ArrowRight className="size-4" aria-hidden="true" />
        </a>
      ) : null}
      {people ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
          <span>{deptLabel}</span>
          {people.map((p) => (
            <Who key={p.name} {...p} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ART = { mill: Factory, rice: Wheat, warehouse: Warehouse } as const;

// The modules (option E, the owner's pick): each department's module as a small piece of the app, with the people
// and agents who work in it. Finance is the largest because it is what ships first.
export function Modules({ dict }: { dict: Dictionary }) {
  const { modules } = dict;
  const { finance, agents, tasks, notes, social, crm } = modules;
  const t = finance.taccount;
  return (
    <Section id="module" labelledBy="modules-title" tinted>
      <SectionHead id="modules-title" title={modules.title} lead={modules.lead} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHead
            name={finance.name}
            body={finance.body}
            points={finance.points}
            people={finance.people}
            deptLabel={modules.deptLabel}
            more={{ label: `${modules.pageLink}: ${finance.name}`, href: appPagePath('accounting', dict.lang) }}
          />
          <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg md:col-span-2 lg:col-span-1">
              <div className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2.5">
                <span className="text-sm font-semibold">{finance.inboxTitle}</span>
                <span className="text-xs text-subtle">{finance.inboxSub}</span>
              </div>
              <ul className="divide-y divide-line">
                {finance.inbox.map((row) => (
                  <li key={row.title} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
                    <span className="truncate font-medium">{row.title}</span>
                    <span className="num text-right">{row.amount}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <Chip tone={toneOf(row.tone)}>
                        {row.tone === 'ok' ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
                        {row.label}
                      </Chip>
                    </span>
                    <span className="num text-right text-xs text-subtle">{row.account}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-auto border-t border-line px-3 py-2.5 text-xs text-subtle">{finance.tail}</p>
            </div>
            <div className="contents">
              <figure className="rounded-md border border-line bg-bg p-3">
                <figcaption>
                  <div className="text-sm font-semibold">{t.title}</div>
                  <div className="text-xs text-subtle">{t.sub}</div>
                </figcaption>
                <div className="mt-3 grid grid-cols-2 border-t-2 border-fg/80 text-xs">
                  <div className="border-r-2 border-fg/80 pt-1.5 pr-2">
                    <div className="text-center font-semibold text-subtle">{t.debit}</div>
                    <div className="mt-1.5 flex flex-col">
                      <span className="text-subtle">{t.debitRow[0]}</span>
                      <span className="num">{t.debitRow[1]}</span>
                    </div>
                  </div>
                  <div className="pt-1.5 pl-2">
                    <div className="text-center font-semibold text-subtle">{t.credit}</div>
                    {t.creditRows.map(([label, amount]) => (
                      <div key={label} className="mt-1.5 flex flex-col">
                        <span className="text-subtle">{label}</span>
                        <span className="num">{amount}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-2 border-t border-line pt-2 text-xs">
                  <span className="text-subtle">{t.balanceLabel}</span>
                  <span className="num border-b-[3px] border-double border-fg pb-0.5 font-semibold">{t.balance}</span>
                </div>
              </figure>
              <VatBreakdown vat={finance.vat} />
            </div>
          </div>
          <SalesNumberGaps sales={finance.sales} className="mt-4" />
          <p className="mt-4 flex items-center gap-2 text-xs text-subtle">
            <Chip tone="neutral">{finance.soonLabel}</Chip>
            <span>{finance.soon}</span>
          </p>
        </Card>

        <Card>
          <CardHead name={agents.name} body={agents.body} deptLabel={modules.deptLabel} />
          <ul className="mt-5 flex flex-col gap-3">
            {agents.roster.map((agent) => (
              <li key={agent.name} className="rounded-md border border-dashed border-accent/50 bg-bg p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink" aria-hidden="true">
                    <Bot className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{agent.name}</span>
                    <span className="block text-subtle">{agent.manager}</span>
                  </span>
                  <span className="rounded-sm border border-accent/50 px-1 font-medium text-accent-ink">{agent.risk}</span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 text-subtle">
                  <span>{agents.budgetLabel}</span>
                  <span className="inline-flex items-center gap-1.5 text-ok">
                    <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
                    {agents.running}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-surface-2" aria-hidden="true">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${agent.pct}%` }} />
                </div>
                <div className="num mt-1.5 text-right">{agent.spent}</div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHead name={tasks.name} body={tasks.body} deptLabel={modules.deptLabel} />
          <ul className="mt-5 flex flex-col divide-y divide-line rounded-md border border-line bg-bg">
            {tasks.items.map((task) => (
              <li key={task.title} className="flex items-start gap-2.5 px-3 py-2.5 text-[13px]">
                <span
                  className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${task.done ? 'border-ok bg-ok text-bg' : 'border-line-strong/70 bg-surface'}`}
                  aria-hidden="true"
                >
                  {task.done ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block ${task.done ? 'text-subtle line-through' : 'font-medium'}`}>
                    {task.title}
                    {task.done ? <span className="sr-only">, {tasks.doneLabel}</span> : null}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    <Who name={task.who} initials={task.initials} agent={task.agent} />
                    <span className="num">{task.due}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Ludy Notes (#1671, #1673): notes with their private or shared mark, and one member's own to-dos. */}
        <Card className="lg:col-span-2">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
            <CardHead
              name={notes.name}
              body={notes.body}
              points={notes.points}
              people={notes.people}
              deptLabel={modules.deptLabel}
              more={{ label: `${modules.pageLink}: ${notes.name}`, href: appPagePath('notes', dict.lang) }}
            />
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <NotesList notes={notes} />
              <TodoList notes={notes} />
            </div>
          </div>
        </Card>

        {/* CRM & Calendar (#1568): the public booking page as the client sees it, and what reaches the host. */}
        <Card className="lg:col-span-2">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
            <CardHead
              name={crm.name}
              body={crm.body}
              points={crm.points}
              people={crm.people}
              deptLabel={modules.deptLabel}
              more={{ label: `${modules.pageLink}: ${crm.name}`, href: appPagePath('crm', dict.lang) }}
            />
            <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <BookingSlots crm={crm} />
              <div className="flex min-w-0 flex-col gap-3">
                <BookingConfirmed crm={crm} />
                <CalendarConnection crm={crm} />
                <VySuggestion crm={crm} />
              </div>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
            <CardHead name={social.name} body={social.body} people={social.people} deptLabel={modules.deptLabel} />
            {/* Scrolls sideways at phone width, so it takes keyboard focus to scroll with the arrow keys (WCAG 2.1.1,
                #1629). It carries the week's name, which the list inside had. */}
            <div role="group" aria-label={social.weekLabel} tabIndex={0} className="min-w-0 overflow-x-auto">
              <ol className="grid min-w-[640px] grid-cols-7 gap-1.5">
                {social.days.map((day) => {
                  const Art = day.post ? (ART[day.post.art as keyof typeof ART] ?? Wheat) : null;
                  return (
                    <li
                      key={day.label}
                      className={`flex min-h-36 min-w-0 flex-col gap-1.5 rounded-md border p-1.5 ${day.today ? 'border-accent/70 bg-accent-soft/40' : 'border-line bg-bg'}`}
                    >
                      <div className="flex items-center justify-between gap-1 px-0.5 text-[11px]">
                        <span className={day.today ? 'font-semibold text-accent-ink' : 'text-subtle'}>{day.label}</span>
                        {day.today ? <span className="sr-only">{social.todayLabel}</span> : null}
                      </div>
                      {day.post && Art ? (
                        <div className="flex min-w-0 flex-col gap-1 rounded-sm border border-line bg-surface p-1.5 text-[11px]">
                          <span
                            className={`flex h-10 items-center justify-center rounded-[3px] ${day.post.tone === 'ok' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
                            aria-hidden="true"
                          >
                            <Art className="size-5" />
                          </span>
                          <span className="leading-snug font-semibold">{day.post.title}</span>
                          <span className="num text-subtle">
                            {day.post.time}, {day.post.channels.join(', ')}
                          </span>
                          <Chip tone={toneOf(day.post.tone)} wrap className="self-start text-[10px] leading-snug">
                            {day.post.state}
                          </Chip>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </Card>
      </div>
    </Section>
  );
}
