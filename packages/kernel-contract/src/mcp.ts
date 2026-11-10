// SPDX-License-Identifier: AGPL-3.0-only
// The grants an owner or admin gave MCP clients (ADR-0051 decision 2, issue #2975): the list of an org's grants and the revoke of one.
// The authorization itself (consent, tokens) is a set of HTTP routes under /oauth and /mcp, not procedures: they carry secrets.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The scopes an MCP grant may hold. @crove/kernel-runtime keeps the list the runtime enforces (MCP_SCOPES) and
// crove_kernel.agent_grant's CHECK the same one; a test pins the two lists.
export const MCP_SCOPE_IDS = ['ludy.read'] as const;
export type McpScopeId = (typeof MCP_SCOPE_IDS)[number];
export const zMcpScope = z.enum(MCP_SCOPE_IDS);

// One grant of the org in the request, for an owner or an admin. Never a token. The client name is what the client declared about itself.
export const zMcpGrantView = z.strictObject({
  id: zId,
  userId: zId,
  clientId: z.string(),
  clientName: z.string(),
  clientHost: z.string(),
  scopes: z.array(zMcpScope),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type McpGrantView = z.infer<typeof zMcpGrantView>;

export const zMcpGrantRevoke = z.strictObject({ grantId: zId });
export const zMcpGrantRevoked = z.strictObject({ grantId: zId, revoked: z.literal(true) });
