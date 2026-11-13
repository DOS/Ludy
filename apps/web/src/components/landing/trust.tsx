// SPDX-License-Identifier: AGPL-3.0-only
import { Database, FileText, Server, Sparkles } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { CopyCommand } from './copy-command';
import { Section, SectionHead } from './ui';

const PART_ICONS = [Server, Database, FileText];

// Your data stays yours (owner request, 2026-11-12): a picture of where the data lives (on your own server, with the AI at arm's length and
// optional), four short promises, and the one command that runs Ludy.
export function Trust({ dict }: { dict: Dictionary }) {
  const { trust } = dict;
  return (
    <Section id="ma-nguon-mo" labelledBy="trust-title" tinted>
      <SectionHead id="trust-title" title={trust.title} lead={trust.lead} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-10">
        <div className="min-w-0">
          {/* The map: your server holds Ludy, the database and the files; the AI sits outside, dashed, because it is optional. */}
          <div className="grid items-stretch gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.7fr)] sm:gap-3" role="group" aria-label={trust.mapTitle}>
            <div className="rounded-xl border border-line-strong/60 bg-surface p-4">
              <p className="text-xs font-semibold tracking-wide text-subtle uppercase">{trust.mapTitle}</p>
              <ul className="mt-3 flex flex-col gap-2">
                {trust.mapParts.map((part, i) => {
                  const Icon = PART_ICONS[i] ?? Server;
                  return (
                    <li key={part} className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5 text-sm font-medium">
                      <Icon className="size-5 shrink-0 text-accent-ink" aria-hidden="true" />
                      {part}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div aria-hidden="true" className="flex items-center justify-center text-subtle sm:px-1">
              <span className="hidden h-px w-8 border-t border-dashed border-accent sm:block" />
              <span className="h-6 w-px border-l border-dashed border-accent sm:hidden" />
            </div>
            <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed border-accent/70 bg-surface p-4">
              <Sparkles className="size-5 text-accent-ink" aria-hidden="true" />
              <p className="text-sm font-medium">{trust.mapAi}</p>
              <p className="text-xs text-subtle">{trust.mapAiNote}</p>
            </div>
          </div>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {trust.cards.map((card, i) => (
              <li key={card.key} className="rounded-xl border border-line bg-surface p-4">
                <h3 className={`font-display text-base font-semibold ${i % 2 === 0 ? 'text-accent-ink' : 'text-ok'}`}>{card.title}</h3>
                <p className="mt-1.5 text-sm text-muted">{card.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <div id="tu-host" className="min-w-0 scroll-mt-24 rounded-xl border border-line bg-surface p-5 sm:p-6">
          <h3 className="font-display text-xl font-semibold">{trust.selfHostTitle}</h3>
          <p className="mt-2 text-sm text-muted">{trust.selfHostBody}</p>
          <div className="mt-4">
            <CopyCommand command={trust.command} copy={trust.copy} copied={trust.copied} copyFail={trust.copyFail} />
          </div>
          <p className="mt-3 text-xs text-subtle">{trust.openHint}</p>
        </div>
      </div>
    </Section>
  );
}
