// SPDX-License-Identifier: AGPL-3.0-only
// The numbers of the org's bank accounts (#2183, after #2142): an owner or admin records the digits a bank statement names
// on a bank account of an entity, so a statement that arrives by email or in the Inbox finds its account without a bank
// feed (a bank feed mapping, #2099, is the other way; both are read by finance.bank.statement_stage).
// - finance.bank_account_number.set: records a number on a bank account (a 112 account or an org sub-account under it, in
//   use). One number belongs to one bank account of an org: the same number on the same account is a no-op, on another
//   account (or as a bank feed mapping of another account) is BANK_ACCOUNT_NUMBER_TAKEN. A bank account may hold several.
// - finance.bank_account_number.clear: removes a number; the lines already imported stay. Changing a number is a clear
//   and a set; both are audited, with the number replaced by its class (the audit trail never holds an account number).
// - finance.bank_account_number.list: the numbers the caller's entities hold, for the Settings card (owners and admins).
// A number belongs to an entity (the row is under the entity scope): the one that holds the bank account, as a feed
// mapping does. Nothing here moves money or posts a line.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { auditValue, zBankAccountNumberSet, zId, type BankAccountNumberView } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { accountNumberDigits } from './account-number.ts';
import { bankAccount } from './bank.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { financeManifest } from './manifest.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// The number is a `payment` column: an audit fact keeps its class, never its digits (#1626). bank_account is the chart
// account code (112x) the number is recorded on, internal data as in bank-feed.ts, listed for this file in
// apps/kernel/test/audit-facts.test.ts.
const NUMBER = financeManifest.tables.crove_finance.bank_account_number;

// One answer for a number that is on another bank account, whether the caller can read that row or row security hides it
// (as #2079 did for a feed mapping): nothing says which entity or account holds it.
const taken = () => new DomainError('BANK_ACCOUNT_NUMBER_TAKEN', 409, 'Số tài khoản này đã gắn với một tài khoản ngân hàng khác của tổ chức; hãy gỡ số đó ở tài khoản kia trước');

export const bankAccountNumberSet = defineCommand({
  name: 'finance.bank_account_number.set',
  input: zBankAccountNumberSet,
  // It decides which bank account a statement's lines are offered to (a member still imports them) and posts nothing (R1,
  // as mapping a bank feed account is).
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const digits = accountNumberDigits(input.accountNumber);
    if (digits === null) throw new DomainError('BANK_ACCOUNT_NUMBER_INVALID', 422, 'Số tài khoản chỉ gồm chữ số (6 đến 20 chữ số); khoảng trắng, dấu chấm và dấu gạch ngang giữa các nhóm số được bỏ qua');
    await bankAccount(ctx, input.bankAccount, true);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // Two records of one number at once: the second waits, then finds the first's row (a lookup of a row that does not
    // exist yet locks nothing).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.bank_account_number:${ctx.orgId}:${digits}`}, 0))`.execute(ctx.trx);
    const existing = await ctx.trx
      .selectFrom('crove_finance.bank_account_number')
      .select(['id', 'bank_account', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('account_number', '=', digits)
      .executeTakeFirst();
    if (existing) {
      if (existing.bank_account !== input.bankAccount || existing.legal_entity_id !== legalEntityId) throw taken();
      return { id: existing.id };
    }
    // The same number as a bank feed mapping of another bank account would make a statement for it ambiguous.
    const fed = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account')
      .select(['bank_account', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where(sql<boolean>`pg_catalog.regexp_replace(external_account_id, '[^0-9]', '', 'g') = ${digits}`)
      .execute();
    if (fed.some((f) => f.bank_account !== input.bankAccount || f.legal_entity_id !== legalEntityId)) throw taken();
    // Under the number's lock the lookups above have seen every row the caller may read. A conflict here is a row that
    // row security hides from the caller (another entity's): the same answer as a visible one.
    const inserted = await ctx.trx
      .insertInto('crove_finance.bank_account_number')
      .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, bank_account: input.bankAccount, account_number: digits, created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null })
      .onConflict((oc) => oc.columns(['org_id', 'account_number']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) throw taken();
    ctx.audit({ numberId: inserted.id, bankAccount: input.bankAccount, legalEntityId, accountNumber: auditValue(NUMBER, 'account_number', digits) });
    return { id: inserted.id };
  },
});

export const bankAccountNumberClear = defineCommand({
  name: 'finance.bank_account_number.clear',
  input: z.strictObject({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const removed = await ctx.trx
      .deleteFrom('crove_finance.bank_account_number')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .returning(['id', 'bank_account', 'legal_entity_id', 'account_number'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('BANK_ACCOUNT_NUMBER_NOT_FOUND', 404, 'Không tìm thấy số tài khoản này');
    ctx.audit({ numberId: removed.id, bankAccount: removed.bank_account, legalEntityId: removed.legal_entity_id, accountNumber: auditValue(NUMBER, 'account_number', removed.account_number) });
    return { id: removed.id };
  },
});

export const bankAccountNumberList = defineQuery({
  name: 'finance.bank_account_number.list',
  input: z.object({}),
  access: MANAGERS,
  handler: async (ctx): Promise<BankAccountNumberView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_account_number')
      .select(['id', 'bank_account', 'account_number', 'legal_entity_id', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('bank_account')
      .orderBy('account_number')
      .limit(500)
      .execute();
    return rows.map((r) => ({ id: r.id, bankAccount: r.bank_account, accountNumber: r.account_number, legalEntityId: r.legal_entity_id, createdAt: new Date(r.created_at).toISOString() }));
  },
});

export const bankAccountNumberCommands = [bankAccountNumberSet, bankAccountNumberClear];
export const bankAccountNumberQueries = [bankAccountNumberList];
