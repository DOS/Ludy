// SPDX-License-Identifier: AGPL-3.0-only
// Deals and the pipeline (issue #2225, plan docs/plan/crm.md §4.1, §4.2 and §5, step K1): the org's one pipeline of
// ordered stages and the deals that sit in them. Owners, admins and members write; viewers read. Every command is R1
// and internal: it changes only the org's own records, and no agent runs one (the commands refuse a caller that is not
// a person, and no agent role writes crove_crm).
//
// A deal's status is its stage's kind: moving it into a won or lost stage closes it, moving it back opens it again.
// An edit or a move sends the version the caller read, so a second person's save in between is refused instead of
// overwritten. The audit rows and the activity on the party's timeline hold ids, field names and stage names, never a
// title, an amount or a lost reason (they may name a person, and audit rows outlive an erasure).
import { sql } from 'kysely';
import {
  DEAL_PAGE_SIZE,
  DEFAULT_PIPELINE_STAGES,
  REBALANCE_AT,
  keyBetween,
  spreadKeys,
  vietnamToday,
  zDealCreate,
  zDealListQuery,
  zDealMove,
  zDealRef,
  zDealUpdate,
  PARTY_SEARCH_LIMIT,
  zPartyDealsQuery,
  zPartySearchQuery,
  type Deal,
  type DealPage,
  type DealStageKind,
  type FilterAst,
  type PartyChoice,
  type PipelineStage,
} from '@crove/kernel-contract';
import { filterCondition, sortTerms } from '@crove/kernel';
import type { MemberRole } from '@crove/db';
import { z } from 'zod';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { DEAL_DEFAULT_SORT, dealFields, dealSortColumns, dealsAfter } from './deal-filter.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export type Reader = Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

// ---------------------------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------------------------

export async function loadStages(ctx: Reader): Promise<PipelineStage[]> {
  const rows = await ctx.trx.selectFrom('crove_crm.pipeline_stage').select(['id', 'name', 'kind', 'position']).where('org_id', '=', ctx.orgId).orderBy('position').execute();
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as DealStageKind, position: r.position }));
}

