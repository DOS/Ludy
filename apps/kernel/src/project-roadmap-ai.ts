// SPDX-License-Identifier: AGPL-3.0-only
// API-side orchestrators for Vy's public roadmap duplicate detection and changelog drafting (#4400, ADR-0018, ADR-0057).
// Runs deterministic DB/budget checks first, calls metered InboxReader helpers outside transactions, and leaves manual
// merging/authoring 100% functional when AI is off, paused, over budget, or refuses output.
import {
  AiBudgetExhaustedError,
  type InboxReader,
  type RoadmapChangelogDraftFacts,
  type RoadmapDedupeFacts,
} from '@ludy/agent';
import type { RoadmapChangelogDraftResult, RoadmapDedupeResult } from '@ludy/kernel-contract';
import type { RoadmapAiChangelogSource, RoadmapAiDedupeSource } from '@ludy/mod-projects';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ProjectRoadmapAi {
  reader: Partial<Pick<InboxReader, 'roadmapDedupe' | 'roadmapChangelogDraft'>> | null;
  budget: DraftBudget;
}

export function projectRoadmapAi(
  reader: ProjectRoadmapAi['reader'],
  budget: DraftBudget,
): ProjectRoadmapAi {
  return { reader, budget };
}

export async function prepareRoadmapDedupe(
  ai: ProjectRoadmapAi,
  orgId: string,
  userId: string,
  source: RoadmapAiDedupeSource,
  language: 'vi' | 'en' = 'vi',
): Promise<RoadmapDedupeResult> {
  const empty = (state: RoadmapDedupeResult['ai']): RoadmapDedupeResult => ({
    ai: state,
    suggestions: [],
    inspectedCount: source.items.length,
    truncated: source.truncated,
  });

  if (!ai.reader?.roadmapDedupe) return empty('off');
  if (source.aiStopped) return empty('paused');
  if (source.aiBudgetSpent) return empty('budget');
  if (source.items.length < 2) return empty('empty');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return empty('busy');

  const facts: RoadmapDedupeFacts = {
    language,
    boardTitle: source.boardTitle,
    items: source.items,
  };

  try {
    const out = await ai.reader.roadmapDedupe(facts);
    if (out.kind === 'none') {
      console.error(`[project-roadmap-ai] dedupe refused: ${out.code}`);
      return empty(out.code === 'EMPTY' ? 'empty' : 'refused');
    }
    return {
      ai: 'used',
      suggestions: out.suggestions,
      inspectedCount: source.items.length,
      truncated: source.truncated,
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return empty('budget');
    console.error('[project-roadmap-ai] dedupe failed', error instanceof Error ? error.name : typeof error);
    return empty('failed');
  } finally {
    ticket.release();
  }
}

export async function prepareRoadmapChangelogDraft(
  ai: ProjectRoadmapAi,
  orgId: string,
  userId: string,
  source: RoadmapAiChangelogSource,
  language: 'vi' | 'en' = 'vi',
): Promise<RoadmapChangelogDraftResult> {
  const empty = (state: RoadmapChangelogDraftResult['ai']): RoadmapChangelogDraftResult => ({
    ai: state,
    title: null,
    bodyMd: null,
  });

  if (!ai.reader?.roadmapChangelogDraft) return empty('off');
  if (source.aiStopped) return empty('paused');
  if (source.aiBudgetSpent) return empty('budget');
  if (source.items.length === 0) return empty('empty');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return empty('busy');

  const facts: RoadmapChangelogDraftFacts = {
    language,
    boardTitle: source.boardTitle,
    today: source.todayVn,
    items: source.items,
  };

  try {
    const out = await ai.reader.roadmapChangelogDraft(facts);
    if (out.kind === 'none') {
      console.error(`[project-roadmap-ai] changelog draft refused: ${out.code}`);
      return empty(out.code === 'EMPTY' ? 'empty' : 'refused');
    }
    return {
      ai: 'used',
      title: out.title,
      bodyMd: out.bodyMd,
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return empty('budget');
    console.error('[project-roadmap-ai] changelog draft failed', error instanceof Error ? error.name : typeof error);
    return empty('failed');
  } finally {
    ticket.release();
  }
}
