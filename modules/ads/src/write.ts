// SPDX-License-Identifier: AGPL-3.0-only
// The switches, the caps and the requests of running ads (ADR-0043, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.6 and 5.1,
// issue #2294, W0a). Nothing here calls an ad platform and nothing spends. Two kinds of command:
// - What opens the way to spend is a proposal (ADR-0043 point 1): the org switch on (ads.write.enable), one account enabled
//   (ads.account.enable_write), a cap set or raised (ads.cap.set) and launches opened again after a block
//   (ads.launches.unblock). Each is asked for through a preparer (R1, owners and admins) that checks the request against the
//   database and builds the proposal, and runs only when approved: R3 `financial`, `access: 'proposal'`, approved by an owner
//   or admin who is not an author of it (P10, with the one-person path), behind a fresh second factor (P11). The database
//   lets the change through for an owner and for the execution of that approved proposal alone (crove_ads.switch_guard,
//   cap_guard, approved_execution), so no other path writes it.
// - What only stops or reduces spend is direct: ads.write.disable (R2, owner), ads.account.disable_write (R2, owner),
//   ads.pause_all (R2, owner and admin: the kill switch; it blocks launches at once, and the pausing of what was launched comes
//   with the launch itself, W2, since nothing has been launched yet) and ads.cap.lower (R2, owner).
// - ads.write.state and ads.proposal.change (queries, owners and admins): the switches, the current caps and the requests
//   waiting in the Inbox, and what one Inbox item of an ads kind changes.
// Module permissions (plan section 5.3) are not defined yet: the commands are the base roles' (owner, admin) until the drafting
// and approving commands of W1 give the permissions something to name.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import {
  ADS_ACCOUNT_ENABLE_COMMAND,
  ADS_ACCOUNT_ENABLE_KIND,
  ADS_CAP_SET_COMMAND,
  ADS_CAP_SET_KIND,
  ADS_LAUNCHES_UNBLOCK_COMMAND,
  ADS_LAUNCHES_UNBLOCK_KIND,
  ADS_WRITE_ENABLE_COMMAND,
  ADS_WRITE_ENABLE_KIND,
  zAdsAccountEnablePayload,
  zAdsCapLower,
  zAdsCapRequest,
  zAdsCapSetPayload,
  zAdsLaunchesUnblockPayload,
  zAdsWriteEnablePayload,
  zId,
  type AdsCapView,
  type AdsChange,
  type AdsWriteState,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
const writeOff = () => new DomainError('ADS_WRITE_OFF', 409, 'Chủ sở hữu chưa bật việc chạy quảng cáo cho tổ chức này');
const onlyApproved = () => new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');

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

// The org's switches as they stand, without making the row or locking it (the preparers only look).
const currentSetting = (ctx: Pick<CommandContext, 'trx' | 'orgId'>) =>
  ctx.trx.selectFrom('crove_ads.ad_org_setting').select(['write_enabled', 'launches_blocked']).where('org_id', '=', ctx.orgId).orderBy('id').limit(1).executeTakeFirst();

// One question at a time: a request is refused while a pending proposal of the same command (and, where the change names a
// target, for the same target: an account, or a cap's scope, account and period) waits in the Inbox.
async function refuseOpenRequest(ctx: Pick<CommandContext, 'trx' | 'orgId'>, command: string, match: Record<string, string> | null): Promise<void> {
  let query = ctx.trx.selectFrom('crove_kernel.proposal').select('id').where('org_id', '=', ctx.orgId).where('command', '=', command).where('status', '=', 'pending');
  if (match) query = query.where(sql<boolean>`payload @> ${JSON.stringify(match)}::jsonb`);
  if (await query.limit(1).executeTakeFirst()) {
    throw new DomainError('ADS_REQUEST_OPEN', 409, 'Đã có một đề xuất giống thế đang chờ duyệt trong Hộp thư');
  }
}

interface CapRow {
  amount: string;
  currency: string;
  // How the new amount compares with this one, decided in the database (money is never compared as a JS number).
  not_above: boolean;
  below: boolean;
}

