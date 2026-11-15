// SPDX-License-Identifier: AGPL-3.0-only
// The grants an owner or admin gave MCP clients (ADR-0051 decision 2, issue #2975): the list of an org's grants and the revoke of one.
// The authorization itself (consent, tokens) is a set of HTTP routes under /oauth and /mcp, not procedures: they carry secrets.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The scopes an MCP grant may hold. @crove/kernel-runtime keeps the list the runtime enforces (MCP_SCOPES) and
// crove_kernel.agent_grant's CHECK the same one; a test pins the two lists.
// `ludy.member.read` is the private scope of a member grant (design note on #2975, slice 3): it ships dark. The database accepts it on a member grant, but the runtime's own
// list (MCP_SCOPES) does not have it yet, so no query can declare it, and no screen asks for it; it joins that list with the first query that declares it (step 3d).
// `ludy.social.draft` (#3227) is the one write scope: a company grant's alone, for the one command that creates a draft Social post for a person to review.
export const MCP_SCOPE_IDS = ['ludy.read', 'ludy.member.read', 'ludy.social.draft'] as const;
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
  // 'member' for a grant a member made for themself, 'company' for the org's (an owner's or admin's); and whether the grant is the viewer's own.
  kind: z.enum(['company', 'member']),
  mine: z.boolean(),
});
export type McpGrantView = z.infer<typeof zMcpGrantView>;

// The org's switch for member-bound grants (owner only; off by default): while it is off no member or viewer can consent and every non-admin member grant ends at its next request.
export const zMcpMemberGrantsSet = z.strictObject({ enabled: z.boolean() });
export const zMcpMemberGrantsView = z.strictObject({ enabled: z.boolean() });

export const zMcpGrantRevoke = z.strictObject({ grantId: zId });
export const zMcpGrantRevoked = z.strictObject({ grantId: zId, revoked: z.literal(true) });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The wake-up webhook of a grant (ADR-0051 decision 4, issue #3024): one HTTPS receiver an owner or admin sets, a secret shown once, an optional schedule.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const MCP_WAKE_SCHEDULES = ['off', 'daily', 'weekly'] as const;
export type McpWakeSchedule = (typeof MCP_WAKE_SCHEDULES)[number];
export const MCP_WAKE_URL_MAX = 2048;

// Why a receiver URL is refused before any lookup, or null when it fits: https only, a name (never an address), the default port, no credentials, no fragment.
// The database holds the same rule as a CHECK; the egress guard holds the rest (every address the name resolves to must be public) on every send.
export function mcpWakeUrlProblem(raw: string): string | null {
  if (raw.length > MCP_WAKE_URL_MAX || raw.length < 12) return 'length';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'only https';
  if (url.username || url.password) return 'credentials in the URL';
  if (url.hash) return 'a fragment';
  if (url.port && url.port !== '443') return 'only the default port';
  const host = url.hostname;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9.]+$/.test(host)) return 'an address, not a name';
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return 'not a public name';
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return 'not a plain host name';
  if (/\s/.test(url.href)) return 'whitespace';
  return null;
}

export const zMcpWakeUrl = z.string().trim().max(MCP_WAKE_URL_MAX).refine((v) => mcpWakeUrlProblem(v) === null, 'Địa chỉ nhận phải là https, dùng tên miền công khai (không phải địa chỉ IP), cổng 443, không kèm tài khoản');

export const zMcpWakeSet = z
  .strictObject({
    grantId: zId,
    url: zMcpWakeUrl,
    enabled: z.boolean().default(true),
    schedule: z.enum(MCP_WAKE_SCHEDULES).default('off'),
    // Minutes after midnight in Vietnam time, and the ISO weekday (1 Monday to 7 Sunday).
    minute: z.number().int().min(0).max(1439).optional(),
    weekday: z.number().int().min(1).max(7).optional(),
  })
  .refine((v) => v.schedule === 'off' || v.minute !== undefined, { message: 'Chọn giờ gửi', path: ['minute'] })
  .refine((v) => v.schedule !== 'weekly' || v.weekday !== undefined, { message: 'Chọn ngày trong tuần', path: ['weekday'] });
export type McpWakeSet = z.infer<typeof zMcpWakeSet>;

export const zMcpWakeGrantRef = z.strictObject({ grantId: zId });
export const zMcpWakeGetInput = z.strictObject({ grantId: zId.optional() });

// The wake-up of one grant as an owner or admin reads it: the receiver, the schedule and how deliveries are going. Never a secret: only the public id beside it.
export const zMcpWakeView = z.strictObject({
  grantId: zId,
  url: z.string(),
  enabled: z.boolean(),
  pausedReason: z.literal('failing').nullable(),
  secretHint: z.string(),
  // While a rotation overlaps, the instant the previous secret stops signing.
  previousUntil: z.string().nullable(),
  schedule: z.enum(MCP_WAKE_SCHEDULES),
  minute: z.number().int().nullable(),
  weekday: z.number().int().nullable(),
  nextDueAt: z.string().nullable(),
  failingSince: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: z.string().nullable(),
  lastStatus: z.enum(['sent', 'failed']).nullable(),
});
export type McpWakeView = z.infer<typeof zMcpWakeView>;

// What set and rotate answer: the view and, only when a secret was just made, the secret itself, once. It is shown to the person who asked and kept nowhere in the clear.
export const zMcpWakeWithSecret = zMcpWakeView.extend({ secret: z.string().nullable() });
export type McpWakeWithSecret = z.infer<typeof zMcpWakeWithSecret>;
export const zMcpWakeTested = z.strictObject({ grantId: zId, eventId: zId, queued: z.literal(true) });
export const zMcpWakeCleared = z.strictObject({ grantId: zId, cleared: z.literal(true) });
