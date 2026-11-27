// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MEETING_FACTS_CONTACTS_MAX = 3;
export const MEETING_FACTS_DEALS_MAX = 10;
export const MEETING_FACTS_MESSAGES_MAX = 5;
export const MEETING_FACTS_ATTENDEES_MAX = 50;
export const MEETING_BRIEF_DRAFT_MAX = 8000;
export const MEETING_BRIEF_DRAFT_TARGET_KINDS = ['agenda', 'booking', 'meeting'] as const;

export const zMeetingBriefTargetKind = z.enum(MEETING_BRIEF_DRAFT_TARGET_KINDS);
export type MeetingBriefTargetKind = z.infer<typeof zMeetingBriefTargetKind>;

const zIsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zDecimalMoney = z.string().regex(/^-?\d+(?:\.\d+)?$/);

export const zPartyInvoiceSummaryInput = z.strictObject({
  partyIds: z.array(zId).min(1).max(MEETING_FACTS_CONTACTS_MAX),
});
export type PartyInvoiceSummaryInput = z.infer<typeof zPartyInvoiceSummaryInput>;

export const zPartyInvoiceSummary = z.strictObject({
  partyId: zId,
  openCount: z.number().int().min(0),
  overdueAmount: zDecimalMoney,
  lastInvoiceDate: zIsoDay.nullable(),
  lastPaidDate: zIsoDay.nullable(),
});
export type PartyInvoiceSummary = z.infer<typeof zPartyInvoiceSummary>;

export const zPartyInvoiceSummaryOutput = z.strictObject({
  items: z.array(zPartyInvoiceSummary).max(MEETING_FACTS_CONTACTS_MAX),
});
export type PartyInvoiceSummaryOutput = z.infer<typeof zPartyInvoiceSummaryOutput>;

export const zMeetingsAttendeeHashesInput = z.strictObject({
  targetKind: z.enum(['agenda', 'meeting']),
  targetId: zId,
});
export type MeetingsAttendeeHashesInput = z.infer<typeof zMeetingsAttendeeHashesInput>;

export const zMeetingsAttendeeHashesOutput = z.strictObject({
  found: z.boolean(),
  linkedMeetingId: zId.nullable(),
  hashes: z.array(z.string().min(1).max(128)).max(MEETING_FACTS_ATTENDEES_MAX),
  calendarEventIds: z.array(zId).max(10),
});
export type MeetingsAttendeeHashesOutput = z.infer<typeof zMeetingsAttendeeHashesOutput>;

export const zCrmBookingBriefTargetInput = z.strictObject({ bookingId: zId });
export const zCrmBookingBriefTargetOutput = z.strictObject({ readable: z.boolean(), calendarEventId: zId.nullable() });

export const zMeetingFactsInput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
});
export type MeetingFactsInput = z.infer<typeof zMeetingFactsInput>;

export const zMeetingFactsDeal = z.strictObject({
  dealId: zId,
  title: z.string(),
  stage: z.string(),
  amount: zDecimalMoney.nullable(),
  expectedClose: zIsoDay.nullable(),
});
export type MeetingFactsDeal = z.infer<typeof zMeetingFactsDeal>;

export const zMeetingFactsQuote = z.strictObject({
  quoteId: zId,
  label: z.string(),
  total: zDecimalMoney,
  status: z.enum(['sent', 'accepted', 'declined', 'superseded']),
  validUntil: zIsoDay,
  expired: z.boolean(),
  sentOn: zIsoDay.nullable(),
});
export type MeetingFactsQuote = z.infer<typeof zMeetingFactsQuote>;

export const zMeetingFactsInvoices = z.strictObject({
  openCount: z.number().int().min(0),
  overdueAmount: zDecimalMoney,
  lastInvoiceDate: zIsoDay.nullable(),
  lastPaidDate: zIsoDay.nullable(),
});
export type MeetingFactsInvoices = z.infer<typeof zMeetingFactsInvoices>;

export const zMeetingFactsContact = z.strictObject({
  partyId: zId,
  contactName: z.string(),
  deals: z.array(zMeetingFactsDeal).max(MEETING_FACTS_DEALS_MAX),
  latestQuote: zMeetingFactsQuote.nullable(),
  invoices: zMeetingFactsInvoices.nullable(),
  messages: z.array(z.string()).max(MEETING_FACTS_MESSAGES_MAX),
});
export type MeetingFactsContact = z.infer<typeof zMeetingFactsContact>;

export const zMeetingFactsOutput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
  wordsAllowed: z.boolean(),
  contacts: z.array(zMeetingFactsContact).max(MEETING_FACTS_CONTACTS_MAX),
});
export type MeetingFactsOutput = z.infer<typeof zMeetingFactsOutput>;

export const zMeetingBriefDraftListInput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
});
export type MeetingBriefDraftListInput = z.infer<typeof zMeetingBriefDraftListInput>;

export const zMeetingBriefDraft = z.strictObject({
  id: zId,
  partyId: zId,
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
  body: z.string().min(1).max(MEETING_BRIEF_DRAFT_MAX),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MeetingBriefDraft = z.infer<typeof zMeetingBriefDraft>;

export const zMeetingBriefDraftListOutput = z.strictObject({
  drafts: z.array(zMeetingBriefDraft).max(20),
});
export type MeetingBriefDraftListOutput = z.infer<typeof zMeetingBriefDraftListOutput>;

export const zMeetingBriefDraftSaveInput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
  partyId: zId,
  body: z.string().trim().min(1).max(MEETING_BRIEF_DRAFT_MAX),
});
export type MeetingBriefDraftSaveInput = z.infer<typeof zMeetingBriefDraftSaveInput>;

export const zMeetingBriefDraftSaveOutput = z.strictObject({
  draft: zMeetingBriefDraft,
});
export type MeetingBriefDraftSaveOutput = z.infer<typeof zMeetingBriefDraftSaveOutput>;

export const zMeetingBriefDraftRemoveInput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
  partyId: zId,
});
export type MeetingBriefDraftRemoveInput = z.infer<typeof zMeetingBriefDraftRemoveInput>;

export const zMeetingBriefDraftRemovedOutput = z.strictObject({
  removed: z.boolean(),
});
export type MeetingBriefDraftRemovedOutput = z.infer<typeof zMeetingBriefDraftRemovedOutput>;

export const zMeetingBriefDraftPutToNotesInput = z.strictObject({
  targetKind: zMeetingBriefTargetKind,
  targetId: zId,
  partyId: zId,
  meetingId: zId,
});
export type MeetingBriefDraftPutToNotesInput = z.infer<typeof zMeetingBriefDraftPutToNotesInput>;

export const zMeetingBriefDraftPutToNotesOutput = z.strictObject({
  meetingId: zId,
  partyId: zId,
  length: z.number().int().min(1),
  truncated: z.boolean(),
});
export type MeetingBriefDraftPutToNotesOutput = z.infer<typeof zMeetingBriefDraftPutToNotesOutput>;
