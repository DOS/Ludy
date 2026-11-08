// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's devices (issue #2582, ADR-0047 point 10, meetings plan M8).
//
// - kernel.extension.code.issue: the signed-in member approved the extension for the org of the request. The HTTP route
//   makes the one-time code and hands the command only its SHA-256, the PKCE challenge, the scopes and a device name, so
//   the code is in no input hash, audit row or stored answer. The definer records it for five minutes, single use.
// - kernel.extension.token.list and kernel.extension.token.revoke: the member's own connected devices in the org, and a
//   one-click revoke. Any role may list and revoke their own, so a member demoted to viewer can still cut theirs off.
// The extension itself reaches none of these (no `extension` scope is declared): a stolen token cannot mint another
// token, list devices or revoke one.
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTENSION_SCOPE_IDS, zExtensionAuthorize, zExtensionTokenRevoke, zId, type ExtensionOrgTokenView, type ExtensionTokenView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, hasFreshMfa, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// A viewer holds no feature's permission, so none may connect a device.
const CONNECTORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// Who may see and cut off the devices of the other members.
const DEVICE_ADMINS: readonly MemberRole[] = ['owner', 'admin'];

const zCodeHash = z.string().regex(/^[0-9a-f]{64}$/);

export const zExtensionCodeIssue = z.strictObject({
  codeHash: zCodeHash,
  codeChallenge: zExtensionAuthorize.shape.codeChallenge,
  scopes: zExtensionAuthorize.shape.scopes,
  deviceName: zExtensionAuthorize.shape.deviceName,
  // The extension the member approved (#2850): the code is bound to it and only that extension can exchange it. Required: no code is made
  // without it (the unbound 5-argument definer is gone, step 2 #2855).
  extensionId: zExtensionAuthorize.shape.extensionId,
});

// The errors the extension definers raise, as domain errors; anything else goes through the runtime's mapping.
function extensionError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'EXTENSION_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu, quản trị viên hoặc thành viên mới kết nối được tiện ích Ludy');
    case 'EXTENSION_INVALID':
      throw new DomainError('INVALID', 422, 'Yêu cầu kết nối tiện ích không hợp lệ');
    case 'EXTENSION_TOO_MANY':
      throw new DomainError('EXTENSION_TOO_MANY', 429, 'Bạn đã mở quá nhiều lượt kết nối tiện ích chưa hoàn tất, hãy thử lại sau ít phút');
    default:
      throw error;
  }
}

function requireUser(ctx: CommandContext): void {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới quản lý được tiện ích Ludy');
}

export const extensionCodeIssue = defineCommand({
  name: 'kernel.extension.code.issue',
  input: zExtensionCodeIssue,
  risk: 'R1',
  sideEffect: 'internal',
  access: CONNECTORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    // A member who has a second factor approves the extension with a fresh one (ADR-0047 point 10). The sign-in of a
    // member with a verified factor is aal2 (the session check requires it), so aal2 here means "has one".
    const actor = ctx.actor;
    if (actor.type === 'user' && actor.aal === 'aal2' && !hasFreshMfa(actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để kết nối tiện ích Ludy');
    }
    const { rows } = await sql<{ id: string }>`
      SELECT crove_kernel.issue_extension_auth_code(
        decode(${input.codeHash}, 'hex'), ${input.codeChallenge}, 'S256', ${input.scopes}::text[], ${input.deviceName}, ${input.extensionId}::text) AS id`
      .execute(ctx.trx)
      .catch(extensionError);
    const codeId = rows[0]?.id;
    if (!codeId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the code's id and scopes: never the code, its hash, the challenge or the device name.
    ctx.audit({ codeId, scopes: [...input.scopes].sort() });
    return { codeId, expiresInSeconds: 300 };
  },
});

// The audit row of an exchange (ADR-0047 point 10: every token is audited from its creation). The exchange definer runs with no
// member context, so it cannot write one; the API runs this right after it, as the member with the new token, and the row names
// the token (in every row of its requests, by the runtime) and the one-time code it came from. Ids only. It writes nothing else.
export const extensionTokenExchanged = defineCommand({
  name: 'kernel.extension.token.exchanged',
  input: z.strictObject({ codeId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: CONNECTORS,
  extension: { scope: 'meetings' },
  writes: [],
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || !ctx.actor.extension) throw new DomainError('FORBIDDEN', 403, 'Chỉ mã của tiện ích mới ghi nhận được lượt đổi mã');
    ctx.audit({ codeId: input.codeId });
    return { recorded: true as const };
  },
});

export const extensionTokenRevoke = defineCommand({
  name: 'kernel.extension.token.revoke',
  input: zExtensionTokenRevoke,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ revoked: boolean }>`SELECT crove_kernel.revoke_extension_token(${input.tokenId}::uuid) AS revoked`.execute(ctx.trx);
    // One answer for an unknown id, another member's device and one already revoked.
    if (rows[0]?.revoked !== true) throw new DomainError('EXTENSION_TOKEN_NOT_FOUND', 404, 'Không tìm thấy thiết bị này, hoặc đã được ngắt kết nối');
    ctx.audit({ tokenId: input.tokenId });
    return { tokenId: input.tokenId, revoked: true as const };
  },
});

