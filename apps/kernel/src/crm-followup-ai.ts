// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's draft of the follow-up message for a "Cần theo dõi" step, on the API side (#3101, docs/plan/crm.md 4.4a, docs/plan/crm-quotes.md section 7).
// crm.followup.source runs in the member's own transaction and gives the facts (the contact, the days, the deal's sent quote); when the deal has a sent quote, the member's own command
// crm.quote.create_link makes the link the message carries (audited in their name; the token is in the answer only); the model call then runs here, outside any transaction, through the
// AI budget meter. The model is told none of the facts, and its words are refused when they hold a figure, a link, an address or a name (packages/agent crm-followup.ts); the whole
// draft is composed by code around the facts and checked against them again before it is returned.
//
// It is read, never written: nothing here stores the text, sends a message or an email, or moves the deal or the step, and no agent runs it. A person reads the text, edits it and
// sends it from the reply box of the conversation or from their own mail program. When the model is off, the AI budget is spent, the member's calls are too frequent, the call fails or
// its words are refused, the answer names the state (`ai`) and the text uses the fixed Vietnamese words with the same facts. A failure is named, never quoted: neither the contact's name,
// the hint nor the model's answer is logged.
import { AiBudgetExhaustedError, buildCrmFollowupDraft, type CrmFollowupFacts, type CrmFollowupWords, type InboxReader } from '@crove/agent';
import { QUOTE_PAGE_PATH, type CrmFollowupState, type FollowupDrafted, type QuoteLinkCreated } from '@crove/kernel-contract';
import type { FollowupSource } from '@crove/mod-crm';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface CrmFollowupAi {
  reader: Pick<InboxReader, 'crmFollowupWords'> | null;
  budget: DraftBudget;
}

export function crmFollowupAi(reader: CrmFollowupAi['reader'], budget: DraftBudget): CrmFollowupAi {
  return { reader, budget };
}

async function wordCrmFollowup(ai: CrmFollowupAi, orgId: string, userId: string, source: FollowupSource, hint: string | undefined): Promise<{ ai: CrmFollowupState; words: CrmFollowupWords | null }> {
  const answer = (state: CrmFollowupState, words: CrmFollowupWords | null = null) => ({ ai: state, words });
  if (!ai.reader) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.crmFollowupWords({ reason: source.reason, ...(hint ? { hint } : {}) }, [source.contactName, source.orgName]);
    if (result.kind === 'none') {
      console.error(`[crm-followup-ai] wording refused: ${result.code}`);
      return answer('failed');
    }
    return answer('used', result.words);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[crm-followup-ai] wording failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}

export interface CrmFollowupDeps {
  ai: CrmFollowupAi;
  // The address the app is served at (no trailing slash needed), or empty when the deployment does not know it: then the draft has no link.
  publicUrl: string;
  // The member's own command that makes a link to a sent quote (crm.quote.create_link).
  makeLink: (quoteId: string) => Promise<Pick<QuoteLinkCreated, 'path'>>;
}

export async function draftCrmFollowup(deps: CrmFollowupDeps, orgId: string, userId: string, source: FollowupSource, hint: string | undefined): Promise<FollowupDrafted> {
  const base = deps.publicUrl.trim().replace(/\/+$/, '');
  // The facts come first, so a link that fails for a real reason refuses before any paid call.
  let url: string | null = null;
  if (source.quote && base !== '') {
    try {
      const link = await deps.makeLink(source.quote.id);
      url = `${base}${link.path.startsWith(QUOTE_PAGE_PATH) ? link.path : `${QUOTE_PAGE_PATH}#${link.path}`}`;
    } catch (error: unknown) {
      // Too many live links on the quote, or its links can no longer open: the draft has no link and says so; the person can revoke a link or revise the quote. Any other failure is real.
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
      if (code !== 'QUOTE_LINK_LIMIT' && code !== 'QUOTE_LINK_EXPIRED') throw error;
    }
  }
  const facts: CrmFollowupFacts = {
    reason: source.reason,
    contactName: source.contactName,
    days: source.days,
    quote: source.quote ? { label: source.quote.label, total: source.quote.total, validUntil: source.quote.validUntil, url } : null,
  };
  const worded = await wordCrmFollowup(deps.ai, orgId, userId, source, hint);
  const draft = buildCrmFollowupDraft(facts, worded.words);
  // Words that passed their own check but not the check of the whole draft count as a refusal: the fixed words stand.
  const state: CrmFollowupState = worded.ai === 'used' && !draft.aiWords ? 'failed' : worded.ai;
  return {
    ai: state,
    reason: source.reason,
    subject: draft.subject,
    text: draft.text,
    email: source.contactEmail,
    quoteId: source.quote?.id ?? null,
    hasLink: url !== null,
  };
}