// The cap in force for a scope, account and period (the newest row, whose id the database stamped at insert), and whether the
// amount asked for is not above it.
async function currentCap(
  ctx: Pick<CommandContext, 'trx' | 'orgId'>,
  cap: { scope: 'org' | 'account'; adAccountId?: string | undefined; period: 'daily' | 'monthly'; amount: string },
): Promise<CapRow | undefined> {
  const { rows } = await sql<CapRow>`
    SELECT c.amount::text AS amount, c.currency, (${cap.amount}::numeric <= c.amount) AS not_above, (${cap.amount}::numeric < c.amount) AS below
    FROM crove_ads.ad_spend_cap c
    WHERE c.org_id = ${ctx.orgId}::uuid AND c.scope = ${cap.scope} AND c.period = ${cap.period}
      AND c.ad_account_id IS NOT DISTINCT FROM ${cap.adAccountId ?? null}::uuid
    ORDER BY c.id DESC
    LIMIT 1`.execute(ctx.trx);
  return rows[0];
}

// The account a cap or an enabling names, in the caller's entity scope, and for a cap its currency checked against the cap's.
async function capAccount(ctx: Pick<CommandContext, 'trx' | 'orgId'>, adAccountId: string, currency: string, lock: boolean) {
  let query = ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'name', 'currency', 'legal_entity_id']).where('org_id', '=', ctx.orgId).where('id', '=', adAccountId);
  if (lock) query = query.forUpdate();
  const account = await query.executeTakeFirst();
  if (!account) throw notFound();
  // The account's currency is the platform's, read by its first sync: a cap before that would be in a guess.
  if (account.currency === null) throw new DomainError('ADS_CAP_ACCOUNT_UNSYNCED', 422, 'Tài khoản này chưa được cập nhật lần nào nên chưa biết loại tiền; hãy đặt hạn mức sau lần cập nhật đầu');
  if (account.currency !== currency) throw new DomainError('ADS_CAP_CURRENCY', 422, 'Hạn mức của một tài khoản phải tính bằng tiền của tài khoản quảng cáo đó');
  return account;
}

const PERIOD_WORDS = { daily: 'theo ngày', monthly: 'theo tháng' } as const;

// ---------------------------------------------------------------------------------------------------------------
// The preparers: they check a request against the database and build the proposal; they write nothing.
// ---------------------------------------------------------------------------------------------------------------

export const adsWritePrepareEnable = defineCommand({
  name: 'ads.write.prepare_enable',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx) => {
    if ((await currentSetting(ctx))?.write_enabled) throw new DomainError('ADS_WRITE_ALREADY_ON', 409, 'Việc chạy quảng cáo đã được bật cho tổ chức');
    await refuseOpenRequest(ctx, ADS_WRITE_ENABLE_COMMAND, null);
    return { kind: ADS_WRITE_ENABLE_KIND, command: ADS_WRITE_ENABLE_COMMAND, title: 'Bật chạy quảng cáo cho tổ chức', payload: {} };
  },
});

export const adsAccountPrepareEnableWrite = defineCommand({
  name: 'ads.account.prepare_enable_write',
  input: z.strictObject({ adAccountId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input) => {
    // One spelling of the id in every payload, so open requests are found by it and the database's check matches it.
    const adAccountId = input.adAccountId.toLowerCase();
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'name', 'write_enabled', 'legal_entity_id']).where('org_id', '=', ctx.orgId).where('id', '=', adAccountId).executeTakeFirst();
    if (!account) throw notFound();
    if (!(await currentSetting(ctx))?.write_enabled) throw writeOff();
    if (account.write_enabled) throw new DomainError('ADS_ACCOUNT_ALREADY_ON', 409, 'Tài khoản này đã được phép chạy quảng cáo');
    await refuseOpenRequest(ctx, ADS_ACCOUNT_ENABLE_COMMAND, { adAccountId });
    return {
      kind: ADS_ACCOUNT_ENABLE_KIND,
      command: ADS_ACCOUNT_ENABLE_COMMAND,
      title: `Cho phép chạy quảng cáo trên tài khoản ${account.name}`.slice(0, 300),
      payload: { adAccountId, adAccountName: account.name.slice(0, 200) },
      // The proposal belongs to the account's legal entity (#1538).
      legalEntityId: account.legal_entity_id,
    };
  },
});

