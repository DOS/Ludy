// SPDX-License-Identifier: AGPL-3.0-only
// Zero-dependency leaf constants and types for MISA AMIS blocker notes (#4022): kept separate from
// misa-amis-blocker-notes.ts so inbox.ts can build its Zod enum schema without hitting a circular module load.

// The blocker kinds of the AMIS mapper, as the preview names them (packages/kernel-contract misa-amis-preview.ts; a test keeps the two lists equal).
export const MISA_AMIS_BLOCKER_KINDS = ['branch_missing', 'party_code_unknown', 'party_code_ambiguous', 'item_code_unknown', 'stock_missing', 'stock_unknown', 'unit_unknown', 'unit_ambiguous', 'vat_rate_unmapped', 'voucher_number_too_long', 'no_lines'] as const;
export type MisaAmisBlockerKind = (typeof MISA_AMIS_BLOCKER_KINDS)[number];
