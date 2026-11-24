// SPDX-License-Identifier: AGPL-3.0-only
// Vy's triage assist coworker for Projects Triage Inbox (#4493, ADR-0058):
// enforces AI-off/kill-switch/budget gates, DraftBudget concurrency cap, and strict allowlist validation.
import {
  AiBudgetExhaustedError,
  type InboxReader,
  type ProjectTriageAssistFacts,
} from '@ludy/agent';
import type { ProjectTriageAiState, ProjectTriageAssistResult } from '@ludy/kernel-contract';
import type { ProjectTriageAssistSource } from '@ludy/mod-projects';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ProjectTriageAi {
  reader: Partial<Pick<InboxReader, 'projectTriageAssist'>> | null;
  budget: DraftBudget;
}

export function projectTriageAi(
  reader: ProjectTriageAi['reader'],
  budget: DraftBudget,
): ProjectTriageAi {
  return { reader, budget };
}

function empty(ai: ProjectTriageAiState): ProjectTriageAssistResult {
  return { ai, proposal: null };
}

export async function prepareProjectTriageAssist(
  ai: ProjectTriageAi,
  orgId: string,
  userId: string,
  source: ProjectTriageAssistSource,
  language: 'vi' | 'en' = 'vi',
  options?: { conversationAutoDraft?: boolean },
): Promise<ProjectTriageAssistResult> {
  if (!ai.reader?.projectTriageAssist) return empty('off');
  if (source.item.sourceType === 'kernel.conversation' && options?.conversationAutoDraft === false) {
    return empty('off');
  }
  if (source.aiStopped) return empty('paused');
  if (source.aiBudgetSpent) return empty('budget');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return empty('busy');

  const facts: ProjectTriageAssistFacts = {
    language,
    projectName: source.item.projectName,
    item: {
      id: source.item.id,
      title: source.item.title,
      description: source.item.description,
      sourceType: source.item.sourceType,
      priority: source.item.priority,
      tainted: source.item.tainted,
    },
    candidates: source.candidates,
  };

  try {
    const out = await ai.reader.projectTriageAssist(facts);
    if (out.kind === 'none') {
      console.error(`[project-triage-ai] triage assist refused: ${out.code}`);
      return empty(out.code === 'EMPTY' ? 'empty' : 'refused');
    }
    return {
      ai: 'used',
      proposal: out.proposal,
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) {
      ticket.refund?.();
      return empty('budget');
    }
    console.error('[project-triage-ai] triage assist failed', error instanceof Error ? error.name : typeof error);
    return empty('failed');
  } finally {
    ticket.release();
  }
}
