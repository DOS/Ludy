// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible reasons on the expense variance card (#4392): the model call, in a small class of its own (like PayrollCoworker) so the shared inbox reader's constructor is not touched. The
// facts, the prompt and every check of the answer are in expense-variance.ts; the call goes through the AI budget meter under `finance.expense_variance_note`, and the caller's own sink (onUsage) sees its tokens.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { checkExpenseVarianceNotes, expenseVarianceInstructions, expenseVarianceNotesHaveNews, expenseVariancePrompt, type ExpenseVarianceNoteFacts, type ExpenseVarianceNotesResult } from './expense-variance.ts';
import { metered } from './meter.ts';

const zExpenseVarianceOut = z.object({
  notes: z
    .array(z.object({ row: z.number().int().min(1).describe('The number of the row, as given'), text: z.string().describe('One plain sentence suggesting what may explain why that cost moved, using no number and no name at all (say a supplier)') }))
    .describe('One note for each row, under its row number'),
});
export type ExpenseVarianceGenerator = (args: { system: string; prompt: string }) => Promise<{ output: z.infer<typeof zExpenseVarianceOut> | null; usage?: AiUsage }>;

export class ExpenseVarianceCoworker {
  private readonly generate: ExpenseVarianceGenerator;

  // The generator replaces the model call in tests; by default it goes to the deployment's OpenAI-compatible endpoint, through the AI meter.
  constructor(config: AiConfig, generator?: ExpenseVarianceGenerator) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    this.generate =
      generator ??
      (async ({ system, prompt }) => {
        const { output, usage } = await metered('finance.expense_variance_note', () =>
          generateText({ model: chatModel(config), output: Output.object({ schema: zExpenseVarianceOut }), system, prompt, abortSignal: AbortSignal.timeout(timeoutMs), ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) }),
        );
        return { output: output ?? null, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
      });
  }

  /** One possible reason per flagged line, from the facts of the lines only, or why there is none: nothing flagged means no model call; a note is dropped when it states a number, a date or a name it was
   * not given, claims certainty, advises or is not marked as a possibility (expense-variance.ts). onUsage gets the tokens the call used. */
  async notes(facts: ExpenseVarianceNoteFacts, onUsage?: (usage: AiUsage) => void): Promise<ExpenseVarianceNotesResult> {
    if (!expenseVarianceNotesHaveNews(facts)) return { kind: 'none', code: 'EMPTY' };
    const { output, usage } = await this.generate({ system: expenseVarianceInstructions(facts.language), prompt: expenseVariancePrompt(facts) });
    if (usage) onUsage?.(usage);
    return checkExpenseVarianceNotes(facts, output);
  }
}