export const adsCapPrepareSet = defineCommand({
  name: 'ads.cap.prepare_set',
  input: zAdsCapRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => (input.adAccountId ? { type: 'ads.ad_account', id: input.adAccountId } : null),
  handler: async (ctx, input) => {
    const adAccountId = input.adAccountId?.toLowerCase();
    let accountName: string | undefined;
    let legalEntityId: string | undefined;
    if (input.scope === 'account') {
      const account = await capAccount(ctx, adAccountId as string, input.currency, false);
      accountName = account.name.slice(0, 200);
      legalEntityId = account.legal_entity_id;
    }
    const previous = await currentCap(ctx, { ...input, adAccountId });
    // Lowering a cap is the owner's direct command (ads.cap.lower): this proposal sets one or raises one. A cap in another
    // currency than the one in force is a new cap, not a comparison.
    if (previous && previous.currency === input.currency && previous.not_above) {
      throw new DomainError('ADS_CAP_NOT_RAISED', 422, 'Hạn mức này không cao hơn hạn mức đang có; hãy dùng Giảm hạn mức, không cần duyệt');
    }
    await refuseOpenRequest(ctx, ADS_CAP_SET_COMMAND, { scope: input.scope, period: input.period, ...(adAccountId ? { adAccountId } : {}) });
    const where = input.scope === 'org' ? 'của cả tổ chức' : `của tài khoản ${accountName}`;
    return {
      kind: ADS_CAP_SET_KIND,
      command: ADS_CAP_SET_COMMAND,
      title: `Đặt hạn mức chi tiêu quảng cáo ${PERIOD_WORDS[input.period]} ${where}: ${input.amount} ${input.currency}`.slice(0, 300),
      payload: {
        scope: input.scope,
        ...(adAccountId ? { adAccountId, adAccountName: accountName } : {}),
        period: input.period,
        amount: input.amount,
        currency: input.currency,
        previous: previous?.amount ?? null,
        previousCurrency: previous?.currency ?? null,
      },
      ...(legalEntityId ? { legalEntityId } : {}),
    };
  },
});

