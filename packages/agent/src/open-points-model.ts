// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the recorder's Vy listing what a meeting left open (questions not answered, decisions not taken) (#4768, ADR-0049 stage A): a system text and a user text in, the answer text and the tokens out, through the AI
// budget meter under its own key (meetings.open_points, so it never cuts off a transcription, a summary, a translation, a question, a brief, chapters, commitments or a title, #3029) and the deployment's
// OpenAI-compatible endpoint. The model is given no tools and no output schema: its answer is text that the checks in member-vy/meeting-open-points.ts parse and prune.
// This file is org-level code, so it takes plain strings; the kernel's built-in model port hands it the prompt the member-Vy feature built. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class OpenPointsModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'OPEN_POINTS_TIMEOUT' : 'OPEN_POINTS_FAILED');
    this.name = 'OpenPointsModelError';
    this.kind = kind;
  }
}

/** The hard limit of one run's call, in milliseconds: the member waits for it. */
export const OPEN_POINTS_TIMEOUT_MS = 60_000;

/** The most the model may write: two lists of 5 short lines fit well inside it; a longer answer is cut and then refused as unparsable. */
export const OPEN_POINTS_MAX_OUTPUT_TOKENS = 1200;

export async function generateMeetingOpenPointsText(config: AiConfig, prompt: { system: string; user: string }, timeoutMs: number = OPEN_POINTS_TIMEOUT_MS): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered('meetings.open_points', () =>
      generateText({ model: chatModel(config), system: prompt.system, prompt: prompt.user, abortSignal: AbortSignal.timeout(timeoutMs), maxRetries: 0, maxOutputTokens: OPEN_POINTS_MAX_OUTPUT_TOKENS }),
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    // The meter's own refusals (a spent budget, no scope) and nothing else keep their type; every provider failure is a fixed word, never the provider's message.
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new OpenPointsModelError(timedOut ? 'timeout' : 'failed');
  }
}
