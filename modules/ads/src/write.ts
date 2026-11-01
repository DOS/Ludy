// SPDX-License-Identifier: AGPL-3.0-only
// The switches and the spend caps of running ads (ADR-0043, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.6 and 5.1, issue
// #2294, W0a). Nothing here calls an ad platform and nothing spends: it decides whether ad writing may be offered at all, and
// the money fences a later launch must stay inside.
// - ads.write.enable (R3, owner): the org switch, off by default. Only with it on may an ad account be enabled for writing, and
//   (W0b) a token that can change campaigns be accepted.
// - ads.write.disable (R2, owner): the switch off, every account's flag off, and launches blocked until an owner clears the flag.
// - ads.account.enable_write (R3, owner), ads.account.disable_write (R2, owner): one account's flag.
// - ads.cap.set (R3, owner): a daily or monthly spend cap of the org or of one account, in a currency; a row per change. With
//   no cap there is no launch (checked by the launch, W2).
// - ads.pause_all (R2, owner and admin): the kill switch. It blocks launches at once; the pausing of what was launched comes with
//   the launch itself (W2), since nothing has been launched yet.
// - ads.launches.unblock (R3, owner): clears the block that pause_all or a switch-off set.
// - ads.write.state (query, owner and admin): the switches and the current caps.
// Module permissions (plan section 5.3) are not defined yet: the commands are the base roles' (owner, admin) until the drafting
// and approving commands of W1 give the permissions something to name.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zAdsCapSet, zId, type AdsCapView, type AdsWriteState } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
const writeOff = () => new DomainError('ADS_WRITE_OFF', 409, 'Chủ sở hữu chưa bật việc chạy quảng cáo cho tổ chức này');

interface Setting {
  id: string;
  write_enabled: boolean;
  launches_blocked: boolean;
}

// The org's row of switches, made on first use and locked for the rest of the command, so two owners' changes queue. The row is
// the org's one by this lock, not by a unique key (the first by id is read, were there ever two).
async function lockedSetting(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<Setting> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.ads.setting:${ctx.orgId}`}, 0))`.execute(ctx.trx);
  const read = () =>
    ctx.trx.selectFrom('crove_ads.ad_org_setting').select(['id', 'write_enabled', 'launches_blocked']).where('org_id', '=', ctx.orgId).orderBy('id').limit(1).forUpdate().executeTakeFirst();
  const found = await read();
  if (found) return found;
  await ctx.trx.insertInto('crove_ads.ad_org_setting').values({ org_id: ctx.orgId }).execute();
  return (await read()) as Setting;
}

const by = (ctx: Pick<CommandContext, 'actor'>): string | null => (ctx.actor.type === 'user' ? ctx.actor.userId : null);

export const adsWriteEnable = defineCommand({
  name: 'ads.write.enable',
  input: z.strictObject({}),
  // Opens the path to spend money on a platform for the whole org: the policy of ADR-0043 point 3 (a second factor verified in the
  // last five minutes, the owner alone), as the owner's other R3 switches.
  risk: 'R3',
  sideEffect: 'financial',
  access: OWNERS,
  handler: async (ctx): Promise<{ writeEnabled: true; changed: boolean }> => {
    const setting = await lockedSetting(ctx);
    if (setting.write_enabled) return { writeEnabled: true, changed: false };
    await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ write_enabled: true, updated_by: by(ctx), updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    ctx.audit({ writeEnabled: true });
    return { writeEnabled: true, changed: true };
  },
});

export const adsWriteDisable = defineCommand({
  name: 'ads.write.disable',
  input: z.strictObject({}),
  // Closes the path again. The write tokens are revoked at the platform by the job of W0b, which is why it declares an external
  // effect now: a switch-off is never quiet.
  risk: 'R2',
  sideEffect: 'external',
  access: OWNERS,
  handler: async (ctx): Promise<{ writeEnabled: false; accountsDisabled: number }> => {
    const setting = await lockedSetting(ctx);
    // Launches are blocked with it, so nothing queued or launched goes on spending while the owner decides what to do; an
    // owner who turns writing on again clears the block on purpose (ads.launches.unblock).
    await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ write_enabled: false, launches_blocked: true, updated_by: by(ctx), updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    const closed = await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: false }).where('org_id', '=', ctx.orgId).where('write_enabled', '=', true).returning('id').execute();
    ctx.audit({ writeEnabled: false, accountsDisabled: closed.length, wasEnabled: setting.write_enabled });
    return { writeEnabled: false, accountsDisabled: closed.length };
  },
});

const zAccount = z.strictObject({ adAccountId: zId });

export const adsAccountEnableWrite = defineCommand({
  name: 'ads.account.enable_write',
  input: zAccount,
  // One account may be run from Ludy: the same fence as the org switch, per account.
  risk: 'R3',
  sideEffect: 'financial',
  access: OWNERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; writeEnabled: true }> => {
    const setting = await lockedSetting(ctx);
    if (!setting.write_enabled) throw writeOff();
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'write_enabled']).where('org_id', '=', ctx.orgId).where('id', '=', input.adAccountId).forUpdate().executeTakeFirst();
    if (!account) throw notFound();
    if (!account.write_enabled) {
      await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: true, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', account.id).execute();
    }
    ctx.audit({ adAccountId: account.id, writeEnabled: true });
    return { adAccountId: account.id, writeEnabled: true };
  },
});

