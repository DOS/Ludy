// SPDX-License-Identifier: AGPL-3.0-only
// Pure unit tests for signObligationsTodayItemsOf, decimal contractValue validation, and urgency ranking (#3821).
import { describe, expect, it } from 'vitest';
import { TODAY_ITEMS_MAX, todayCoworkerKey } from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import {
  parseContractValueDecimal,
  signObligationsTodayItemsOf,
  summarizeObligationUrgency,
  type SignObligationTodayRow,
} from '../src/obligations.ts';

const ENV_A = '01900000-0000-7000-8000-00000000000a';
const ENV_B = '01900000-0000-7000-8000-00000000000b';
const USER_1 = '01900000-0000-7000-8000-000000000001';

describe('parseContractValueDecimal (#3821)', () => {
  it('preserves exact decimal strings via decimal.js and rejects floats, negatives, and >4dp or >16-int overflow', () => {
    expect(parseContractValueDecimal(null)).toBeNull();
    expect(parseContractValueDecimal('   ')).toBeNull();
    expect(parseContractValueDecimal('24000000')).toBe('24000000');
    expect(parseContractValueDecimal('1250.5000')).toBe('1250.5');
    expect(parseContractValueDecimal('9999999999999999.9999')).toBe('9999999999999999.9999');

    for (const bad of ['-1', '12.12345', '24,000,000', '1e6', '10000000000000000', 'NaN']) {
      expect(() => parseContractValueDecimal(bad), bad).toThrow(DomainError);
    }
  });
});

