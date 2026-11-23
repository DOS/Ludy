// SPDX-License-Identifier: AGPL-3.0-only
// What to know before closing a month of stock (#3712 slice 3): the entity's books regime on the month's last day and its 1381 balance at that day. Read only, from the ledger; a
// reversal entry takes back what the entry it reverses posted, so it counts against the same balance. The answer is a warning for the screen and never blocks finance.stock.prepare_close
// or finance.stock.close_empty. No model, nothing written.
import { sql } from 'kysely';
import { zStockCloseRequest, type StockCloseCheck } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineQuery } from '@ludy/kernel-runtime';
import { balanceOf, closeCheckApplies, WAITING_SHORTAGE_ACCOUNT } from './domain/stock-close-check.ts';
import { monthEnd } from './domain/stock-close.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { booksOn } from './payroll-posting.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const stockCloseCheck = defineQuery({
  name: 'finance.stock.close_check',
  input: zStockCloseRequest,
  access: REQUESTERS,
  handler: async (ctx, { month, legalEntityId: requested }): Promise<StockCloseCheck> => {
    const legalEntityId = await resolveLegalEntity(ctx, requested);
    const last = monthEnd(month);
    const { regime } = await booksOn(ctx, legalEntityId, last);
    const { rows } = await sql<{ debit: string; credit: string }>`
      SELECT l.debit::text AS debit, l.credit::text AS credit
      FROM ludy_finance.journal_line l
      JOIN ludy_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
      WHERE l.org_id = ${ctx.orgId}::uuid AND l.legal_entity_id = ${legalEntityId}::uuid AND l.account_code = ${WAITING_SHORTAGE_ACCOUNT} AND e.entry_date <= ${last}::date`.execute(ctx.trx);
    const balance1381 = balanceOf(rows);
    return { month, legalEntityId, regime, balance1381, applies: closeCheckApplies(regime, balance1381) };
  },
});

export const stockCloseQueries = [stockCloseCheck];
