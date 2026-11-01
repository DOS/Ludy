// SPDX-License-Identifier: AGPL-3.0-only
// Saved views of a list (CRM plan 4.3, step K3, #2227), the kernel's: a member names the filter and the sort of a list
// (the deals today, the contacts next) and opens them again in one click. A view is private to its owner, or shared with
// every member of the org; the owner changes and deletes it, and owners and admins a shared one too (they may not make
// another's view private, which would hide it from them). At most SAVED_VIEW_LIMIT per member and scope, counted under a
// lock; the table's restrictive policies hold the same rules in the database, and a view goes with the membership.
//
// A view stores a Filter AST (@crove/kernel-contract saved-view.ts), never SQL. Saving checks it against the scope
// registry: an unknown scope, field or operator, a value of the wrong kind or a repeated condition is a 422. Applying a
// view is the list's own query with the AST turned into a condition (saved-view-filter.ts), so a view only narrows what
// the member's row-level security lets them read. No agent writes or reads one.
import { sql } from 'kysely';
import {
  SAVED_VIEW_FILTERS_MAX_CHARS,
  SAVED_VIEW_LIMIT,
  filterIssues,
  isSavedViewScope,
  normalizeFilter,
  sortIssues,
  zFilterAstShape,
  zSavedViewDelete,
  zSavedViewList,
  zSavedViewName,
  zSavedViewRename,
  zSavedViewSave,
  zSavedViewSetShared,
  zSavedViewSortShape,
  type FilterAst,
  type SavedView,
  type SavedViewSort,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The most views one list answers: the viewer's own and the shared ones of the scope.
export const SAVED_VIEW_LIST_MAX = 200;

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The name as stored: NFC and trimmed (the contract bounds it; the table checks the length again).
function nameOf(raw: string): string {
  const parsed = zSavedViewName.safeParse(raw);
  if (!parsed.success) throw new DomainError('VALIDATION', 422, 'Tên chế độ xem dài từ 1 đến 60 ký tự');
  return parsed.data;
}

// The filter as stored, the registry having accepted it: values normalized, as compact JSON of bounded size.
function storedFilters(scope: string, filters: FilterAst): string {
  if (!isSavedViewScope(scope)) throw new DomainError('VALIDATION', 422, 'Chế độ xem không hợp lệ');
  const text = JSON.stringify(normalizeFilter(scope, filters));
  if (text.length > SAVED_VIEW_FILTERS_MAX_CHARS) throw new DomainError('VALIDATION', 422, 'Bộ lọc quá dài');
  return text;
}

// A filter and sort the registry of `scope` accepts, else a 422 naming where and why (fixed codes, never the values).
function checkViewBody(scope: string, filters: FilterAst, sort: SavedViewSort | null | undefined): void {
  const issues = [...filterIssues(scope, filters), ...sortIssues(scope, sort)];
  if (issues.length > 0) throw new DomainError('VALIDATION', 422, 'Bộ lọc hoặc cách sắp xếp không hợp lệ', { issues });
}

// The view, locked, when the viewer may change it: their own, or a shared one for an owner or admin. A view the viewer
// cannot see (another's private one) is not found. Read before it is locked: a lock asks for the update policy, which
// would hide a shared view from a member who may only read it, and they are told why instead.
async function changeable(ctx: CommandContext, me: string, viewId: string, verb: 'sửa' | 'xoá') {
  const of = () =>
    ctx.trx.selectFrom('crove_kernel.saved_view').select(['id', 'user_id', 'scope', 'shared']).where('org_id', '=', ctx.orgId).where('id', '=', viewId);
  const seen = await of().executeTakeFirst();
  if (!seen) throw new DomainError('SAVED_VIEW_NOT_FOUND', 404, 'Không tìm thấy chế độ xem này');
  if (seen.user_id !== me && !(seen.shared && (ctx.role === 'owner' || ctx.role === 'admin'))) {
    throw new DomainError('FORBIDDEN', 403, `Chỉ người tạo, chủ sở hữu hoặc quản trị viên mới ${verb} được chế độ xem này`);
  }
  const view = await of().forUpdate().executeTakeFirst();
  if (!view) throw new DomainError('SAVED_VIEW_NOT_FOUND', 404, 'Không tìm thấy chế độ xem này');
  return view;
}

// One name per owner and scope, the view's owner whoever renames it.
async function nameTaken(ctx: CommandContext, owner: string, scope: string, name: string, exceptId?: string): Promise<boolean> {
  let q = ctx.trx.selectFrom('crove_kernel.saved_view').select('id').where('org_id', '=', ctx.orgId).where('user_id', '=', owner).where('scope', '=', scope).where('name', '=', name);
  if (exceptId) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

export const savedViewSave = defineCommand({
  name: 'kernel.saved_view.save',
  input: zSavedViewSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    const filters = input.filters as FilterAst;
    const sort = input.sort ?? null;

    if ('viewId' in input) {
      // A change of the filter and sort of a view the viewer may change; its scope, name and sharing stay.
      const view = await changeable(ctx, me, input.viewId, 'sửa');
      checkViewBody(view.scope, filters, sort);
      // A sort left out keeps the view's own; null clears it.
      await ctx.trx
        .updateTable('crove_kernel.saved_view')
        .set({
          filters: storedFilters(view.scope, filters),
          ...(input.sort === undefined ? {} : { sort: sort === null ? null : JSON.stringify(sort) }),
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', view.id)
        .execute();
      ctx.audit({ view_id: view.id, scope: view.scope });
      return { viewId: view.id };
    }

    const name = nameOf(input.name);
    checkViewBody(input.scope, filters, sort);
    // Sharing shows the view to the whole org: not for viewers, who only read.
    if (input.shared && ctx.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người chỉ xem không chia sẻ được chế độ xem');
    const stored = storedFilters(input.scope, filters);
    // One save at a time per member and scope, so the count below holds until the commit.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_kernel.saved_view:${ctx.orgId}:${me}:${input.scope}`}, 0))`.execute(ctx.trx);
    const count = await ctx.trx
      .selectFrom('crove_kernel.saved_view')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', me)
      .where('scope', '=', input.scope)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= SAVED_VIEW_LIMIT) {
      throw new DomainError('SAVED_VIEW_LIMIT', 409, `Mỗi người lưu tối đa ${SAVED_VIEW_LIMIT} chế độ xem cho mỗi danh sách`, { limit: String(SAVED_VIEW_LIMIT) });
    }
    if (await nameTaken(ctx, me, input.scope, name)) throw new DomainError('SAVED_VIEW_NAME_TAKEN', 409, 'Bạn đã có chế độ xem cùng tên', { name });
    const row = await ctx.trx
      .insertInto('crove_kernel.saved_view')
      .values({
        org_id: ctx.orgId,
        user_id: me,
        scope: input.scope,
        name,
        filters: stored,
        sort: sort === null ? null : JSON.stringify(sort),
        shared: input.shared,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ view_id: row.id, scope: input.scope, shared: input.shared });
    return { viewId: row.id };
  },
});

export const savedViewRename = defineCommand({
  name: 'kernel.saved_view.rename',
  input: zSavedViewRename,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    const name = nameOf(input.name);
    const view = await changeable(ctx, me, input.viewId, 'sửa');
    // The lock a save takes for this owner and scope, so a rename racing a save or another rename to the same name is
    // answered SAVED_VIEW_NAME_TAKEN and not by the unique index.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_kernel.saved_view:${ctx.orgId}:${view.user_id}:${view.scope}`}, 0))`.execute(ctx.trx);
    if (await nameTaken(ctx, view.user_id, view.scope, name, view.id)) throw new DomainError('SAVED_VIEW_NAME_TAKEN', 409, 'Đã có chế độ xem cùng tên', { name });
    await ctx.trx.updateTable('crove_kernel.saved_view').set({ name, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', view.id).execute();
    ctx.audit({ view_id: view.id, scope: view.scope });
    return { viewId: view.id };
  },
});

export const savedViewSetShared = defineCommand({
  name: 'kernel.saved_view.set_shared',
  input: zSavedViewSetShared,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    // Sharing shows the view to the whole org: not for viewers, who only read.
    if (input.shared && ctx.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người chỉ xem không chia sẻ được chế độ xem');
    const view = await changeable(ctx, me, input.viewId, 'sửa');
    // Another's shared view stays shared: making it private would hide it from the admin who changes it.
    if (view.user_id !== me && !input.shared) throw new DomainError('FORBIDDEN', 403, 'Chỉ người tạo mới chuyển được chế độ xem này về riêng tư');
    await ctx.trx.updateTable('crove_kernel.saved_view').set({ shared: input.shared, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', view.id).execute();
    ctx.audit({ view_id: view.id, scope: view.scope, shared: input.shared });
    return { viewId: view.id };
  },
});

export const savedViewDelete = defineCommand({
  name: 'kernel.saved_view.delete',
  input: zSavedViewDelete,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    const view = await changeable(ctx, me, input.viewId, 'xoá');
    await ctx.trx.deleteFrom('crove_kernel.saved_view').where('org_id', '=', ctx.orgId).where('id', '=', view.id).execute();
    ctx.audit({ view_id: view.id, scope: view.scope });
    return { viewId: view.id };
  },
});

// A stored filter read back: the shape the contract allows, else the empty filter (a row written before a field was
// narrowed opens on the plain list rather than failing the whole answer).
const EMPTY_FILTER: FilterAst = { v: 1, all: [] };
function filtersOf(raw: unknown): FilterAst {
  const parsed = zFilterAstShape.safeParse(raw);
  return parsed.success ? (parsed.data as FilterAst) : EMPTY_FILTER;
}
function sortOf(raw: unknown): SavedViewSort | null {
  const parsed = zSavedViewSortShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// The viewer's views and the org's shared ones of a scope, the viewer's first, each by name. The policy shows nothing else.
export const savedViewList = defineQuery({
  name: 'kernel.saved_view.list',
  input: zSavedViewList,
  access: ALL,
  handler: async (ctx, input): Promise<SavedView[]> => {
    if (ctx.actor.type !== 'user') return [];
    if (!isSavedViewScope(input.scope)) throw new DomainError('VALIDATION', 422, 'Danh sách không hợp lệ', { issues: [{ path: 'scope', code: 'unknown_scope' }] });
    const me = ctx.actor.userId;
    const rows = await ctx.trx
      .selectFrom('crove_kernel.saved_view')
      .select(['id', 'user_id', 'scope', 'name', 'filters', 'sort', 'shared', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('scope', '=', input.scope)
      .where((eb) => eb.or([eb('user_id', '=', me), eb('shared', '=', true)]))
      .orderBy(sql`user_id = ${me}`, 'desc')
      .orderBy('name')
      .orderBy('id')
      .limit(SAVED_VIEW_LIST_MAX)
      .execute();
    const admin = ctx.role === 'owner' || ctx.role === 'admin';
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      name: r.name,
      filters: filtersOf(r.filters),
      sort: sortOf(r.sort),
      shared: r.shared,
      ownerId: r.user_id,
      mine: r.user_id === me,
      canChange: r.user_id === me || (r.shared && admin),
      updatedAt: r.updated_at.toISOString(),
    }));
  },
});

export const savedViewCommands = [savedViewSave, savedViewRename, savedViewSetShared, savedViewDelete];
export const savedViewQueries = [savedViewList];
