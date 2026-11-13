// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowRight, Bot, CalendarCheck, Calculator, MessagesSquare, Mic, NotebookPen, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { appPagePath, type AppPageKey } from '../../content/site';
import { Section, SectionHead } from './ui';

const ICONS: Record<string, LucideIcon> = { accounting: Calculator, engage: MessagesSquare, notes: NotebookPen, bookings: CalendarCheck, meetings: Mic, vy: Bot };

// One card per app (owner request, 2026-11-12): an icon, what it does in one plain sentence, which AI coworker works in it, and a link to
// its page where it has one. The long lists of what each app does live on those pages, not here.
export function AppCards({ dict }: { dict: Dictionary }) {
  const { appCards } = dict;
  return (
    <Section id="module" labelledBy="apps-title" tinted>
      <SectionHead id="apps-title" title={appCards.title} lead={appCards.lead} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {appCards.items.map((item, i) => {
          const Icon = ICONS[item.key] ?? Bot;
          return (
            <li key={item.key} className="flex flex-col rounded-xl border border-line bg-surface p-5">
              <span className={`flex size-11 items-center justify-center rounded-xl ${i % 2 === 0 ? 'bg-accent-soft text-accent-ink' : 'bg-ok-soft text-ok'}`}>
                <Icon className="size-6" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-display text-lg leading-snug font-semibold">{item.name}</h3>
              <p className="mt-2 text-sm text-muted">{item.body}</p>
              <div className="mt-auto flex flex-col gap-2 pt-4">
                {item.agent ? (
                  <span className="text-xs text-subtle">
                    {appCards.agentLabel}: <span className="font-medium text-fg">{item.agent}</span>
                  </span>
                ) : null}
                {item.page ? (
                  <a href={appPagePath(item.page as AppPageKey)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink underline-offset-4 hover:underline">
                    {appCards.more}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
