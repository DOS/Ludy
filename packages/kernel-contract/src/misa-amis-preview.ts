// SPDX-License-Identifier: AGPL-3.0-only
// What would be sent to MISA AMIS Kế toán (#3901, S3a of #3854): the vouchers of a period and kind as the push would write them, each with its AMIS type, its parts (a voucher of more than 500 lines is several
// requests), its totals and the blockers that keep it from being sent. A read: nothing is sent and MISA is not called. A blocker names a code and a line, never a party, an invoice number or a name. The
// AMIS-side references (branch, party codes read from get_dictionary) are not known until the connection test of #3885 reads the dictionary, so `checkedAgainstAmis` is false and the blockers that need them
// are left out until then; the deterministic list of what Ludy can decide alone is shown.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// The seven kinds Ludy hands to AMIS, with the voucher_type AMIS gives them (17, 18, 13, 5, 4, 1, 3).
export const MISA_AMIS_KINDS = ['purchase_services', 'purchase_goods', 'sales', 'cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit'] as const;
export type MisaAmisKind = (typeof MISA_AMIS_KINDS)[number];

// branch_missing and party_code_unknown need AMIS's dictionary; the preview cannot raise them yet.
export const MISA_AMIS_BLOCKERS = ['branch_missing', 'party_code_unknown', 'item_code_unknown', 'vat_rate_unmapped', 'no_lines'] as const;
export type MisaAmisBlockerCode = (typeof MISA_AMIS_BLOCKERS)[number];

// A code of AMIS's item dictionary, as a person types it.
const zItemCode = z.string().trim().min(1).max(50);

export const zMisaAmisPreviewAsk = z.strictObject({
  kind: z.enum(MISA_AMIS_KINDS),
  from: zLocalDate.optional(),
  to: zLocalDate.optional(),
  legalEntityId: zId.optional(),
  // The AMIS item the purchase service lines, or the sales lines, go under; without it those vouchers are blocked.
  serviceItemCode: zItemCode.optional(),
  salesItemCode: zItemCode.optional(),
  // The "mục đích mua vào" AMIS asks of purchases and payments; 1 when not given.
  purchasePurpose: z.enum(['1', '2', '3', '4', '5']).optional(),
});
export type MisaAmisPreviewAsk = z.infer<typeof zMisaAmisPreviewAsk>;

export const zMisaAmisPreviewBlocker = z.strictObject({ code: z.enum(MISA_AMIS_BLOCKERS), lineNo: z.number().int().min(0).nullable() });

export const zMisaAmisPreviewItem = z.strictObject({
  // The voucher's id in Ludy: the `org_refid` of the push.
  sourceId: zId,
  // Ludy's own voucher number (the `org_refno`), as on the MISA SME file.
  voucherNo: z.string().max(40),
  // AMIS's voucher_type, reftype and reason_type_id (null when the kind has none). The last two are Ludy's own choices, not yet confirmed in a MISA sandbox, so the person sees them before anything is sent.
  amisType: z.number().int().positive(),
  reftype: z.number().int().positive(),
  reasonTypeId: z.number().int().positive().nullable(),
  // How many requests it is: more than one when it has more than 500 lines.
  parts: z.number().int().min(1),
  lines: z.number().int().min(0),
  // The total payable, VAT included; "0" for a voucher that is blocked.
  total: zMoney,
  blockers: z.array(zMisaAmisPreviewBlocker).max(1000),
});
export type MisaAmisPreviewItem = z.infer<typeof zMisaAmisPreviewItem>;

// The most vouchers one preview lists; a longer period says `more` and the person narrows it.
export const MISA_AMIS_PREVIEW_LIMIT = 500;

export const zMisaAmisPreview = z.strictObject({
  kind: z.enum(MISA_AMIS_KINDS),
  // Vouchers read, those with no blocker, those with at least one.
  vouchers: z.number().int().min(0),
  ready: z.number().int().min(0),
  blocked: z.number().int().min(0),
  // false until the AMIS dictionary has been read: the branch and the party codes are not checked ("not matched with AMIS yet").
  checkedAgainstAmis: z.boolean(),
  // The "mục đích mua vào" the purchases and payments are written with (default 1, not yet confirmed in a MISA sandbox).
  purchasePurpose: z.enum(['1', '2', '3', '4', '5']),
  // true when the period holds more than MISA_AMIS_PREVIEW_LIMIT vouchers: the counts and items are of the first ones.
  more: z.boolean(),
  items: z.array(zMisaAmisPreviewItem).max(MISA_AMIS_PREVIEW_LIMIT),
});
export type MisaAmisPreview = z.infer<typeof zMisaAmisPreview>;