export const adsLaunchesPrepareUnblock = defineCommand({
  name: 'ads.launches.prepare_unblock',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx) => {
    if (!(await currentSetting(ctx))?.launches_blocked) throw new DomainError('ADS_LAUNCHES_NOT_BLOCKED', 409, 'Các lần chạy quảng cáo hiện không bị chặn');
    await refuseOpenRequest(ctx, ADS_LAUNCHES_UNBLOCK_COMMAND, null);
    return { kind: ADS_LAUNCHES_UNBLOCK_KIND, command: ADS_LAUNCHES_UNBLOCK_COMMAND, title: 'Mở lại việc chạy quảng cáo sau khi bị chặn', payload: {} };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The commands an approved proposal runs (access 'proposal': only through kernel.proposal.approve, which passes the stored
// payload and acceptFailedChecks, and runs them as the approver in the approving transaction).
// ---------------------------------------------------------------------------------------------------------------

export const adsWriteEnable = defineCommand({
  name: ADS_WRITE_ENABLE_COMMAND,
  input: z.object({ payload: zAdsWriteEnablePayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_WRITE_ENABLE_KIND,
  handler: async (ctx): Promise<{ writeEnabled: true; changed: boolean }> => {
    if (!ctx.proposalId) throw onlyApproved();
    const setting = await lockedSetting(ctx);
    if (setting.write_enabled) return { writeEnabled: true, changed: false };
    await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ write_enabled: true }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    ctx.audit({ writeEnabled: true });
    return { writeEnabled: true, changed: true };
  },
});

export const adsAccountEnableWrite = defineCommand({
  name: ADS_ACCOUNT_ENABLE_COMMAND,
  input: z.object({ payload: zAdsAccountEnablePayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_ACCOUNT_ENABLE_KIND,
  target: (input) => ({ type: 'ads.ad_account', id: input.payload.adAccountId }),
  handler: async (ctx, { payload }): Promise<{ adAccountId: string; writeEnabled: true }> => {
    if (!ctx.proposalId) throw onlyApproved();
    const setting = await lockedSetting(ctx);
    // The switch may have been turned off since it was asked for: an account is enabled only while the org's is on.
    if (!setting.write_enabled) throw writeOff();
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'write_enabled']).where('org_id', '=', ctx.orgId).where('id', '=', payload.adAccountId.toLowerCase()).forUpdate().executeTakeFirst();
    if (!account) throw notFound();
    if (!account.write_enabled) {
      await ctx.trx.updateTable('crove_ads.ad_account').set({ write_enabled: true, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', account.id).execute();
    }
    ctx.audit({ adAccountId: account.id, writeEnabled: true });
    return { adAccountId: account.id, writeEnabled: true };
  },
});

export const adsCapSet = defineCommand({
  name: ADS_CAP_SET_COMMAND,
  input: z.object({ payload: zAdsCapSetPayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_CAP_SET_KIND,
  target: (input) => (input.payload.adAccountId ? { type: 'ads.ad_account', id: input.payload.adAccountId } : null),
  handler: async (ctx, { payload }): Promise<{ capId: string; previous: string | null }> => {
    if (!ctx.proposalId) throw onlyApproved();
    if (ctx.actor.type !== 'user') throw onlyApproved();
    // The org's caps are taken one at a time under the org's lock, so "the latest" is the order they were inserted in.
    await lockedSetting(ctx);
    const adAccountId = payload.adAccountId?.toLowerCase();
    // The account and its currency as they are now: the proposal may be old.
    if (payload.scope === 'account') await capAccount(ctx, adAccountId as string, payload.currency, true);
    const previous = await currentCap(ctx, { scope: payload.scope, adAccountId, period: payload.period, amount: payload.amount });
    const inserted = await ctx.trx
      .insertInto('crove_ads.ad_spend_cap')
      // The database stamps the id, who set it and when (crove_ads.cap_guard); set_by is the approver's, the one whose
      // approval this is.
      .values({ org_id: ctx.orgId, scope: payload.scope, ad_account_id: adAccountId ?? null, period: payload.period, amount: payload.amount, currency: payload.currency, set_by: ctx.actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ scope: payload.scope, adAccountId: adAccountId ?? null, period: payload.period, amount: payload.amount, currency: payload.currency, previous: previous?.amount ?? null });
    return { capId: inserted.id, previous: previous?.amount ?? null };
  },
});

export const adsLaunchesUnblock = defineCommand({
  name: ADS_LAUNCHES_UNBLOCK_COMMAND,
  input: z.object({ payload: zAdsLaunchesUnblockPayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_LAUNCHES_UNBLOCK_KIND,
  handler: async (ctx): Promise<{ launchesBlocked: false }> => {
    if (!ctx.proposalId) throw onlyApproved();
    const setting = await lockedSetting(ctx);
    if (setting.launches_blocked) {
      await ctx.trx.updateTable('crove_ads.ad_org_setting').set({ launches_blocked: false }).where('org_id', '=', ctx.orgId).where('id', '=', setting.id).execute();
    }
    ctx.audit({ launchesBlocked: false });
    return { launchesBlocked: false };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What only stops or reduces spend: direct.
// ---------------------------------------------------------------------------------------------------------------

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
    // Launches are blocked with it, so nothing queued or launched goes on spending while the owner decides what to do;
    // opening them again is a proposal, on purpose (the stricter way back).
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

export const adsCapLower = defineCommand({
  name: 'ads.cap.lower',
  input: zAdsCapLower,
  // A lower cap only reduces what may be spent, so it needs no proposal and no second factor: the owner's, in the cap's own
  // currency, and only below the cap in force.
  risk: 'R2',
  sideEffect: 'external',
  access: OWNERS,
  target: (input) => (input.adAccountId ? { type: 'ads.ad_account', id: input.adAccountId } : null),
  handler: async (ctx, input): Promise<{ capId: string; previous: string }> => {
    if (ctx.actor.type !== 'user') throw onlyApproved();
    await lockedSetting(ctx);
    const adAccountId = input.adAccountId?.toLowerCase();
    if (input.scope === 'account') {
      const account = await ctx.trx.selectFrom('crove_ads.ad_account').select('id').where('org_id', '=', ctx.orgId).where('id', '=', adAccountId as string).forUpdate().executeTakeFirst();
      if (!account) throw notFound();
    }
    const previous = await currentCap(ctx, { ...input, adAccountId });
    if (!previous) throw new DomainError('ADS_CAP_NOT_SET', 409, 'Chưa có hạn mức để giảm; hãy đề xuất đặt hạn mức trước');
    // Strictly below: a cap that stays or rises is a proposal's to make.
    if (!previous.below) throw new DomainError('ADS_CAP_NOT_LOWER', 422, 'Hạn mức mới phải thấp hơn hạn mức đang có');
    const inserted = await ctx.trx
      .insertInto('crove_ads.ad_spend_cap')
      .values({ org_id: ctx.orgId, scope: input.scope, ad_account_id: adAccountId ?? null, period: input.period, amount: input.amount, currency: previous.currency, set_by: ctx.actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ scope: input.scope, adAccountId: adAccountId ?? null, period: input.period, amount: input.amount, currency: previous.currency, previous: previous.amount, lowered: true });
    return { capId: inserted.id, previous: previous.amount };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

// What a proposal of an ads kind changes, from its kind and stored payload; null for any other kind or a payload that does not
// parse (a screen then shows the title alone).
function changeOf(kind: string, raw: unknown): AdsChange | null {
  switch (kind) {
    case ADS_WRITE_ENABLE_KIND:
      return zAdsWriteEnablePayload.safeParse(raw).success ? { change: 'write_enable' } : null;
    case ADS_ACCOUNT_ENABLE_KIND: {
      const p = zAdsAccountEnablePayload.safeParse(raw);
      return p.success ? { change: 'account_enable', adAccountId: p.data.adAccountId, adAccountName: p.data.adAccountName } : null;
    }
    case ADS_CAP_SET_KIND: {
      const p = zAdsCapSetPayload.safeParse(raw);
      if (!p.success) return null;
      return {
        change: 'cap_set',
        scope: p.data.scope,
        adAccountId: p.data.adAccountId ?? null,
        adAccountName: p.data.adAccountName ?? null,
        period: p.data.period,
        amount: p.data.amount,
        currency: p.data.currency,
        previous: p.data.previous,
        previousCurrency: p.data.previousCurrency,
      };
    }
    case ADS_LAUNCHES_UNBLOCK_KIND:
      return zAdsLaunchesUnblockPayload.safeParse(raw).success ? { change: 'launches_unblock' } : null;
    default:
      return null;
  }
}

const ADS_KINDS = [ADS_WRITE_ENABLE_KIND, ADS_ACCOUNT_ENABLE_KIND, ADS_CAP_SET_KIND, ADS_LAUNCHES_UNBLOCK_KIND];

// What one Inbox item of an ads kind changes (the approval card shows it). Another org's id and a kind that is not an ads one
// read as nothing.
export const adsProposalChange = defineQuery({
  name: 'ads.proposal.change',
  input: z.strictObject({ id: zId }),
  access: MANAGERS,
  handler: async (ctx, input) => {
    const row = await ctx.trx.selectFrom('crove_kernel.proposal').select(['kind', 'payload']).where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    return { change: row ? changeOf(row.kind, row.payload) : null };
  },
});

// The switches, the current cap of each scope, account and period (the latest row), and the requests waiting for approval,
// without the caps of an account the caller does not read (its row is hidden by the entity policy).
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
    const waiting = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'kind', 'payload', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'pending')
      .where('kind', 'in', ADS_KINDS)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const pending = waiting.flatMap((p) => {
      const change = changeOf(p.kind, p.payload);
      return change ? [{ proposalId: p.id, change, requestedAt: new Date(p.created_at).toISOString() }] : [];
    });
    return {
      writeEnabled: setting?.write_enabled ?? false,
      launchesBlocked: setting?.launches_blocked ?? false,
      updatedAt: setting ? new Date(setting.updated_at).toISOString() : null,
      caps,
      pending,
    };
  },
});

export const writeCommands = [
  adsWritePrepareEnable,
  adsAccountPrepareEnableWrite,
  adsCapPrepareSet,
  adsLaunchesPrepareUnblock,
  adsWriteEnable,
  adsAccountEnableWrite,
  adsCapSet,
  adsLaunchesUnblock,
  adsWriteDisable,
  adsAccountDisableWrite,
  adsPauseAll,
  adsCapLower,
];
export const writeQueries = [adsWriteState, adsProposalChange];
