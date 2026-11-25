// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the recorder's Vy proposing the update of a deal after a meeting (#4766, ADR-0049 stage A): a system text and a user text in, the answer text and the tokens out,
// through the AI budget meter under its own key (meetings.deal_update, #3029) and the deployment's OpenAI-compatible endpoint. The model is given no tools and no output schema:
// its answer is text that the checks in member-vy/meeting-deal-update.ts parse and validate.
// This file is org-level code, so it takes plain strings; the kernel's built-in model port hands it the prompt the member-Vy feature built. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class DealUpdateModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'DEAL_UPDATE_TIMEOUT' : 'DEAL_UPDATE_FAILED');
    this.name = 'DealUpdateModelError';
    this.kind = kind;
  }
}

/** The hard limit of one deal-update run's call, in milliseconds: the recorder waits for it. */
export const DEAL_UPDATE_TIMEOUT_MS = 30_000;

/** The most the model may write: a next step and two or three sentences fit well inside it; a longer answer is cut and refused. */
export const DEAL_UPDATE_MAX_OUTPUT_TOKENS = 600;

export async function generateMeetingDealUpdateText(
  config: AiConfig,
  prompt: { system: string; user: string },
  timeoutMs: number = DEAL_UPDATE_TIMEOUT_MS,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered('meetings.deal_update', () =>
      generateText({
        model: chatModel(config),
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: AbortSignal.timeout(timeoutMs),
        maxRetries: 0,
        maxOutputTokens: DEAL_UPDATE_MAX_OUTPUT_TOKENS,
      }),
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    // The meter's own refusals (a spent budget, no scope) and nothing else keep their type; every provider failure is a fixed word, never the provider's message.
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new DealUpdateModelError(timedOut ? 'timeout' : 'failed');
  }
}
