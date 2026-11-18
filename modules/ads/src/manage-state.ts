// SPDX-License-Identifier: AGPL-3.0-only
// What a launch's changes add up to (ads W4, issue #3835): the recorded objects, the changes asked so far and the management state the Campaigns screen shows. Reads only; the
// commands that write a change are in manage.ts, and the rules (what a launch holds, an object's status) in manage-rules.ts.
import { sql } from 'kysely';
import type { AdsManageChangeView, AdsManageObjectView, AdsManageSlot, AdsManageStateView } from '@crove/kernel-contract';
import type { Db } from './launch-run.ts';
import { heldValues, objectStatusOf, type ChangeRow } from './manage-rules.ts';
import { currentSetting } from './write.ts';

export interface ChangeRecord extends ChangeRow {
  id: string;
  level: 'campaign' | 'ad_set' | 'ad';
  fromBudget: string | null;
  fromEndOn: string | null;
  code: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export async function changesOf(ctx: Db, launchId: string): Promise<ChangeRecord[]> {
  const rows = await ctx.trx
    .selectFrom('crove_ads.ad_manage_change')
    .select([
      'id',
      'seq',
      'kind',
      'slot',
      'level',
      'state',
      'code',
      'created_at',
      'settled_at',
      sql<string | null>`from_budget::text`.as('from_budget'),
      sql<string | null>`to_budget::text`.as('to_budget'),
      sql<string | null>`from_end_on::text`.as('from_end_on'),
      sql<string | null>`to_end_on::text`.as('to_end_on'),
    ])
    .where('org_id', '=', ctx.orgId)
    .where('launch_id', '=', launchId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind,
    slot: r.slot as AdsManageSlot,
    level: r.level as ChangeRecord['level'],
    state: r.state,
    code: r.code,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    fromBudget: r.from_budget,
    toBudget: r.to_budget,
    fromEndOn: r.from_end_on,
    toEndOn: r.to_end_on,
  }));
}

export const changeView = (c: ChangeRecord): AdsManageChangeView => ({
  id: c.id,
  kind: c.kind,
  slot: c.slot,
  state: c.state,
  fromBudget: c.fromBudget,
  toBudget: c.toBudget,
  fromEndOn: c.fromEndOn,
  toEndOn: c.toEndOn,
  code: c.code,
  requestedAt: c.createdAt.toISOString(),
  settledAt: c.settledAt ? c.settledAt.toISOString() : null,
});

// The recorded objects of a launch that have a status of their own, by slot.
export async function objectsOf(ctx: Db, launchId: string) {
  const rows = await ctx.trx
    .selectFrom('crove_ads.ad_object')
    .select(['slot', 'level', 'external_id', 'name'])
    .where('org_id', '=', ctx.orgId)
    .where('launch_id', '=', launchId)
    .where('level', 'in', ['campaign', 'ad_set', 'ad'])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((r) => ({ slot: r.slot as AdsManageSlot, level: r.level as ChangeRecord['level'], externalId: r.external_id, name: r.name }));
}

// The management state of a launch, as the Campaigns screen shows it: members read it (the state only), owners and admins get the controls.
export async function manageStateOf(ctx: Db, launch: { id: string; ad_account_id: string; state: string; currency: string; daily_budget: string; end_text: string }): Promise<AdsManageStateView> {
  const objects = await objectsOf(ctx, launch.id);
  const changes = await changesOf(ctx, launch.id);
  const held = heldValues({ dailyBudget: launch.daily_budget, endOn: launch.end_text }, changes);
  const setting = await currentSetting(ctx);
  const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['write_enabled', 'write_connection_id']).where('org_id', '=', ctx.orgId).where('id', '=', launch.ad_account_id).executeTakeFirst();
  const canChange = launch.state === 'live' && setting?.write_enabled === true && setting.launches_blocked === false && account?.write_enabled === true && account.write_connection_id !== null;
  const views: AdsManageObjectView[] = objects.map((o) => ({ slot: o.slot, level: o.level, name: o.name, ...objectStatusOf(o.slot, changes) }));
  return {
    launchId: launch.id,
    currency: launch.currency,
    dailyBudget: held.confirmedBudget,
    endOn: held.confirmedEndOn,
    heldDailyBudget: held.dailyBudget,
    heldEndOn: held.endOn,
    canChange,
    objects: views,
    changes: changes.slice(-20).reverse().map(changeView),
  };
}

