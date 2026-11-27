// SPDX-License-Identifier: AGPL-3.0-only
// What the deal form shows when the deal changes under it (#5015). Pure, so it loads without the api client.
import type { Deal, PartyChoice } from '@ludy/kernel-contract';

// What the person has typed so far, by field. A field that is not here follows the deal; one that is here keeps what was typed (null is a real edit: the customer let go).
export interface DealFormEdits {
  title?: string;
  party?: PartyChoice | null;
  amount?: string;
  expectedClose?: string;
  ownerUserId?: string;
}

export interface DealFormValues {
  title: string;
  party: PartyChoice | null;
  amount: string;
  expectedClose: string;
  ownerUserId: string;
}

// The values the form shows: the deal as it is now, with the person's own edits on top (#5015). A deal that changes under an open form (a read that lands after the card's copy, a quote's offer, a move
// from another tab) updates the fields nobody touched and never throws away or resets what was typed, so a save sends the typed title with the newest version and not the stale one.
export function dealFormValues(deal: Deal | null, presetParty: PartyChoice | null, edits: DealFormEdits): DealFormValues {
  const base: DealFormValues = {
    title: deal?.title ?? '',
    party: deal ? { id: deal.partyId, name: deal.partyName, kind: 'organization', taxCode: null } : presetParty,
    amount: deal ? deal.amount.replace(/\.00$/, '') : '',
    expectedClose: deal?.expectedClose ?? '',
    ownerUserId: deal ? (deal.ownerUserId ?? '') : 'me',
  };
  return {
    title: edits.title ?? base.title,
    party: edits.party !== undefined ? edits.party : base.party,
    amount: edits.amount ?? base.amount,
    expectedClose: edits.expectedClose ?? base.expectedClose,
    ownerUserId: edits.ownerUserId ?? base.ownerUserId,
  };
}

// The newer of two copies of one deal: the card or row the sheet was opened from, and the read by id. A cached read can be older than the card (the board refetched after a save, the read by id is still within its stale time), and a form on the older copy would send a version the server refuses (#5015).
export function newerDeal(opened: Deal, read: Deal | undefined): Deal {
  return read && read.version >= opened.version ? read : opened;
}
