// SPDX-License-Identifier: AGPL-3.0-only
// API-side orchestrator for Vy's weekly status of one project (projects P6, #2597): consumes the deterministic source
// built inside the member's own transaction, applies model availability / kill-switch / viewer / budget / rate-limit
// guards, runs one metered model call outside the transaction when permitted, and always returns the exact code counts
// and task lists even when Vy's summary is off, paused, budget-exhausted, refused or failed. Nothing is stored or sent.
import {
  AiBudgetExhaustedError,
  type InboxReader,
  type ProjectWeeklyStatusFacts,
  type ProjectWeeklyStatusTaskFact,
} from '@ludy/agent';
import {
  vietnamToday,
  type ProjectWeeklyStatus,
  type ProjectWeeklyStatusState,
  type ProjectWeeklyStatusTask,
} from '@ludy/kernel-contract';
import type { ProjectWeeklyStatusSource } from '@ludy/mod-projects';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ProjectWeeklyStatusAi {
  reader: Pick<InboxReader, 'projectWeeklyStatus'> | null;
  budget: DraftBudget;
}

export function projectWeeklyStatusAi(
  reader: ProjectWeeklyStatusAi['reader'],
  budget: DraftBudget,
): ProjectWeeklyStatusAi {
  return { reader, budget };
}

function toTaskFacts(tasks: readonly ProjectWeeklyStatusTask[]): ProjectWeeklyStatusTaskFact[] {
  return tasks.map((task) => ({
    title: task.title,
    status: task.status,
    dueDay: task.due ? vietnamToday(new Date(task.due)) : null,
    commentCount: task.commentCount,
    latestComment: task.latestComment,
  }));
}

async function generateSummary(
  ai: ProjectWeeklyStatusAi,
  orgId: string,
  userId: string,
  source: ProjectWeeklyStatusSource,
  language: 'vi' | 'en',
): Promise<{ state: ProjectWeeklyStatusState; sentences: string[] }> {
  const result = (state: ProjectWeeklyStatusState, sentences: string[] = []) => ({ state, sentences });
  if (!ai.reader) return result('off');
  if (source.aiStopped) return result('paused');
  if (!source.aiAllowed) return result('forbidden');
  if (source.aiBudgetSpent) return result('budget');
  if (source.counts.totalVisible === 0) return result('empty');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return result('busy');

  const bottlenecks = source.bottlenecks ?? [];
  const facts: ProjectWeeklyStatusFacts = {
    language,
    projectName: source.project.name,
    projectStatus: source.project.status,
    window: {
      from: source.window.from,
      to: source.window.to,
      nextFrom: source.window.nextFrom,
      nextTo: source.window.nextTo,
    },
    counts: source.counts,
    ...(source.columns && source.columns.length > 0 ? { columns: source.columns } : {}),
    ...(source.timeThisWeek ? { timeThisWeek: source.timeThisWeek } : {}),
    tasks: {
      doneThisWeek: toTaskFacts(source.tasks.doneThisWeek),
      overdue: toTaskFacts(source.tasks.overdue),
      waiting: toTaskFacts(source.tasks.waiting),
      dueNextWeek: toTaskFacts(source.tasks.dueNextWeek),
    },
    ...(bottlenecks.length > 0
      ? {
          bottlenecks: bottlenecks.map((item) => ({
            title: item.title,
            status: item.status,
            dueDay: item.due ? vietnamToday(new Date(item.due)) : null,
            blockedCount: item.blockedCount,
          })),
        }
      : {}),
  };

  try {
    const out = await ai.reader.projectWeeklyStatus(facts);
    if (out.kind === 'none') {
      console.error(`[project-weekly-status-ai] summary refused: ${out.code}`);
      return result('refused');
    }
    return result('used', out.sentences);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return result('budget');
    console.error('[project-weekly-status-ai] summary failed', error instanceof Error ? error.name : typeof error);
    return result('failed');
  } finally {
    ticket.release();
  }
}

export async function prepareProjectWeeklyStatus(
  ai: ProjectWeeklyStatusAi,
  orgId: string,
  userId: string,
  source: ProjectWeeklyStatusSource,
  language: 'vi' | 'en' = 'vi',
): Promise<ProjectWeeklyStatus> {
  const aiOut = await generateSummary(ai, orgId, userId, source, language);
  const bottlenecks = source.bottlenecks ?? [];
  return {
    ai: aiOut.state,
    project: source.project,
    window: source.window,
    counts: source.counts,
    ...(source.columns && source.columns.length > 0 ? { columns: source.columns } : {}),
    tasks: source.tasks,
    ...(bottlenecks.length > 0 ? { bottlenecks } : {}),
    ...(source.timeThisWeek ? { timeThisWeek: source.timeThisWeek } : {}),
    hiddenByEntityCount: source.hiddenByEntityCount,
    sentences: aiOut.sentences,
    truncated: source.truncated,
  };
}
