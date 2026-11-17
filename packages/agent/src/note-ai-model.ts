// SPDX-License-Identifier: AGPL-3.0-only
// Thin Stage A ModelPort adapter for notes AI summary and to-do suggestions (#1677, ADR-0049).
// Calls the model outside member-vy/ under the notes meter keys with zero tools and bounded output.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { metered } from './meter.ts';

export function generateNoteSummaryText(
  config: AiConfig,
  prompt: Readonly<{ system: string; user: string }>,
  abortSignal: AbortSignal,
): Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }> {
  return metered('notes.summary', () =>
    generateText({
      model: chatModel(config),
      system: prompt.system,
      prompt: prompt.user,
      maxOutputTokens: 2000,
      maxRetries: 0,
      abortSignal,
    }),
  );
}

export function generateTodoSuggestText(
  config: AiConfig,
  prompt: Readonly<{ system: string; user: string }>,
  abortSignal: AbortSignal,
): Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }> {
  return metered('notes.todo_suggest', () =>
    generateText({
      model: chatModel(config),
      system: prompt.system,
      prompt: prompt.user,
      maxOutputTokens: 2000,
      maxRetries: 0,
      abortSignal,
    }),
  );
}
