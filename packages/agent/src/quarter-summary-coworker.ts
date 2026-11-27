// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentences on the quarter card (#5183): the model call, in a small class of its own (like ExpenseVarianceCoworker) so the shared inbox reader's constructor is not touched beyond one field. The
// facts, the prompt and every check of the answer are in quarter-summary.ts; the call goes through the AI budget meter under `finance.quarter_summary_note`, and the caller's own sink (onUsage) sees its tokens.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { checkQuarterSummaryNotes, quarterSummaryInstructions, quarterSummaryNotesHaveNews, quarterSummaryPrompt, type QuarterSummaryNoteFacts, type QuarterSummaryNotesResult } from './quarter-summary.ts';
import { metered } from './meter.ts';

const zQuarterSummaryOut = z.object({
  notes: z
    .array(z.object({ row: z.number().int().min(1).describe('The number of the row, as given'), text: z.string().describe('One plain sentence saying how that figure moved, using no number, no name and no cause at all') }))
    .describe('One sentence for each row, under its row number'),
});
export type QuarterSummaryGenerator = (args: { system: string; prompt: string }) => Promise<{ output: z.infer<typeof zQuarterSummaryOut> | null; usage?: AiUsage }>;

export class QuarterSummaryCoworker {
  private readonly generate: QuarterSummaryGenerator;

  // The generator replaces the model call in tests; by default it goes to the deployment's OpenAI-compatible endpoint, through the AI meter.
  constructor(config: AiConfig, generator?: QuarterSummaryGenerator) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    this.generate =
      generator ??
      (async ({ system, prompt }) => {
        const { output, usage } = await metered('finance.quarter_summary_note', () =>
          generateText({ model: chatModel(config), output: Output.object({ schema: zQuarterSummaryOut }), system, prompt, abortSignal: AbortSignal.timeout(timeoutMs), ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) }),
        );
        return { output: output ?? null, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
      });
  }

  /** One sentence per row asked, from the labels of the rows only, or why there is none: no row asked means no model call; a sentence is dropped when it states a number, a date, a name, a cause or advice, or says a
   * direction its row does not have, and a set below its floor is dropped whole (quarter-summary.ts). onUsage gets the tokens the call used. */
  async notes(facts: QuarterSummaryNoteFacts, onUsage?: (usage: AiUsage) => void): Promise<QuarterSummaryNotesResult> {
    if (!quarterSummaryNotesHaveNews(facts)) return { kind: 'none', code: 'EMPTY' };
    const { output, usage } = await this.generate({ system: quarterSummaryInstructions(facts.language), prompt: quarterSummaryPrompt(facts) });
    if (usage) onUsage?.(usage);
    return checkQuarterSummaryNotes(facts, output);
  }
}
