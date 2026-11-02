// SPDX-License-Identifier: AGPL-3.0-only
// Learned rules that point a bank statement line's text at a party (issue #2402, part 2 of #2385), after the learned account
// rules of #1399:
// - Learning: when the voucher of a bank line is approved and its proposal says the person chose the party themselves
//   (`matchedBy.kind = 'manual'`, never a suggestion the matcher made), finance.voucher.record writes a rule in the same
//   audited command: the keyed hash of the line's distinctive words (domain/bank-rule-key.ts) for that party. The key is
//   never stored as text. Only a user's approval teaches; a rule never posts anything.
// - Matching: lineMatchFor adds the parties whose rule the line's key hits, in the line's own org and legal entity, as
//   candidates with the reason `learned`. Two parties on one key make the line one to look at, never a clean one.
// - Settings: every role lists the rules (party, who confirmed, when, the voucher that taught it); owners and admins remove one
//   (R1, audited).
// Both the learner and the matcher hash through crove_finance.bank_party_rule_hash, so the deployment's key is read by that
// definer alone.
import { sql } from 'kysely';
import { z } from 'zod';
import { voucherCode, zId, type BankPartyRule } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { bankLineKey } from './domain/bank-rule-key.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// The most rules the Settings list shows, newest first.
export const BANK_RULE_LIST_LIMIT = 500;

// The parties whose rule this line's text hits, in the line's org and legal entity.
export async function learnedParties(ctx: QueryContext, line: { description: string; legalEntityId: string }): Promise<string[]> {
  const key = bankLineKey(line.description);
  if (key === null) return [];
  const { rows } = await sql<{ party_id: string }>`
    SELECT r.party_id FROM crove_finance.bank_party_rule r
    WHERE r.org_id = ${ctx.orgId} AND r.legal_entity_id = ${line.legalEntityId} AND r.kind = 'text'
      AND r.key_hash = crove_finance.bank_party_rule_hash('text', ${key})`.execute(ctx.trx);
  return rows.map((r) => r.party_id);
}

// Writes the rule a user's own choice of party teaches, inside finance.voucher.record; nothing when the line's text has no key,
// when the approver is not a user, or when the rule exists. Returns what it wrote, for the audit row.
export async function learnFromVoucher(
  ctx: CommandContext,
  input: { voucherId: string; partyId: string; legalEntityId: string; description: string },
): Promise<{ ruleId: string } | null> {
  if (ctx.actor.type !== 'user') return null;
  const key = bankLineKey(input.description);
  if (key === null) return null;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO crove_finance.bank_party_rule (org_id, legal_entity_id, kind, key_hash, party_id, confirmed_by, confirmed_at, source_voucher_id)
    VALUES (${ctx.orgId}, ${input.legalEntityId}, 'text', crove_finance.bank_party_rule_hash('text', ${key}), ${input.partyId}, ${ctx.actor.userId}, ${ctx.now}, ${input.voucherId})
    ON CONFLICT ON CONSTRAINT bank_party_rule_key_uq DO NOTHING
    RETURNING id`.execute(ctx.trx);
  return rows[0] ? { ruleId: rows[0].id } : null;
}

export const bankPartyRulesList = defineQuery({
  name: 'finance.bank_party_rules.list',
  // The rules of one legal entity (#1280): legalEntityId as in zLegalEntityChoice.
  input: z.object({ legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<BankPartyRule[]> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_party_rule as r')
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'r.org_id').onRef('p.id', '=', 'r.party_id'))
      .innerJoin('crove_finance.cash_voucher as v', (join) => join.onRef('v.org_id', '=', 'r.org_id').onRef('v.id', '=', 'r.source_voucher_id'))
      .select(['r.id', 'r.kind', 'r.party_id', 'p.name as party_name', 'r.confirmed_by', 'r.confirmed_at', 'r.source_voucher_id', 'v.voucher_type', 'v.number'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.legal_entity_id', '=', legalEntityId)
      .orderBy('r.confirmed_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(BANK_RULE_LIST_LIMIT)
      .execute();
    // Who confirmed a rule, by name while they are a member (crove_kernel.member_profiles answers only members).
    const users = [...new Set(rows.map((r) => r.confirmed_by).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (users.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${users}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      party: { partyId: r.party_id, name: r.party_name },
      confirmedBy: r.confirmed_by ? (names.get(r.confirmed_by) ?? null) : null,
      confirmedAt: r.confirmed_at.toISOString(),
      voucher: { voucherId: r.source_voucher_id, code: voucherCode(r.voucher_type, r.number) },
    }));
  },
});

export const removeBankPartyRule = defineCommand({
  name: 'finance.bank_party_rule.remove',
  input: z.object({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.bank_party_rule', id: input.id }),
  handler: async (ctx, { id }) => {
    const removed = await ctx.trx
      .deleteFrom('crove_finance.bank_party_rule')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id)
      .returning(['party_id', 'kind', 'confirmed_by', 'source_voucher_id', 'legal_entity_id'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('RULE_NOT_FOUND', 404, 'Không tìm thấy quy tắc này; có thể đã có người xóa');
    // The audit row keeps where the rule came from, never what it matched (the table holds only a hash of it).
    ctx.audit({
      ruleId: id,
      kind: removed.kind,
      partyId: removed.party_id,
      confirmedBy: removed.confirmed_by,
      sourceVoucherId: removed.source_voucher_id,
      legalEntityId: removed.legal_entity_id,
    });
    return { id };
  },
});

export const bankPartyRuleCommands = [removeBankPartyRule];
export const bankPartyRuleQueries = [bankPartyRulesList];
