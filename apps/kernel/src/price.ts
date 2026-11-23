// SPDX-License-Identifier: AGPL-3.0-only
// A price is a decimal string and is compared as one (the money rule, AGENTS.md; #3242, #3481), never through a JS number: a price too small for a JS number is still a price. A value
// that is not a decimal is no price.
import { Decimal } from '@ludy/l10n-vn';

export function isPositivePrice(value: string): boolean {
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
  }
}