// An owner or an admin cuts off the device of any member of the org (an admin not an owner's). One answer for an unknown
// id, another org's device, one already revoked and an owner's device an admin may not touch. The audit row names the
// token and its member, ids only.
export const extensionTokenRevokeMember = defineCommand({
  name: 'kernel.extension.token.revoke_member',
  input: zExtensionTokenRevoke,
  risk: 'R1',
  sideEffect: 'internal',
  access: DEVICE_ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ user_id: string | null }>`SELECT crove_kernel.revoke_extension_token_as_admin(${input.tokenId}::uuid) AS user_id`
      .execute(ctx.trx)
      .catch(extensionError);
    const userId = rows[0]?.user_id;
    if (!userId) throw new DomainError('EXTENSION_TOKEN_NOT_FOUND', 404, 'Không tìm thấy thiết bị này, hoặc đã được ngắt kết nối');
    ctx.audit({ tokenId: input.tokenId, userId });
    return { tokenId: input.tokenId, userId, revoked: true as const };
  },
});

export const extensionTokenListOrg = defineQuery({
  name: 'kernel.extension.token.list_org',
  input: z.strictObject({}),
  access: DEVICE_ADMINS,
  handler: async (ctx): Promise<ExtensionOrgTokenView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được thiết bị kết nối');
    const { rows } = await sql<{
      id: string;
      user_id: string;
      device_name: string;
      scopes: string[];
      created_at: Date;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>`SELECT id, user_id, device_name, scopes, created_at, expires_at, last_used_at, revoked_at FROM crove_kernel.list_extension_tokens_for_org()`
      .execute(ctx.trx)
      .catch(extensionError);
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      deviceName: r.device_name,
      scopes: r.scopes.filter((s): s is (typeof EXTENSION_SCOPE_IDS)[number] => (EXTENSION_SCOPE_IDS as readonly string[]).includes(s)),
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  },
});

export const extensionTokenList = defineQuery({
  name: 'kernel.extension.token.list',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<ExtensionTokenView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được thiết bị kết nối');
    const { rows } = await sql<{
      id: string;
      device_name: string;
      scopes: string[];
      created_at: Date;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>`SELECT id, device_name, scopes, created_at, expires_at, last_used_at, revoked_at FROM crove_kernel.list_extension_tokens()`.execute(ctx.trx);
    return rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      scopes: r.scopes.filter((s): s is (typeof EXTENSION_SCOPE_IDS)[number] => (EXTENSION_SCOPE_IDS as readonly string[]).includes(s)),
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  },
});

export const extensionCommands = [extensionCodeIssue, extensionTokenExchanged, extensionTokenRevoke, extensionTokenRevokeMember];
export const extensionQueries = [extensionTokenList, extensionTokenListOrg];
