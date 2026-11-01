// SPDX-License-Identifier: AGPL-3.0-only
// The stops and the state of running ads (ADR-0043, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.6 and 5.1, issue #2294,
// W0a-1). Nothing here calls an ad platform and nothing spends. What opens the way to spend (the org switch on, an account
// enabled, a cap set or raised, launches opened again) is a proposal, approved with four-eyes where the org has two people
// (ADR-0043 point 1), and comes in the next PR; the database already keeps those switches to a signed-in owner
// (crove_ads.switch_guard, cap_guard). What only stops or reduces spend is direct, and is here:
// - ads.write.disable (R2, owner): the switch off, every account's flag off, and launches blocked until an owner opens them again.
// - ads.account.disable_write (R2, owner): one account's flag off.
// - ads.pause_all (R2, owner and admin): the kill switch. It blocks launches at once; the pausing of what was launched comes with
//   the launch itself (W2), since nothing has been launched yet.
// - ads.write.state (query, owner and admin): the switches and the current caps.
// Module permissions (plan section 5.3) are not defined yet: the commands are the base roles' (owner, admin) until the drafting
// and approving commands of W1 give the permissions something to name.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zId, type AdsCapView, type AdsWriteState } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');

interface Setting {
  id: string;
  write_enabled: boolean;
  launches_blocked: boolean;
}

// The org's row of switches, made on first use and locked for the rest of the command, so two commands' changes queue. The
// database keeps it to one row per org (UNIQUE (org_id)); the advisory lock makes the first use of two commands at once wait for
// each other instead of one of them failing on the key.
async function lockedSetting(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<Setting> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.ads.setting:${ctx.orgId}`}, 0))`.execute(ctx.trx);
  const read = () =>
    ctx.trx.selectFrom('crove_ads.ad_org_setting').select(['id', 'write_enabled', 'launches_blocked']).where('org_id', '=', ctx.orgId).orderBy('id').limit(1).forUpdate().executeTakeFirst();
  const found = await read();
  if (found) return found;
  await ctx.trx.insertInto('crove_ads.ad_org_setting').values({ org_id: ctx.orgId }).execute();
  return (await read()) as Setting;
}

export const adsWriteDisable = defineCommand({
  name: 'ads.write.disable',
  input: z.strictObject({}),
  // Closes the path. The write tokens are closed with it in W0b and revoked at the platform with the launch queue (W2), which
  // is why it declares an external effect now: a switch-off is never quiet.
  risk: 'R2',
  sideEffect: 'external',
  access: OWNERS,
  handler: async (ctx): Promise<{ writeEnabled: false; accountsDisabled: number }> => {
    const setting = await lockedSetting(ctx);
    // Launches are blocked with it, so nothing queued or launched goes on spending while the owner decides what to do; opening
    // them again is an owner's proposal, on purpose (the stricter way back).
    await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ write_enabled: false, launches_blocked: true }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    const closed = await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: false }).where('org_id', '=', ctx.orgId).where('write_enabled', '=', true).returning('id').execute();
    ctx.audit({ writeEnabled: false, accountsDisabled: closed.length, wasEnabled: setting.write_enabled });
    return { writeEnabled: false, accountsDisabled: closed.length };
  },
});

export const adsAccountDisableWrite = defineCommand({
  name: 'ads.account.disable_write',
  input: z.strictObject({ adAccountId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  access: OWNERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; writeEnabled: false }> => {
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'write_enabled']).where('org_id', '=', ctx.orgId).where('id', '=', input.adAccountId).forUpdate().executeTakeFirst();
    if (!account) throw notFound();
    if (account.write_enabled) {
      await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: false, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', account.id).execute();
    }
    ctx.audit({ adAccountId: account.id, writeEnabled: false });
    return { adAccountId: account.id, writeEnabled: false };
  },
});

export const adsPauseAll = defineCommand({
  name: 'ads.pause_all',
  input: z.strictObject({}),
  // The kill switch: it only stops spend, so it needs no proposal and no second factor, and speed is the point.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx): Promise<{ launchesBlocked: true; paused: number }> => {
    const setting = await lockedSetting(ctx);
    if (!setting.launches_blocked) {
      await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ launches_blocked: true }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    }
    // Nothing has been launched from Ludy yet, so there is nothing to pause at a platform: the count is the objects paused.
    ctx.audit({ launchesBlocked: true, paused: 0 });
    return { launchesBlocked: true, paused: 0 };
  },
});

// The switches and the current cap of each scope, account and period (the latest row), without the caps of an account the
// caller does not read (its row is hidden by the entity policy).
export const adsWriteState = defineQuery({
  name: 'ads.write.state',
  input: z.object({}),
  access: MANAGERS,
  handler: async (ctx: QueryContext): Promise<AdsWriteState> => {
    const setting = await ctx.trx.selectFrom('crove_ads.ad_org_setting').select(['write_enabled', 'launches_blocked', 'updated_at']).where('org_id', '=', ctx.orgId).orderBy('id').limit(1).executeTakeFirst();
    // The latest of each is the newest id, which the database stamps at insert (crove_ads.cap_guard).
    const { rows } = await sql<{ scope: 'org' | 'account'; ad_account_id: string | null; period: 'daily' | 'monthly'; amount: string; currency: string; set_by: string; set_at: Date }>`
      SELECT DISTINCT ON (c.scope, c.ad_account_id, c.period) c.scope, c.ad_account_id, c.period, c.amount::text AS amount, c.currency, c.set_by, c.set_at
      FROM crove_ads.ad_spend_cap c
      LEFT JOIN crove_ads.ad_account a ON a.org_id = c.org_id AND a.id = c.ad_account_id
      WHERE c.org_id = ${ctx.orgId} AND (c.scope = 'org' OR a.id IS NOT NULL)
      ORDER BY c.scope, c.ad_account_id, c.period, c.id DESC`.execute(ctx.trx);
    const caps: AdsCapView[] = rows.map((r) => ({ scope: r.scope, adAccountId: r.ad_account_id, period: r.period, amount: r.amount, currency: r.currency, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() }));
    return {
      writeEnabled: setting?.write_enabled ?? false,
      launchesBlocked: setting?.launches_blocked ?? false,
      updatedAt: setting ? new Date(setting.updated_at).toISOString() : null,
      caps,
    };
  },
});

export const writeCommands = [adsWriteDisable, adsAccountDisableWrite, adsPauseAll];
export const writeQueries = [adsWriteState];
