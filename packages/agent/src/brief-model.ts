// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the member's Vy writing the few sentences of the brief before a meeting (#3543, ADR-0049 stage A): a system text and a user text in, the answer text and the tokens out, through
// the AI budget meter under its own key (meetings.brief, so a brief never cuts off a transcription, a summary, a translation, a question or live notes, #3029) and the deployment's OpenAI-compatible
// endpoint. The model is given no tools and no output schema: its answer is text that the checks in member-vy/meetings-brief.ts parse and prune.
// This file is org-level code, so it takes plain strings; the kernel's built-in model port hands it the prompt the member-Vy feature built. Nothing here logs the prompt or the answer.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class BriefModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'BRIEF_TIMEOUT' : 'BRIEF_FAILED');
    this.name = 'BriefModelError';
    this.kind = kind;
  }
}

/** The hard limit of one brief's call, in milliseconds: the member waits for it, so it is short. */
export const BRIEF_TIMEOUT_MS = 30_000;

/** The most the model may write: three short sentences with their fact numbers fit well inside it; a longer answer is cut and then refused as unparsable. */
export const BRIEF_MAX_OUTPUT_TOKENS = 700;

export type BriefModelFeature = 'meetings.brief' | 'meetings.brief_daily';

async function runBriefModelCall(
  call: () => Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }>,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await call();
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    // The meter's own refusals (a spent budget, no scope) and nothing else keep their type; every provider failure is a fixed word, never the provider's message.
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new BriefModelError(timedOut ? 'timeout' : 'failed');
  }
}

export function generateMeetingBriefText(
  config: AiConfig,
  prompt: { system: string; user: string },
  timeoutMs: number = BRIEF_TIMEOUT_MS,
  feature: BriefModelFeature = 'meetings.brief',
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const input = {
    model: chatModel(config),
    system: prompt.system,
    prompt: prompt.user,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: 0,
    maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
  };
  return runBriefModelCall(() =>
    feature === 'meetings.brief_daily'
      ? metered('meetings.brief_daily', () => generateText(input))
      : metered('meetings.brief', () => generateText(input)),
  );
}
