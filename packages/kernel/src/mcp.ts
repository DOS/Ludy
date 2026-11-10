// SPDX-License-Identifier: AGPL-3.0-only
// The grants an owner or admin gave MCP clients (ADR-0051 decision 2, ADR-0032, issue #2975).
//
// - kernel.mcp.grant.approve: the consent. The authorization server's interaction route runs it with the signed-in user's own actor after
//   it saved the authorization grant; the definer records one live grant per (org, client, user) for an owner or admin and destroys the
//   tokens of the one it replaces. It is not a procedure of the contract (the route is the only caller) and no MCP grant reaches it.
// - kernel.mcp.grant.list and kernel.mcp.grant.revoke: an owner or admin sees the org's grants and cuts one off; the consenting user may cut
//   off their own.
// - kernel.mcp.call.audit: the audit row of one MCP call or refusal, written by the endpoint as the system actor, so a row never reads as the
//   person's own click: it names the grant, the client and the tool (ids and names only, never an argument or an answer).
// - kernel.mcp.about: the one read of this step, `ludy_about`: the org's name, the grant and its scope. It holds no business data.
// No command declares `mcp`: an MCP grant reaches no write (a test pins it).
import { sql } from 'kysely';
import { z } from 'zod';
import { MCP_SCOPE_IDS, zMcpGrantRevoke, zId, type McpGrantView } from '@crove/kernel-contract';
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

// What one MCP call or refusal records. The tool is a name from the endpoint's own list, the outcome one of a few words; no argument, no answer.
export const zMcpCallAudit = z.strictObject({
  grantId: zId,
  clientId: z.string().min(1).max(512),
  clientName: z.string().min(1).max(120),
  tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  requestId: z.string().min(1).max(100),
  outcome: z.enum(['ok', 'refused', 'rate_limited', 'failed']),
});

export const mcpCallAudit = defineCommand({
  name: 'kernel.mcp.call.audit',
  input: zMcpCallAudit,
  risk: 'R0',
  sideEffect: 'internal',
  access: 'system',
  writes: [],
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới ghi nhận lượt gọi MCP');
    // The row says it came over MCP, from which grant and client, and that it is not the person's own click.
    ctx.audit({ via: 'mcp', mcpGrant: input.grantId, mcpClient: input.clientId, mcpClientName: input.clientName, tool: input.tool, requestId: input.requestId, outcome: input.outcome });
    return { recorded: true as const };
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

export const mcpCommands = [mcpGrantApprove, mcpGrantRevoke, mcpCallAudit];
export const mcpQueries = [mcpGrantList, mcpAbout];