// One lock per org for everything that places a deal or touches the pipeline (creating the defaults, creating a deal,
// moving one), taken before any deal row is locked: two moves into one crowded stage then never rebalance rows the other
// holds, and two creates never take the same sort key. It is held to the end of the transaction.
export async function lockPipeline(ctx: CommandContext): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${'crm.pipeline:' + ctx.orgId}, 0))`.execute(ctx.trx);
}

// Creates the defaults when the org has none. Two first uses at once wait for each other on the pipeline lock, so the
// second sees the first one's stages.
export async function ensureStages(ctx: CommandContext): Promise<PipelineStage[]> {
  await lockPipeline(ctx);
  const existing = await loadStages(ctx);
  if (existing.length > 0) return existing;
  await ctx.trx
    .insertInto('crove_crm.pipeline_stage')
    .values(DEFAULT_PIPELINE_STAGES.map((s, i) => ({ org_id: ctx.orgId, name: s.name, kind: s.kind, position: i + 1 })))
    .execute();
  const stages = await loadStages(ctx);
  ctx.audit({ stages: stages.length });
  return stages;
}

export const pipelineStages = defineQuery({
  name: 'crm.stage.list',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<PipelineStage[]> => loadStages(ctx),
});

export const pipelineSetup = defineCommand({
  name: 'crm.pipeline.setup',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx): Promise<PipelineStage[]> => {
    userOf(ctx.actor);
    return ensureStages(ctx);
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------------------------------------------

const COLUMNS = ['d.id', 'd.party_id', 'd.title', 'd.amount', 'd.currency', 'd.stage_id', 'd.expected_close', 'd.owner_user_id', 'd.lost_reason', 'd.closed_at', 'd.version', 'd.created_by', 'd.created_at', 'd.updated_at'] as const;

export interface Row {
  id: string;
  party_id: string;
  title: string;
  amount: string;
  currency: string;
  stage_id: string;
  expected_close: Date | string | null;
  owner_user_id: string | null;
  lost_reason: string | null;
  closed_at: Date | string | null;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  party_name: string;
  stage_kind: string;
}

// Owners and admins delete any deal, a member the ones they made (the delete command enforces it).
export const mayDelete = (ctx: Reader, createdBy: string): boolean => ctx.role === 'owner' || ctx.role === 'admin' || (ctx.role === 'member' && ctx.actor.type === 'user' && ctx.actor.userId === createdBy);

export function view(r: Row, canDelete: boolean): Deal {
  return {
    id: r.id,
    partyId: r.party_id,
    partyName: r.party_name,
    title: r.title,
    amount: r.amount,
    currency: 'VND',
    stageId: r.stage_id,
    stageKind: r.stage_kind as DealStageKind,
    expectedClose: day(r.expected_close),
    ownerUserId: r.owner_user_id,
    lostReason: r.lost_reason,
    closedAt: r.closed_at === null ? null : iso(r.closed_at),
    version: r.version,
    canDelete,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function base(ctx: Reader) {
  return ctx.trx
    .selectFrom('crove_crm.deal as d')
    .innerJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .innerJoin('crove_crm.pipeline_stage as s', (j) => j.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.stage_id'))
    .select([...COLUMNS, 'p.name as party_name', 's.kind as stage_kind'])
    .where('d.org_id', '=', ctx.orgId);
}

async function loadView(ctx: Reader, dealId: string): Promise<Deal> {
  const row = await base(ctx).where('d.id', '=', dealId).executeTakeFirst();
  if (!row) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
  return view(row, mayDelete(ctx, row.created_by));
}

const notFound = () => new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
const stale = () => new DomainError('STALE_VERSION', 409, 'Cơ hội này vừa được người khác sửa; hãy mở lại để xem bản mới');

async function assertParty(ctx: CommandContext, partyId: string): Promise<string> {
  const party = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', '=', partyId).executeTakeFirst();
  if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy liên hệ hoặc công ty này');
  return party.name;
}

async function assertOwner(ctx: CommandContext, userId: string | null): Promise<void> {
  if (userId === null) return;
  const member = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
  if (!member) throw new DomainError('DEAL_OWNER_INVALID', 422, 'Người phụ trách phải là thành viên của tổ chức');
}

// The stage's keys in order, for placing a deal between two others.
async function stageKeys(ctx: CommandContext, stageId: string, except: string | null): Promise<{ id: string; sort_key: string }[]> {
  let q = ctx.trx.selectFrom('crove_crm.deal').select(['id', 'sort_key']).where('org_id', '=', ctx.orgId).where('stage_id', '=', stageId);
  if (except) q = q.where('id', '<>', except);
  return q.orderBy('sort_key').orderBy('id').execute();
}

async function rebalance(ctx: CommandContext, rows: { id: string; sort_key: string }[]): Promise<{ id: string; sort_key: string }[]> {
  const keys = spreadKeys(rows.length);
  const next = rows.map((r, i) => ({ id: r.id, sort_key: keys[i] as string }));
  for (const r of next) await ctx.trx.updateTable('crove_crm.deal').set({ sort_key: r.sort_key }).where('org_id', '=', ctx.orgId).where('id', '=', r.id).execute();
  return next;
}

// A key for a deal placed after `afterId`, before `beforeId`, or at the end of the stage, under the pipeline lock. A
// stage whose neighbours share a key, or whose keys have grown long, is given fresh keys first.
async function keyFor(ctx: CommandContext, stageId: string, except: string | null, beforeId: string | null, afterId: string | null): Promise<string> {
  let rows = await stageKeys(ctx, stageId, except);
  const around = (list: typeof rows): [string | null, string | null] => {
    if (afterId) {
      const i = list.findIndex((r) => r.id === afterId);
      if (i < 0) throw new DomainError('DEAL_NEIGHBOUR_INVALID', 422, 'Cơ hội đứng cạnh không còn ở giai đoạn này');
      return [list[i]!.sort_key, list[i + 1]?.sort_key ?? null];
    }
    if (beforeId) {
      const i = list.findIndex((r) => r.id === beforeId);
      if (i < 0) throw new DomainError('DEAL_NEIGHBOUR_INVALID', 422, 'Cơ hội đứng cạnh không còn ở giai đoạn này');
      return [list[i - 1]?.sort_key ?? null, list[i]!.sort_key];
    }
    return [list.at(-1)?.sort_key ?? null, null];
  };
  let [lo, hi] = around(rows);
  if ((lo !== null && hi !== null && lo >= hi) || (lo !== null && lo.length > REBALANCE_AT) || (hi !== null && hi.length > REBALANCE_AT)) {
    rows = await rebalance(ctx, rows);
    [lo, hi] = around(rows);
  }
  return keyBetween(lo, hi);
}

async function stageOf(ctx: CommandContext, stageId: string): Promise<{ id: string; name: string; kind: DealStageKind }> {
  const stage = await ctx.trx.selectFrom('crove_crm.pipeline_stage').select(['id', 'name', 'kind']).where('org_id', '=', ctx.orgId).where('id', '=', stageId).executeTakeFirst();
  if (!stage) throw new DomainError('STAGE_NOT_FOUND', 404, 'Không tìm thấy giai đoạn này');
  return { id: stage.id, name: stage.name, kind: stage.kind as DealStageKind };
}

// Amounts as the column stores them, so "1500000" and "1500000.00" compare equal.
const money2 = (v: string): string => {
  const [whole = '0', frac = ''] = v.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${(frac + '00').slice(0, 2)}`;
};
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const dealCreate = defineCommand({
  name: 'crm.deal.create',
  input: zDealCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<Deal> => {
    const userId = userOf(ctx.actor);
    const title = oneLine(input.title);
    if (!title) throw new DomainError('INVALID_DEAL_TITLE', 422, 'Tên cơ hội không được để trống');
    await assertParty(ctx, input.partyId);
    const owner = input.ownerUserId === undefined ? userId : input.ownerUserId;
    await assertOwner(ctx, owner);
    const stages = await ensureStages(ctx);
    const stage = input.stageId ? stages.find((s) => s.id === input.stageId) : stages.find((s) => s.kind === 'open');
    if (!stage) throw new DomainError('STAGE_NOT_FOUND', 404, 'Không tìm thấy giai đoạn này');
    if (stage.kind !== 'open') throw new DomainError('DEAL_STAGE_CLOSED', 422, 'Cơ hội mới chỉ tạo ở một giai đoạn đang mở');
    const sortKey = await keyFor(ctx, stage.id, null, null, null);
    const row = await ctx.trx
      .insertInto('crove_crm.deal')
      .values({
        org_id: ctx.orgId,
        party_id: input.partyId,
        title,
        amount: input.amount,
        stage_id: stage.id,
        sort_key: sortKey,
        expected_close: input.expectedClose,
        owner_user_id: owner,
        created_by: userId,
        created_at: ctx.now,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ dealId: row.id, partyId: input.partyId, stageId: stage.id, ownerUserId: owner });
    await ctx.activity('kernel.party', input.partyId, 'deal.created', 'Tạo cơ hội bán hàng');
    return loadView(ctx, row.id);
  },
});

