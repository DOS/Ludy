// SPDX-License-Identifier: AGPL-3.0-only
// The input of the Meetings MCP search over the published minutes (#4030): a trimmed query of 2 to 200 characters, a limit of 1 to 50 (default 10), and no other key.
import { describe, expect, it } from 'vitest';
import { MCP_SEARCH_DEFAULT, MCP_SEARCH_MAX, MCP_SEARCH_QUERY_MAX, zMcpSearchInput } from '../src/meetings.ts';

describe('zMcpSearchInput', () => {
  it('defaults the limit to 10 and trims the query', () => {
    expect(zMcpSearchInput.parse({ q: '  chiết khấu  ' })).toEqual({ q: 'chiết khấu', limit: MCP_SEARCH_DEFAULT });
    expect(MCP_SEARCH_DEFAULT).toBe(10);
  });

  it('takes a query of 2 to 200 characters after trimming', () => {
    expect(zMcpSearchInput.parse({ q: 'ab' }).q).toBe('ab');
    expect(zMcpSearchInput.parse({ q: 'x'.repeat(MCP_SEARCH_QUERY_MAX) }).q).toHaveLength(200);
    for (const q of ['', ' ', 'a', ' a ', 'x'.repeat(MCP_SEARCH_QUERY_MAX + 1), 5, null, undefined]) expect(zMcpSearchInput.safeParse({ q }).success, String(q)).toBe(false);
    expect(zMcpSearchInput.safeParse({}).success).toBe(false);
  });

  it('takes a limit of 1 to 50 and refuses a number outside it, a fraction and any other key', () => {
    expect(zMcpSearchInput.parse({ q: 'ab', limit: 1 }).limit).toBe(1);
    expect(zMcpSearchInput.parse({ q: 'ab', limit: MCP_SEARCH_MAX }).limit).toBe(50);
    for (const limit of [0, -1, 51, 1.5, '5', null]) expect(zMcpSearchInput.safeParse({ q: 'ab', limit }).success, String(limit)).toBe(false);
    for (const extra of [{ offset: 1 }, { meetingId: 'x' }, { days: 7 }, { orgId: 'x' }]) expect(zMcpSearchInput.safeParse({ q: 'ab', ...extra }).success, JSON.stringify(extra)).toBe(false);
  });
});
