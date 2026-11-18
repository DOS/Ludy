// SPDX-License-Identifier: AGPL-3.0-only
// The "sender not confirmed" mark of an email thread is shown only where a mail's sender can be confirmed at all (#3636). The shipped default has no INBOUND_AUTHSERV_ID, so
// no sender is ever verified, every email thread is unverified, and a warning on all of them would mean nothing. The database keeps the truth either way (contact linking and
// the address book still treat such a sender as untrusted); only what the Inbox is told to draw changes. The fact travels in the field itself, over the authenticated read the
// Inbox already calls: without a verifier the field is left out, so nothing public says whether this deployment checks senders.
import type { ConversationDetail, ConversationListed, ConversationSummary } from '@crove/kernel-contract';

export function markableSummary(summary: ConversationSummary, canVerifySenders: boolean): ConversationSummary {
  if (canVerifySenders || summary.senderUnverified === undefined) return summary;
  const { senderUnverified: _omitted, ...rest } = summary;
  return rest;
}

export function markableListed(listed: ConversationListed, canVerifySenders: boolean): ConversationListed {
  return canVerifySenders ? listed : { ...listed, conversations: listed.conversations.map((c) => markableSummary(c, false)) };
}

export function markableDetail(detail: ConversationDetail, canVerifySenders: boolean): ConversationDetail {
  return canVerifySenders ? detail : { ...detail, conversation: markableSummary(detail.conversation, false) };
}
