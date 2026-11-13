// SPDX-License-Identifier: AGPL-3.0-only
import { Eye, Lock, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Section, SectionHead } from './ui';

const LANE_ICONS: Record<string, LucideIcon> = { self: Sparkles, review: Eye, locked: ShieldCheck };
// The lanes read left to right as the AI hands over more: dashed (it acts), plain (a person approves), solid and warm (a person with a code).
const LANE_LOOK: Record<string, string> = {
  self: 'border-dashed border-accent/70',
  review: 'border-line-strong/60',
  locked: 'border-warn/50 bg-warn-soft',
};

// The AI team (the general manager and the department coworkers with their roles, from content/roster.ts), then what an AI coworker may do in
// everyday words: three lanes from "does it alone" to "always you", plus what it can never touch (the org chart itself is the hero).
export function Agents({ dict }: { dict: Dictionary }) {
  const a = dict.agents;
  const m = a.matrix;
  return (
    <Section id="agents" labelledBy="agents-title">
      <SectionHead id="agents-title" title={a.team.title} lead={a.team.lead} />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {a.team.members.map((member) => (
          <li key={member.name} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-lg font-semibold">{member.name}</span>
              <span className="text-sm text-accent-ink">{member.role}</span>
            </div>
            <p className="mt-1 text-sm text-muted">{member.scope}</p>
          </li>
        ))}
      </ul>
      <h3 id="agents-rules-title" className="mt-14 font-display text-xl font-semibold">
        {m.title}
      </h3>
      <p className="mt-2 mb-6 max-w-[62ch] text-muted">{m.lead}</p>
      <ol className="grid gap-4 lg:grid-cols-3">
        {m.lanes.map((lane, i) => {
          const Icon = LANE_ICONS[lane.key] ?? Sparkles;
          return (
            <li key={lane.key} className={`flex flex-col rounded-xl border bg-surface p-5 ${LANE_LOOK[lane.key] ?? ''}`}>
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-lg bg-surface-2 text-accent-ink">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h4 className="font-display text-base leading-snug font-semibold">
                  <span className="num mr-1.5 text-muted">{i + 1}.</span>
                  {lane.title}
                </h4>
              </div>
              <p className="mt-3 text-sm text-muted">{lane.body}</p>
              <ul className="mt-4 flex flex-col gap-2 border-t border-line pt-3 text-sm">
                {lane.examples.map((example) => (
                  <li key={example} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" />
                    {example}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-subtle">{m.note}</p>
      <div className="mt-8 rounded-xl border border-line bg-surface p-5">
        <h3 className="font-display text-lg font-semibold">{m.neverTitle}</h3>
        <ul className="mt-4 grid gap-4 md:grid-cols-3">
          {m.never.map((item) => (
            <li key={item.title} className="flex gap-3">
              <Lock className="mt-1 size-4 shrink-0 text-muted" aria-hidden="true" />
              <div>
                <div className="text-sm font-medium">{item.title}</div>
                <p className="text-sm text-muted">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
