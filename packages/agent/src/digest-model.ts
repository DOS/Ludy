// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the member's Vy writing the few sentences of the weekly digest across meetings (#3949, ADR-0049 stage A): a system text and a user text in, the answer text and the tokens out, through
// the AI budget meter under its own key (meetings.digest, so a digest never cuts off a transcription, a summary, a translation, a question, a brief or live notes, #3029) and the deployment's OpenAI-compatible
// endpoint. The model is given no tools and no output schema: its answer is text that the checks in member-vy/meetings-digest.ts parse and prune.
// This file is org-level code, so it takes plain strings; the kernel's built-in model port hands it the prompt the member-Vy feature built. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class DigestModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'DIGEST_TIMEOUT' : 'DIGEST_FAILED');
    this.name = 'DigestModelError';
    this.kind = kind;
  }
}

/** The hard limit of one digest's call, in milliseconds: the member waits for it, so it is short. */
export const DIGEST_TIMEOUT_MS = 30_000;

/** The most the model may write: three short sentences with their fact numbers fit well inside it; a longer answer is cut and then refused as unparsable. */
export const DIGEST_MAX_OUTPUT_TOKENS = 700;

export async function generateMeetingDigestText(config: AiConfig, prompt: { system: string; user: string }, timeoutMs: number = DIGEST_TIMEOUT_MS): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered('meetings.digest', () =>
      generateText({ model: chatModel(config), system: prompt.system, prompt: prompt.user, abortSignal: AbortSignal.timeout(timeoutMs), maxRetries: 0, maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS }),
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    // The meter's own refusals (a spent budget, no scope) and nothing else keep their type; every provider failure is a fixed word, never the provider's message.
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new DigestModelError(timedOut ? 'timeout' : 'failed');
  }
}
