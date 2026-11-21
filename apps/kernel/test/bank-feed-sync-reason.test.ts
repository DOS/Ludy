// SPDX-License-Identifier: AGPL-3.0-only
// Why a bank feed pull stopped (#4244): a failure becomes a closed kind and, for a page with a line it cannot store, that
// line's position. The error's own text never leaves the classifier.
import { describe, expect, it } from 'vitest';
import { TingeeError } from '@crove/bank-feed';
import { DomainError } from '@crove/kernel-runtime';
import { classifyBankFeedFailure } from '../src/bank-feed-sync.ts';

describe('classifyBankFeedFailure', () => {
  it.each(['credentials', 'clock', 'rate_limited', 'upstream', 'config', 'too_many_lines'] as const)('keeps the adapter kind %s and nothing else', (kind) => {
    expect(classifyBankFeedFailure(new TingeeError(kind, 'text that must not travel', '97'))).toEqual({ kind });
  });

  it('keeps the position of a line the adapter could not read', () => {
    expect(classifyBankFeedFailure(new TingeeError('bad_page', 'x', null, 4))).toEqual({ kind: 'bad_page', item: 4 });
    expect(classifyBankFeedFailure(new TingeeError('bad_page', 'x'))).toEqual({ kind: 'bad_page' });
  });

  it('takes the runtime refusing the page input as a page it cannot store', () => {
    expect(classifyBankFeedFailure(new DomainError('VALIDATION', 422, 'lines.3.amount: invalid'))).toEqual({ kind: 'bad_page' });
  });

  it('takes the stricter reading of a page lines as a page it cannot store too', () => {
    expect(classifyBankFeedFailure(new DomainError('BANK_FEED_INVALID', 422, 'bad line'))).toEqual({ kind: 'bad_page' });
  });

  it('takes anything else as an answer that was not understood', () => {
    expect(classifyBankFeedFailure(new Error('ECONNRESET'))).toEqual({ kind: 'upstream' });
    expect(classifyBankFeedFailure('boom')).toEqual({ kind: 'upstream' });
    expect(classifyBankFeedFailure(new DomainError('BANK_FEED_CURSOR_MOVED', 409, 'moved'))).toEqual({ kind: 'upstream' });
  });
});
