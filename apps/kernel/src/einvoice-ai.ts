// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on a sales e-invoice draft, on the API side (#2505): the lines, the VAT rate the text states and the buyer, proposed from a text a person typed or pasted.
// finance.einvoice_draft.suggest_source runs in the member's own transaction and says what the model may see (the text, the names of the customers that fit it, and earlier VAT rates:
// no address, tax code, credential, bank account or provider data); the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the
// org and the member).
//
// It is read, never written: nothing here saves a draft, approves or issues; the answer fills the form as proposals that a person reads, edits and saves, and issuing keeps its own approval.
// What the model wrote is checked in code first (packages/agent einvoice-draft.ts: a figure the text does not hold, a VAT rate the text does not state or the date does not allow, a link
// refuse the whole proposal). Then the code, not the model, fills in the rest:
// - the buyer's name, address, email and tax code come from the customer's own record, by the number the model answered; a tax code that fails its checksum is left out, so the form's own
//   check asks for it;
// - a line whose VAT rate the text did not state gets the rate of the earlier drafts to that customer, else of the org (the most used rate that the invoice date allows), and where there
//   is none the form's default stands;
// - amounts are not here at all: the draft's own check computes them from the quantities and prices a person saves.
// When the model is off, the AI budget is spent, the member's calls are too frequent, the call fails or its answer is refused, the answer names the state (`ai`) and gives nothing to fill in,
// so the form works as it does with AI off. A failure is named, never quoted: neither the text nor the model's answer is logged.
import { AiBudgetExhaustedError, type EInvoiceDraftRequest, type InboxReader } from '@crove/agent';
import type { EInvoiceSuggestInput, EInvoiceSuggested } from '@crove/kernel-contract';
import { parseTaxCode, salesVatRatesOn } from '@crove/l10n-vn';
import type { EInvoiceSuggestParty, EInvoiceSuggestSource, RateCount } from '@crove/mod-finance';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface EInvoiceAi {
  reader: Partial<Pick<InboxReader, 'einvoiceDraft'>> | null;
  budget: DraftBudget;
}

export function einvoiceAi(reader: EInvoiceAi['reader'], budget: DraftBudget): EInvoiceAi {
  return { reader, budget };
}

/** The most used VAT rate among `rates` that the invoice date allows, or null. A tie goes to the rate that sorts first, so the answer does not depend on the order of the rows. */
export function usualRate(rates: readonly RateCount[], allowed: readonly string[]): string | null {
  const best = [...rates].filter((r) => allowed.includes(r.vatRate) && r.n > 0).sort((a, b) => b.n - a.n || a.vatRate.localeCompare(b.vatRate))[0];
  return best?.vatRate ?? null;
}

/** The buyer a customer's record gives, for the form: name, address and email as the record holds them, the tax code only when it passes its checksum. An organisation is a business (the
 * form's checks then ask for a tax code it lacks), a person an individual. */
export function buyerOf(party: EInvoiceSuggestParty): NonNullable<EInvoiceSuggested['buyer']> {
  const info = party.taxCode ? parseTaxCode(party.taxCode) : null;
  const taxCode = party.taxCode && info !== null && info.checksumValid !== false ? party.taxCode : null;
  // A field longer than the draft takes is left out, so one odd record does not refuse the lines as well.
  const within = (value: string | null, max: number) => (value !== null && value.length <= max ? value : null);
  return { kind: party.kind === 'organization' ? 'business' : 'individual', partyId: party.id, taxCode, name: within(party.name, 400), address: within(party.address, 500), email: within(party.email, 254) };
}

export async function suggestEInvoiceDraft(ai: EInvoiceAi, orgId: string, userId: string, source: EInvoiceSuggestSource, input: EInvoiceSuggestInput): Promise<EInvoiceSuggested> {
  const answer = (state: EInvoiceSuggested['ai'], lines: EInvoiceSuggested['lines'] = [], buyer: EInvoiceSuggested['buyer'] = null): EInvoiceSuggested => ({ ai: state, lines, buyer });
  const ask = ai.reader?.einvoiceDraft;
  if (!ask) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const request: EInvoiceDraftRequest = { text: input.text, date: input.date, parties: source.parties.map((p) => ({ name: p.name })) };
    const result = await ask(request);
    if (result.kind === 'none') {
      console.error(`[einvoice-ai] draft refused: ${result.code}`);
      return answer('refused');
    }
    const party = result.buyerIndex === null ? undefined : source.parties[result.buyerIndex];
    const allowed = salesVatRatesOn(input.date);
    // The rate to give a line that did not state one: the customer's usual, else the org's.
    const fallback = usualRate(party?.rates ?? [], allowed) ?? usualRate(source.orgRates, allowed);
    const lines = result.lines.map((line) => {
      const vatRate = line.vatRate ?? fallback ?? '10%';
      return { description: line.description, unit: line.unit, quantity: line.quantity, unitPrice: line.unitPrice, vatRate, vatFrom: line.vatRate !== null ? ('text' as const) : fallback !== null ? ('earlier' as const) : ('default' as const) };
    });
    return answer('used', lines, party ? buyerOf(party) : null);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[einvoice-ai] draft failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
