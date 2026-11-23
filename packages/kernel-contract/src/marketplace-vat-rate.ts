// SPDX-License-Identifier: AGPL-3.0-only
// The VAT method and rate of an entity's marketplace sales (#4303 S3a, parent #2520, plan stock-and-marketplaces.md section 8.4): what the settings field shows and what its command takes. A rate is DATA with an
// effective date, never a constant in code. `deduction`: the entity declares VAT by deduction, so a marketplace sale carries output VAT on 33311 at `vatPercent`; `none`: it does not (a household on the percentage
// method, a direct-method company), so the sales posting adds no VAT line. A row exists only because an owner or admin entered it, so a row IS the person's confirmation; the table is append-only: a change or a correction is a later entry, never an edit.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const MARKETPLACE_VAT_METHOD_KEYS = ['deduction', 'none'] as const;
export const zMarketplaceVatMethod = z.enum(MARKETPLACE_VAT_METHOD_KEYS);
export type MarketplaceVatMethodKey = z.infer<typeof zMarketplaceVatMethod>;

// A rate in percent: a plain decimal string with at most two decimals, 0 to 100 ("8", "10", "5", "0", "8.5"). Never a JS number.
export const zMarketplaceVatPercent = z.string().regex(/^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/, 'a rate from 0 to 100 with at most two decimals');

const zRow = z.strictObject({ effectiveFrom: zLocalDate, method: zMarketplaceVatMethod, vatPercent: zMarketplaceVatPercent.nullable() });
const rowIsConsistent = (row: z.infer<typeof zRow>) => (row.method === 'deduction' ? row.vatPercent !== null : row.vatPercent === null);

// The entries of one entity by effective date and, within a date, in the order entered: the row in force on a day is the one with the greatest date on or before it, the latest entered among that date's.
export const zMarketplaceVatRateRow = zRow;
export type MarketplaceVatRateRow = z.infer<typeof zMarketplaceVatRateRow>;
export const zMarketplaceVatRatesGet = z.strictObject({ legalEntityId: zId });
export type MarketplaceVatRatesGet = z.infer<typeof zMarketplaceVatRatesGet>;
export const zMarketplaceVatRates = z.strictObject({ legalEntityId: zId, rows: z.array(zRow) });
export type MarketplaceVatRates = z.infer<typeof zMarketplaceVatRates>;

// New rows from their dates, all or none: at most four at once, strictly ascending by date, each `deduction` with a rate or `none` with none. The command also checks that they start outside a locked period;
// a date that already has a row is allowed (the new entry replaces it from now on).
export const zMarketplaceVatRateSet = z.strictObject({
  legalEntityId: zId,
  rows: z
    .array(zRow.refine(rowIsConsistent, 'deduction needs a rate and none takes none'))
    .min(1)
    .max(4)
    .refine((rows) => rows.every((row, i) => i === 0 || (rows[i - 1] as { effectiveFrom: string }).effectiveFrom < row.effectiveFrom), 'dates must be strictly ascending'),
});
export type MarketplaceVatRateSet = z.infer<typeof zMarketplaceVatRateSet>;
