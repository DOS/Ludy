// SPDX-License-Identifier: AGPL-3.0-only
// The write connection of an ad account (ADR-0043 points 3 and 4, issue #2294, W0b): a second channel connection of the same platform
// account (provider `metawrite_ads` or `sandboxwrite_ads`, its own sealed token, the permission that can change campaigns), hung off the
// account the read connection linked (`ad_account.write_connection_id`). Nothing here calls a platform and nothing spends: it connects,
// shows what the account can do, and closes the connection again.
// - ads.account.link_write (owner): attaches a write connection the owner just made, only while the org's switch is on, to the account
//   the read connection linked. It is never an account of its own (the account's key names the read provider).
// - ads.account.disconnect (owner, admin): closes the read connection of an account and its write connection, dropping both sealed
//   tokens, and turns its flag off.
// - closeWriteConnections: what the switch-off commands (ads.write.disable, ads.account.disable_write) and the removal of an account
//   run: it closes the write connections and drops their sealed tokens, with the kernel's own commands. The platform's own copy of the
//   token is revoked by the write queue of W2, which cannot merge without it; until then the owner is told to remove the app in the
//   platform's settings.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { READ_PROVIDER_OF_WRITE, isAdWriteProviderId, zAdsAccountLinkWrite, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');

// Closes the write connections of one account, or of every account of the org, that are not closed yet (a connection that expired or
// failed still holds a sealed token), as the caller: the kernel's disconnect closes it and drops the sealed token. As the system (the
// platform's deletion request) the kernel's platform-deletion close does the same. Returns how many it closed.
export async function closeWriteConnections(ctx: CommandContext, scope: { adAccountId?: string }): Promise<number> {
  let query = ctx.trx
    .selectFrom('crove_ads.ad_account as a')
    .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.write_connection_id'))
    .select(['a.id as ad_account_id', 'c.id as connection_id'])
    .where('a.org_id', '=', ctx.orgId)
    .where('c.status', '<>', 'revoked')
    .orderBy('c.id');
  if (scope.adAccountId) query = query.where('a.id', '=', scope.adAccountId);
  const open = await query.execute();
  const command = ctx.actor.type === 'system' ? 'kernel.channel.revoke_by_platform' : 'kernel.channel.disconnect';
  for (const row of open) await ctx.run(command, { connectionId: row.connection_id });
  return open.length;
}

export const adsAccountLinkWrite = defineCommand({
  name: 'ads.account.link_write',
  input: zAdsAccountLinkWrite,
  // The owner connects it (the database lets only a signed-in owner attach one): the token it seals can change campaigns once the account
  // is enabled and a proposal approved, and nothing yet.
  risk: 'R2',
  sideEffect: 'external',
  access: OWNERS,
  handler: async (ctx, input): Promise<{ adAccountId: string; connectionId: string }> => {
    // Only while the org's switch is on: a write token is not made, or kept, for an org that has not turned running ads on.
    const setting = await ctx.trx.selectFrom('crove_ads.ad_org_setting').select('write_enabled').where('org_id', '=', ctx.orgId).orderBy('id').limit(1).executeTakeFirst();
    if (!setting?.write_enabled) throw new DomainError('ADS_WRITE_OFF', 409, 'Chủ sở hữu chưa bật việc chạy quảng cáo cho tổ chức này');
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'external_account_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isAdWriteProviderId(connection.provider)) throw new DomainError('ADS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối tài khoản quảng cáo');
    if (connection.status !== 'active') throw new DomainError('ADS_CONNECTION_INACTIVE', 422, 'Kết nối tài khoản quảng cáo không còn hoạt động; hãy kết nối lại');
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'write_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', READ_PROVIDER_OF_WRITE[connection.provider])
      .where('external_account_id', '=', connection.external_account_id)
      .forUpdate()
      .executeTakeFirst();
    // The account is the one the read connection linked: the write connection never makes an account of its own.
    if (!account) throw new DomainError('ADS_WRITE_NEEDS_READ', 409, 'Hãy kết nối tài khoản quảng cáo này để đọc số liệu trước, rồi mới kết nối để chạy quảng cáo');
    // A write connection made again replaces the one before it, which is closed so no spend-capable token is left behind.
    if (account.write_connection_id && account.write_connection_id !== connection.id) await closeWriteConnections(ctx, { adAccountId: account.id });
    await ctx.trx
      .updateTable('crove_ads.ad_account')
      .set({ write_connection_id: connection.id, write_granted_by_hash: input.grantedByHash ?? null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.id)
      .execute();
    ctx.audit({ adAccountId: account.id, connectionId: connection.id, provider: connection.provider });
    return { adAccountId: account.id, connectionId: connection.id };
  },
});

export const adsAccountDisconnect = defineCommand({
  name: 'ads.account.disconnect',
  input: z.strictObject({ adAccountId: zId }),
  // Closing is a stop: owners and admins, and it drops both sealed tokens. The account's row and figures stay (deleting them is its own
  // action).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; closed: number }> => {
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.channel_connection_id', 'a.write_enabled', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.adAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!account) throw notFound();
    let closed = await closeWriteConnections(ctx, { adAccountId: account.id });
    if (account.status !== 'revoked') {
      await ctx.run('kernel.channel.disconnect', { connectionId: account.channel_connection_id });
      closed += 1;
    }
    // Nothing is left to run ads with: its flag goes off with the connections.
    if (account.write_enabled) {
      await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: false, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', account.id).execute();
    }
    ctx.audit({ adAccountId: account.id, closed });
    return { adAccountId: account.id, closed };
  },
});

// What the API needs to make the sandbox's write connection of an account: the platform account the read connection linked (its key
// and currency, which no view carries) for the owner who connects it. Read only, no secret.
export const adsAccountWriteTarget = defineQuery({
  name: 'ads.account.write_target',
  input: z.strictObject({ adAccountId: zId }),
  access: OWNERS,
  handler: async (ctx, input): Promise<{ provider: string; externalAccountId: string; currency: string | null; name: string }> => {
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['provider', 'external_account_id', 'currency', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.adAccountId)
      .executeTakeFirst();
    if (!account) throw notFound();
    return { provider: account.provider, externalAccountId: account.external_account_id, currency: account.currency, name: account.name };
  },
});

export const writeConnectionCommands = [adsAccountLinkWrite, adsAccountDisconnect];
export const writeConnectionQueries = [adsAccountWriteTarget];
