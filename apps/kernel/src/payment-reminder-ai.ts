// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's wording of a payment reminder, on the API side (#2488, slice 2). finance.payment_reminder.draft runs in the member's own transaction and
// gives the notice level, the language and the sender's name; the model call then runs here, outside any transaction, through the AI budget meter (the request's
// AI scope names the org and the member). The model is told none of the invoices, amounts, dates or accounts, nor the customer's name, and its text is refused when
// it holds a figure or a link (packages/agent reminder.ts), so what it writes can never state a fact the books do not hold.
//
// The wording is read, never written: nothing here stores a text or sends a mail, and it is not a command. A person reads it, edits it and sends it through
// finance.payment_reminder.send, which rebuilds every fact from the books. When the model is off, the AI budget is spent, the member's calls are too frequent,
// the call fails or its text is refused, the answer names the state (`ai`) with no words, and the screen keeps the fixed template words. A failure is named,
// never quoted: neither the org's name, the hint nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader } from '@crove/agent';
import type { PaymentReminderWording } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ReminderAi {
  reader: Pick<InboxReader, 'reminderWords'> | null;
  budget: DraftBudget;
}

export async function wordReminder(
  ai: ReminderAi,
  orgId: string,
  userId: string,
  facts: { level: 1 | 2 | 3; lang: 'vi' | 'en'; org: string },
  hint: string | undefined,
): Promise<PaymentReminderWording> {
  const answer = (state: PaymentReminderWording['ai'], words: PaymentReminderWording['words'] = null): PaymentReminderWording => ({ ai: state, words });
  if (!ai.reader) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.reminderWords({ level: facts.level, language: facts.lang, orgName: facts.org, ...(hint ? { hint } : {}) });
    if (result.kind === 'none') {
      console.error(`[payment-reminder-ai] wording refused: ${result.code}`);
      return answer('failed');
    }
    return answer('used', result.words);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[payment-reminder-ai] wording failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
