// SPDX-License-Identifier: AGPL-3.0-only
// The state of the day-1 "Bắt đầu" card on Home (#4783).
// The "Bắt đầu" card (day-1 start path) goes away by itself or by the member's choice, and does not come back on this device:
// 'done' once the org has its first approved invoice, 'dismissed' after the close button. Per org and browser, so it is a
// convenience, never a fact about the org: storage may be missing or full (private window), and then the card simply shows by its own rule.
export type StartCardState = 'done' | 'dismissed';

const startKey = (slug: string) => `ludy.home.start.${slug}`;

export function readStartCardState(slug: string): StartCardState | null {
  try {
    const value = globalThis.localStorage?.getItem(startKey(slug));
    return value === 'done' || value === 'dismissed' ? value : null;
  } catch {
    return null;
  }
}

export function writeStartCardState(slug: string, state: StartCardState): void {
  try {
    globalThis.localStorage?.setItem(startKey(slug), state);
  } catch {
    // Storage is not there: the card follows its rule on the next visit.
  }
}

// Whether the day-1 card shows. `firstInvoiceApproved` is undefined until the read answers (the card never flashes before it knows);
// without the accounting app there is no invoice to wait for, so the card follows the empty-org rule (`orgEmpty`) instead.
export function showStartCard(input: {
  steps: number;
  stored: StartCardState | null;
  financeOn: boolean;
  firstInvoiceApproved: boolean | undefined;
  orgEmpty: boolean;
}): boolean {
  if (input.steps === 0 || input.stored !== null) return false;
  if (input.financeOn) return input.firstInvoiceApproved === false;
  return input.orgEmpty;
}
