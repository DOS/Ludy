// SPDX-License-Identifier: AGPL-3.0-only
// Clean purchase proposals grouped by vendor and by the learned rules that set their accounts (issue #2379), so an
// approver reads a vendor's usual invoices once and approves them together through the bulk approval (#315). The
// grouping only reads what kernel.inbox.list says; the server still checks every proposal by itself when it is approved.
import { bulkSelectable } from './review.ts';
import { fromUnits, toUnits } from './decimal.ts';

// The fields of an Inbox item the grouping reads.
export interface GroupableItem {
  id: string;
  kind: string;
  status: string;
  direction: 'purchase' | 'sale' | null;
  failedChecks: number;
  warnChecks: number;
  duplicateOf: string | null;
  unclassifiedLines?: number;
  signatureStatus: string | null;
  requestedByAgent: unknown;
  sellerName: string | null;
  total: string | null;
  learnedRuleIds?: readonly string[];
  otherRuleLines?: number;
}

// The fewest proposals that make a group: one alone is approved as any other.
export const GROUP_MIN_SIZE = 2;
// A learned rule people corrected this many times or more is shown as one to look at.
export const RULE_OFTEN_CORRECTED = 2;

// A proposal a group may hold: a pending purchase that can be approved in bulk with no check at all besides the passes
// (no failed or warning check, which includes an unverified signature and every anomaly flag), no line waiting for an
// account, and not one an AI agent asked for (its output is tainted: a person reads it one by one).
export function isCleanPurchase(item: GroupableItem, reversalKind: string): boolean {
  return (
    item.direction === 'purchase' &&
    bulkSelectable(item, reversalKind) &&
    item.warnChecks === 0 &&
    item.signatureStatus !== 'unverified' &&
    item.requestedByAgent === null
  );
}

export interface ProposalGroup<T extends GroupableItem> {
  key: string;
  vendor: string;
  items: T[];
  // The sum of the invoices' totals, exact; proposals with no total are left out of it.
  total: string;
  // The learned rules behind the group's accounts, and how many lines in all had none (a built-in keyword, the vendor's
  // default or a person's pick).
  ruleIds: string[];
  otherLines: number;
}

// The groups of at least GROUP_MIN_SIZE clean proposals sharing a vendor (by name, as the Inbox shows it) and the same
// set of learned rules, the largest first.
export function cleanGroups<T extends GroupableItem>(items: readonly T[], reversalKind: string): ProposalGroup<T>[] {
  const groups = new Map<string, ProposalGroup<T>>();
  for (const item of items) {
    if (!isCleanPurchase(item, reversalKind)) continue;
    const vendor = (item.sellerName ?? '').trim();
    if (vendor === '') continue;
    const ruleIds = [...new Set(item.learnedRuleIds ?? [])].sort();
    const key = `${vendor.toLowerCase()}|${ruleIds.join(',')}`;
    const group = groups.get(key) ?? { key, vendor, items: [], total: '0', ruleIds, otherLines: 0 };
    group.items.push(item);
    group.otherLines += item.otherRuleLines ?? 0;
    if (item.total !== null) group.total = fromUnits(toUnits(group.total) + toUnits(item.total));
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.items.length >= GROUP_MIN_SIZE).sort((a, b) => b.items.length - a.items.length || a.vendor.localeCompare(b.vendor));
}
