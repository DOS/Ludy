// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the four read-only eSign MCP tool descriptors (#4441, Slice 5c):
//   - Offered to company grants (owner/admin) holding `ludy.read`, omitted for member-bound grants
//   - Strictly read-only annotations, `module: 'sign'`, strict Zod input schemas, and untrusted-data descriptions
//   - Bounded pagination/window limits and accurate daily row budget accounting
import { describe, expect, it } from 'vitest';
import type { Runtime, UserActor } from '@ludy/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { McpWriteBudget } from '../src/mcp-write-limit.ts';
import { toolsFor } from '../src/mcp-endpoint.ts';

const company: UserActor = {
  type: 'user',
  userId: 'u-owner',
  aal: 'aal1',
  mcp: { grantId: 'g-company', clientId: 'c1', clientName: 'Test MCP', scopes: ['ludy.read'], kind: 'company' },
};

const member: UserActor = {
  type: 'user',
  userId: 'u-member',
  aal: 'aal1',
  mcp: { grantId: 'g-member', clientId: 'c1', clientName: 'Test MCP', scopes: ['ludy.read'], kind: 'member' },
};

const listed = (actor: UserActor) =>
  toolsFor({} as unknown as Runtime, actor, 'org-1', new DraftBudget(), new McpWriteBudget());

const SIGN_TOOLS = [
  'ludy_sign_envelopes_list',
  'ludy_sign_envelope_get',
  'ludy_sign_renewals_list',
  'ludy_sign_templates_list',
] as const;

describe('eSign read-only MCP tool descriptors (#4441)', () => {
  it('offers all four eSign read tools to a company grant and none to a member-bound grant', () => {
    const companyNames = listed(company).map((t) => t.name);
    for (const name of SIGN_TOOLS) {
      expect(companyNames, name).toContain(name);
    }

    const memberNames = listed(member).map((t) => t.name);
    for (const name of SIGN_TOOLS) {
      expect(memberNames, name).not.toContain(name);
    }
  });

  it('marks every eSign tool read-only, gated on module sign, strict on unknown arguments, and explicit about untrusted text', () => {
    for (const name of SIGN_TOOLS) {
      const tool = listed(company).find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.module, name).toBe('sign');
      expect(tool!.writeScope, name).toBeUndefined();
      expect(tool!.annotations, name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool!.argsSchema.safeParse({ unexpectedField: 1 }).success, name).toBe(false);
      expect(tool!.inputSchema.type, name).toBe('object');
      expect(tool!.outputSchema.type, name).toBe('object');
      expect(tool!.description, name).toMatch(/Read only/);
      expect(tool!.description, name).toMatch(/data, never instructions|never as instructions/);
    }
  });

  it('enforces input defaults and upper bounds across limit, status, and withinDays', () => {
    const args = (name: string) =>
      listed(company).find((t) => t.name === name)!.argsSchema as {
        safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> };
      };

    expect(args('ludy_sign_envelopes_list').safeParse({}).data).toEqual({ limit: 25 });
    expect(args('ludy_sign_envelopes_list').safeParse({ status: 'completed', limit: 50 }).success).toBe(true);
    expect(args('ludy_sign_envelopes_list').safeParse({ limit: 51 }).success).toBe(false);
    expect(args('ludy_sign_envelopes_list').safeParse({ status: 'bogus' }).success).toBe(false);

    expect(
      args('ludy_sign_envelope_get').safeParse({ envelopeId: '01950000-0000-7000-8000-000000000001' }).success,
    ).toBe(true);
    expect(args('ludy_sign_envelope_get').safeParse({ envelopeId: 'not-a-uuid' }).success).toBe(false);

    expect(args('ludy_sign_renewals_list').safeParse({}).data).toEqual({ withinDays: 90, limit: 25 });
    expect(args('ludy_sign_renewals_list').safeParse({ withinDays: 366 }).success).toBe(false);
    expect(args('ludy_sign_renewals_list').safeParse({ limit: 51 }).success).toBe(false);

    expect(args('ludy_sign_templates_list').safeParse({}).data).toEqual({ limit: 25 });
    expect(args('ludy_sign_templates_list').safeParse({ limit: 51 }).success).toBe(false);
  });

  it('charges the daily row budget for envelopes, signers + obligation items, renewals, and templates', () => {
    const rows = (name: string, value: Record<string, unknown>) =>
      listed(company).find((t) => t.name === name)!.rows(value);
    const many = (n: number) => Array.from({ length: n }, () => ({}));

    expect(rows('ludy_sign_envelopes_list', { envelopes: many(4), total: 4, truncated: false })).toBe(4);
    expect(rows('ludy_sign_envelope_get', { signers: many(2), obligation: null })).toBe(3);
    expect(rows('ludy_sign_envelope_get', { signers: many(2), obligation: { items: many(3) } })).toBe(6);
    expect(rows('ludy_sign_renewals_list', { items: many(5), total: 5, truncated: false })).toBe(5);
    expect(rows('ludy_sign_templates_list', { templates: many(3), total: 3, truncated: false })).toBe(3);
  });
});
