// SPDX-License-Identifier: AGPL-3.0-only
import { FileUp, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Chip, Kbd, Section, SectionHead, toneOf } from './ui';

const STEP_ICONS: Record<string, LucideIcon> = {
  receive: FileUp,
  draft: Sparkles,
  approve: ShieldCheck,
};

const STEP_LOOKS: Record<string, string> = {
  receive: 'border-line bg-surface',
  draft: 'border-dashed border-accent/70 bg-surface',
  approve: 'border-ok/60 bg-ok-soft',
};

// Compact 3-step visual workflow (Input -> AI + Deterministic checks -> Human 2FA approval) + keyboard shortcuts.
export function ProductTour({ dict }: { dict: Dictionary }) {
  const { tour, keys } = dict;
  return (
    <Section id="quy-trinh" labelledBy="tour-title">
      <SectionHead id="tour-title" title={tour.title} lead={tour.lead} />
      <ol className="grid gap-4 md:grid-cols-3">
        {tour.steps.map((step, i) => {
          const Icon = STEP_ICONS[step.key] ?? Sparkles;
          return (
            <li key={step.key} className={`flex min-w-0 flex-col rounded-xl border p-5 ${STEP_LOOKS[step.key] ?? 'border-line bg-surface'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted">
                  <span className="num inline-flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg">{i + 1}</span>
                  <span>{step.label}</span>
                </span>
                <Icon className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
              </div>
              <h3 className="mt-3 font-display text-lg font-semibold text-fg">{step.title}</h3>
              <p className="mt-1.5 text-sm text-muted">{step.body}</p>
              <div className="mt-4 pt-1 md:mt-auto">
                <Chip tone={toneOf(step.tone)} className={step.key === 'approve' ? 'border border-ok/30 bg-surface' : ''}>
                  {step.chip}
                </Chip>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-8 grid gap-4 rounded-xl border border-line bg-surface-2/60 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {keys.items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex gap-1">
              {item.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </div>
            <div className="mt-2.5 text-sm font-medium text-fg">{item.label}</div>
            <p className="mt-0.5 text-xs text-muted">{item.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
