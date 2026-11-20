// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854): what the Tích hợp card shows and what its commands take. The access code the customer makes in AMIS is sealed in the
// kernel and never in an answer, a log or an audit row; nothing here carries a voucher, a party or MISA's own text, only ids and states.
import { z } from 'zod';
import { zId } from './schemas.ts';

// Whether this deployment offers the connector at all: it does only when the deployment holds the integrator's ClientID (never in any answer).
// `pushOffered`: the push of vouchers is also switched on (MISA_AMIS_PUSH, after the sandbox check): without it the screen draws no confirm button and the route answers 404.
// `aspOffered` (#4111, S2 of #4103): this deployment also holds a ClientID for MISA ASP (MISA_ASP_CLIENT_ID), so a connection may be made for that product. Each product is on only with its own ClientID.
// `aspPushOffered` (#4113, S4 of #4103): the push to MISA ASP is switched on too (MISA_ASP_PUSH=on, with the ClientID): its own switch, apart from `pushOffered`.
export const zMisaAmisStatus = z.object({ offered: z.boolean(), pushOffered: z.boolean(), aspOffered: z.boolean(), aspPushOffered: z.boolean() });
export type MisaAmisStatus = z.infer<typeof zMisaAmisStatus>;

// What a connection test came back with, as a state and never MISA's own text (the column's CHECK).
export const MISA_AMIS_TEST_STATES = ['works', 'wrong_credentials', 'unreachable'] as const;
export const zMisaAmisTestState = z.enum(MISA_AMIS_TEST_STATES);
export type MisaAmisTestState = z.infer<typeof zMisaAmisTestState>;

// The MISA product a connection is for: AMIS Kế toán or MISA ASP. A legal entity is on one of them, never both; the product is fixed for the connection's life.
export const MISA_AMIS_PRODUCTS = ['amis', 'asp'] as const;
export const zMisaAmisProduct = z.enum(MISA_AMIS_PRODUCTS);
export type MisaAmisProduct = z.infer<typeof zMisaAmisProduct>;

export const zMisaAmisConnection = z.object({
  id: zId,
  product: zMisaAmisProduct,
  // The channel connection that holds the sealed access code. The code itself is never in any answer.
  connectionId: zId,
  legalEntityId: zId,
  displayName: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'error']),
  // "Connected since": the only thing the screen shows of the connection's secret side.
  connectedAt: z.iso.datetime({ offset: true }),
  // The last connection test (#3885, S2b): its state and time, or null while none ran.
  lastTestState: zMisaAmisTestState.nullable(),
  lastTestedAt: z.iso.datetime({ offset: true }).nullable(),
  // The connection's default items (S3b, #4124): the item code a person keeps for service lines and for sales lines, as the firm's MISA catalogue spells it; null for none. The preview starts from them.
  defaultServiceItemCode: z.string().nullable().optional(),
  defaultSalesItemCode: z.string().nullable().optional(),
  // MISA ASP only (#4125): the stock code a person keeps for the connection's sales lines, as the catalogue spells it; null for none.
  defaultSalesStockCode: z.string().nullable().optional(),
  // MISA ASP only (#4125): the unit names a person typed as the catalogue spells them, by the unit of Ludy (folded); absent or empty for none.
  unitAliases: z.record(z.string(), z.string()).optional(),
});
export type MisaAmisConnection = z.infer<typeof zMisaAmisConnection>;

// The access code the customer made in AMIS (a person with admin rights there): typed once, sealed at the edge and never shown back.
export const MISA_AMIS_ACCESS_CODE_MAX = 500;
export const zMisaAmisConnect = z.strictObject({
  // Left out, the org's default entity.
  legalEntityId: zId.nullable(),
  // Left out, AMIS Kế toán (what every caller before #4111 meant).
  product: zMisaAmisProduct.default('amis'),
  accessCode: z.string().trim().min(1).max(MISA_AMIS_ACCESS_CODE_MAX),
});
export type MisaAmisConnect = z.infer<typeof zMisaAmisConnect>;

// The command that records a connection test (the worker's alone): a state, nothing else.
export const zMisaAmisConnectionRecordTest = z.strictObject({ id: zId, state: zMisaAmisTestState });

// A person keeps, or clears, the default item of a connection for one kind of line (S3b, #4124): `service` for a purchase of services, `sales` for a sale. The code is typed as the catalogue spells it (at most 50
// characters, as the preview's own field); null clears it. It is not looked up here (the API cannot read the catalogue): the next check against the catalogue says when an item is not there.
// `sales_stock` (#4125, MISA ASP only): the stock a sales line leaves, a stock code typed as the catalogue spells it.
export const MISA_AMIS_DEFAULT_ITEM_ROLES = ['service', 'sales', 'sales_stock'] as const;
export const zMisaAmisDefaultItem = z.strictObject({
  id: zId,
  role: z.enum(MISA_AMIS_DEFAULT_ITEM_ROLES),
  // No control character (a NUL cannot be stored in text and would be a 500, not a refusal): a code is typed as the catalogue spells it.
  code: z.string().trim().min(1).max(50).regex(/^[^\p{Cc}]+$/u).nullable(),
});
export type MisaAmisDefaultItem = z.infer<typeof zMisaAmisDefaultItem>;

// A person keeps, or clears with a null name, the unit name MISA has for one unit of Ludy (#4125, MISA ASP only): `unit` is the unit as Ludy writes it (folded by the server the way the check folds it), `misaName`
// the unit as the catalogue spells it, typed (1 to 64 characters). It is not looked up here (the API cannot read the catalogue): the next check matches it exactly, and a unit it does not find stays a blocker.
export const MISA_AMIS_UNIT_ALIASES_MAX = 200;
export const zMisaAmisUnitAlias = z.strictObject({
  id: zId,
  // No control character in either text (a NUL cannot be stored in jsonb text and would be a 500, not a refusal).
  unit: z.string().trim().min(1).max(64).regex(/^[^\p{Cc}]+$/u),
  misaName: z.string().trim().min(1).max(64).regex(/^[^\p{Cc}]+$/u).nullable(),
});
export type MisaAmisUnitAlias = z.infer<typeof zMisaAmisUnitAlias>;

// The units of the last check a person can give a MISA name (#4125): a unit of Ludy the catalogue did not match (none or several of that name), or one that has a name typed. Owner or admin.
export const zMisaAmisUnitsAsk = z.strictObject({ connectionId: zId });
export const zMisaAmisUnitRow = z.strictObject({
  unit: z.string(),
  state: z.enum(['unknown', 'ambiguous', 'matched']),
  alias: z.string().nullable(),
});
export type MisaAmisUnitRow = z.infer<typeof zMisaAmisUnitRow>;