export const dealUpdate = defineCommand({
  name: 'crm.deal.update',
  input: zDealUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.deal', id: input.dealId }),
  handler: async (ctx, input): Promise<Deal> => {
    const userId = userOf(ctx.actor);
    const title = oneLine(input.title);
    if (!title) throw new DomainError('INVALID_DEAL_TITLE', 422, 'Tên cơ hội không được để trống');
    const before = await ctx.trx
      .selectFrom('crove_crm.deal')
      .select(['id', 'party_id', 'title', 'amount', 'expected_close', 'owner_user_id', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.dealId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw notFound();
    if (before.version !== input.version) throw stale();
    if (input.partyId !== before.party_id) await assertParty(ctx, input.partyId);
    if (input.ownerUserId !== before.owner_user_id) await assertOwner(ctx, input.ownerUserId);
    const titleChanged = title !== before.title;
    await ctx.trx
      .updateTable('crove_crm.deal')
      .set({ party_id: input.partyId, title, amount: input.amount, expected_close: input.expectedClose, owner_user_id: input.ownerUserId, version: before.version + 1, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.dealId)
      .execute();
    // Field names only: the title may name a person.
    const changed: string[] = [];
    if (titleChanged) changed.push('title');
    if (money2(input.amount) !== money2(before.amount)) changed.push('amount');
    if (input.expectedClose !== day(before.expected_close)) changed.push('expectedClose');
    if (input.ownerUserId !== before.owner_user_id) changed.push('ownerUserId');
    if (input.partyId !== before.party_id) changed.push('partyId');
    ctx.audit({ dealId: input.dealId, partyId: input.partyId, changed });
    return loadView(ctx, input.dealId);
  },
});

export const dealMove = defineCommand({
  name: 'crm.deal.move',
  input: zDealMove,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.deal', id: input.dealId }),
  handler: async (ctx, input): Promise<Deal> => {
    const userId = userOf(ctx.actor);
    await lockPipeline(ctx);
    const before = await ctx.trx
      .selectFrom('crove_crm.deal as d')
      .innerJoin('crove_crm.pipeline_stage as s', (j) => j.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.stage_id'))
      .select(['d.id', 'd.party_id', 'd.stage_id', 'd.version', 's.kind as stage_kind', 's.name as stage_name'])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.id', '=', input.dealId)
      .forUpdate('d')
      .executeTakeFirst();
    if (!before) throw notFound();
    if (before.version !== input.version) throw stale();
    const stage = await stageOf(ctx, input.stageId);
    const closing = stage.kind !== 'open';
    const sameStage = stage.id === before.stage_id;
    if (input.lostReason && stage.kind !== 'lost') throw new DomainError('DEAL_LOST_REASON_INVALID', 422, 'Lý do chỉ ghi khi chuyển cơ hội sang giai đoạn thua');
    const sortKey = await keyFor(ctx, stage.id, input.dealId, input.beforeDealId ?? null, input.afterDealId ?? null);
    await ctx.trx
      .updateTable('crove_crm.deal')
      .set({
        stage_id: stage.id,
        sort_key: sortKey,
        // A move inside the stage it is in (a reorder of the Lost column) keeps the close time and the reason, unless a
        // new reason comes with it.
        ...(sameStage && closing
          ? input.lostReason
            ? { lost_reason: oneLine(input.lostReason) || null }
            : {}
          : { closed_at: closing ? ctx.now : null, lost_reason: stage.kind === 'lost' ? (input.lostReason ? oneLine(input.lostReason) || null : null) : null }),
        version: before.version + 1,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.dealId)
      .execute();
    ctx.audit({ dealId: input.dealId, partyId: before.party_id, fromStageId: before.stage_id, toStageId: stage.id, status: stage.kind });
    if (stage.id !== before.stage_id) {
      const kind = stage.kind === 'won' ? 'deal.won' : stage.kind === 'lost' ? 'deal.lost' : 'deal.stage_changed';
      const summary = stage.kind === 'won' ? 'Cơ hội đã thắng' : stage.kind === 'lost' ? 'Cơ hội đã thua' : 'Chuyển cơ hội sang giai đoạn khác';
      await ctx.activity('kernel.party', before.party_id, kind, summary);
    }
    return loadView(ctx, input.dealId);
  },
});

export const dealDelete = defineCommand({
  name: 'crm.deal.delete',
  input: zDealRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.deal', id: input.dealId }),
  handler: async (ctx, input): Promise<{ dealId: string; deleted: true }> => {
    const userId = userOf(ctx.actor);
    const deal = await ctx.trx.selectFrom('crove_crm.deal').select(['id', 'party_id', 'created_by']).where('org_id', '=', ctx.orgId).where('id', '=', input.dealId).forUpdate().executeTakeFirst();
    if (!deal) throw notFound();
    // A member deletes the deals they created; owners and admins any.
    if (ctx.role === 'member' && deal.created_by !== userId) throw new DomainError('DEAL_DELETE_FORBIDDEN', 403, 'Bạn chỉ xóa được cơ hội do chính mình tạo');
    await ctx.trx.deleteFrom('crove_crm.deal').where('org_id', '=', ctx.orgId).where('id', '=', input.dealId).execute();
    ctx.audit({ dealId: input.dealId, partyId: deal.party_id });
    await ctx.activity('kernel.party', deal.party_id, 'deal.deleted', 'Xóa một cơ hội bán hàng');
    return { dealId: input.dealId, deleted: true };
  },
});

export const dealGet = defineQuery({
  name: 'crm.deal.get',
  input: zDealRef,
  access: ALL,
  handler: async (ctx, input): Promise<Deal> => loadView(ctx, input.dealId),
});

export const dealList = defineQuery({
  name: 'crm.deal.list',
  input: zDealListQuery,
  access: ALL,
  handler: async (ctx, input): Promise<DealPage> => {
    const limit = input.limit ?? DEAL_PAGE_SIZE;
    let q = base(ctx);
    if (input.stageId) q = q.where('d.stage_id', '=', input.stageId);
    if (input.partyId) q = q.where('d.party_id', '=', input.partyId);
    if (input.ownerUserId) q = q.where('d.owner_user_id', '=', input.ownerUserId);
    if (input.status) q = q.where('s.kind', '=', input.status);
    // A saved view's filter and sort, or a page after a deal: the view's own order, the id as tie-breaker.
    if (input.filters !== undefined || (input.sort ?? null) !== null || input.after !== undefined) {
      const sort = input.sort ?? DEAL_DEFAULT_SORT;
      // A query has no command clock: one read takes the process clock once, for "created within the last N days".
      const now = new Date();
      const me = ctx.actor.type === 'user' ? ctx.actor.userId : null;
      q = q.where(filterCondition('crm.deal', (input.filters as FilterAst | undefined) ?? { v: 1, all: [] }, dealFields(), { me, today: vietnamToday(now), now }));
      if (input.after) q = q.where(await dealsAfter(ctx, sort, input.after));
      for (const term of sortTerms('crm.deal', input.sort ?? null, dealSortColumns(), sql`d.id`, DEAL_DEFAULT_SORT)) q = q.orderBy(term);
      const rows = await q.limit(limit + 1).execute();
      const items = rows.slice(0, limit).map((r) => view(r, mayDelete(ctx, r.created_by)));
      const last = items.at(-1);
      return { items, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
    }
    if (input.cursor) {
      const { createdAt, id } = input.cursor;
      q = q.where(sql<boolean>`(d.created_at, d.id) < (${new Date(createdAt)}::timestamptz, ${id}::uuid)`);
    }
    const rows = await q.orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(limit + 1).execute();
    const items = rows.slice(0, limit).map((r) => view(r, mayDelete(ctx, r.created_by)));
    const last = items.at(-1);
    return { items, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  },
});

export const partyDeals = defineQuery({
  name: 'crm.party.deals',
  input: zPartyDealsQuery,
  access: ALL,
  handler: async (ctx, input): Promise<Deal[]> => {
    const rows = await base(ctx).where('d.party_id', '=', input.partyId).orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(200).execute();
    return rows.map((r) => view(r, mayDelete(ctx, r.created_by)));
  },
});

// A few parties whose name or tax code contains the text, for the deal form's picker. The text is matched as typed,
// with LIKE's own characters escaped.
export const partySearch = defineQuery({
  name: 'crm.party.search',
  input: zPartySearchQuery,
  access: ALL,
  handler: async (ctx, input): Promise<PartyChoice[]> => {
    const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    let q = ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'kind', 'tax_code']).where('org_id', '=', ctx.orgId);
    if (input.q) q = q.where((eb) => eb.or([eb('name', 'ilike', like), eb('tax_code', 'ilike', like)]));
    const rows = await q.orderBy('name').orderBy('id').limit(input.limit ?? PARTY_SEARCH_LIMIT).execute();
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as PartyChoice['kind'], taxCode: r.tax_code }));
  },
});

export const dealCommands = [pipelineSetup, dealCreate, dealUpdate, dealMove, dealDelete];
export const dealQueries = [pipelineStages, dealGet, dealList, partyDeals, partySearch];