describe('signObligationsTodayItemsOf (#3821)', () => {
  const NOW = new Date('2026-11-21T03:00:00Z'); // 2026-11-21 in Asia/Ho_Chi_Minh

  it('attributes sign TodayItems to Vy (gm), excludes viewers, and surfaces renewal windows <= 30d and obligations <= 7d or overdue', () => {
    expect(todayCoworkerKey('sign')).toBe('gm');

    const rows: SignObligationTodayRow[] = [
      {
        envelopeId: ENV_A,
        sourceKind: 'standalone',
        createdBy: USER_1,
        expiryDate: '2026-12-25', // notice 30d -> noticeDate 2026-11-25 (4 days away, <= 30d!)
        renewalNoticeDays: 30,
        autoRenew: true,
        contractValue: '24000000',
        currency: 'VND',
        obligations: [
          {
            id: 'obl-overdue',
            title: 'Pay milestone 1',
            dueDate: '2026-11-18', // 3 days overdue
            status: 'pending',
            completedAt: null,
            pageNumber: 1,
            quoteExcerpt: null,
            proposedByAi: false,
          },
          {
            id: 'obl-done',
            title: 'Signed NDA',
            dueDate: '2026-11-10',
            status: 'completed', // completed -> never surfaced
            completedAt: '2026-11-10T00:00:00Z',
            pageNumber: null,
            quoteExcerpt: null,
            proposedByAi: false,
          },
          {
            id: 'obl-far',
            title: 'Annual review',
            dueDate: '2027-03-01', // > 7 days away -> not surfaced yet
            status: 'pending',
            completedAt: null,
            pageNumber: null,
            quoteExcerpt: null,
            proposedByAi: false,
          },
        ],
      },
      {
        envelopeId: ENV_B,
        sourceKind: 'crm_quote',
        createdBy: USER_1,
        expiryDate: '2026-12-01', // notice 15d -> noticeDate 2026-11-16 (already inside notice window, 10d until expiry)
        renewalNoticeDays: 15,
        autoRenew: false,
        contractValue: '1500.25',
        currency: 'USD',
        obligations: [
          {
            id: 'obl-soon',
            title: 'Deliver onboarding report',
            dueDate: '2026-11-25', // 4 days away (<= 7d)
            status: 'pending',
            completedAt: null,
            pageNumber: 2,
            quoteExcerpt: null,
            proposedByAi: true,
          },
        ],
      },
    ];

    expect(signObligationsTodayItemsOf(rows, { role: 'viewer', now: NOW })).toEqual([]);
    expect(signObligationsTodayItemsOf(rows, { role: null, now: NOW })).toEqual([]);

    const items = signObligationsTodayItemsOf(rows, { role: 'member', now: NOW });
    expect(items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, amount: i.amount, currency: i.currency }))).toEqual([
      {
        id: `obligation-item:${ENV_A}:obl-overdue`,
        kind: 'flag',
        title: { key: 'sign.obligationOverdueDays', params: { days: 3 } },
        amount: undefined,
        currency: undefined,
      },
      {
        id: `obligation-renewal:${ENV_B}`,
        kind: 'flag',
        title: { key: 'sign.obligationRenewalWindowOpen', params: { days: 10 } },
        amount: '1500.25',
        currency: 'USD',
      },
      {
        id: `obligation-item:${ENV_B}:obl-soon`,
        kind: 'deadline',
        title: { key: 'sign.obligationDueSoon', params: { days: 4 } },
        amount: undefined,
        currency: undefined,
      },
      {
        id: `obligation-renewal:${ENV_A}`,
        kind: 'deadline',
        title: { key: 'sign.obligationRenewalSoon', params: { days: 4 } },
        amount: '24000000',
        currency: 'VND',
      },
    ]);

    // Verify zero contract prose or counterparty names ever enter TodayItem title params.
    expect(JSON.stringify(items)).not.toContain('Pay milestone');
    expect(JSON.stringify(items)).not.toContain('Deliver onboarding');
  });

  it('caps items at TODAY_ITEMS_MAX with sign.obligationMore overflow item', () => {
    const many: SignObligationTodayRow[] = Array.from({ length: TODAY_ITEMS_MAX + 5 }, (_, idx) => ({
      envelopeId: `01900000-0000-7000-8000-${String(idx + 1).padStart(12, '0')}`,
      sourceKind: 'standalone',
      createdBy: USER_1,
      expiryDate: '2026-11-25',
      renewalNoticeDays: 10,
      autoRenew: false,
      contractValue: null,
      currency: 'VND',
      obligations: [],
    }));

    const items = signObligationsTodayItemsOf(many, { role: 'owner', now: NOW });
    expect(items).toHaveLength(TODAY_ITEMS_MAX);
    const tail = items[TODAY_ITEMS_MAX - 1];
    expect(tail).toMatchObject({
      id: 'obligations:more',
      kind: 'flag',
      app: 'sign',
      title: { key: 'sign.obligationMore', params: { count: 6 } },
      count: 6,
      href: '/sign/envelopes',
    });
  });

  it('ranks overdue obligations ahead of upcoming renewals in summarizeObligationUrgency', () => {
    const summary = summarizeObligationUrgency(
      {
        id: ENV_A,
        orgId: USER_1,
        envelopeId: ENV_A,
        status: 'confirmed',
        counterpartyName: 'Minh Anh',
        effectiveDate: '2026-01-01',
        expiryDate: '2026-12-15',
        renewalNoticeDays: 30,
        autoRenew: true,
        contractValue: '24000000',
        currency: 'VND',
        obligations: [
          {
            id: 'o1',
            title: 'Milestone 1',
            dueDate: '2026-11-15',
            status: 'pending',
            completedAt: null,
            pageNumber: null,
            quoteExcerpt: null,
            proposedByAi: false,
          },
        ],
        proposal: null,
        promptVersion: null,
        confirmedBy: USER_1,
        confirmedAt: '2026-11-01T00:00:00Z',
        createdBy: USER_1,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      },
      '2026-11-21',
    );
    expect(summary.renewalNoticeDate).toBe('2026-11-15');
    expect(summary.overdueObligationCount).toBe(1);
    expect(summary.pendingObligationCount).toBe(1);
    expect(summary.urgencyRank).toBe(0);
  });
});
