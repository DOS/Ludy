// SPDX-License-Identifier: AGPL-3.0-only
// SG1 contact "Can chu y" (attention) list and per-member "Da xem" marks (#4993, docs/plan/crm.md 10.3).
// Items hold only a kind, a timestamp, and entity IDs, never customer or deal text.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const PARTY_ATTENTION_KINDS = ['quote_viewed', 'quote_expiring', 'quote_unanswered', 'customer_replied'] as const;
export type PartyAttentionKind = (typeof PARTY_ATTENTION_KINDS)[number];

// Maximum items returned per contact attention query.
export const PARTY_ATTENTION_MAX = 10;
// Lookback window for first-party quote views and silence threshold for customer replies (in days).
export const PARTY_ATTENTION_DAYS = 7;

export const zPartyAttentionQuery = z.strictObject({
  partyId: zId,
});
export type PartyAttentionQuery = z.infer<typeof zPartyAttentionQuery>;

export const zPartyAttentionItem = z.strictObject({
  kind: z.enum(PARTY_ATTENTION_KINDS),
  targetId: zId,
  eventAt: z.iso.datetime({ offset: true }),
  partyId: zId,
  dealId: zId.nullable(),
  quoteId: zId.nullable(),
  nextStepId: zId.nullable(),
  conversationId: zId.nullable(),
});
export type PartyAttentionItem = z.infer<typeof zPartyAttentionItem>;

export const zPartyAttentionList = z.strictObject({
  items: z.array(zPartyAttentionItem).max(PARTY_ATTENTION_MAX),
});
export type PartyAttentionList = z.infer<typeof zPartyAttentionList>;

export const zPartyAttentionMarkSeen = z.strictObject({
  partyId: zId,
  kind: z.enum(PARTY_ATTENTION_KINDS),
  targetId: zId,
  eventAt: z.iso.datetime({ offset: true }).optional(),
});
export type PartyAttentionMarkSeen = z.infer<typeof zPartyAttentionMarkSeen>;

export const zPartyAttentionSeen = z.strictObject({
  partyId: zId,
  kind: z.enum(PARTY_ATTENTION_KINDS),
  targetId: zId,
  seenEventAt: z.iso.datetime({ offset: true }),
});
export type PartyAttentionSeen = z.infer<typeof zPartyAttentionSeen>;
