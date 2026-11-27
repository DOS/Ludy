// SPDX-License-Identifier: AGPL-3.0-only
// API-side orchestrator for Vy's read-only GitHub PR/issue summary and issue matching helpers (#5159, ADR-0060 D6).
// Enforces AI-off/kill-switch/budget/DraftBudget gates outside DB transactions and always provides deterministic fallbacks.
import {
  AiBudgetExhaustedError,
  buildDeterministicGithubPrSummary,
  rankGithubIssueCandidatesDeterministic,
  type InboxReader,
  type ProjectGithubIssueMatchCandidateInput,
  type ProjectGithubIssueMatchFacts,
  type ProjectGithubPrSummaryFacts,
} from '@ludy/agent';
import type {
  GithubAiState,
  GithubIssueMatchRpcResult,
  GithubPrSummaryRpcResult,
} from '@ludy/kernel-contract';
import type { ProjectGithubPrSummarySource } from '@ludy/mod-projects';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ProjectGithubAi {
  reader: Partial<Pick<InboxReader, 'projectGithubPrSummary' | 'projectGithubIssueMatch'>> | null;
  budget: DraftBudget;
}

export function projectGithubAi(
  reader: ProjectGithubAi['reader'],
  budget: DraftBudget,
): ProjectGithubAi {
  return { reader, budget };
}

export async function prepareProjectGithubPrSummary(
  ai: ProjectGithubAi,
  orgId: string,
  userId: string,
  source: ProjectGithubPrSummarySource,
  language: 'vi' | 'en' = 'vi',
): Promise<GithubPrSummaryRpcResult> {
  const linkFacts: ProjectGithubPrSummaryFacts['links'] = source.links.map((link) => ({
    kind: link.kind,
    repoFullName: link.repoFullName,
    externalNumber: link.externalNumber,
    externalState: link.externalState,
    externalTitle: link.externalTitle,
    branchName: link.branchName,
    authorLogin: link.authorLogin,
    closesTask: link.closesTask,
    tainted: true,
  }));

  const fallbackSummary = source.githubEnabled
    ? buildDeterministicGithubPrSummary(linkFacts, language)
    : null;

  const fallbackResult = (aiState: GithubAiState): GithubPrSummaryRpcResult => ({
    ai: aiState,
    summary: null,
    fallbackSummary,
    linkCount: linkFacts.length,
    tainted: true,
  });

  if (!source.githubEnabled || linkFacts.length === 0) return fallbackResult('empty');
  if (!ai.reader?.projectGithubPrSummary) return fallbackResult('off');
  if (source.aiStopped) return fallbackResult('paused');
  if (source.aiBudgetSpent) return fallbackResult('budget');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return fallbackResult('busy');

  const facts: ProjectGithubPrSummaryFacts = {
    language,
    projectName: source.projectName,
    taskKey: source.taskKey,
    taskTitle: source.taskTitle,
    taskTainted: source.taskTainted,
    links: linkFacts,
  };

  try {
    const out = await ai.reader.projectGithubPrSummary(facts);
    if (out.kind === 'none') {
      console.error(`[project-github-ai] pr summary refused: ${out.code}`);
      return fallbackResult(out.code === 'EMPTY' ? 'empty' : 'refused');
    }
    return {
      ai: 'used',
      summary: out.summary,
      fallbackSummary,
      linkCount: linkFacts.length,
      tainted: true,
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) {
      ticket.refund?.();
      return fallbackResult('budget');
    }
    console.error('[project-github-ai] pr summary failed', error instanceof Error ? error.name : typeof error);
    return fallbackResult('failed');
  } finally {
    ticket.release();
  }
}

export async function prepareProjectGithubIssueMatch(
  ai: ProjectGithubAi,
  orgId: string,
  userId: string,
  facts: ProjectGithubIssueMatchFacts,
  gates: { readonly githubEnabled: boolean; readonly aiStopped: boolean; readonly aiBudgetSpent: boolean },
): Promise<GithubIssueMatchRpcResult> {
  const inspectedCount = facts.candidates.length;
  const deterministicFallback = (aiState: GithubAiState): GithubIssueMatchRpcResult => {
    const ranked = gates.githubEnabled && inspectedCount > 0 ? rankGithubIssueCandidatesDeterministic(facts) : [];
    return {
      ai: aiState,
      candidates: ranked.map((c) => ({ ...c, deterministic: true })),
      inspectedCount,
    };
  };

  if (!gates.githubEnabled || inspectedCount === 0) {
    return deterministicFallback('empty');
  }
  if (!ai.reader?.projectGithubIssueMatch) return deterministicFallback('off');
  if (gates.aiStopped) return deterministicFallback('paused');
  if (gates.aiBudgetSpent) return deterministicFallback('budget');

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return deterministicFallback('busy');

  try {
    const out = await ai.reader.projectGithubIssueMatch(facts);
    if (out.kind === 'none') {
      console.error(`[project-github-ai] issue match refused: ${out.code}`);
      return deterministicFallback(out.code === 'EMPTY' ? 'empty' : 'refused');
    }
    return {
      ai: 'used',
      candidates: out.matches.map((m) => ({ ...m, deterministic: false })),
      inspectedCount,
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) {
      ticket.refund?.();
      return deterministicFallback('budget');
    }
    console.error('[project-github-ai] issue match failed', error instanceof Error ? error.name : typeof error);
    return deterministicFallback('failed');
  } finally {
    ticket.release();
  }
}

export type ProjectGithubCandidateInput = ProjectGithubIssueMatchCandidateInput;
