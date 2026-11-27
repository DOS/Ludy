// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the recorder's Vy drafting minutes from typed notes for an unrecorded meeting (#5129, L32): system text and user text in, answer text and tokens out, through the AI budget meter under its own key (meetings.notes_minutes) and admitted on projected cost before sending the request. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class NotesMinutesModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'NOTES_MINUTES_TIMEOUT' : 'NOTES_MINUTES_FAILED');
    this.name = 'NotesMinutesModelError';
    this.kind = kind;
  }
}

/** Hard limit of one run's call, in milliseconds: the recorder waits for it. */
export const NOTES_MINUTES_TIMEOUT_MS = 60_000;

/** Output token ceiling covering summary, up to 20 cited decisions, and up to 20 cited action items. */
export const NOTES_MINUTES_MAX_OUTPUT_TOKENS = 1_600;

export async function generateMeetingNotesMinutesText(
  config: AiConfig,
  prompt: { system: string; user: string; expected?: { inputTokens: number; outputTokens: number } | undefined },
  timeoutMs: number = NOTES_MINUTES_TIMEOUT_MS,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered(
      'meetings.notes_minutes',
      () =>
        generateText({
          model: chatModel(config),
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: AbortSignal.timeout(timeoutMs),
          maxRetries: 0,
          maxOutputTokens: NOTES_MINUTES_MAX_OUTPUT_TOKENS,
        }),
      undefined,
      prompt.expected,
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new NotesMinutesModelError(timedOut ? 'timeout' : 'failed');
  }
}
