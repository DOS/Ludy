// SPDX-License-Identifier: AGPL-3.0-only
// What the org sets for its payment reminders ("nhắc thu nợ", #2488, slice 3): the payment terms, a customer's own terms and a pause, and the weekly item.
// - finance.collection_setting.get (every role): the org's terms in days (30 until it sets another) and whether the weekly "Hôm nay cần bạn" item is on.
// - finance.collection_setting.set (owners and admins; R1, audited): the org's terms and the weekly switch.
// - finance.customer_collection.get (every role): one customer's own terms and its pause, with the terms that apply to it.
// - finance.customer_collection.set (owners, admins and members; R1, audited): a customer's own terms (null: the org's) and the date up to which no reminder
//   is drafted for it (null: not paused).
// Nothing here sends a mail or drafts one: the settings are read by the reminders (terms, pause) and by the Home item (the switch). A customer is the kept party
// of a duplicate group, as on the customers list, so setting it on a duplicate sets it on the one that stays. The audit rows hold ids, the numbers and the date,
// never a name.
import { sql } from 'kysely';
import { z } from 'zod';
import { zCustomerCollectionSet, zId, zTermsDays } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The terms the reminders have always assumed, until the org sets another.
const DEFAULT_TERMS_DAYS = 30;
// A pause runs to a date in the next two years: far enough for a customer in a long dispute, near enough that it cannot be forgotten for good.
export const PAUSE_MAX_DAYS = 730;

export interface CollectionSetting {
  termsDays: number;
  weeklyItem: boolean;
}
export interface CustomerCollection {
  partyId: string;
  // The customer's own terms, or null for the org's.
  termsDays: number | null;
  // The terms that apply to it.
  effectiveTermsDays: number;
  pausedUntil: string | null;
}

const DAY_MS = 86_400_000;

export async function readCollectionSetting(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<CollectionSetting> {
  const row = await ctx.trx.selectFrom('crove_finance.collection_setting').select(['terms_days', 'weekly_item']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  return { termsDays: row?.terms_days ?? DEFAULT_TERMS_DAYS, weeklyItem: row?.weekly_item ?? false };
}

// The kept party of a duplicate group: the settings sit on it, whichever party of the group a caller names. A party of another org, or none, is not found.
async function keptParty(ctx: Pick<QueryContext, 'trx' | 'orgId'>, partyId: string): Promise<string> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.party')
    .select(sql<string>`coalesce(duplicate_of, id)`.as('kept'))
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', partyId)
    .executeTakeFirst();
  if (!row) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy khách hàng này');
  return row.kept;
}

// The kept party, resolved with the party and its kept party locked FOR SHARE (in id order, as kernel.party.mark_duplicate locks the pair FOR UPDATE), so a merge or a split
// that would move the party waits for this transaction and the write below lands on the party that is kept when it commits. A merge that got in between the first read and
// the locks shows as a different kept party the second time, and the lock is taken again.
async function lockedKeptParty(ctx: Pick<QueryContext, 'trx' | 'orgId'>, partyId: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const guess = await keptParty(ctx, partyId);
    await ctx.trx
      .selectFrom('crove_kernel.party')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [partyId, guess])
      .orderBy('id')
      .forShare()
      .execute();
    if ((await keptParty(ctx, partyId)) === guess) return guess;
  }
  throw new DomainError('PARTY_CHANGING', 409, 'Khách hàng này đang được gộp hoặc tách; hãy thử lại');
}

