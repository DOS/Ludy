// SPDX-License-Identifier: AGPL-3.0-only
// Query registration gates for memberVy declarations outside kernel.member_vy.* (#5073).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Runtime, defineQuery } from '../../src/runtime.ts';

const noopCells = {} as never;

describe('QueryDef.memberVy registration rules', () => {
  it('allows non-kernel.member_vy.* queries with role-list access while rejecting system, streamed, and MCP queries', () => {
    const rt = new Runtime(noopCells, { manifests: [] });
    expect(() =>
      rt.register({
        queries: [
          defineQuery({
            name: 'meetings.brief.facts',
            input: z.object({}),
            access: ['owner', 'admin', 'member'],
            memberVy: { reads: ['crm.deal.get'] },
            handler: async () => ({}),
          }),
          defineQuery({
            name: 'crm.deal.get',
            input: z.object({}),
            access: ['owner', 'admin', 'member'],
            memberVy: { reads: [] },
            handler: async () => ({}),
          }),
        ],
      }),
    ).not.toThrow();

    expect(() =>
      new Runtime(noopCells, { manifests: [] }).register({
        queries: [
          defineQuery({
            name: 'meetings.brief.sys',
            input: z.object({}),
            access: 'system',
            memberVy: { reads: [] },
            handler: async () => ({}),
          }),
        ],
      }),
    ).toThrow(/role list/);

    expect(() =>
      new Runtime(noopCells, { manifests: [] }).register({
        queries: [
          defineQuery({
            name: 'meetings.brief.streamed',
            input: z.object({}),
            access: ['owner'],
            stream: true,
            memberVy: { reads: [] },
            handler: async () => ({}),
          }),
        ],
      }),
    ).toThrow(/streamed/);

    expect(() =>
      new Runtime(noopCells, { manifests: [] }).register({
        queries: [
          defineQuery({
            name: 'crm.deal.mcp',
            input: z.object({}),
            access: ['owner', 'admin'],
            mcp: { scope: 'ludy.read' },
            memberVy: { reads: [] },
            handler: async () => ({}),
          }),
        ],
      }),
    ).toThrow(/MCP grant/);
  });
});
