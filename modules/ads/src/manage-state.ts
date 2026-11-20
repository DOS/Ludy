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

// The changes of several launches in one read, by launch, oldest first.
// `kinds` narrows the read to those kinds of change (a caller that needs one family reads none of the rest).
export async function changesOfMany(ctx: Db, launchIds: readonly string[], kinds?: readonly ChangeRecord['kind'][]): Promise<Map<string, ChangeRecord[]>> {
  const out = new Map<string, ChangeRecord[]>(launchIds.map((id) => [id, []]));
  if (launchIds.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('crove_ads.ad_manage_change')
    .select([
      'id',
      'launch_id',
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
    .where('launch_id', 'in', [...launchIds])
    .$if(kinds !== undefined, (qb) => qb.where('kind', 'in', [...(kinds as readonly ChangeRecord['kind'][])]))
    .orderBy('seq', 'asc')
    .execute();
  for (const r of rows) {
    out.get(r.launch_id)?.push({
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
    });
  }
  return out;
}

export async function changesOf(ctx: Db, launchId: string): Promise<ChangeRecord[]> {
  return (await changesOfMany(ctx, [launchId])).get(launchId) ?? [];
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
export type ManagedObject = { slot: AdsManageSlot; level: ChangeRecord['level']; externalId: string; name: string };
export async function objectsOfMany(ctx: Db, launchIds: readonly string[]): Promise<Map<string, ManagedObject[]>> {
  const out = new Map<string, ManagedObject[]>(launchIds.map((id) => [id, []]));
  if (launchIds.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('crove_ads.ad_object')
    .select(['launch_id', 'slot', 'level', 'external_id', 'name'])
    .where('org_id', '=', ctx.orgId)
    .where('launch_id', 'in', [...launchIds])
    .where('level', 'in', ['campaign', 'ad_set', 'ad'])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  for (const r of rows) out.get(r.launch_id)?.push({ slot: r.slot as AdsManageSlot, level: r.level as ChangeRecord['level'], externalId: r.external_id, name: r.name });
  return out;
}

export async function objectsOf(ctx: Db, launchId: string): Promise<ManagedObject[]> {
  return (await objectsOfMany(ctx, [launchId])).get(launchId) ?? [];
}

type StateLaunch = { id: string; ad_account_id: string; state: string; currency: string; daily_budget: string; end_text: string };

// The management state of several launches, as the Campaigns screen shows it, in four reads in all (the objects, the changes, the org's switches and the accounts' flags), whatever
// the number of launches: members read it (the state only), owners and admins get the controls.
export async function manageStatesOf(ctx: Db, launches: readonly StateLaunch[]): Promise<Map<string, AdsManageStateView>> {
  const out = new Map<string, AdsManageStateView>();
  if (launches.length === 0) return out;
  const ids = launches.map((l) => l.id);
  const [objects, changes, setting, accounts] = await Promise.all([
    objectsOfMany(ctx, ids),
    changesOfMany(ctx, ids),
    currentSetting(ctx),
    ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'write_enabled', 'write_connection_id']).where('org_id', '=', ctx.orgId).where('id', 'in', [...new Set(launches.map((l) => l.ad_account_id))]).execute(),
  ]);
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  for (const launch of launches) {
    const mine = changes.get(launch.id) ?? [];
    const held = heldValues({ dailyBudget: launch.daily_budget, endOn: launch.end_text }, mine);
    const account = accountOf.get(launch.ad_account_id);
    const canChange = launch.state === 'live' && setting?.write_enabled === true && setting.launches_blocked === false && account?.write_enabled === true && account.write_connection_id !== null;
    const views: AdsManageObjectView[] = (objects.get(launch.id) ?? []).map((o) => ({ slot: o.slot, level: o.level, name: o.name, ...objectStatusOf(o.slot, mine) }));
    out.set(launch.id, {
      launchId: launch.id,
      currency: launch.currency,
      dailyBudget: held.confirmedBudget,
      endOn: held.confirmedEndOn,
      heldDailyBudget: held.dailyBudget,
      heldEndOn: held.endOn,
      canChange,
      objects: views,
      changes: mine.slice(-20).reverse().map(changeView),
    });
  }
  return out;
}

export async function manageStateOf(ctx: Db, launch: StateLaunch): Promise<AdsManageStateView> {
  return (await manageStatesOf(ctx, [launch])).get(launch.id) as AdsManageStateView;
}
