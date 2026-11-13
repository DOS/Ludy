// SPDX-License-Identifier: AGPL-3.0-only
import { BookCheck, FileUp, ListChecks, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Dictionary } from '../../content/vi';
import { appPagePath } from '../../content/site';
import { Section, SectionHead } from './ui';

const ICONS: Record<string, LucideIcon> = { drop: FileUp, read: Sparkles, check: ListChecks, approve: ShieldCheck, done: BookCheck };
// How each step looks: the AI step is dashed (it only proposes, as in the org chart), the last one is green, the rest are plain.
const LOOK: Record<string, string> = {
  drop: 'border-line-strong/60',
  read: 'border-dashed border-accent/70',
  check: 'border-line-strong/60',
  approve: 'border-line-strong/60',
  done: 'border-ok/60 bg-ok-soft',
};
const TILE: Record<string, string> = {
  drop: 'bg-surface-2 text-fg',
  read: 'bg-accent-soft text-accent-ink',
  check: 'bg-surface-2 text-fg',
  approve: 'bg-accent-soft text-accent-ink',
  done: 'bg-surface text-ok',
};

// The story of one invoice in five steps, in everyday words (owner request, 2026-11-12): what the person does, what the AI does and what
// the fixed rules do, side by side. A dot travels along the line and each step lights up in turn (CSS only; still when motion is reduced).
export function Story({ dict }: { dict: Dictionary }) {
  const { story } = dict;
  return (
    <Section id="cach-lam" labelledBy="story-title">
      <SectionHead id="story-title" title={story.title} lead={story.lead} />
      <div className="relative">
        {/* The line the dot travels along, behind the cards, on wide screens only. */}
        <div aria-hidden="true" className="absolute inset-x-[10%] top-[2.1rem] hidden h-px bg-line-strong/50 lg:block">
          <span className="story-dot absolute -top-[3px] left-0 size-[7px] rounded-full bg-accent" />
        </div>
        <ol className="relative grid gap-4 lg:grid-cols-5 lg:gap-5">
          {story.steps.map((step, i) => {
            const Icon = ICONS[step.key] ?? Sparkles;
            return (
              <li
                key={step.key}
                style={{ '--i': i } as CSSProperties}
                className={`story-step relative flex gap-4 rounded-xl border bg-surface p-4 lg:flex-col lg:gap-3 ${LOOK[step.key] ?? ''}`}
              >
                <span className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${TILE[step.key] ?? ''}`}>
                  <Icon className="size-6" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-subtle">
                    <span className="num inline-flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg">{i + 1}</span>
                    {step.who}
                  </div>
                  <h3 className="mt-1.5 font-display text-lg leading-snug font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-sm text-muted">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-subtle">
        <span>{story.note}</span>
        <a href={appPagePath('accounting')} className="font-medium text-accent-ink underline-offset-4 hover:underline">
          {story.pageLink}
        </a>
      </p>
    </Section>
  );
}
