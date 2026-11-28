// SPDX-License-Identifier: AGPL-3.0-only
import { Database, FileText, Server, Sparkles } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { STATS } from '../../content/stats';
import { Section, SectionHead } from './ui';

const PART_ICONS = [Server, Database, FileText];
const ROUNDED = new Set<string>(['testCases']);

// Open-source proof & data sovereignty: 4 verified codebase metrics (from stats.ts),
// server-vs-AI isolation map, and 3 concise trust guarantees.
export function Trust({ dict }: { dict: Dictionary }) {
  const { trust } = dict;
  const format = new Intl.NumberFormat(dict.lang === 'vi' ? 'vi-VN' : 'en-US');

  return (
    <Section id="ma-nguon-mo" labelledBy="trust-title">
      <SectionHead id="trust-title" title={trust.title} lead={trust.lead} />
      <dl className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        {trust.metrics.map((metric, i) => {
          const value = STATS[metric.key as keyof typeof STATS];
          return (
            <div key={metric.key} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
              <dt className="mt-2.5 text-sm font-semibold text-fg">{metric.label}</dt>
              <dd className={`order-first num font-display text-2xl leading-none font-semibold tracking-[-0.02em] sm:text-3xl ${i % 2 === 0 ? 'text-accent-ink' : 'text-ok'}`}>
                {format.format(value)}
                {ROUNDED.has(metric.key) ? '+' : ''}
              </dd>
              <dd className="mt-1 text-xs text-muted">{metric.hint}</dd>
            </div>
          );
        })}
      </dl>

      <div className="mt-8 grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="grid items-stretch gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.8fr)]" role="group" aria-label={trust.mapTitle}>
          <div className="rounded-lg border border-line-strong/60 bg-bg p-3.5">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{trust.mapTitle}</p>
            <ul className="mt-2.5 flex flex-col gap-2">
              {trust.mapParts.map((part, i) => {
                const Icon = PART_ICONS[i] ?? Server;
                return (
                  <li key={part} className="flex items-center gap-2.5 rounded-md bg-surface px-3 py-2 text-sm font-medium text-fg">
                    <Icon className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
                    <span>{part}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div aria-hidden="true" className="flex items-center justify-center sm:px-1">
            <span className="hidden h-px w-6 border-t border-dashed border-accent sm:block" />
            <span className="h-5 w-px border-l border-dashed border-accent sm:hidden" />
          </div>
          <div className="flex flex-col justify-center gap-2 rounded-lg border border-dashed border-accent/70 bg-bg p-3.5">
            <Sparkles className="size-5 text-accent-ink" aria-hidden="true" />
            <p className="text-sm font-semibold text-fg">{trust.mapAi}</p>
            <p className="text-xs text-muted">{trust.mapAiNote}</p>
          </div>
        </div>

        <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          {trust.cards.map((card, i) => (
            <li key={card.key} className="rounded-xl border border-line bg-surface p-4">
              <h3 className={`font-display text-base font-semibold ${i % 2 === 0 ? 'text-accent-ink' : 'text-ok'}`}>{card.title}</h3>
              <p className="mt-1 text-sm text-muted">{card.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
