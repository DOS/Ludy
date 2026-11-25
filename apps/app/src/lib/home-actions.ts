// SPDX-License-Identifier: AGPL-3.0-only
// The fixed "create" actions at the top of Home (UI/UX P2-2, #4783) and the state of the day-1 "Bắt đầu" card.
// The actions are named by the job, not the screen (docs/research/smb-suite-navigation-benchmark-2026-11.md L1, L4), the same for everyone,
// and only those whose app is on are shown. The list lives in this one constant so the wording and targets of the lean-navigation work
// (#4800, docs/plan/lean-navigation-audit-2026-11.md section 4, "Trả nhà cung cấp" and the others) change here and nowhere else.
import type { NavIconName } from '@ludy/ui/components/nav-icon';

export type HomeActionId = 'uploadInvoice' | 'recordExpense' | 'createSalesInvoice' | 'addCustomer';

export type HomeActionTarget = '/o/$slug/inbox' | '/o/$slug/vouchers' | '/o/$slug/sales-invoices' | '/o/$slug/contacts';

export interface HomeAction {
  readonly id: HomeActionId;
  readonly to: HomeActionTarget;
  // Search params of the target, when it opens on a preset (a phiếu chi, not the whole list).
  readonly search?: Readonly<Record<string, string>>;
  readonly icon: NavIconName;
  // The module (app) that has to be on for the action to be shown.
  readonly module: string;
}

// At most 4: one row at 1366 px, and a two-by-two grid of 44 px targets on a phone. The order is the order on screen.
export const HOME_ACTIONS: readonly HomeAction[] = [
  { id: 'uploadInvoice', to: '/o/$slug/inbox', icon: 'documents', module: 'finance' },
  { id: 'recordExpense', to: '/o/$slug/vouchers', search: { type: 'cash_payment' }, icon: 'vouchers', module: 'finance' },
  { id: 'createSalesInvoice', to: '/o/$slug/sales-invoices', icon: 'salesInvoices', module: 'finance' },
  { id: 'addCustomer', to: '/o/$slug/contacts', icon: 'contacts', module: 'crm' },
];

export const HOME_ACTIONS_MAX = 4;

// The actions this member sees: a viewer creates nothing, and an action of an app that is off is never shown.
export function homeActions(modules: readonly string[], role: 'owner' | 'admin' | 'member' | 'viewer' | undefined): HomeAction[] {
  if (!role || role === 'viewer') return [];
  return HOME_ACTIONS.filter((a) => modules.includes(a.module)).slice(0, HOME_ACTIONS_MAX);
}

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
