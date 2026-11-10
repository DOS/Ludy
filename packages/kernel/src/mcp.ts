// SPDX-License-Identifier: AGPL-3.0-only
// The grants an owner or admin gave MCP clients (ADR-0051 decision 2, ADR-0032, issue #2975).
//
// - kernel.mcp.grant.approve: the consent. The authorization server's interaction route runs it with the signed-in user's own actor after
//   it saved the authorization grant; the definer records one live grant per (org, client, user) for an owner or admin and destroys the
//   tokens of the one it replaces. It is not a procedure of the contract (the route is the only caller) and no MCP grant reaches it.
// - kernel.mcp.grant.list and kernel.mcp.grant.revoke: an owner or admin sees the org's grants and cuts one off; the consenting user may cut
//   off their own.
// The audit row of one MCP call or refusal is not a command: the endpoint writes it through crove_kernel.mcp_call_audit (the API login has no
// system context), as the system, naming the grant, the client and the tool, so it never reads as the person's own click.
// - kernel.mcp.about: the one read of this step, `ludy_about`: the org's name, the grant and its scope. It holds no business data.
// No command declares `mcp`: an MCP grant reaches no write (a test pins it).
import { sql } from 'kysely';
import { z } from 'zod';
import { MCP_SCOPE_IDS, plainLine, zMcpGrantRevoke, type McpGrantView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, hasFreshMfa, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

export const zMcpGrantApprove = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientName: z.string().trim().min(1).max(120),
  clientHost: z.string().trim().min(1).max(253),
  scopes: z.array(z.enum(MCP_SCOPE_IDS)).min(1).max(4),
  oauthGrantId: z.string().min(1).max(200),
  expiresInDays: z.number().int().min(1).max(89).default(89),
});

// The errors the grant definers raise, as domain errors; anything else goes through the runtime's mapping.
function mcpError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MCP_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấp được quyền kết nối MCP');
    case 'MCP_INVALID':
      throw new DomainError('INVALID', 422, 'Yêu cầu cấp quyền kết nối MCP không hợp lệ');
    default:
      throw error;
  }
}

function requireUser(ctx: CommandContext): void {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới quản lý được quyền kết nối MCP');
}

export const mcpGrantApprove = defineCommand({
  name: 'kernel.mcp.grant.approve',
  input: zMcpGrantApprove,
  risk: 'R2',
  sideEffect: 'internal',
  access: GRANTORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    // A member who has a second factor approves a connection with a fresh one, as for the extension (ADR-0047 point 10): aal2 means "has one".
    const actor = ctx.actor;
    if (actor.type === 'user' && actor.aal === 'aal2' && !hasFreshMfa(actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để cấp quyền kết nối MCP');
    }
    const { rows } = await sql<{ id: string }>`
      SELECT crove_kernel.mcp_grant_approve(
        ${input.clientId}, ${input.clientName}, ${input.clientHost}, ${input.scopes}::text[], ${input.oauthGrantId},
        pg_catalog.clock_timestamp() + (${input.expiresInDays} * interval '1 day')) AS id`
      .execute(ctx.trx)
      .catch(mcpError);
    const grantId = rows[0]?.id;
    if (!grantId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // Ids, the client and the scopes: never a token, a code or the authorization grant's id.
    ctx.audit({ grantId, clientId: input.clientId, clientName: input.clientName, clientHost: input.clientHost, scopes: [...input.scopes].sort() });
    return { grantId };
  },
});

export const mcpGrantRevoke = defineCommand({
  name: 'kernel.mcp.grant.revoke',
  input: zMcpGrantRevoke,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ revoked: boolean }>`SELECT crove_kernel.mcp_grant_revoke(${input.grantId}::uuid) AS revoked`.execute(ctx.trx);
    // One answer for an unknown id, another org's grant, one already revoked and one the user may not revoke.
    if (rows[0]?.revoked !== true) throw new DomainError('MCP_GRANT_NOT_FOUND', 404, 'Không tìm thấy quyền kết nối này, hoặc đã được thu hồi');
    ctx.audit({ grantId: input.grantId });
    return { grantId: input.grantId, revoked: true as const };
  },
});

