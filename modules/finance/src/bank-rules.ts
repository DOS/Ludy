// SPDX-License-Identifier: AGPL-3.0-only
// Learned rules that point a bank statement line's text, or its counterparty account number, at a party (issue #2402, part 2
// of #2385), after the learned account rules of #1399:
// - Learning: when the voucher of a bank line is approved and its proposal says `matchedBy.kind = 'manual'`: the person chose the
//   party themselves, or took one the server could not verify as the matcher's (never a suggestion it verified), finance.voucher.record writes a rule in the same
//   audited command: the keyed hash of the line's distinctive words (domain/bank-rule-key.ts) for that party. The key is
//   never stored as text. Only a user's approval teaches; a rule never posts anything.
// - Matching: lineMatchFor adds the parties whose rule the line's key hits, in the line's own org and legal entity, as
//   candidates with the reason `learned`. Two parties on one key make the line one to look at, never a clean one.
// - Settings: every role lists the rules (party, who confirmed, when, the voucher that taught it); owners and admins remove one
//   (R1, audited).
// The key is hashed with BANK_KEY_VERSION in front: a later change to the noise words or the key logic bumps it, and the rules
// learned under the old derivation are simply not hit again (a person's next match teaches the new key).
// Both the learner and the matcher hash through crove_finance.bank_party_rule_hash, so the deployment's key is read by that
// definer alone.
import { sql } from 'kysely';
import { z } from 'zod';
import { voucherCode, zId, type BankPartyRule } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { bankLineKey } from './domain/bank-rule-key.ts';
import { mappedAccounts } from './account-number.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// The most rules the Settings list shows, newest first.
export const BANK_RULE_LIST_LIMIT = 500;
// The version of each key derivation (the words: domain/bank-rule-key.ts; the account: its digits), part of what is hashed, so a change
// to one never orphans the rules of the other.
export const BANK_KEY_VERSIONS = { text: 1, account: 1 } as const;
const hashed = (kind: 'text' | 'account', key: string) => `${BANK_KEY_VERSIONS[kind]}:${key}`;

// The parties whose rule this line hits, in the line's org and legal entity: by the key of its words (kind 'text') and by its
// counterparty account number (kind 'account', #2402). A rule whose voucher was reversed since (a wrong match undone) teaches no
// more.
export async function learnedParties(
  ctx: QueryContext,
  line: { description: string; legalEntityId: string; counterpartyAccount?: string | null },
): Promise<{ text: string[]; account: string[] }> {
  const key = bankLineKey(line.description);
  const account = line.counterpartyAccount ?? null;
  if (key === null && account === null) return { text: [], account: [] };
  const { rows } = await sql<{ party_id: string; kind: string }>`
    SELECT r.party_id, r.kind FROM crove_finance.bank_party_rule r
    WHERE r.org_id = ${ctx.orgId} AND r.legal_entity_id = ${line.legalEntityId}
      AND ((${key}::text IS NOT NULL AND r.kind = 'text' AND r.key_hash = crove_finance.bank_party_rule_hash('text', ${hashed('text', key ?? '')}))
        OR (${account}::text IS NOT NULL AND r.kind = 'account' AND r.key_hash = crove_finance.bank_party_rule_hash('account', ${hashed('account', account ?? '')})))
      AND NOT EXISTS (
        SELECT 1 FROM crove_finance.journal_entry j
        JOIN crove_finance.journal_entry x ON x.org_id = j.org_id AND x.reverses_entry_id = j.id
        WHERE j.org_id = r.org_id AND j.source_id = r.source_voucher_id AND j.source_type = ${VOUCHER_SOURCE} AND j.reverses_entry_id IS NULL)`.execute(ctx.trx);
  return { text: rows.filter((r) => r.kind === 'text').map((r) => r.party_id), account: rows.filter((r) => r.kind === 'account').map((r) => r.party_id) };
}

// Writes the rules a user's own choice of party teaches, inside finance.voucher.record: one for the line's words and one for its
// counterparty account number when it has one; nothing when the approver is not a user, and nothing for a rule that exists.
// Returns what it wrote, for the audit row.
export async function learnFromVoucher(
  ctx: CommandContext,
  input: { voucherId: string; partyId: string; legalEntityId: string; description: string; counterpartyAccount?: string | null },
): Promise<{ text?: string; account?: string } | null> {
  if (ctx.actor.type !== 'user') return null;
  const write = async (kind: 'text' | 'account', key: string): Promise<string | undefined> => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO crove_finance.bank_party_rule (org_id, legal_entity_id, kind, key_hash, party_id, confirmed_by, confirmed_at, source_voucher_id)
      VALUES (${ctx.orgId}, ${input.legalEntityId}, ${kind}, crove_finance.bank_party_rule_hash(${kind}, ${hashed(kind, key)}), ${input.partyId}, ${ctx.actor.type === 'user' ? ctx.actor.userId : null}, ${ctx.now}, ${input.voucherId})
      ON CONFLICT ON CONSTRAINT bank_party_rule_key_uq DO NOTHING
      RETURNING id`.execute(ctx.trx);
    return rows[0]?.id;
  };
  const key = bankLineKey(input.description);
  const text = key === null ? undefined : await write('text', key);
  // The org's own account numbers (a bank feed mapping or a number recorded on a bank account) say nothing about the other side (a bank
  // prints the holder's own account for fees and interest).
  const own = input.counterpartyAccount
    ? (await mappedAccounts(ctx, input.counterpartyAccount)).length > 0
    : true;
  const account = input.counterpartyAccount && !own ? await write('account', input.counterpartyAccount) : undefined;
  return text || account ? { ...(text ? { text } : {}), ...(account ? { account } : {}) } : null;
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
