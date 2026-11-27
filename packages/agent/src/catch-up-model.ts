// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of a member's Vy catching up on published minutes they missed (#5130, L33, ADR-0049): metered under meetings.catch_up
// and admitted on projected cost before sending the request.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class CatchUpModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'CATCH_UP_TIMEOUT' : 'CATCH_UP_FAILED');
    this.name = 'CatchUpModelError';
    this.kind = kind;
  }
}

export const CATCH_UP_TIMEOUT_MS = 45_000;
const CATCH_UP_MAX_OUTPUT_TOKENS = 900;

/** Runs one metered foreground model call for a member's meeting catch-up summary. */
export async function generateMeetingCatchUpText(
  config: AiConfig,
  prompt: { system: string; user: string; expected?: { inputTokens: number; outputTokens: number } | undefined },
  timeoutMs: number = CATCH_UP_TIMEOUT_MS,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered(
      'meetings.catch_up',
      () =>
        generateText({
          model: chatModel(config),
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: AbortSignal.timeout(timeoutMs),
          maxRetries: 0,
          maxOutputTokens: CATCH_UP_MAX_OUTPUT_TOKENS,
        }),
      undefined,
      prompt.expected,
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CatchUpModelError(timedOut ? 'timeout' : 'failed');
  }
}
