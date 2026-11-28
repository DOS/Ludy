// SPDX-License-Identifier: AGPL-3.0-only
import { Eye, Lock, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { OrgChart } from './org-chart';
import { Section, SectionHead } from './ui';

const LANE_ICONS: Record<string, LucideIcon> = { self: Sparkles, review: Eye, locked: ShieldCheck };

const LANE_LOOK: Record<string, string> = {
  self: 'border-dashed border-accent/70 bg-surface',
  review: 'border-line-strong/60 bg-surface',
  locked: 'border-warn/50 bg-warn-soft',
};

// AI team governance: interactive org chart island, 4 coworker roster cards, and a crisp 3-lane human approval rail.
export function Agents({ dict }: { dict: Dictionary }) {
  const a = dict.agents;
  const m = a.matrix;
  return (
    <Section id="agents" labelledBy="agents-title" tinted>
      <SectionHead id="agents-title" title={a.team.title} lead={a.team.lead} />
      <div className="mb-8">
        <OrgChart dict={dict} />
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {a.team.members.map((member) => (
          <li key={member.name} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-lg font-semibold text-fg">{member.name}</span>
              <span className="text-sm font-medium text-accent-ink">{member.role}</span>
            </div>
            <p className="mt-1 text-sm text-muted">{member.scope}</p>
          </li>
        ))}
      </ul>
      <div className="mt-10">
        <h3 id="agents-rules-title" className="font-display text-xl font-semibold text-fg">
          {m.title}
        </h3>
        <p className="mt-1.5 mb-5 max-w-[60ch] text-sm text-muted">{m.lead}</p>
        <ol className="grid gap-4 lg:grid-cols-3">
          {m.lanes.map((lane, i) => {
            const Icon = LANE_ICONS[lane.key] ?? Sparkles;
            return (
              <li key={lane.key} className={`flex flex-col rounded-xl border p-4 ${LANE_LOOK[lane.key] ?? 'bg-surface'}`}>
                <div className="flex items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
                  <h4 className="font-display text-base font-semibold text-fg">
                    <span className="num mr-1.5 text-muted">{i + 1}.</span>
                    {lane.title}
                  </h4>
                </div>
                <p className="mt-2 text-sm text-muted">{lane.body}</p>
                <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-2.5 text-xs text-fg">
                  {lane.examples.map((example) => (
                    <li key={example} className="flex items-start gap-2">
                      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
                      <span>{example}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-6 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 font-display text-base font-semibold text-fg">
            <Lock className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
            <span>{m.neverTitle}</span>
          </div>
          <ul className="grid gap-3 sm:grid-cols-3 lg:flex-1 lg:pl-8">
            {m.never.map((item) => (
              <li key={item.title} className="min-w-0 text-xs">
                <div className="font-semibold text-fg">{item.title}</div>
                <div className="mt-0.5 text-muted">{item.body}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
