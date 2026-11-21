// SPDX-License-Identifier: AGPL-3.0-only
// The digit runs of a bank account as it is compared (#2426): digits joined by one space, dot or dash are one run, anything else ends it, and a run counts from six digits.
import { describe, expect, it } from 'vitest';
import { bankAccountRuns } from '../src/bank-account.ts';

describe('bankAccountRuns', () => {
  it('joins digits split by one space, dot or dash and keeps runs of six or more', () => {
    expect(bankAccountRuns('0011 2233 4455')).toEqual(['001122334455']);
    expect(bankAccountRuns('TK: 0011-2233.4455 (VCB) CN Hà Nội')).toEqual(['001122334455']);
    expect(bankAccountRuns('0987654321, 001122334455')).toEqual(['0987654321', '001122334455']);
    expect(bankAccountRuns('001122334455 001122334455')).toEqual(['001122334455001122334455']);
  });

  it('is empty for text with no account: short codes, bank names, notes', () => {
    expect(bankAccountRuns('0011 (VCB)')).toEqual([]);
    expect(bankAccountRuns('N/A')).toEqual([]);
    expect(bankAccountRuns('12345')).toEqual([]);
    expect(bankAccountRuns('')).toEqual([]);
  });

  it('does not join across a note, a line break or a letter', () => {
    expect(bankAccountRuns('001122334455 - 012')).toEqual(['001122334455']);
    expect(bankAccountRuns('STK 001122334455 - 2026')).toEqual(['001122334455']);
    expect(bankAccountRuns('001122334455\n1 Dịch vụ')).toEqual(['001122334455']);
    expect(bankAccountRuns('0011AB2233')).toEqual([]);
  });
});
