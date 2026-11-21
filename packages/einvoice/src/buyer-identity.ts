// SPDX-License-Identifier: AGPL-3.0-only
// Where an individual buyer's CCCD, passport number or budget-relation unit code goes in a provider's document (#3678). The names are data, never code, and THE MISA NAMES ARE EMPTY ON
// PURPOSE for now: they were not read from MISA's own integration guide (developer.misa.vn), and no field name is invented. With a null name an invoice that carries an identity is
// refused before any call (`invalid_data`) instead of being sent without the identity the person typed, which is the safe answer while MISA's issuing is off (`MISA_GATES`). Writing the
// three names from the guide, with the date they were read, is the whole change that makes them go through. The offline sandbox needs no names: it echoes the identity in its own XML.
import type { BuyerIdentityKind } from './port.ts';

export const MISA_BUYER_IDENTITY_FIELDS: Readonly<Record<BuyerIdentityKind, string | null>> = {
  cccd: null,
  passport: null,
  budget_code: null,
};

// Where a foreign buyer's nationality (ISO 3166-1 alpha-2, Decree 254 Appendix point 4.b, #3709) goes: empty on purpose for the same reason as the names above. A request that carries a nationality
// is refused before any call (`invalid_data`) while this is null; the offline sandbox echoes it in its own XML (`QTich`).
export const MISA_BUYER_NATIONALITY_FIELD: string | null = null;