export const mcpGrantList = defineQuery({
  name: 'kernel.mcp.grant.list',
  input: z.strictObject({}),
  access: GRANTORS,
  handler: async (ctx): Promise<McpGrantView[]> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được quyền kết nối MCP');
    const { rows } = await sql<{
      id: string;
      user_id: string;
      client_id: string;
      client_name: string;
      client_host: string;
      scopes: string[];
      created_at: Date;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>`SELECT id, user_id, client_id, client_name, client_host, scopes, created_at, expires_at, last_used_at, revoked_at FROM crove_kernel.mcp_grant_list()`
      .execute(ctx.trx)
      .catch(mcpError);
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      clientId: r.client_id,
      clientName: r.client_name,
      clientHost: r.client_host,
      scopes: r.scopes.filter((s): s is (typeof MCP_SCOPE_IDS)[number] => (MCP_SCOPE_IDS as readonly string[]).includes(s)),
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  },
});

export const zMcpAbout = z.strictObject({
  orgName: z.string(),
  clientName: z.string(),
  scopes: z.array(z.enum(MCP_SCOPE_IDS)),
});
export type McpAbout = z.infer<typeof zMcpAbout>;

// `ludy_about`: who the client is connected to and as what. The org's name is the one thing it reads; nothing of the books, the people or the
// notes. It proves the connection end to end (token, grant, per-request check, audit) before a tool reads business data.
export const mcpAbout = defineQuery({
  name: 'kernel.mcp.about',
  input: z.strictObject({}),
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<McpAbout> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const { rows } = await sql<{ name: string }>`SELECT name FROM crove_kernel.tenant WHERE org_id = crove_kernel.ctx_org_id()`.execute(ctx.trx);
    const name = rows[0]?.name;
    if (name === undefined) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tổ chức');
    return { orgName: name, clientName: ctx.actor.mcp.clientName, scopes: ctx.actor.mcp.scopes.filter((s): s is (typeof MCP_SCOPE_IDS)[number] => (MCP_SCOPE_IDS as readonly string[]).includes(s)) };
  },
});

export const MCP_LIST_DEFAULT = 25;
export const MCP_LIST_MAX = 50;
const zMcpLimit = z.number().int().min(1).max(MCP_LIST_MAX).default(MCP_LIST_DEFAULT).describe(`How many rows to return, newest first (1 to ${MCP_LIST_MAX}, default ${MCP_LIST_DEFAULT}).`);

export const zMcpPartiesInput = z.strictObject({
  kind: z.enum(['organization', 'person']).optional().describe('Only companies (organization) or only people (person). Leave out for both.'),
  limit: zMcpLimit,
});

export interface McpPartyRow {
  id: string;
  kind: 'organization' | 'person';
  name: string;
  companyName: string | null;
  createdOn: string;
}
export interface McpParties {
  parties: McpPartyRow[];
  total: number;
  truncated: boolean;
}

// `ludy_parties_list`: the org's customers and suppliers (the party register), newest first, at most MCP_LIST_MAX. The projection is the privacy review of
// this tool: the name of the party, whether it is a company or a person, and for a person the company they work at, and the day it was recorded.
// Never an email, a phone number, an address or a tax code (a household business's tax code is its owner's own), never the free-text search column,
// never the duplicate or verification state. Merged duplicates are not listed (the kept party stands for them). There is no search and no cursor:
// a client sees the newest rows and says so (`truncated`); a way to page is a later step with its own review.
export const mcpParties = defineQuery({
  name: 'kernel.mcp.parties',
  input: zMcpPartiesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpParties> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const kind = input.kind ?? null;
    const found = await sql<{ id: string; kind: 'organization' | 'person'; name: string; company_name: string | null; created_on: string }>`
      SELECT p.id, p.kind, p.name, c.name AS company_name, to_char(p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS created_on
      FROM crove_kernel.party p
      LEFT JOIN crove_kernel.party c0 ON c0.org_id = p.org_id AND c0.id = p.company_id
      LEFT JOIN crove_kernel.party c ON c.org_id = c0.org_id AND c.id = coalesce(c0.duplicate_of, c0.id)
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND (${kind}::text IS NULL OR p.kind = ${kind}::text)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${input.limit}`.execute(ctx.trx);
    const count = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND (${kind}::text IS NULL OR p.kind = ${kind}::text)`.execute(ctx.trx);
    const total = count.rows[0]?.n ?? 0;
    const parties = found.rows.map((r) => ({ id: r.id, kind: r.kind, name: plainLine(r.name, 300), companyName: r.company_name === null ? null : plainLine(r.company_name, 300), createdOn: r.created_on }));
    return { parties, total, truncated: total > parties.length };
  },
});

export const mcpCommands = [mcpGrantApprove, mcpGrantRevoke];
export const mcpQueries = [mcpGrantList, mcpAbout, mcpParties];
