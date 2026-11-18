// SPDX-License-Identifier: AGPL-3.0-only
// The correction panel's handling of the coworker's reason answer (#3690): the select is filled only with a code it holds, and the button turns off once the model is off or the budget is spent.
import { describe, expect, it } from 'vitest';
import type { EInvoiceReasonSuggested } from '@crove/kernel-contract';
import { reasonButtonOff, reasonFill } from '../src/lib/einvoice-reason.ts';

const HELD = [{ code: 'T-1' }, { code: 'T-2' }];
const answer = (over: Partial<EInvoiceReasonSuggested> = {}): EInvoiceReasonSuggested => ({ ai: 'used', code: 'T-2', label: 'Sai số lượng', why: 'Mô tả nói sai số lượng.', ...over });

describe('reasonFill', () => {
  it('fills the code and the why of a used answer whose code the select holds', () => {
    expect(reasonFill(answer(), HELD)).toEqual({ code: 'T-2', why: 'Mô tả nói sai số lượng.' });
  });
  it('fills nothing for a code the select does not hold, whatever the state says', () => {
    expect(reasonFill(answer({ code: 'T-9' }), HELD)).toBeNull();
    expect(reasonFill(answer({ code: 'T-2' }), [])).toBeNull();
  });
  it('fills nothing for any answer that is not used, or has no code or why', () => {
    for (const ai of ['no_list', 'no_note', 'off', 'busy', 'budget', 'failed', 'refused'] as const) expect(reasonFill(answer({ ai }), HELD)).toBeNull();
    expect(reasonFill(answer({ code: null }), HELD)).toBeNull();
    expect(reasonFill(answer({ why: null }), HELD)).toBeNull();
  });
});

describe('reasonButtonOff', () => {
  it('is on once something is described and nothing is running', () => {
    expect(reasonButtonOff({ note: 'ghi sai địa chỉ', pending: false, last: null })).toBe(false);
    for (const last of ['used', 'busy', 'failed', 'refused', 'no_list', 'no_note'] as const) expect(reasonButtonOff({ note: 'x', pending: false, last })).toBe(false);
  });
  it('is off with no note, while a call runs, and after an answer that said off or budget', () => {
    expect(reasonButtonOff({ note: '   ', pending: false, last: null })).toBe(true);
    expect(reasonButtonOff({ note: 'x', pending: true, last: null })).toBe(true);
    expect(reasonButtonOff({ note: 'x', pending: false, last: 'off' })).toBe(true);
    expect(reasonButtonOff({ note: 'x', pending: false, last: 'budget' })).toBe(true);
  });
});
