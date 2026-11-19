// SPDX-License-Identifier: AGPL-3.0-only
// The input of the Meetings MCP read of published decisions (#4016): a window of exactly 7, 14 or 30 days (default 14), a limit of 1 to 100 (default 50), and no other key, so a client cannot widen what it reads.
import { describe, expect, it } from 'vitest';
import { MCP_DECISIONS_DAYS, MCP_OPEN_ACTIONS_DEFAULT, MCP_OPEN_ACTIONS_MAX, zMcpDecisionsInput } from '../src/meetings.ts';

describe('zMcpDecisionsInput', () => {
  it('defaults to 14 days and 50 decisions', () => {
    expect(zMcpDecisionsInput.parse({})).toEqual({ days: 14, limit: MCP_OPEN_ACTIONS_DEFAULT });
    expect(MCP_OPEN_ACTIONS_DEFAULT).toBe(50);
  });

  it('takes a window of 7, 14 or 30 days and nothing else', () => {
    for (const days of MCP_DECISIONS_DAYS) expect(zMcpDecisionsInput.parse({ days }).days).toBe(days);
    for (const days of [0, 1, 6, 8, 13, 31, 90, -7, 7.5, '7', null]) expect(zMcpDecisionsInput.safeParse({ days }).success, String(days)).toBe(false);
  });

  it('takes a limit of 1 to 100 and refuses a whole number outside it, a fraction and other keys', () => {
    expect(zMcpDecisionsInput.parse({ limit: 1 }).limit).toBe(1);
    expect(zMcpDecisionsInput.parse({ limit: MCP_OPEN_ACTIONS_MAX }).limit).toBe(100);
    for (const limit of [0, -1, 101, 1.5, '5', null]) expect(zMcpDecisionsInput.safeParse({ limit }).success, String(limit)).toBe(false);
    for (const extra of [{ orgId: 'x' }, { meetingId: 'x' }, { from: '2026-01-01T00:00:00Z' }, { seriesId: 'x' }]) expect(zMcpDecisionsInput.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
  });

  it('advertises the three windows as a list of numbers to the client', async () => {
    const { z } = await import('zod');
    const schema = z.toJSONSchema(zMcpDecisionsInput, { io: 'input' }) as { properties: { days: { enum?: number[]; anyOf?: Array<{ const: number }> } } };
    const days = schema.properties.days;
    const offered = days.enum ?? (days.anyOf ?? []).map((a) => a.const);
    expect([...offered].sort((a, b) => a - b)).toEqual([7, 14, 30]);
  });
});
