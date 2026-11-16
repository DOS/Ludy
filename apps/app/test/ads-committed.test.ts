// SPDX-License-Identifier: AGPL-3.0-only
// What the committed-spend line says for the server's figures (#3297): no cap at all, the account's line with the org's only when it adds something, and a room
// below zero shown as the amount over the cap. Only the sign of a decimal string is read on the client; no amount is computed here.
import { describe, expect, it } from 'vitest';
import type { AdsCommitted } from '@crove/kernel-contract';
import { committedView, isBelowZero } from '../src/lib/ads-committed.ts';

const line = (over: Partial<AdsCommitted['org']> = {}): AdsCommitted['org'] => ({ committed: '700000', cap: null, left: null, ...over });
const data = (over: Partial<AdsCommitted> = {}): AdsCommitted => ({ adAccountId: 'a1', month: '2026-11', currency: 'VND', hasCap: true, capCurrencyMismatch: false, account: line(), org: line(), ...over });

describe('isBelowZero', () => {
  it('reads the sign, and not "-0.00"', () => {
    expect(isBelowZero('-200000')).toBe(true);
    expect(isBelowZero('-0.01')).toBe(true);
    expect(isBelowZero('0')).toBe(false);
    expect(isBelowZero('-0.00')).toBe(false);
    expect(isBelowZero('300000')).toBe(false);
  });
});

describe('committedView', () => {
  it('is the no-cap state when no cap is in force', () => {
    expect(committedView(data({ hasCap: false, account: line({ committed: '0' }) }))).toEqual({ kind: 'noCap', committed: '0' });
  });

  it('says the currency is wrong, not that a cap is missing, when a cap is in another currency', () => {
    expect(committedView(data({ hasCap: false, capCurrencyMismatch: true }))).toEqual({ kind: 'capCurrency', committed: '700000' });
    expect(committedView(data({ hasCap: true, capCurrencyMismatch: true, account: line({ cap: '1000000', left: '300000' }) })).kind).toBe('capCurrency');
  });

  it('draws the account line alone when the org adds nothing', () => {
    expect(committedView(data({ account: line({ cap: '1000000', left: '300000' }), org: line({ cap: null }) }))).toEqual({
      kind: 'rows',
      rows: [{ scope: 'account', committed: '700000', cap: '1000000', left: '300000', over: null }],
    });
  });

  it('adds the org line for an org cap or for other accounts\' launches, and turns a negative room into the amount over', () => {
    const view = committedView(data({ org: line({ committed: '910000', cap: '900000', left: '-10000' }) }));
    expect(view).toEqual({
      kind: 'rows',
      rows: [
        { scope: 'account', committed: '700000', cap: null, left: null, over: null },
        { scope: 'org', committed: '910000', cap: '900000', left: null, over: '10000' },
      ],
    });
  });
});
