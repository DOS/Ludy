// SPDX-License-Identifier: AGPL-3.0-only
// The guard every finance read of an MCP grant shares (#3849): the figures it returns are the whole organization's or it answers nothing. A grant whose legal-entity scope is
// narrower than the org gets SIGNAL_PARTIAL_VIEW (as the signals reads), and so does an org with more than one legal entity, because the books are read per entity and one entity's
// figures must never read as the org's. It returns the one entity the figures are read from.
import { sql } from 'kysely';
import { SIGNAL_PARTIAL_VIEW_CODE } from '@crove/kernel-contract';
import { DomainError, type QueryContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

export async function wholeOrgEntity(ctx: QueryContext): Promise<string> {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
  const { rows: scope } = await sql<{ whole: boolean }>`SELECT coalesce('*' = ANY (crove_kernel.ctx_le_scope()::text[]), false) AS whole`.execute(ctx.trx);
  if (scope[0]?.whole !== true) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Bạn chỉ xem được một phần sổ sách nên chưa đọc được số liệu tài chính của cả tổ chức');
  const { rows: entities } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM crove_kernel.legal_entity WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
  if (Number(entities[0]?.n ?? 0) > 1) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Tổ chức có nhiều pháp nhân nên số liệu của một pháp nhân không phải của cả tổ chức');
  return await resolveLegalEntity(ctx, undefined);
}
