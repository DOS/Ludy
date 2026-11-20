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
// - kernel.mcp.about: `ludy_about`: the org's name, the grant and its scope. It holds no business data.
// - kernel.mcp.parties: `ludy_parties_list` (slice 1b), the party register as the contacts screen shows it to an owner or admin; its comment is its privacy review.
// No command of the kernel declares `mcp`. The one command an MCP grant may run, the Social draft (#3227), is declared in modules/social, and a test pins that it is the only one.
// - kernel.mcp.propose: what an MCP grant's call to an R2 or R3 command becomes (ADR-0051 decision 10, #3858 slice d): a pending proposal, never an execution.
// - kernel.mcp.proposal_notify: the worker's step after it (E5, #4180): the people who may approve that proposal are told, once, in their notifications.
import { sql } from 'kysely';
import { z } from 'zod';
import { MCP_SCOPE_IDS, plainLine, zId, zMcpGrantRevoke, zMcpMemberGrantsSet, zMcpMemberGrantsView, type McpGrantView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, MCP_PROPOSE_COMMAND, defineCommand, defineQuery, hasFreshMfa, type CommandContext } from '@crove/kernel-runtime';
import { hasApprovalPolicy } from './approval.ts';
import { APPROVAL_WAITING, notifyMembers } from './notifications.ts';
import { approversNow } from './proposal-reminders.ts';
import { PROPOSAL_PREPARERS } from './proposal-resubmit.ts';
import { mcpConversationQueries } from './mcp-conversations.ts';
import { mcpSignals } from './mcp-signals.ts';
import { mcpWakeCommands, mcpWakeQueries } from './mcp-wake.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

export const zMcpGrantApprove = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientName: z.string().trim().min(1).max(120),
  clientHost: z.string().trim().min(1).max(253),
  scopes: z.array(z.enum(MCP_SCOPE_IDS)).min(1).max(4),
  oauthGrantId: z.string().min(1).max(200),
  expiresInDays: z.number().int().min(1).max(89).default(89),
  // A company grant (an owner or admin, for the company) or a member grant (a member, for themself, under their own rights).
  kind: z.enum(['company', 'member']).default('company'),
});

