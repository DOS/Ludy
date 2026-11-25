// SPDX-License-Identifier: AGPL-3.0-only
// The source tag and the coworkers' current names (UI/UX P2-1, #4782): the tag comes only from what a proposal recorded, and a
// rename of an org-chart agent is the name the surfaces show, by the same rule as the server's `coworkerNames`.
import { describe, expect, it, vi } from 'vitest';
import { bankMatchTag } from '../src/lib/proposal-source.ts';

// coworker-names.ts imports the API client for its hook; the pure function under test needs no network.
vi.mock('../src/lib/api.ts', () => ({ orpc: {} }));

const { DEFAULT_COWORKER_NAMES, coworkerNamesFrom } = await import('../src/lib/coworker-names.ts');

describe('bankMatchTag', () => {
  it('tags only what the matcher recorded, in four plain words', () => {
    expect(bankMatchTag({ kind: 'suggested', reason: 'tax_code' })).toBe('exact');
    expect(bankMatchTag({ kind: 'suggested', reason: 'invoice' })).toBe('exact');
    expect(bankMatchTag({ kind: 'suggested', reason: 'learned' })).toBe('rule');
    expect(bankMatchTag({ kind: 'suggested', reason: 'account' })).toBe('history');
  });

  it('shows no tag for a looser hint, a hand-picked party, or a voucher that recorded no match', () => {
    expect(bankMatchTag({ kind: 'suggested', reason: 'name' })).toBeNull();
    expect(bankMatchTag({ kind: 'suggested', reason: 'balance' })).toBeNull();
    expect(bankMatchTag({ kind: 'suggested' })).toBeNull();
    expect(bankMatchTag({ kind: 'manual', reason: 'learned' })).toBeNull();
    expect(bankMatchTag(undefined)).toBeNull();
    expect(bankMatchTag(null)).toBeNull();
  });
});

describe('coworkerNamesFrom', () => {
  const modules = new Map([
    ['finance.bookkeeper', 'finance'],
    ['hr.assistant', 'hr'],
    ['crm.sales', 'crm'],
    ['social.writer', 'social'],
  ]);

  it('is the roster until an org renames an agent', () => {
    expect(coworkerNamesFrom([], modules)).toEqual(DEFAULT_COWORKER_NAMES);
    expect(DEFAULT_COWORKER_NAMES).toEqual({ gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' });
  });

  it('takes the display name of the oldest agent that is not retired, per coworker, and leaves Vy alone', () => {
    const names = coworkerNamesFrom(
      [
        { templateKey: 'finance.bookkeeper', displayName: 'Lan', status: 'retired' },
        { templateKey: 'hr.assistant', displayName: 'Mai', status: 'active' },
        { templateKey: 'finance.bookkeeper', displayName: 'Hoa', status: 'active' },
        { templateKey: 'crm.sales', displayName: ' Bảo ', status: 'active' },
        { templateKey: 'unknown.template', displayName: 'Ghost', status: 'active' },
      ],
      modules,
    );
    // HR is covered by the finance coworker (Ly): the oldest active one speaks for it.
    expect(names).toEqual({ gm: 'Vy', finance: 'Mai', sales: 'Bảo', marketing: 'Uy' });
  });
});