export const adsAccountDisableWrite = defineCommand({
  name: 'ads.account.disable_write',
  input: zAccount,
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

const capCurrency = () => new DomainError('ADS_CAP_CURRENCY', 422, 'Hạn mức phải tính bằng tiền của tài khoản quảng cáo, và hạn mức của tổ chức bằng một loại tiền duy nhất');

export const adsCapSet = defineCommand({
  name: 'ads.cap.set',
  input: zAdsCapSet,
  // A cap raised is spend raised, so every change is the owner's, behind a second factor.
  risk: 'R3',
  sideEffect: 'financial',
  access: OWNERS,
  target: (input) => (input.adAccountId ? { type: 'ads.ad_account', id: input.adAccountId } : null),
  handler: async (ctx, input): Promise<{ capId: string; previous: string | null }> => {
    let accountCurrency: string | null = null;
    if (input.scope === 'account') {
      const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'currency']).where('org_id', '=', ctx.orgId).where('id', '=', input.adAccountId as string).forUpdate().executeTakeFirst();
      if (!account) throw notFound();
      // The account's currency is the platform's, read by its first sync: a cap before that would be in a guess.
      if (account.currency === null) throw new DomainError('ADS_CAP_ACCOUNT_UNSYNCED', 422, 'Tài khoản này chưa được cập nhật lần nào nên chưa biết loại tiền; hãy đặt hạn mức sau lần cập nhật đầu');
      accountCurrency = account.currency;
      if (input.currency !== accountCurrency) throw capCurrency();
    } else {
      // One currency for the org's caps: another one beside it would add up to nothing a launch can check.
      await lockedSetting(ctx);
      const other = await ctx.trx.selectFrom('crove_ads.ad_spend_cap').select('currency').where('org_id', '=', ctx.orgId).where('scope', '=', 'org').where('currency', '<>', input.currency).limit(1).executeTakeFirst();
      if (other) throw capCurrency();
    }
    const latest = await ctx.trx
      .selectFrom('crove_ads.ad_spend_cap')
      .select('amount')
      .where('org_id', '=', ctx.orgId)
      .where('scope', '=', input.scope)
      .where('period', '=', input.period)
      .where((eb) => (input.adAccountId ? eb('ad_account_id', '=', input.adAccountId) : eb('ad_account_id', 'is', null)))
      .orderBy('set_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const inserted = await ctx.trx
      .insertInto('crove_ads.ad_spend_cap')
      .values({ org_id: ctx.orgId, scope: input.scope, ad_account_id: input.adAccountId ?? null, period: input.period, amount: input.amount, currency: input.currency, set_by: by(ctx) as string })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ scope: input.scope, adAccountId: input.adAccountId ?? null, period: input.period, amount: input.amount, currency: input.currency, previous: latest?.amount ?? null });
    return { capId: inserted.id, previous: latest?.amount ?? null };
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
      await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ launches_blocked: true, updated_by: by(ctx), updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    }
    // Nothing has been launched from Ludy yet, so there is nothing to pause at a platform: the count is the objects paused.
    ctx.audit({ launchesBlocked: true, paused: 0 });
    return { launchesBlocked: true, paused: 0 };
  },
});

export const adsLaunchesUnblock = defineCommand({
  name: 'ads.launches.unblock',
  input: z.strictObject({}),
  // Lets launches, activations and resumes through again: spend restarts, so it is the owner's, behind a second factor.
  risk: 'R3',
  sideEffect: 'financial',
  access: OWNERS,
  handler: async (ctx): Promise<{ launchesBlocked: false }> => {
    const setting = await lockedSetting(ctx);
    if (setting.launches_blocked) {
      await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ launches_blocked: false, updated_by: by(ctx), updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    }
    ctx.audit({ launchesBlocked: false });
    return { launchesBlocked: false };
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
    const { rows } = await sql<{ scope: 'org' | 'account'; ad_account_id: string | null; period: 'daily' | 'monthly'; amount: string; currency: string; set_by: string; set_at: Date }>`
      SELECT DISTINCT ON (c.scope, c.ad_account_id, c.period) c.scope, c.ad_account_id, c.period, c.amount::text AS amount, c.currency, c.set_by, c.set_at
      FROM crove_ads.ad_spend_cap c
      LEFT JOIN crove_ads.ad_account a ON a.org_id = c.org_id AND a.id = c.ad_account_id
      WHERE c.org_id = ${ctx.orgId} AND (c.scope = 'org' OR a.id IS NOT NULL)
      ORDER BY c.scope, c.ad_account_id, c.period, c.set_at DESC, c.id DESC`.execute(ctx.trx);
    const caps: AdsCapView[] = rows.map((r) => ({ scope: r.scope, adAccountId: r.ad_account_id, period: r.period, amount: r.amount, currency: r.currency, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() }));
    return {
      writeEnabled: setting?.write_enabled ?? false,
      launchesBlocked: setting?.launches_blocked ?? false,
      updatedAt: setting ? new Date(setting.updated_at).toISOString() : null,
      caps,
    };
  },
});

export const writeCommands = [adsWriteEnable, adsWriteDisable, adsAccountEnableWrite, adsAccountDisableWrite, adsCapSet, adsPauseAll, adsLaunchesUnblock];
export const writeQueries = [adsWriteState];
