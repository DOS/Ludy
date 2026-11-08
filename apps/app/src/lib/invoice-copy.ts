// SPDX-License-Identifier: AGPL-3.0-only
// The previous invoice to the same customer copied into the draft form by code, with no model (#2721). No browser or API imports, so it is unit tested.
import { EINVOICE_DRAFT_MAX_LINES, type BuyerKind, type EInvoicePrevious } from '@crove/kernel-contract';

interface CopyLine {
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  ai: null | string;
}
interface CopyForm {
  buyer: { kind: BuyerKind; partyId: string | null; taxCode: string; name: string; address: string; email: string };
  lines: CopyLine[];
}

const isBlank = (l: CopyLine) => l.description.trim() === '' && l.unit.trim() === '' && l.unitPrice.trim() === '';

// The invoice's lines follow the lines a person already wrote (at most what a draft holds), the buyer is filled while the form has none of its own or still holds the buyer of the invoice copied
// before (`replaceBuyerOf`), and a VAT rate the form's date no longer allows is set to the default so a person chooses it again. `added` and `rateChanged` count the lines that really went in.
export function applyPrevious<S extends CopyForm>(s: S, invoice: NonNullable<EInvoicePrevious['invoice']>, replaceBuyerOf: string | null): { state: S; added: number; rateChanged: number } {
  const kept = s.lines.filter((l) => !isBlank(l));
  const taken = invoice.lines.slice(0, Math.max(0, EINVOICE_DRAFT_MAX_LINES - kept.length));
  const proposed: CopyLine[] = taken.map((l) => ({ description: l.description, unit: l.unit ?? '', quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatAllowed ? l.vatRate : '10%', ai: null }));
  const lines = [...kept, ...proposed];
  const b = s.buyer;
  const buyerEmpty = b.partyId === null && b.taxCode.trim() === '' && b.name.trim() === '' && b.address.trim() === '' && b.email.trim() === '';
  const from = invoice.buyer;
  const replace = b.kind !== 'consumer' && (buyerEmpty || (replaceBuyerOf !== null && b.partyId === replaceBuyerOf));
  const buyer = replace ? { kind: from.kind as BuyerKind, partyId: from.partyId, taxCode: from.taxCode ?? '', name: from.name ?? '', address: from.address ?? '', email: from.email ?? '' } : b;
  return { state: { ...s, lines: lines.length > 0 ? lines : s.lines, buyer }, added: proposed.length, rateChanged: taken.filter((l) => !l.vatAllowed).length };
}
