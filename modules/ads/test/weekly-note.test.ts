// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's deterministic weekly comparison note (#2220): side-by-side platform breakdown (Meta, Google, sandbox),
// spend change, cost-per-result change, and the campaign that moved the most across connected platforms, per currency.
import { describe, expect, it } from 'vitest';
import { evaluateWeeklyNotes, type WeeklyNoteInput } from '../src/weekly-note.ts';

describe('evaluateWeeklyNotes', () => {
  const now = new Date('2026-11-15T05:00:00Z'); // 2026-11-15 in Asia/Ho_Chi_Minh; yesterday is 2026-11-14

  it('compares the last 7 completed days against the 7 days before side by side across Meta and Google, and names the top-moving campaign', () => {
    const input: WeeklyNoteInput = {
      accounts: [
        {
          id: '0190c4a1-0000-7000-8000-000000000001',
          name: 'Meta Cửa hàng',
          provider: 'meta_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: 'purchase',
          syncedThrough: '2026-11-14',
        },
        {
          id: '0190c4a1-0000-7000-8000-000000000002',
          name: 'Google Tìm kiếm',
          provider: 'google_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: 'conversion',
          syncedThrough: '2026-11-14',
        },
      ],
      accountDays: [
        // Prior 7 days: 2026-11-01 .. 2026-11-07
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', day: '2026-11-03', spend: '1000000', results: '10' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', day: '2026-11-04', spend: '2000000', results: '20' },
        // Recent 7 days: 2026-11-08 .. 2026-11-14
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', day: '2026-11-10', spend: '1500000', results: '10' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', day: '2026-11-12', spend: '1200000', results: '15' },
        // Today (2026-11-15) is still in flight and must not be counted
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', day: '2026-11-15', spend: '9999999', results: '50' },
      ],
      campaignDays: [
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', campaignId: 'm-1', campaignName: 'Thu Đông Meta', day: '2026-11-03', spend: '1000000' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', campaignId: 'm-1', campaignName: 'Thu Đông Meta', day: '2026-11-10', spend: '1500000' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', campaignId: 'g-1', campaignName: 'Brand Search', day: '2026-11-04', spend: '2000000' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', campaignId: 'g-1', campaignName: 'Brand Search VN', day: '2026-11-12', spend: '1200000' },
      ],
    };

    const notes = evaluateWeeklyNotes(input, now);
    expect(notes).toEqual([
      {
        currency: 'VND',
        recentFrom: '2026-11-08',
        recentTo: '2026-11-14',
        priorFrom: '2026-11-01',
        priorTo: '2026-11-07',
        recentSpend: '2700000',
        priorSpend: '3000000',
        spendDelta: '-300000',
        platforms: [
          {
            provider: 'meta_ads',
            accountCount: 1,
            recentSpend: '1500000',
            priorSpend: '1000000',
            spendDelta: '500000',
            resultKind: 'purchase',
            recentResults: '10',
            priorResults: '10',
            recentCostPerResult: '150000',
            priorCostPerResult: '100000',
            cprDelta: '50000',
          },
          {
            provider: 'google_ads',
            accountCount: 1,
            recentSpend: '1200000',
            priorSpend: '2000000',
            spendDelta: '-800000',
            resultKind: 'conversion',
            recentResults: '15',
            priorResults: '20',
            recentCostPerResult: '80000',
            priorCostPerResult: '100000',
            cprDelta: '-20000',
          },
        ],
        topMover: {
          adAccountId: '0190c4a1-0000-7000-8000-000000000002',
          accountName: 'Google Tìm kiếm',
          provider: 'google_ads',
          externalObjectId: 'g-1',
          campaignName: 'Brand Search VN',
          recentSpend: '1200000',
          priorSpend: '2000000',
          spendDelta: '-800000',
        },
        skippedAccounts: 0,
      },
    ]);
  });

  it('never mixes currencies and leaves out accounts not yet synced through yesterday', () => {
    const input: WeeklyNoteInput = {
      accounts: [
        {
          id: '0190c4a1-0000-7000-8000-000000000001',
          name: 'Meta VND',
          provider: 'meta_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: 'purchase',
          syncedThrough: '2026-11-14',
        },
        {
          id: '0190c4a1-0000-7000-8000-000000000002',
          name: 'Google VND (lagging)',
          provider: 'google_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: 'conversion',
          syncedThrough: '2026-11-12',
        },
        {
          id: '0190c4a1-0000-7000-8000-000000000003',
          name: 'Google USD',
          provider: 'google_ads',
          currency: 'USD',
          timeZone: 'UTC',
          resultKind: 'conversion',
          syncedThrough: '2026-11-14',
        },
      ],
      accountDays: [
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', day: '2026-11-10', spend: '500000', results: '5' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', day: '2026-11-10', spend: '900000', results: '9' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000003', day: '2026-11-04', spend: '100.00', results: '4' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000003', day: '2026-11-11', spend: '125.50', results: '5' },
      ],
      campaignDays: [],
    };

    const notes = evaluateWeeklyNotes(input, now);
    expect(notes.map((n) => ({ currency: n.currency, recentSpend: n.recentSpend, skipped: n.skippedAccounts }))).toEqual([
      { currency: 'USD', recentSpend: '125.50', skipped: 0 },
      { currency: 'VND', recentSpend: '500000', skipped: 1 },
    ]);
    expect(notes[0]?.platforms[0]).toMatchObject({
      provider: 'google_ads',
      recentCostPerResult: '25.10',
      priorCostPerResult: '25.00',
      cprDelta: '0.10',
    });
  });

  it('omits platform CPR when two accounts on the same platform and currency use different result kinds', () => {
    const input: WeeklyNoteInput = {
      accounts: [
        {
          id: '0190c4a1-0000-7000-8000-000000000001',
          name: 'Google A',
          provider: 'google_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: 'conversion',
          syncedThrough: '2026-11-14',
        },
        {
          id: '0190c4a1-0000-7000-8000-000000000002',
          name: 'Google B',
          provider: 'google_ads',
          currency: 'VND',
          timeZone: 'Asia/Ho_Chi_Minh',
          resultKind: null,
          syncedThrough: '2026-11-14',
        },
      ],
      accountDays: [
        { adAccountId: '0190c4a1-0000-7000-8000-000000000001', day: '2026-11-10', spend: '400000', results: '4' },
        { adAccountId: '0190c4a1-0000-7000-8000-000000000002', day: '2026-11-10', spend: '600000', results: null },
      ],
      campaignDays: [],
    };

    const [note] = evaluateWeeklyNotes(input, now);
    expect(note?.platforms[0]).toMatchObject({
      provider: 'google_ads',
      accountCount: 2,
      recentSpend: '1000000',
      resultKind: null,
      recentCostPerResult: null,
      priorCostPerResult: null,
      cprDelta: null,
    });
  });
});
