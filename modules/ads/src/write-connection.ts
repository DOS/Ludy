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
import { AD_WRITE_PROVIDERS, READ_PROVIDER_OF_WRITE, isAdWriteProviderId, zAdsAccountLinkWrite, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');

// Closes the write connections of one account, or of every account of the org, that are not closed yet (a connection that expired or
// failed still holds a sealed token), as the caller: the kernel's disconnect closes it and drops the sealed token. As the system (the
// platform's deletion request) the kernel's platform-deletion close does the same. Returns how many it closed.
// It does not go through `ad_account.write_connection_id` alone: a write connection made by the sign-in dialog exists before it is
// attached, so one whose attaching was refused or never ran (a crash, a deploy) is still found, by its provider, and so is the one of an
// account, by the provider of its twin and its platform account. Switching writing off leaves no spend-capable token behind that no
// account refers to. `except` spares the connection that was just attached.
export async function closeWriteConnections(ctx: CommandContext, scope: { adAccountId?: string; except?: string }): Promise<number> {
  let query = ctx.trx.selectFrom('crove_kernel.channel_connection as c').select('c.id').where('c.org_id', '=', ctx.orgId).where('c.status', '<>', 'revoked').orderBy('c.id');
  if (scope.adAccountId) {
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['provider', 'external_account_id', 'write_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', scope.adAccountId)
      .executeTakeFirst();
    if (!account) return 0;
    const twin = AD_WRITE_PROVIDERS.find((write) => READ_PROVIDER_OF_WRITE[write] === account.provider);
    if (!twin && !account.write_connection_id) return 0;
    query = query.where((eb) => {
      const found = [];
      if (twin) found.push(eb.and([eb('c.provider', '=', twin), eb('c.external_account_id', '=', account.external_account_id)]));
      if (account.write_connection_id) found.push(eb('c.id', '=', account.write_connection_id));
      return eb.or(found);
    });
  } else {
    query = query.where('c.provider', 'in', [...AD_WRITE_PROVIDERS]);
  }
  if (scope.except) query = query.where('c.id', '<>', scope.except);
  const open = await query.execute();
  const command = ctx.actor.type === 'system' ? 'kernel.channel.revoke_by_platform' : 'kernel.channel.disconnect';
  for (const row of open) await ctx.run(command, { connectionId: row.id });
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
    // Only while the org's switch is on: a write token is not made, or kept, for an org that has not turned running ads on. The setting
    // is read FOR SHARE: a switch-off running at the same moment (it locks the setting FOR UPDATE and then closes what is linked) either
    // commits first, and this refuses, or waits for this command and then closes the connection it attached.
    const setting = await ctx.trx.selectFrom('crove_ads.ad_org_setting').select('write_enabled').where('org_id', '=', ctx.orgId).orderBy('id').limit(1).forShare().executeTakeFirst();
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
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as rc', (j) => j.onRef('rc.org_id', '=', 'a.org_id').onRef('rc.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.write_connection_id', 'rc.status as read_status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.provider', '=', READ_PROVIDER_OF_WRITE[connection.provider])
      .where('a.external_account_id', '=', connection.external_account_id)
      .forUpdate('a')
      .executeTakeFirst();
    // The account is the one the read connection linked, and its read connection is not closed: the write connection never makes an
    // account of its own, and an account an owner or admin disconnected is not given one again by a sign-in made for another account.
    if (!account || account.read_status === 'revoked') throw new DomainError('ADS_WRITE_NEEDS_READ', 409, 'Hãy kết nối tài khoản quảng cáo này để đọc số liệu trước, rồi mới kết nối để chạy quảng cáo');
    // A write connection made again replaces the one before it, which is closed so no spend-capable token is left behind.
    if (account.write_connection_id && account.write_connection_id !== connection.id) await closeWriteConnections(ctx, { adAccountId: account.id, except: connection.id });
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

// The platform's data deletion request, for an account whose write connection the person granted but whose read connection somebody else
// did (run by the worker): the write connection is closed as a platform's deletion closes it, its sealed token dropped, and the account
// forgets it (and its grantor). The account itself stays, read by the grant that made it. Its flag is left as it is: the switch guard
// lets only a signed-in user change it (a system update of it rolls the whole closing back), the owner withdraws it, and nothing can run
// without a live write connection (W2 launches only with both).
export const adsAccountForgetWrite = defineCommand({
  name: 'ads.account.forget_write',
  input: z.strictObject({ adAccountId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; closed: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.adAccountId).forUpdate().executeTakeFirst();
    if (!account) return { adAccountId: input.adAccountId, closed: 0 };
    const closed = await closeWriteConnections(ctx, { adAccountId: account.id });
    await ctx.trx
      .updateTable('crove_ads.ad_account')
      .set({ write_connection_id: null, write_granted_by_hash: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.id)
      .execute();
    ctx.audit({ adAccountId: account.id, closed, source: 'platform_deletion' });
    return { adAccountId: account.id, closed };
  },
});

// Which of the platform accounts a sign-in reached are linked for reading with a read connection that is not closed (the owner's
// "connect to run ads" connects only those: a connection is not made, and its token not sealed, for an account that could not take
// it). Read only, nothing about the platform's own answer is stored.
export const adsAccountWriteReady = defineQuery({
  name: 'ads.account.write_ready',
  input: z.strictObject({ provider: z.enum(AD_WRITE_PROVIDERS), externalAccountIds: z.array(z.string().min(1).max(200)).max(100) }),
  access: OWNERS,
  handler: async (ctx, input): Promise<string[]> => {
    if (input.externalAccountIds.length === 0) return [];
    const rows = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as rc', (j) => j.onRef('rc.org_id', '=', 'a.org_id').onRef('rc.id', '=', 'a.channel_connection_id'))
      .select('a.external_account_id')
      .where('a.org_id', '=', ctx.orgId)
      .where('a.provider', '=', READ_PROVIDER_OF_WRITE[input.provider])
      .where('a.external_account_id', 'in', input.externalAccountIds)
      .where('rc.status', '<>', 'revoked')
      .execute();
    return rows.map((r) => r.external_account_id);
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

export const writeConnectionCommands = [adsAccountLinkWrite, adsAccountDisconnect, adsAccountForgetWrite];
export const writeConnectionQueries = [adsAccountWriteTarget, adsAccountWriteReady];
