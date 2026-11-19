// SPDX-License-Identifier: AGPL-3.0-only
// The push of vouchers to MISA AMIS Kế toán as the screen sees it (#3902, S3b-2 of #3854): the confirmation of a previewed batch, the rows of a connection with their state, and what a person decides about a row
// MISA never answered for. Nothing here carries a voucher body, a party or a secret: ids, numbers, states, counts and, for a refused voucher, MISA's own text (untrusted: shown escaped, capped like the column).
import { z } from 'zod';
import { zMisaAmisPreviewAsk } from './misa-amis-preview.ts';
import { zId } from './schemas.ts';

export const MISA_AMIS_PUSH_ROW_STATES = ['queued', 'sending', 'sent', 'accepted', 'refused', 'ambiguous', 'failed'] as const;
export type MisaAmisPushRowState = (typeof MISA_AMIS_PUSH_ROW_STATES)[number];

// What the person confirms: the preview's own ask, the connection it goes through and the digest of what they saw. A different digest now means the data changed since, and nothing is queued.
export const zMisaAmisPushConfirm = zMisaAmisPreviewAsk.extend({ connectionId: zId, digest: z.string().regex(/^[0-9a-f]{64}$/) });
export type MisaAmisPushConfirm = z.infer<typeof zMisaAmisPushConfirm>;

// How many requests were queued, put back in the queue (a refused or failed one the person sends again), left alone because they are already queued or sent, or not sent because the source was revised since.
export const zMisaAmisPushConfirmed = z.strictObject({
  queued: z.number().int().min(0),
  requeued: z.number().int().min(0),
  already: z.number().int().min(0),
  revised: z.number().int().min(0),
});
export type MisaAmisPushConfirmed = z.infer<typeof zMisaAmisPushConfirmed>;

export const zMisaAmisPushListAsk = z.strictObject({ connectionId: zId, state: z.enum(MISA_AMIS_PUSH_ROW_STATES).optional() });

export const zMisaAmisPushRow = z.strictObject({
  id: zId,
  // The request's id in AMIS (`org_refid`): what a person settles a row by.
  orgRefid: zId,
  sourceType: z.enum(['cash_voucher', 'purchase_document', 'sales_document']),
  sourceId: zId,
  voucherType: z.number().int().min(1),
  part: z.number().int().min(1),
  // Ludy's own voucher number as AMIS shows it.
  orgRefno: z.string().max(40),
  state: z.enum(MISA_AMIS_PUSH_ROW_STATES),
  // MISA's own text for a refused voucher (untrusted) or the code of a failure of ours.
  reason: z.string().max(2000).nullable(),
  attempts: z.number().int().min(1),
  requestedAt: z.iso.datetime({ offset: true }),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
  // The row's last change: with the state it says whether a person may settle the row.
  changedAt: z.iso.datetime({ offset: true }),
});
export type MisaAmisPushRow = z.infer<typeof zMisaAmisPushRow>;

// "It is in AMIS" / "it is not in AMIS": what an owner or admin found when they looked in AMIS for a request MISA never answered for.
export const zMisaAmisPushResolveAsk = z.strictObject({ connectionId: zId, orgRefid: zId, outcome: z.enum(['in_amis', 'not_in_amis']) });
export type MisaAmisPushResolveAsk = z.infer<typeof zMisaAmisPushResolveAsk>;
