// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the recorder's Vy checking a meeting's agenda against its transcript (#3959, ADR-0049 stage A): a system text and a user text in, the answer text and the tokens out, through the AI budget
// meter under its own key (meetings.adherence, so it never cuts off a transcription, a summary, a translation, a question, a brief or live notes, #3029) and the deployment's OpenAI-compatible endpoint.
// The model is given no tools: its answer is text that the checks in member-vy/meetings-adherence.ts parse and prune.
// This file is org-level code, so it takes plain strings; the kernel's built-in model port hands it the prompt the member-Vy feature built. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class AdherenceModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'ADHERENCE_TIMEOUT' : 'ADHERENCE_FAILED');
    this.name = 'AdherenceModelError';
    this.kind = kind;
  }
}

/** The hard limit of one call, in milliseconds: the recorder waits for it, and it reads a whole transcript, so it is longer than a short pick but still bounded. */
export const ADHERENCE_TIMEOUT_MS = 45_000;

/** The most the model may write: one small JSON object of at most twelve short entries; a longer answer is cut and then refused as unparsable. */
export const ADHERENCE_MAX_OUTPUT_TOKENS = 500;

export async function generateMeetingAdherenceText(config: AiConfig, prompt: { system: string; user: string }, timeoutMs: number = ADHERENCE_TIMEOUT_MS): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered('meetings.adherence', () =>
      generateText({ model: chatModel(config), system: prompt.system, prompt: prompt.user, abortSignal: AbortSignal.timeout(timeoutMs), maxRetries: 0, maxOutputTokens: ADHERENCE_MAX_OUTPUT_TOKENS }),
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    // The meter's own refusals (a spent budget, no scope) and nothing else keep their type; every provider failure is a fixed word, never the provider's message.
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new AdherenceModelError(timedOut ? 'timeout' : 'failed');
  }
}
