// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the recorder's Vy analysing a sales call linked to an open deal (#4920, L26, ADR-0049 stage A): metered under meetings.sales_insight and admitted on
// projected cost before sending the request.
import { generateText } from 'ai';
import { chatModel, type AiConfig } from './index.ts';
import { AiBudgetExhaustedError, AiMeterMissingError, metered } from './meter.ts';

export class SalesInsightModelError extends Error {
  readonly kind: 'timeout' | 'failed';
  constructor(kind: 'timeout' | 'failed') {
    super(kind === 'timeout' ? 'SALES_INSIGHT_TIMEOUT' : 'SALES_INSIGHT_FAILED');
    this.name = 'SalesInsightModelError';
    this.kind = kind;
  }
}

export const SALES_INSIGHT_TIMEOUT_MS = 60_000;
export const SALES_INSIGHT_MAX_OUTPUT_TOKENS = 1800;

/** One foreground call to extract sales call insights for the recorder, admitted on projected cost and never retrying inside the request. */
export async function generateMeetingSalesInsightText(
  config: AiConfig,
  prompt: { system: string; user: string; expected?: { inputTokens: number; outputTokens: number } | undefined },
  timeoutMs: number = SALES_INSIGHT_TIMEOUT_MS,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  try {
    const { text, usage } = await metered(
      'meetings.sales_insight',
      () =>
        generateText({
          model: chatModel(config),
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: AbortSignal.timeout(timeoutMs),
          maxRetries: 0,
          maxOutputTokens: SALES_INSIGHT_MAX_OUTPUT_TOKENS,
        }),
      undefined,
      prompt.expected,
    );
    return { text, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new SalesInsightModelError(timedOut ? 'timeout' : 'failed');
  }
}
