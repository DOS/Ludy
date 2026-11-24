// SPDX-License-Identifier: AGPL-3.0-only
// API-side orchestrator for Vy's cycle summary (#4361, docs/plan/projects-v2.md section 4.1): runs deterministic guards,
// performs one metered call outside the DB transaction when allowed, and returns full deterministic cycle metrics on any AI off/refusal state.
import {
  AiBudgetExhaustedError,
  type InboxReader,
  type ProjectCycleSummaryFacts,
  type ProjectWeeklyStatusTaskFact,
} from '@ludy/agent';
import {
  vietnamToday,
  type ProjectCycleSummary,
  type ProjectWeeklyStatusState,
  type ProjectWeeklyStatusTask,
} from '@ludy/kernel-contract';
import type { ProjectCycleSummarySource } from '@ludy/mod-projects';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ProjectCycleSummaryAi {
  reader: Pick<InboxReader, 'projectCycleSummary'> | null;
  budget: DraftBudget;
}

export function projectCycleSummaryAi(
  reader: ProjectCycleSummaryAi['reader'],
  budget: DraftBudget,
): ProjectCycleSummaryAi {
  return { reader, budget };
}

function toTaskFacts(tasks: readonly ProjectWeeklyStatusTask[]): ProjectWeeklyStatusTaskFact[] {
  return tasks.map((task) => ({
    title: task.title,
    tainted: task.tainted !== false,
    status: task.status,
    dueDay: task.due ? vietnamToday(new Date(task.due)) : null,
    commentCount: task.commentCount,
    latestComment: task.latestComment,
  }));
}

async function generateSummary(
  ai: ProjectCycleSummaryAi,
  orgId: string,
  userId: string,
  source: ProjectCycleSummarySource,
  language: 'vi' | 'en',
): Promise<{ state: ProjectWeeklyStatusState; sentences: string[] }> {
  const result = (state: ProjectWeeklyStatusState, sentences: string[] = []) => ({ state, sentences });
  if (!ai.reader) return result('off');
  if (source.aiStopped) return result('paused');
  if (!source.aiAllowed) return result('forbidden');
  if (source.aiBudgetSpent) return result('budget');
  if (!source.cycle || source.cycle.totalTasks === 0) return result('empty');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return result('busy');

  const facts: ProjectCycleSummaryFacts = {
    language,
    projectName: source.project.name,
    projectStatus: source.project.status,
    cycle: {
      number: source.cycle.number,
      name: source.cycle.name,
      goal: source.cycle.goal,
      status: source.cycle.status,
      startsOn: source.cycle.startsOn,
      endsOn: source.cycle.endsOn,
      totalTasks: source.cycle.totalTasks,
      openTasks: source.cycle.openTasks,
      doneTasks: source.cycle.doneTasks,
      totalPoints: source.cycle.totalPoints,
      donePoints: source.cycle.donePoints,
    },
    averageVelocityTasks: source.metrics.averageVelocityTasks,
    averageVelocityPoints: source.metrics.averageVelocityPoints,
    velocityCyclesCount: source.metrics.velocity.length,
    tasks: toTaskFacts(source.tasks),
  };

  try {
    const out = await ai.reader.projectCycleSummary(facts);
    if (out.kind === 'none') {
      console.error(`[project-cycle-summary-ai] summary refused: ${out.code}`);
      return result('refused');
    }
    return result('used', out.sentences);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return result('budget');
    console.error('[project-cycle-summary-ai] summary failed', error instanceof Error ? error.name : typeof error);
    return result('failed');
  } finally {
    ticket.release();
  }
}

export async function prepareProjectCycleSummary(
  ai: ProjectCycleSummaryAi,
  orgId: string,
  userId: string,
  source: ProjectCycleSummarySource,
  language: 'vi' | 'en' = 'vi',
): Promise<ProjectCycleSummary> {
  const aiOut = await generateSummary(ai, orgId, userId, source, language);
  return {
    ai: aiOut.state,
    project: source.project,
    cycle: source.cycle,
    metrics: source.metrics,
    hiddenByEntityCount: source.hiddenByEntityCount,
    sentences: aiOut.sentences,
    truncated: source.truncated,
  };
}