// The errors the grant definers raise, as domain errors; anything else goes through the runtime's mapping.
function mcpError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MCP_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấp được quyền kết nối MCP');
    case 'MCP_INVALID':
      throw new DomainError('INVALID', 422, 'Yêu cầu cấp quyền kết nối MCP không hợp lệ');
    case 'MCP_TOO_MANY':
      throw new DomainError('MCP_GRANT_TOO_MANY', 409, 'Bạn đã có đủ 5 quyền kết nối MCP của riêng mình, hãy ngắt bớt một quyền rồi thử lại');
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
  // Any member may reach the command: the definers decide who may make which kind (a company grant is an owner's or admin's; a member grant is any member's while the org allows it).
  access: ALL,
  handler: async (ctx, input) => {
    requireUser(ctx);
    // A member who has a second factor approves a connection with a fresh one, as for the extension (ADR-0047 point 10): aal2 means "has one".
    const actor = ctx.actor;
    if (actor.type === 'user' && actor.aal === 'aal2' && !hasFreshMfa(actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để cấp quyền kết nối MCP');
    }
    const expires = sql`pg_catalog.clock_timestamp() + (${input.expiresInDays} * interval '1 day')`;
    const { rows } =
      input.kind === 'member'
        ? await sql<{ id: string }>`
            SELECT crove_kernel.mcp_member_grant_approve(${input.clientId}, ${input.clientName}, ${input.clientHost}, ${input.scopes}::text[], ${input.oauthGrantId}, ${expires}) AS id`
            .execute(ctx.trx)
            .catch(mcpError)
        : await sql<{ id: string }>`
            SELECT crove_kernel.mcp_grant_approve(${input.clientId}, ${input.clientName}, ${input.clientHost}, ${input.scopes}::text[], ${input.oauthGrantId}, ${expires}) AS id`
            .execute(ctx.trx)
            .catch(mcpError);
    const grantId = rows[0]?.id;
    if (!grantId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // Ids, the client and the scopes: never a token, a code or the authorization grant's id.
    ctx.audit({ grantId, kind: input.kind, clientId: input.clientId, clientName: input.clientName, clientHost: input.clientHost, scopes: [...input.scopes].sort() });
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
  // An owner or admin sees the org's grants; any other member only their own (the definer decides which).
  access: ALL,
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
    const me = ctx.actor.userId;
    const kinds = new Map((await sql<{ id: string; kind: string }>`SELECT id, kind FROM crove_kernel.mcp_grant_kinds()`.execute(ctx.trx).catch(mcpError)).rows.map((k) => [k.id, k.kind === 'member' ? 'member' : 'company'] as const));
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
      kind: kinds.get(r.id) ?? 'company',
      mine: r.user_id === me,
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
  // Every role: a member grant of a member or a viewer reaches this and nothing that is owner or admin only; what it returns holds no business data.
  access: ALL,
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
  email: string | null;
  phone: string | null;
  address: string | null;
  taxCode: string | null;
  // Who put the row in: 'user' (staff typed it), 'external' (a visitor, a public form or an import), 'system'. A client treats an `external` value as less trusted.
  sourceTrust: 'external' | 'user' | 'system';
}
export interface McpParties {
  parties: McpPartyRow[];
  total: number;
  truncated: boolean;
}

// An optional text field as one plain line, or null when nothing is left of it.
const optionalLine = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const line = plainLine(value, max);
  return line === '' ? null : line;
};

// `ludy_parties_list`: the org's customers, suppliers and contacts (the party register), newest first, at most MCP_LIST_MAX.
//
// The projection is the privacy review of this tool, as the owner decided it (2026-11-11): an AI app the owner connected sees the customer data the consenting owner or
// admin sees on the contacts screen, as the HubSpot and Twenty MCP servers show theirs. Returned: the name, whether it is a company or a person, for a person the
// company they work at, the email, the phone, the address, the tax code (the contacts screen shows all four of every contact to an owner or an admin, a person's tax
// code included), the day it was recorded, and `sourceTrust` (who put the row in: a value a visitor typed through a public form is `external`, so a client can trust
// it less). Every text value is cut to one plain line (see plainLine). Never returned: the free-text search column, the duplicate and verification state, bank account
// records, payroll or salary data, member-private notes or todos or member-Vy data; nothing from a query that is `sensitive`. Merged duplicates are not listed (the kept
// party stands for them). There is no search and no cursor: a client sees the newest rows and `truncated` says there are more; a way to page is a later step.
export const mcpParties = defineQuery({
  name: 'kernel.mcp.parties',
  input: zMcpPartiesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpParties> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const kind = input.kind ?? null;
    const found = await sql<{
      id: string;
      kind: 'organization' | 'person';
      name: string;
      company_name: string | null;
      created_on: string;
      email: string | null;
      phone: string | null;
      address: string | null;
      tax_code: string | null;
      source_trust: 'external' | 'user' | 'system';
    }>`
      SELECT p.id, p.kind, p.name, c.name AS company_name, to_char(p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS created_on,
        p.email, p.phone, p.address, p.tax_code, p.source_trust
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
    const parties = found.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: plainLine(r.name, 300),
      companyName: optionalLine(r.company_name, 300),
      createdOn: r.created_on,
      email: optionalLine(r.email, 254),
      phone: optionalLine(r.phone, 40),
      address: optionalLine(r.address, 500),
      taxCode: optionalLine(r.tax_code, 30),
      sourceTrust: r.source_trust,
    }));
    return { parties, total, truncated: total > parties.length };
  },
});

// The org's switch for member-bound grants: an owner turns it on or off. Off by default; turning it off ends every non-admin member grant at its next request (the standing
// function reads the switch live), with no row touched. It changes who may let company data leave to a third-party AI app, so it is R2, user-only and audited.
export const mcpMemberGrantsSet = defineCommand({
  name: 'kernel.mcp.member_grants.set',
  input: zMcpMemberGrantsSet,
  risk: 'R2',
  sideEffect: 'internal',
  access: ['owner'],
  handler: async (ctx, input) => {
    requireUser(ctx);
    const actor = ctx.actor;
    if (actor.type === 'user' && actor.aal === 'aal2' && !hasFreshMfa(actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để đổi cài đặt này');
    }
    const { rows } = await sql<{ on: boolean }>`SELECT crove_kernel.mcp_member_grants_set(${input.enabled}) AS "on"`.execute(ctx.trx).catch(mcpError);
    ctx.audit({ enabled: rows[0]?.on === true });
    return { enabled: rows[0]?.on === true };
  },
});

export const mcpMemberGrantsGet = defineQuery({
  name: 'kernel.mcp.member_grants.get',
  input: z.strictObject({}),
  access: GRANTORS,
  handler: async (ctx): Promise<z.infer<typeof zMcpMemberGrantsView>> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được cài đặt này');
    const { rows } = await sql<{ on: boolean }>`SELECT crove_kernel.mcp_member_grants_get() AS "on"`.execute(ctx.trx).catch(mcpError);
    return { enabled: rows[0]?.on === true };
  },
});

// The proposal an MCP grant's call to an R2 or R3 command becomes (ADR-0051 decision 10, #3858 slice d). The runtime runs this command in place of the command the call named, for an MCP actor and for nobody else:
// a person calling it is refused. It never runs the command: it writes one pending proposal of the command and the (already parsed) input, in the sealed proposal context of the call's scope, which the database
// lets insert that one row of that one shape. The client and its host, the grant's id and the taint are stamped from the grant of the call, never from the input; the author is the grant, an agent entry that
// never counts as an approver or for four-eyes, so the person who consented can approve it. A person approves it in Ludy through kernel.proposal.approve, with the policy's approvers, four-eyes and step-up;
// the command then runs under the approver's authority and the usual checks, once. A cap of pending proposals per grant and per org is the database's (crove_kernel.mcp_proposal_cap).
const PROPOSAL_PAYLOAD_MAX_BYTES = 64 * 1024;
export const mcpPropose = defineCommand({
  name: MCP_PROPOSE_COMMAND,
  input: z.strictObject({ command: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: GRANTORS,
  handler: async (ctx, input) => {
    const actor = ctx.actor;
    const mcp = actor.type === 'user' ? actor.mcp : undefined;
    if (actor.type !== 'user' || !mcp || mcp.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới tạo được đề xuất này', { rule: 'mcp_scope' });
    const info = ctx.command(input.command);
    // The command must be reachable by a grant as a proposal under a scope this grant holds (the runtime checked the scope against the command's own declaration; this checks it is that command), run
    // through a proposal, and have an approval policy that names an approver. R3 without one is refused (the database refuses the same row).
    // A command that has a preparer (the deterministic step that builds the payload the approver signs from the books: payees, amounts, checks) is not proposable by a client's raw payload: the call would skip it
    // (review of slice d, B2). Such a command reaches MCP only through its preparer, in a later slice that builds that path; every other command is listed by a migration (crove_kernel.mcp_proposal_command) first.
    // The purchase invoice's payload is the extraction's (its checks, its lines), so it is no client's either.
    if (Object.hasOwn(PROPOSAL_PREPARERS, input.command) || input.command === 'finance.purchase.record') throw new DomainError('FORBIDDEN', 403, 'Quyền kết nối MCP không được thực hiện việc này', { rule: 'mcp_scope' });
    if (!info || info.mcp?.mode !== 'proposal' || info.access !== 'proposal' || !mcp.scopes.includes(info.mcp.scope) || !hasApprovalPolicy(input.command)) {
      throw new DomainError('FORBIDDEN', 403, 'Quyền kết nối MCP không được thực hiện việc này', { rule: 'mcp_scope' });
    }
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > PROPOSAL_PAYLOAD_MAX_BYTES) throw new DomainError('INVALID', 422, 'Nội dung đề xuất quá lớn');
    const kind = info.proposalKind;
    // The Inbox renders a proposal by its kind and a title built here from the client's self-declared name (marked as such), never from text the call supplied.
    const title = `Ứng dụng AI “${plainLine(mcp.clientName, 120)}” đề xuất: ${kind}`.slice(0, 300);
    let proposalId: string;
    try {
      const row = await ctx.trx
        .insertInto('crove_kernel.proposal')
        .values({
          org_id: ctx.orgId,
          kind,
          command: input.command,
          title,
          payload: JSON.stringify(input.payload),
          // The approver snapshot and the title are the database's (the guard stamps eligible_approvers from approval_eligible_now, the trigger the title from the catalog's kind): placeholders here.
          eligible_approvers: [],
          // The grant (an agent entry, never an approver) and the person who connected it (a user entry): the grantor stands for what their AI app asks, so with two or more eligible approvers someone else approves
          // when the policy asks for four-eyes (P10), as for a proposal a person asked for or one an org-chart agent's human chain stands behind.
          authors: JSON.stringify([{ type: 'agent', id: mcp.grantId, run: mcp.grantId }, { type: 'user', id: actor.userId }]),
          tainted: true,
          requested_by_grant: mcp.grantId,
          mcp_client_name: mcp.clientName.slice(0, 120),
          // Placeholders the database overwrites from the grant's own record (crove_kernel.mcp_proposal_cap), so what the Inbox card names is never what a caller passed.
          mcp_client_host: '-',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      proposalId = row.id;
    } catch (error) {
      const message = (error as { message?: unknown } | null)?.message;
      // The database keeps a grant's scope to its own line's commands (crove_kernel.mcp_proposal_command): a command the catalog does not list under this scope is refused as any out-of-scope call is.
      if (message === 'AGENT_FORBIDDEN') throw new DomainError('FORBIDDEN', 403, 'Quyền kết nối MCP không được thực hiện việc này', { rule: 'mcp_scope' });
      if (message === 'MCP_PROPOSAL_CAP') throw new DomainError('MCP_PROPOSAL_CAP', 409, 'Có quá nhiều đề xuất của ứng dụng AI này đang chờ duyệt, hãy duyệt hoặc từ chối bớt rồi thử lại');
      throw error;
    }
    // Ids only: the proposal, the command it is for, the grant and the client (the runtime adds them); never the payload.
    ctx.audit({ proposal_id: proposalId, proposal_command: input.command, mcp_proposal: true });
    return { proposalId, status: 'pending' as const };
  },
});

// Telling the approvers (E5, #4180, owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt"): a proposal of an AI coworker waits for an owner or an admin, and nothing else would tell them it is there.
// kernel.mcp.propose cannot do it itself: it runs in the sealed proposal context, which writes that one proposal row and no event and no notification. The worker's sweep (mcp-proposal-notice.ts, every
// 30 seconds) finds the pending proposals of a grant that were not told yet (crove_kernel.mcp_proposals_to_tell) and runs this, under the proposal's lock: the people who could approve it now (the snapshot at
// the ask, still holding an approving role, and not held back by four-eyes: with two owners the person who connected the AI app is not told, a sole owner is) get one kernel.approval_waiting notification
// each, the one a person's or an org-chart agent's proposal already makes, so it turns on and off with that kind, opens the Inbox card and reads as settled once the proposal is decided (the list reads
// the proposal's state). It holds no text: the card's title, which the database built from the client's name and the kind (marked as an AI app's), is read when it is shown, and nothing the call
// supplied (a customer-facing reply, a payload) is ever read here. One per proposal: the notification's key is the proposal's, and the proposal is stamped (approvers_told_at) even when nobody had to
// be told, so a second pass, a retry and a replay write nothing. A proposal decided or expired before the sweep got to it is left alone.
export const mcpProposalNotify = defineCommand({
  name: 'kernel.mcp.proposal_notify',
  input: z.strictObject({ proposalId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.proposal', id: input.proposalId }),
  handler: async (ctx, input) => {
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'command', 'status', 'eligible_approvers', 'authors', 'co_authors', 'legal_entity_id', 'requested_by_grant', 'approvers_told_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.proposalId)
      .forUpdate()
      .executeTakeFirst();
    // Only the pending proposal of a grant that was not told yet; a person's or an agent's proposal has its own event.
    if (!proposal || proposal.status !== 'pending' || proposal.requested_by_grant === null || proposal.approvers_told_at !== null) return { sent: 0 };
    const approvers = await approversNow(ctx, proposal);
    const sent = await notifyMembers(ctx, {
      kind: APPROVAL_WAITING,
      users: approvers,
      key: `proposal:${proposal.id}`,
      subject: { type: 'kernel.proposal', id: proposal.id },
      legalEntityId: proposal.legal_entity_id,
      detail: {},
    });
    await ctx.trx.updateTable('crove_kernel.proposal').set({ approvers_told_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', proposal.id).execute();
    // Counts only: who was told is the notification table's, and the proposal's content is never read here.
    ctx.audit({ approvers: approvers.length, sent });
    return { sent };
  },
});

export const mcpCommands = [mcpGrantApprove, mcpGrantRevoke, mcpMemberGrantsSet, mcpPropose, mcpProposalNotify, ...mcpWakeCommands];
export const mcpQueries = [mcpGrantList, mcpMemberGrantsGet, mcpAbout, mcpParties, mcpSignals, ...mcpConversationQueries, ...mcpWakeQueries];