// What a duplicate group has set. The row sits on the kept party; a party marked as a duplicate afterwards may still hold its own (nothing moves it), so every party of the
// group is read: the kept party's row wins, else the row whose pause runs longest, so a pause or terms set before a merge are not hidden by it.
async function groupRow(ctx: Pick<QueryContext, 'trx' | 'orgId'>, kept: string): Promise<{ terms_days: number | null; paused_until: string | null } | undefined> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.customer_collection as c')
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'c.org_id').onRef('x.id', '=', 'c.party_id'))
    .select(['c.party_id', 'c.terms_days', 'c.paused_until'])
    .where('c.org_id', '=', ctx.orgId)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) = ${kept}`)
    // Ties between rows of duplicates that never had a pause resolve by party id, so a read always answers the same.
    .orderBy('c.party_id')
    .execute();
  return mergeGroupRows(rows, kept);
}

// What a duplicate group has set, from the rows of its parties, which the caller lists by party id. The terms are the kept party's own when it has any, else the first
// duplicate's that has some; the pause is the latest one anywhere in the group, so a pause is never lost to a merge and never hidden by a row that only holds terms.
export function mergeGroupRows(
  rows: ReadonlyArray<{ party_id: string; terms_days: number | null; paused_until: string | null }>,
  kept: string,
): { terms_days: number | null; paused_until: string | null } | undefined {
  if (rows.length === 0) return undefined;
  const own = rows.find((r) => r.party_id === kept);
  const terms = own?.terms_days ?? rows.find((r) => r.terms_days !== null)?.terms_days ?? null;
  const pause = rows.reduce<string | null>((best, r) => (r.paused_until !== null && (best === null || r.paused_until > best) ? r.paused_until : best), null);
  return { terms_days: terms, paused_until: pause };
}

async function readCustomer(ctx: Pick<QueryContext, 'trx' | 'orgId'>, partyId: string): Promise<CustomerCollection> {
  const kept = await keptParty(ctx, partyId);
  const [row, setting] = await Promise.all([groupRow(ctx, kept), readCollectionSetting(ctx)]);
  const termsDays = row?.terms_days ?? null;
  return { partyId: kept, termsDays, effectiveTermsDays: termsDays ?? setting.termsDays, pausedUntil: row?.paused_until ?? null };
}

export const collectionSettingGet = defineQuery({
  name: 'finance.collection_setting.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<CollectionSetting> => readCollectionSetting(ctx),
});

export const collectionSettingSet = defineCommand({
  name: 'finance.collection_setting.set',
  input: z.object({ termsDays: zTermsDays, weeklyItem: z.boolean() }),
  // It changes when an invoice falls due in the reminders and shows or hides one Home item: no money moves, nothing is sent.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<CollectionSetting> => {
    // Two writers of the org's one row wait for each other, so the audit row of the second names what the first left, not what it read before.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.collection_setting:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const before = await readCollectionSetting(ctx);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    await ctx.trx
      .insertInto('crove_finance.collection_setting')
      .values({ org_id: ctx.orgId, terms_days: input.termsDays, weekly_item: input.weeklyItem, set_by: userId })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ terms_days: input.termsDays, weekly_item: input.weeklyItem, set_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ termsDays: input.termsDays, previousTermsDays: before.termsDays, weeklyItem: input.weeklyItem, previousWeeklyItem: before.weeklyItem });
    return { termsDays: input.termsDays, weeklyItem: input.weeklyItem };
  },
});

export const customerCollectionGet = defineQuery({
  name: 'finance.customer_collection.get',
  input: z.object({ partyId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<CustomerCollection> => readCustomer(ctx, input.partyId),
});

export const customerCollectionSet = defineCommand({
  name: 'finance.customer_collection.set',
  // pausedUntil: the last day with no reminder (YYYY-MM-DD), or null.
  // Only what is named changes: a field left out keeps its value (so lifting a pause does not overwrite terms someone changed meanwhile).
  input: zCustomerCollectionSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.customer_collection', id: input.partyId }),
  handler: async (ctx, input): Promise<CustomerCollection> => {
    if (input.pausedUntil !== undefined && input.pausedUntil !== null) {
      const when = Date.parse(`${input.pausedUntil}T00:00:00Z`);
      // Not before 2000: a date PostgreSQL cannot hold (year 0) is refused here, not by the database.
      if (!Number.isFinite(when) || new Date(when).toISOString().slice(0, 10) !== input.pausedUntil || input.pausedUntil < '2000-01-01') throw new DomainError('PAUSE_DATE_INVALID', 422, 'Ngày tạm dừng không hợp lệ');
      if (when - ctx.now.getTime() > PAUSE_MAX_DAYS * DAY_MS) throw new DomainError('PAUSE_TOO_LONG', 422, `Chỉ tạm dừng nhắc tối đa ${PAUSE_MAX_DAYS} ngày kể từ hôm nay`);
    }
    const kept = await lockedKeptParty(ctx, input.partyId);
    // One writer per customer at a time, the first set of a customer included (no row to lock yet): the audit row names the values the previous writer left.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.customer_collection:${ctx.orgId}:${kept}`}, 0))`.execute(ctx.trx);
    const before = await readCustomer(ctx, kept);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const termsDays = input.termsDays === undefined ? before.termsDays : input.termsDays;
    const pausedUntil = input.pausedUntil === undefined ? before.pausedUntil : input.pausedUntil;
    // Nothing to keep and nothing kept, or the same values again: no row is made or touched (who set it and when stay as they were).
    if (termsDays === before.termsDays && pausedUntil === before.pausedUntil) {
      ctx.audit({ partyId: kept, termsDays, pausedUntil, changed: false });
      return before;
    }
    await ctx.trx
      .insertInto('crove_finance.customer_collection')
      .values({ org_id: ctx.orgId, party_id: kept, terms_days: termsDays, paused_until: pausedUntil, set_by: userId })
      .onConflict((oc) => oc.columns(['org_id', 'party_id']).doUpdateSet({ terms_days: termsDays, paused_until: pausedUntil, set_by: userId, updated_at: ctx.now }))
      .execute();
    // The kept party's row now holds the group's merged settings (what `before` read, with this change), so the rows of its duplicates are cleared: otherwise the
    // latest pause anywhere in the group could not be lifted, nor old terms of a duplicate shown again once the kept party's terms are cleared.
    await sql`
      UPDATE crove_finance.customer_collection c
      SET terms_days = NULL, paused_until = NULL, set_by = ${userId}, updated_at = ${ctx.now}
      FROM crove_kernel.party x
      WHERE c.org_id = ${ctx.orgId} AND x.org_id = c.org_id AND x.id = c.party_id AND x.duplicate_of = ${kept} AND c.party_id <> ${kept}
        AND (c.terms_days IS NOT NULL OR c.paused_until IS NOT NULL)`.execute(ctx.trx);
    ctx.audit({ partyId: kept, termsDays, previousTermsDays: before.termsDays, pausedUntil, previousPausedUntil: before.pausedUntil, changed: true });
    return readCustomer(ctx, kept);
  },
});

export const collectionSettingCommands = [collectionSettingSet, customerCollectionSet];
export const collectionSettingQueries = [collectionSettingGet, customerCollectionGet];
