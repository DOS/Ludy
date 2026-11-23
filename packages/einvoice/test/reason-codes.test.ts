// SPDX-License-Identifier: AGPL-3.0-only
// The reason codes of an adjusting or replacing invoice are one data file with its source and date (#3571): every code has a label, none is repeated, and a missing or unknown code is not one.
import { describe, expect, it } from 'vitest';
import { ADJUST_REPLACE_REASON_CODES, isReasonCode } from '../src/index.ts';

describe('the reason code list', () => {
  it('names its source, says it is a draft and records when it was read (null until it is)', () => {
    const { source } = ADJUST_REPLACE_REASON_CODES;
    expect(source.url).toContain('developer.misa.vn');
    expect(source.status).toBe('draft');
    expect(source.retrievedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(source.retrievedAt)).toBe(true);
  });

  it('gives every code a code and a Vietnamese label, and no code twice', () => {
    const { codes, source } = ADJUST_REPLACE_REASON_CODES;
    for (const c of codes) {
      expect(c.code.trim(), 'code').not.toBe('');
      expect(c.label.trim(), `label of ${c.code}`).not.toBe('');
    }
    expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);
    // A list that has codes says when it was read.
    if (codes.length > 0) expect(source.retrievedAt).not.toBeNull();
  });

  it('knows a code only when it is in the list given', () => {
    const list = [{ code: 'TEST-1', label: 'Mã thử nghiệm' }];
    expect(isReasonCode('TEST-1', list)).toBe(true);
    for (const bad of ['', 'test-1', ' TEST-1', 'TEST-2', null, undefined]) expect(isReasonCode(bad, list), String(bad)).toBe(false);
    // The shipped list is empty until it is read from MISA's guide, so nothing is a code yet.
    expect(isReasonCode('TEST-1')).toBe(false);
  });
});
