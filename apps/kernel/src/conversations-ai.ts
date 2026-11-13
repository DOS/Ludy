// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's AI suggestions on the API side (CV3, #2306, plan docs/plan/conversations.md section 13): the suggested intent of a conversation and the
// likely contacts of a customer. The kernel's reads (kernel.conversation.intent_source and kernel.conversation.contact_candidates) run in the member's own
// transaction and say what they may read; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope
// names the org and the member, so @crove/agent's metered() asks the meter before the call and records what it used).
//
// A suggestion is read, never written: nothing here stores an intent, links a contact, assigns, resolves or hides, and it is not a command, so no agent or
// system actor is involved. The cache below keeps only what the model answered for a thread's newest message for an hour, in this process's memory, so
// the screen's six-second poll does not pay for the same answer again; it is a convenience, not a record. When the model is off, the AI budget is spent,
// the member's AI calls are too frequent or the call fails, the answer is no suggestion, with the state named (`ai`), and no error: the Inbox works as it
// did.
import { AiBudgetExhaustedError, type InboxReader, type Intent } from '@crove/agent';
import type { ConversationContactMatched, ConversationIntentSuggested } from '@crove/kernel-contract';
import type { ContactCandidates, IntentSource } from '@crove/kernel';
import { CONVERSATION_CONTACT_MATCHES_MAX } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

// The part of the reader the API uses; tests give a fake.
// reminderWords (the finance coworker's wording of a payment reminder, #2488) rides on the same reader and is optional, so a reader that has none leaves that screen on its template words.
// stockMatch and reorderText (the finance coworker on stock, #2514), einvoiceDraft (the finance coworker on a sales e-invoice draft, #2505) and quoteLines (the sales coworker on the lines of a quote, #2698) are optional the same way.
export type ConversationReader = Pick<InboxReader, 'intents' | 'rank' | 'rankCompanies'> & Partial<Pick<InboxReader, 'reminderWords' | 'followupWords' | 'overviewSentence' | 'payrollMatchSentence' | 'stockMatch' | 'reorderText' | 'einvoiceDraft' | 'quoteLines' | 'crmFollowupWords' | 'payrollPrepare' | 'payrollFlag' | 'payrollExplain'>>;

// An answered thread is kept for the hour; "no suggestion" (the model said other, left the thread out or gave nothing) only briefly, so a thread the model
// skipped is asked again soon.
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_NONE_TTL_MS = 2 * 60_000;
const CACHE_MAX = 2_000;

// What the model answered for a thread's newest message: an intent, or none. Keyed by the org, the thread and its last seq, so a newer message is read again.
export class IntentCache {
  private readonly entries = new Map<string, { intent: Intent | null; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(orgId: string, conversationId: string, lastSeq: number): string {
    return `${orgId}:${conversationId}:${lastSeq}`;
  }

  get(orgId: string, conversationId: string, lastSeq: number): Intent | null | undefined {
    const key = this.key(orgId, conversationId, lastSeq);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > (entry.intent === null ? CACHE_NONE_TTL_MS : CACHE_TTL_MS)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.intent;
  }

  set(orgId: string, conversationId: string, lastSeq: number, intent: Intent | null): void {
    const key = this.key(orgId, conversationId, lastSeq);
    this.entries.delete(key);
    this.entries.set(key, { intent, at: this.now() });
    // The oldest entries go first (a Map keeps insertion order), so the cache never grows past its bound.
    while (this.entries.size > CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface ConversationAi {
  reader: ConversationReader | null;
  // The model calls of the Inbox's suggestions have budgets of their own, apart from the reply drafts' and from each other (a member's suggestion of
  // intents and the ranking of contacts for the thread they opened can run at the same time).
  intentBudget: DraftBudget;
  contactBudget: DraftBudget;
  cache: IntentCache;
}

// A failure is named, never quoted: neither the thread's text nor the model's answer is logged.
const failed = (what: string, error: unknown): 'failed' => {
  console.error(`[conversation-ai] ${what} failed`, error instanceof Error ? error.name : typeof error);
  return 'failed';
};

export async function suggestIntents(ai: ConversationAi, orgId: string, userId: string, sources: readonly IntentSource[]): Promise<ConversationIntentSuggested> {
  const known = new Map<string, Intent | null>();
  for (const s of sources) {
    const hit = ai.cache.get(orgId, s.id, s.lastSeq);
    if (hit !== undefined) known.set(s.id, hit);
  }
  const answer = (state: ConversationIntentSuggested['ai']): ConversationIntentSuggested => ({
    ai: state,
    suggestions: sources.map((s) => ({ conversationId: s.id, intent: known.get(s.id) ?? null })),
  });
  const missing = sources.filter((s) => !known.has(s.id));
  if (missing.length === 0) return answer('used');
  if (!ai.reader) return answer('off');
  const ticket = ai.intentBudget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const intents = await ai.reader.intents(missing.map((s) => ({ texts: s.texts })));
    missing.forEach((s, i) => {
      const intent = intents[i] ?? null;
      known.set(s.id, intent);
      ai.cache.set(orgId, s.id, s.lastSeq, intent);
    });
    return answer('used');
  } catch (error: unknown) {
    return answer(error instanceof AiBudgetExhaustedError ? 'budget' : failed('intent suggestion', error));
  } finally {
    ticket.release();
  }
}

export async function matchContacts(ai: ConversationAi, orgId: string, userId: string, found: ContactCandidates): Promise<ConversationContactMatched> {
  const email = found.email.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'email' as const }));
  const phone = found.phone.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'phone' as const }));
  const named = (names: ContactCandidates['names']) => names.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'name' as const }));
  const result = (state: ConversationContactMatched['ai'], names: ContactCandidates['names']): ConversationContactMatched => ({
    ai: state,
    candidates: [...email, ...phone, ...named(names)].slice(0, CONVERSATION_CONTACT_MATCHES_MAX),
  });
  // One name or none needs no ranking: nothing is asked of the model.
  if (found.names.length < 2 || found.customerName === null) return result('used', found.names);
  // Email and phone matches that already fill the answer leave no room for a name: the model's order would change nothing, so nothing is asked of it.
  if (found.email.length + found.phone.length >= CONVERSATION_CONTACT_MATCHES_MAX) return result('used', found.names);
  if (!ai.reader) return result('off', found.names);
  const ticket = ai.contactBudget.take(orgId, userId);
  if (!ticket.allowed) return result('busy', found.names);
  try {
    const order = await ai.reader.rank(
      found.customerName,
      found.names.map((c) => c.name),
    );
    const ranked = order.flatMap((i) => (found.names[i] ? [found.names[i]] : []));
    // The names the model was not shown (past its bound) keep their place after the ranked ones.
    return result('used', [...ranked, ...found.names.filter((c) => !ranked.includes(c))]);
  } catch (error: unknown) {
    return result(error instanceof AiBudgetExhaustedError ? 'budget' : failed('contact ranking', error), found.names);
  } finally {
    ticket.release();
  }
}
