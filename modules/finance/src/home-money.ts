// SPDX-License-Identifier: AGPL-3.0-only
// finance.home_money (#4785): the three money tiles on Home, read only. What customers still owe (B01 line 131), what the org still owes suppliers (B01 line 311)
// and the net balance of the bank accounts (112), as of one day (the database's today, in Vietnam, when asOf is left out). Every figure comes from the same summed
// balances finance.statements.period reads, in ONE statement (#365), restricted to the three account groups. Deterministic: no model. Who may see them is decided
// here: owners, admins and members holding a finance permission or role; for anyone else, and for an actor that is not a person, the answer is `available: false`
// with no figure, so the screen shows no tile and learns nothing of the books.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { zFinanceHomeMoneyInput, type FinanceHomeMoney } from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { chartAccounts } from './accounts.ts';
import { buildHomeMoney, canSeeMoneyTotals, HOME_MONEY_PREFIXES, MONEY_PERMISSIONS } from './domain/home-money.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { asEntries, balances, type BalanceRow } from './statements.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The member's finance permissions and role keys (the assignments of this user, read inside the member's legal-entity scope).
async function financeStanding(ctx: QueryContext, userId: string): Promise<{ permissions: Set<string>; roleKeys: Set<string> }> {
  const { rows } = await sql<{ permission: string }>`
    SELECT k.p AS permission FROM unnest(ARRAY[${sql.join(MONEY_PERMISSIONS.map((p) => sql`${p}`))}]::text[]) AS k(p)
    WHERE ludy_kernel.member_has_permission(${ctx.orgId}::uuid, ${userId}::uuid, k.p)`.execute(ctx.trx);
  const assignments = await ctx.trx.selectFrom('ludy_kernel.role_assignment').select('role_key').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
  return { permissions: new Set(rows.map((r) => r.permission)), roleKeys: new Set(assignments.map((a) => a.role_key)) };
}

export async function financeHomeMoney(ctx: QueryContext, input: { asOf?: string | undefined }): Promise<FinanceHomeMoney> {
  if (ctx.actor.type !== 'user') return { available: false };
  const standing = ctx.role === 'owner' || ctx.role === 'admin' ? { permissions: new Set<string>(), roleKeys: new Set<string>() } : await financeStanding(ctx, ctx.actor.userId);
  if (!canSeeMoneyTotals({ role: ctx.role, ...standing })) return { available: false };

  // Home shows one entity's books: a caller who sees several legal entities and has none as the default has to choose one on the Kế toán screens.
  let entity: string;
  try {
    entity = await resolveLegalEntity(ctx, undefined);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'LEGAL_ENTITY_REQUIRED' || error.code === 'LEGAL_ENTITY_NOT_ALLOWED')) return { available: false };
    throw error;
  }
  const asOf = input.asOf ?? (await databaseToday(ctx.trx));
  const rows = await balances(ctx, entity, null, asOf, false)
    .where((eb) => eb.or(HOME_MONEY_PREFIXES.map((prefix) => eb('l.account_code', 'like', `${prefix}%`))))
    .orderBy('account_code')
    .execute();
  const entries = asEntries(rows as BalanceRow[], asOf, entity);
  const bankCodes = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.accountCode)).filter((code) => code.startsWith('112')))];
  const chart = await chartAccounts(ctx, bankCodes);
  const names = new Map([...chart.values()].map((a) => [a.code, a.name]));
  return { available: true, asOf, ...buildHomeMoney(entries, entity, asOf, names) };
}

export const financeHomeMoneyQuery = defineQuery({
  name: 'finance.home_money',
  input: zFinanceHomeMoneyInput,
  access: ALL,
  handler: (ctx, input): Promise<FinanceHomeMoney> => financeHomeMoney(ctx, input),
});

