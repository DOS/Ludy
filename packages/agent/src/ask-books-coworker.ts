// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker that reads a question about the books (#5181): the model call, in a small class of its own (like ExpenseVarianceCoworker) so the shared inbox reader's constructor is not touched.
// The question's preparation, the prompt and every check of the answer are in ask-books.ts; the call goes through the AI budget meter under `finance.ask_books`, and the caller's own sink (onUsage) sees its tokens.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { ASK_BOOKS_CHOICES, ASK_BOOKS_PERIODS, askBooksInstructions, askBooksPrompt, checkAskBooksOutput, type AskBooksResult } from './ask-books.ts';
import { metered } from './meter.ts';

// Built when the call is made, not when this file loads: the constants come from ask-books.ts, which the package index and the inbox reader load in a cycle with this file.
const zAskBooksOut = () =>
  z.object({
    entry: z.enum(ASK_BOOKS_CHOICES).describe('The one report of the list that answers the question, or "none" when none does'),
    period: z.enum(ASK_BOOKS_PERIODS).describe('The kind of period the question asks for, never a date; "none" only with entry "none"'),
    lead: z.string().describe('At most one short sentence saying in words which report is shown, with no number, date, name, advice or promise; empty when unsure'),
  });
// The generator's output is read as plain data and checked by checkAskBooksOutput, whatever its declared shape: a test may hand it any object.
export type AskBooksGenerator = (args: { system: string; prompt: string }) => Promise<{ output: Record<string, unknown> | null; usage?: AiUsage }>;

export class AskBooksCoworker {
  private readonly generate: AskBooksGenerator;

  // The generator replaces the model call in tests; by default it goes to the deployment's OpenAI-compatible endpoint, through the AI meter.
  constructor(config: AiConfig, generator?: AskBooksGenerator) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    this.generate =
      generator ??
      (async ({ system, prompt }) => {
        const { output, usage } = await metered('finance.ask_books', () =>
          generateText({ model: chatModel(config), output: Output.object({ schema: zAskBooksOut() }), system, prompt, abortSignal: AbortSignal.timeout(timeoutMs), ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) }),
        );
        return { output: output ?? null, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
      });
  }

  /** The report and period the question asks for, from the REDACTED question only (prepareAskBooksQuestion), or why there is none: a question with no letters left (the placeholders are not letters) means no model call; a choice outside the closed lists
   * is refused whole (ask-books.ts). onUsage gets the tokens the call used. */
  async pick(redactedQuestion: string, language: 'vi' | 'en', onUsage?: (usage: AiUsage) => void): Promise<AskBooksResult> {
    if (!/\p{L}/u.test(redactedQuestion.replace(/\[(?:period|number)\]/g, ''))) return { kind: 'none', code: 'EMPTY' };
    const { output, usage } = await this.generate({ system: askBooksInstructions(language), prompt: askBooksPrompt(redactedQuestion) });
    if (usage) onUsage?.(usage);
    return checkAskBooksOutput(redactedQuestion, output);
  }
}
