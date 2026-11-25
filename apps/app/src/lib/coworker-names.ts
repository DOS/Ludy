// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers' names now, anywhere in the app (DESIGN.md 1.1, UI/UX P2-1, #4782). An org renames a coworker by renaming
// its org-chart agent; the name of a coworker is the display name of the oldest agent that is not retired among the templates
// of the modules it covers, the roster's default when there is none (the same rule as packages/kernel/src/coworker-names.ts,
// which Home reads through `today.list`). Vy, the general manager, is no template agent and keeps the roster's name.
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { COWORKER_BY_MODULE, COWORKER_ROSTER, type CoworkerKey } from '@ludy/kernel-contract';
import { orpc } from './api.ts';

type NamedCoworkerKey = Exclude<CoworkerKey, 'system'>;
export type CoworkerNames = Readonly<Record<NamedCoworkerKey, string>>;

export const DEFAULT_COWORKER_NAMES: CoworkerNames = {
  gm: COWORKER_ROSTER.gm,
  finance: COWORKER_ROSTER.finance,
  sales: COWORKER_ROSTER.sales,
  marketing: COWORKER_ROSTER.marketing,
};

// agents: the chart's agents, oldest first (as `chart.get` answers); templateModules: template key to module.
export function coworkerNamesFrom(
  agents: ReadonlyArray<{ templateKey: string; displayName: string; status: string }>,
  templateModules: ReadonlyMap<string, string>,
): CoworkerNames {
  const names: Record<NamedCoworkerKey, string> = { ...DEFAULT_COWORKER_NAMES };
  const seen = new Set<CoworkerKey>();
  for (const agent of agents) {
    if (agent.status === 'retired') continue;
    const module = templateModules.get(agent.templateKey);
    const key = module !== undefined && Object.hasOwn(COWORKER_BY_MODULE, module) ? COWORKER_BY_MODULE[module] : undefined;
    if (key === undefined || key === 'system' || key === 'gm' || seen.has(key)) continue;
    seen.add(key);
    const name = agent.displayName.trim();
    if (name) names[key] = name;
  }
  return names;
}

// The two reads are every role's and shared with the AI agents screens, so a screen that already showed one asks nothing new.
// Until they answer, or when they fail, the roster's names stand.
export function useCoworkerNames(): CoworkerNames {
  const chart = useQuery(orpc.chart.get.queryOptions());
  const templates = useQuery(orpc.chart.templates.queryOptions());
  const agents = chart.data?.agents;
  const templateList = templates.data;
  return useMemo(() => {
    if (!agents || !templateList) return DEFAULT_COWORKER_NAMES;
    return coworkerNamesFrom(agents, new Map(templateList.map((tpl) => [tpl.key, tpl.module])));
  }, [agents, templateList]);
}
