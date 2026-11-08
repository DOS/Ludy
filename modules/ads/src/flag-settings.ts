// SPDX-License-Identifier: AGPL-3.0-only
// The org's thresholds of the spend flags (issue #2378): when the pace of a month is judged against a cap, by what factor a day or a
// campaign's cost per result may exceed its share or its median, and how many results and days of history that last rule needs. Owners and
// admins read and set them; a threshold the org never set is `null` and the default of flags.ts applies, so a safer default reaches every org
// that left it. Changing a threshold only changes which flags the rules raise: it moves no money and changes no campaign (R1, internal).
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zAdsFlagSetting, type AdsFlagSettings } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { DEFAULT_FLAG_THRESHOLDS, type FlagSetting } from './flags.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The org's row as the rules read it. No row is every threshold unset.
export async function flagSettingOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<{ set: FlagSetting; setAt: Date | null }> {
  const row = await ctx.trx
    .selectFrom('crove_ads.ad_flag_setting')
    .select(['pace_min_days', 'day_factor', 'cpr_factor', 'cpr_min_results', 'cpr_min_history_days', 'updated_at'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (!row) return { set: { paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null }, setAt: null };
  return {
    set: {
      paceMinDays: row.pace_min_days,
      dayFactor: row.day_factor === null ? null : String(row.day_factor),
      cprFactor: row.cpr_factor === null ? null : String(row.cpr_factor),
      cprMinResults: row.cpr_min_results,
      cprMinHistoryDays: row.cpr_min_history_days,
    },
    setAt: row.updated_at,
  };
}

const view = (found: { set: FlagSetting; setAt: Date | null }): AdsFlagSettings => ({ set: found.set, defaults: DEFAULT_FLAG_THRESHOLDS, setAt: found.setAt ? found.setAt.toISOString() : null });

export const adsFlagSettings = defineQuery({
  name: 'ads.flag_settings',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<AdsFlagSettings> => view(await flagSettingOf(ctx)),
});

// Sets every threshold at once; a `null` goes back to the default. Written by the row policy of the table to owners and admins too.
export const adsFlagSettingsSet = defineCommand({
  name: 'ads.flag_settings_set',
  input: zAdsFlagSetting,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<AdsFlagSettings> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên đang đăng nhập mới đặt được ngưỡng cảnh báo');
    const me = ctx.actor.userId;
    const before = await flagSettingOf(ctx);
    const values = {
      pace_min_days: input.paceMinDays,
      day_factor: input.dayFactor,
      cpr_factor: input.cprFactor,
      cpr_min_results: input.cprMinResults,
      cpr_min_history_days: input.cprMinHistoryDays,
    };
    await ctx.trx
      .insertInto('crove_ads.ad_flag_setting')
      .values({ org_id: ctx.orgId, ...values, set_by: me })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ ...values, set_by: me, updated_at: ctx.now }))
      .execute();
    ctx.audit({
      previous: { paceMinDays: before.set.paceMinDays, dayFactor: before.set.dayFactor, cprFactor: before.set.cprFactor, cprMinResults: before.set.cprMinResults, cprMinHistoryDays: before.set.cprMinHistoryDays },
      set: { paceMinDays: input.paceMinDays, dayFactor: input.dayFactor, cprFactor: input.cprFactor, cprMinResults: input.cprMinResults, cprMinHistoryDays: input.cprMinHistoryDays },
    });
    return view(await flagSettingOf(ctx));
  },
});

export const flagSettingCommands = [adsFlagSettingsSet];
export const flagSettingQueries = [adsFlagSettings];
