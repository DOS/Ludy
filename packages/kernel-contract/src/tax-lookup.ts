// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

export const TAX_LOOKUP_PROVIDERS = ['off', 'casso'] as const;
export type TaxLookupProviderId = (typeof TAX_LOOKUP_PROVIDERS)[number];

export const zPartyTaxLookupInput = z.strictObject({
  taxCode: z.string().trim().max(40),
});
export type PartyTaxLookupInput = z.infer<typeof zPartyTaxLookupInput>;

export const zPartyTaxLookupResult = z.strictObject({
  found: z.boolean(),
  taxCode: z.string(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  statusText: z.string().nullable(),
  source: z.string().nullable(),
  cached: z.boolean(),
  household: z.boolean(),
  quotaWarning: z.boolean().optional(),
});
export type PartyTaxLookupResult = z.infer<typeof zPartyTaxLookupResult>;

export const zPartyTaxLookupSwitchInput = z.strictObject({
  enabled: z.boolean(),
});
export type PartyTaxLookupSwitchInput = z.infer<typeof zPartyTaxLookupSwitchInput>;

export const zPartyTaxLookupSwitch = z.strictObject({
  enabled: z.boolean(),
});
export type PartyTaxLookupSwitch = z.infer<typeof zPartyTaxLookupSwitch>;
