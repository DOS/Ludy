// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's suggestion of the company a person works at, on the API side (#2438, CRM-Q5 of docs/plan/crm.md, PR 3). crm.contact.company_candidates runs
// in the member's own transaction and finds the companies by three deterministic rules (a tax code the person wrote, the same email domain, a name that carries the
// word at the heart of the domain); the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and
// the member), and only orders the names when there are two or more of them. It adds no company.
//
// A suggestion is read, never written: nothing here links a person, and it is not a command. When the model is off, the AI budget is spent, the member's calls are
// too frequent or the call fails, the names keep their own order and the state is named (`ai`), with no error: the panel works as it did. A failure is named, never
// quoted: neither a name nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader } from '@crove/agent';
import { COMPANY_SUGGESTIONS_MAX, type CompanyCandidates, type CompanySuggested } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface CompanyAi {
  reader: Pick<InboxReader, 'rankCompanies'> | null;
  budget: DraftBudget;
}

export async function suggestCompanies(ai: CompanyAi, orgId: string, userId: string, found: CompanyCandidates): Promise<CompanySuggested> {
  const sure = [
    ...found.taxCode.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'tax_code' as const })),
    ...found.emailDomain.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'email_domain' as const })),
  ];
  const result = (state: CompanySuggested['ai'], names: CompanyCandidates['names']): CompanySuggested => ({
    ai: state,
    candidates: [...sure, ...names.map((c) => ({ partyId: c.partyId, name: c.name, reason: 'name' as const }))].slice(0, COMPANY_SUGGESTIONS_MAX),
  });
  // One name or none needs no ranking: nothing is asked of the model.
  if (found.names.length < 2 || found.label === null) return result('used', found.names);
  if (!ai.reader) return result('off', found.names);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return result('busy', found.names);
  try {
    const order = await ai.reader.rankCompanies(
      found.personName,
      found.label,
      found.names.map((c) => c.name),
    );
    const ranked = order.flatMap((i) => (found.names[i] ? [found.names[i]] : []));
    // The names the model was not shown (past its bound) keep their place after the ranked ones.
    return result('used', [...ranked, ...found.names.filter((c) => !ranked.includes(c))]);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return result('budget', found.names);
    console.error('[contact-company-ai] company ranking failed', error instanceof Error ? error.name : typeof error);
    return result('failed', found.names);
  } finally {
    ticket.release();
  }
}
