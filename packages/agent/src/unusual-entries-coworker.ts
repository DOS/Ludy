// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible thing to look at per hit of the monthly review of unusual entries (#5182): the model call, in a small class of its own (like ExpenseVarianceCoworker) so the shared inbox
// reader's constructor is not touched. The facts, the prompt and every check of the answer are in unusual-entries.ts; the call goes through the AI budget meter under `finance.unusual_entries_note`, and the
// caller's own sink (onUsage) sees its tokens.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { checkUnusualEntriesNotes, unusualEntriesInstructions, unusualEntriesNotesHaveNews, unusualEntriesPrompt, type UnusualEntriesNoteFacts, type UnusualEntriesNotesResult } from './unusual-entries.ts';
import { metered } from './meter.ts';

const zUnusualEntriesOut = z.object({
  notes: z
    .array(z.object({ row: z.number().int().min(1).describe('The number of the row, as given'), text: z.string().describe('One plain sentence naming what may be behind the unusual entry, using no number and no name at all (say a supplier)') }))
    .describe('One note for each row, under its row number'),
});
export type UnusualEntriesGenerator = (args: { system: string; prompt: string }) => Promise<{ output: z.infer<typeof zUnusualEntriesOut> | null; usage?: AiUsage }>;

export class UnusualEntriesCoworker {
  private readonly generate: UnusualEntriesGenerator;

  // The generator replaces the model call in tests; by default it goes to the deployment's OpenAI-compatible endpoint, through the AI meter.
  constructor(config: AiConfig, generator?: UnusualEntriesGenerator) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    this.generate =
      generator ??
      (async ({ system, prompt }) => {
        const { output, usage } = await metered('finance.unusual_entries_note', () =>
          generateText({ model: chatModel(config), output: Output.object({ schema: zUnusualEntriesOut }), system, prompt, abortSignal: AbortSignal.timeout(timeoutMs), ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) }),
        );
        return { output: output ?? null, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
      });
  }

  /** One possible thing to look at per hit, from the facts of the hits only, or why there is none: nothing flagged means no model call; a note is dropped when it states a number, a date or a name it was not
   * given, claims certainty, says the entry is wrong, advises or is not marked as a possibility (unusual-entries.ts). onUsage gets the tokens the call used. */
  async notes(facts: UnusualEntriesNoteFacts, onUsage?: (usage: AiUsage) => void): Promise<UnusualEntriesNotesResult> {
    if (!unusualEntriesNotesHaveNews(facts)) return { kind: 'none', code: 'EMPTY' };
    const { output, usage } = await this.generate({ system: unusualEntriesInstructions(facts.language), prompt: unusualEntriesPrompt(facts) });
    if (usage) onUsage?.(usage);
    return checkUnusualEntriesNotes(facts, output);
  }
}
