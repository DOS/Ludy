// SPDX-License-Identifier: AGPL-3.0-only
// Model adapter for proposing project tasks from a note or source (#2598, #2608): metered under 'projects.tasks_from_note'
// and 'projects.tasks_from_source'. Kept outside member-vy/ so member-vy/ stays free of provider SDK and key imports.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class TasksFromNoteModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'PROPOSAL_TIMEOUT' : 'PROPOSAL_FAILED');
    this.name = 'TasksFromNoteModelError';
    this.kind = kind;
  }
}

export const TASKS_FROM_NOTE_TIMEOUT_MS = 45_000;
export const TASKS_FROM_NOTE_MAX_OUTPUT_TOKENS = 2_000;

export type TaskProposalModelResult = { text: string; usage: { inputTokens: number; outputTokens: number } };

async function runMeteredTaskProposal(
  call: () => Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }>,
): Promise<TaskProposalModelResult> {
  try {
    const { text, usage } = await call();
    return {
      text,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    };
  } catch (error) {
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const isTimeout =
      (error instanceof DOMException && error.name === 'TimeoutError') ||
      (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
    throw new TasksFromNoteModelError(isTimeout ? 'timeout' : 'failed');
  }
}

function modelCallInput(config: AiConfig, prompt: { system: string; user: string }, timeoutMs: number) {
  return {
    model: chatModel(config),
    system: prompt.system,
    prompt: prompt.user,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: 0,
    maxOutputTokens: TASKS_FROM_NOTE_MAX_OUTPUT_TOKENS,
  };
}

export function generateTasksFromNoteText(
  config: AiConfig,
  prompt: { system: string; user: string },
  timeoutMs: number = TASKS_FROM_NOTE_TIMEOUT_MS,
): Promise<TaskProposalModelResult> {
  return runMeteredTaskProposal(() =>
    metered('projects.tasks_from_note', () => generateText(modelCallInput(config, prompt, timeoutMs))),
  );
}

export function generateTasksFromSourceText(
  config: AiConfig,
  prompt: { system: string; user: string },
  timeoutMs: number = TASKS_FROM_NOTE_TIMEOUT_MS,
): Promise<TaskProposalModelResult> {
  return runMeteredTaskProposal(() =>
    metered('projects.tasks_from_source', () => generateText(modelCallInput(config, prompt, timeoutMs))),
  );
}
