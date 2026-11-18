// SPDX-License-Identifier: AGPL-3.0-only
// What one `ludy_meeting_minutes` answer costs of the grant's daily row budget (#3731, N2 of the post-merge review of #3745): the meeting, plus one row per summary line, decision and action item.
import { describe, expect, it } from 'vitest';
import { minutesRows } from '../src/mcp-endpoint.ts';

describe('minutesRows', () => {
  it('charges the meeting, every summary line, every decision and every action item', () => {
    expect(minutesRows({ summaryLines: ['a', 'b', 'c'], decisions: ['d'], actions: [{}, {}] })).toBe(1 + 3 + 1 + 2);
  });

  it('charges one row for a meeting with nothing else, and ignores a field that is not a list', () => {
    expect(minutesRows({ summaryLines: [], decisions: [], actions: [] })).toBe(1);
    expect(minutesRows({ summaryLines: 'x', decisions: null, actions: undefined })).toBe(1);
    expect(minutesRows({})).toBe(1);
  });

  it('charges the longest summary the query can return (80 lines) in full', () => {
    expect(minutesRows({ summaryLines: Array.from({ length: 80 }, () => 'x'), decisions: [], actions: [] })).toBe(81);
  });
});
