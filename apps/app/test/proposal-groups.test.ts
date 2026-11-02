// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { GROUP_MIN_SIZE, cleanGroups, isCleanPurchase, type GroupableItem } from '../src/lib/proposal-groups.ts';

const REVERSAL = 'kernel.journal.reversal';
const RULE_A = '01a19ca6-19cb-7247-9f55-7e37f6b02e03';
const RULE_B = '01a19ca6-19cb-7247-9f55-7e37f6b02e04';

const item = (id: string, change: Partial<GroupableItem> = {}): GroupableItem => ({
  id,
  kind: 'finance.purchase.record',
  status: 'pending',
  direction: 'purchase',
  failedChecks: 0,
  warnChecks: 0,
  duplicateOf: null,
  unclassifiedLines: 0,
  signatureStatus: 'verified',
  requestedByAgent: null,
  sellerName: 'Công ty Điện lực',
  total: '1000000',
  learnedRuleIds: [RULE_A],
  otherRuleLines: 0,
  ...change,
});

describe('which proposals are clean', () => {
  it('takes a pending purchase with no failed or warning check, a verified or no signature and no agent behind it', () => {
    expect(isCleanPurchase(item('a'), REVERSAL)).toBe(true);
    expect(isCleanPurchase(item('a', { signatureStatus: null }), REVERSAL)).toBe(true);
  });

  it('leaves out a warning, a failure, an unverified signature, a duplicate, a sale, an agent, a line without account and a decided one', () => {
    for (const change of [
      { warnChecks: 1 },
      { failedChecks: 1 },
      { signatureStatus: 'unverified' },
      { duplicateOf: 'b' },
      { direction: 'sale' as const },
      { requestedByAgent: { id: 'x' } },
      { unclassifiedLines: 1 },
      { status: 'executed' },
    ]) {
      expect(isCleanPurchase(item('a', change), REVERSAL), JSON.stringify(change)).toBe(false);
    }
  });
});

describe('cleanGroups', () => {
  it('groups clean proposals by vendor and by the same learned rules, with the exact total, the largest group first', () => {
    const groups = cleanGroups(
      [
        item('1'),
        item('2', { total: '2500000.5', otherRuleLines: 1 }),
        item('3', { learnedRuleIds: [RULE_B] }),
        item('4', { learnedRuleIds: [RULE_B] }),
        item('5', { learnedRuleIds: [RULE_B], sellerName: ' công ty điện lực ' }),
        item('6', { sellerName: 'Nhà cung cấp khác', learnedRuleIds: [] }),
      ],
      REVERSAL,
    );
    expect(groups.map((g) => [g.items.map((i) => i.id), g.ruleIds, g.total, g.otherLines])).toEqual([
      [['3', '4', '5'], [RULE_B], '3000000', 0],
      [['1', '2'], [RULE_A], '3500000.5', 1],
    ]);
  });

  it('never puts a proposal with a warning in a group, even beside clean ones of the same vendor and rule', () => {
    const groups = cleanGroups([item('1'), item('2'), item('3', { warnChecks: 1 })], REVERSAL);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(cleanGroups([item('1'), item('3', { warnChecks: 1 })], REVERSAL)).toEqual([]);
  });

  it('keeps proposals with no learned rule together under the vendor, and does not group a single proposal', () => {
    const none = { learnedRuleIds: [], otherRuleLines: 2 };
    const groups = cleanGroups([item('1', none), item('2', none), item('3', { learnedRuleIds: [RULE_A, RULE_B] })], REVERSAL);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ruleIds: [], otherLines: 4 });
    expect(GROUP_MIN_SIZE).toBe(2);
  });

  it('keys a group by the set of rules whatever their order, and skips a proposal with no vendor name', () => {
    const groups = cleanGroups(
      [item('1', { learnedRuleIds: [RULE_B, RULE_A] }), item('2', { learnedRuleIds: [RULE_A, RULE_B] }), item('3', { sellerName: null }), item('4', { sellerName: '  ' })],
      REVERSAL,
    );
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['1', '2']]);
  });
});
