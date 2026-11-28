// Learned per-line account rules (issue #1399, #1452, plan §8.6 "Memory": learned deterministic rules stored as rows
// with provenance, applied before the LLM). A rule maps an invoice line to the account it is posted to, by the line's
// whole item description (normalized) or by a keyword in it, for purchases or sales, for one vendor/customer or for
// every vendor/customer.
// - Learning: when a purchase or sales invoice is approved under TT133 (finance.purchase.record), every line whose
//   account a user chose on the approved revision (finance.purchase.revise marks it) writes or updates the counterparty's
//   description rule for that direction, with the approver, the time and the new document as provenance, in the same
//   audited command.
// - Suggesting: extraction reads the counterparty's rules and every counterparty's rules for that direction
//   (rulesForSuggestion) and @ludy/l10n-vn applies them: for purchases (suggestDebitAccount) in order of vendor's own
//   rules, vendor's default account, every vendor's rules, then built-in keywords; for sales (suggestSalesAccount) in
//   order of customer's own sales rules, every customer's sales rules, then built-in 511. A rule only proposes an
//   account: the approver confirms every line and the posting checks the account again.
// - Settings: every role lists the rules; owners and admins add a purchase or sales keyword rule and remove any rule
//   (R1, audited).
// Matching is plain string comparison on normalized text (normalizeRuleText): no pattern from user input is compiled,
// and the lookup reads at most LEARNED_RULE_LIMIT rules of each scope.
import { sql } from 'kysely';
import { z } from 'zod';
import { isRevenueAccount, zAccountCode, zDocumentDirection, zId, type CategorizationRule, type DocumentDirection } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { descriptionRuleText, keywordRuleText, money, type LearnedRule, type ProposedLine } from '@ludy/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// The most rules of one scope (the vendor's own, or every vendor's) a suggestion reads, newest first.
export const LEARNED_RULE_LIMIT = 500;
// The most rules the Settings list shows, newest first.
export const RULE_LIST_LIMIT = 500;
// The reason finance.purchase.revise gave a line a user picked before #1399 marked it with accountRule.
const USER_CHOSEN_REASON = 'Người dùng chọn';

// The rules a suggestion reads for an invoice of `partyId` (null: a vendor/customer not yet in the books) and
// `direction`: the party's own and every party's, each newest first, skipping a rule whose sub-account was deactivated
// since or whose account mismatches `direction`. Rules are learned per legal entity (#1280), so only those of the
// invoice's entity are read.
export async function rulesForSuggestion(
  ctx: QueryContext,
  partyId: string | null,
  legalEntityId: string,
  direction: DocumentDirection = 'purchase',
): Promise<LearnedRule[]> {
  const sale = direction === 'sale';
  const load = async (vendor: boolean) => {
    if (vendor && partyId === null) return [];
    const rows = await ctx.trx
      .selectFrom('ludy_finance.categorization_rule as r')
      .select(['r.id', 'r.direction', 'r.match_kind', 'r.match_text', 'r.label', 'r.debit_account'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.legal_entity_id', '=', legalEntityId)
      .where('r.direction', '=', direction)
      .where((eb) => (vendor && partyId !== null ? eb('r.vendor_party_id', '=', partyId) : eb('r.vendor_party_id', 'is', null)))
      .where(({ or, exists, selectFrom }) =>
        or([
          exists(selectFrom('ludy_finance.account as a').select('a.code').whereRef('a.code', '=', 'r.debit_account')),
          exists(
            selectFrom('ludy_finance.org_account as o')
              .select('o.code')
              .whereRef('o.org_id', '=', 'r.org_id')
              .whereRef('o.code', '=', 'r.debit_account')
              .where('o.active', '=', true),
          ),
        ]),
      )
      .orderBy('r.confirmed_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(LEARNED_RULE_LIMIT)
      .execute();
    return rows
      .filter((r) => isRevenueAccount(r.debit_account) === sale)
      .map((r) => ({ id: r.id, direction: r.direction, vendor, kind: r.match_kind, text: r.match_text, label: r.label, account: r.debit_account }));
  };
  return [...(await load(true)), ...(await load(false))];
}

// The lines of an approved purchase or sale whose account a user chose: marked by finance.purchase.revise, or, on a
// revision made before #1399, by its reason.
export function userChosenLines<L extends Pick<ProposedLine, 'reason' | 'accountRule'>>(lines: readonly L[]): L[] {
  return lines.filter((l) => l.accountRule?.source === 'user' || (l.accountRule === undefined && l.reason === USER_CHOSEN_REASON));
}

// Writes or updates the vendor's or customer's description rule for every line whose account a user chose (#1399,
// #1452), inside finance.purchase.record. Lines with the same item text teach one rule: the line with the largest
// amount (either sign) decides, the first line on a tie. Written in text order, so two approvals for one party take
// the rows' locks in the same order. Only a user's approval teaches; returns what it wrote, for the audit row.
export async function learnFromApproval(
  ctx: CommandContext,
  input: {
    direction?: DocumentDirection;
    partyId: string;
    documentId: string;
    lines: ReadonlyArray<Pick<ProposedLine, 'lineNo' | 'description' | 'amount' | 'debitAccount' | 'reason' | 'accountRule'>>;
  },
): Promise<Array<{ ruleId: string; lineNo: number; account: string; created: boolean }>> {
  if (ctx.actor.type !== 'user') return [];
  const direction = input.direction ?? 'purchase';
  const sale = direction === 'sale';
  const byText = new Map<string, (typeof input.lines)[number]>();
  for (const line of userChosenLines(input.lines)) {
    if (isRevenueAccount(line.debitAccount) !== sale) continue;
    const text = descriptionRuleText(line.description);
    if (text === null) continue;
    const kept = byText.get(text);
    if (!kept || money(line.amount).abs().greaterThan(money(kept.amount).abs())) byText.set(text, line);
  }
  const learned: Array<{ ruleId: string; lineNo: number; account: string; created: boolean }> = [];
  for (const [text, line] of [...byText.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const provenance = {
      label: line.description.trim().slice(0, 500),
      debit_account: line.debitAccount,
      confirmed_by: ctx.actor.userId,
      confirmed_at: ctx.now,
      source_document_id: input.documentId,
    };
    const row = await ctx.trx
      .insertInto('ludy_finance.categorization_rule')
      .values({ org_id: ctx.orgId, direction, vendor_party_id: input.partyId, match_kind: 'description', match_text: text, ...provenance })
      .onConflict((oc) => oc.constraint('categorization_rule_match_uq').doUpdateSet(provenance))
      .returning(['id', sql<boolean>`(xmax = 0)`.as('created')])
      .executeTakeFirstOrThrow();
    learned.push({ ruleId: row.id, lineNo: line.lineNo, account: line.debitAccount, created: row.created });
  }
  return learned;
}

export const categorizationRulesList = defineQuery({
  name: 'finance.categorization_rules.list',
  // The rules of one legal entity (#1280): legalEntityId as in zLegalEntityChoice.
  input: z.object({ legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<CategorizationRule[]> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('ludy_finance.categorization_rule as r')
      .leftJoin('ludy_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'r.org_id').onRef('p.id', '=', 'r.vendor_party_id'))
      .leftJoin('ludy_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.source_document_id'))
      .select([
        'r.id',
        'r.direction',
        'r.vendor_party_id',
        'p.name as vendor_name',
        'r.match_kind',
        'r.match_text',
        'r.label',
        'r.debit_account',
        'r.confirmed_by',
        'r.confirmed_at',
        'r.source_document_id',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
      ])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.legal_entity_id', '=', legalEntityId)
      .orderBy('r.confirmed_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(RULE_LIST_LIMIT)
      .execute();
    // The lines of approved invoices a person gave another account than the rule had proposed (#2379), read from the
    // revisions that were approved: no counter is stored, so it cannot drift from them.
    const corrections = new Map<string, number>();
    if (rows.length > 0) {
      const { rows: counted } = await sql<{ rule_id: string; n: string }>`
        SELECT l #>> '{accountRule,correctedRuleId}' AS rule_id, count(*) AS n
        FROM ludy_kernel.proposal p
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.payload -> 'lines') = 'array' THEN p.payload -> 'lines' ELSE '[]'::jsonb END) l
        WHERE p.org_id = ${ctx.orgId} AND p.command = 'finance.purchase.record' AND p.status = 'executed'
          AND (l #>> '{accountRule,correctedRuleId}') = ANY(${rows.map((r) => r.id)}::text[])
        GROUP BY 1`.execute(ctx.trx);
      for (const c of counted) corrections.set(c.rule_id, Number(c.n));
    }
    // Who confirmed a rule, by name while they are a member (ludy_kernel.member_profiles answers only members).
    const users = [...new Set(rows.map((r) => r.confirmed_by).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (users.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM ludy_kernel.member_profiles(${users}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      vendor: r.vendor_party_id ? { partyId: r.vendor_party_id, name: r.vendor_name ?? '' } : null,
      matchKind: r.match_kind,
      matchText: r.match_text,
      label: r.label,
      accountCode: r.debit_account,
      confirmedBy: r.confirmed_by ? (names.get(r.confirmed_by) ?? null) : null,
      confirmedAt: r.confirmed_at.toISOString(),
      corrections: corrections.get(r.id) ?? 0,
      sourceDocument:
        r.source_document_id && r.invoice_number !== null && r.invoice_date !== null
          ? { documentId: r.source_document_id, series: r.invoice_series ?? '', number: r.invoice_number, invoiceDate: r.invoice_date }
          : null,
    }));
  },
});

export const createCategorizationRule = defineCommand({
  name: 'finance.categorization_rule.create',
  input: z.object({
    keyword: z.string().trim().min(1).max(500),
    accountCode: zAccountCode,
    direction: zDocumentDirection.default('purchase'),
    // Omitted or null: the rule applies to every vendor or every customer.
    vendorPartyId: zId.nullable().optional(),
    // The legal entity whose invoices the rule is for (#1280), as in zLegalEntityChoice.
    legalEntityId: zId.optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input) => {
    const text = keywordRuleText(input.keyword);
    if (text === null) {
      throw new DomainError('RULE_TEXT_TOO_SHORT', 422, 'Từ khóa cần có ít nhất hai chữ cái hoặc chữ số');
    }
    const sale = input.direction === 'sale';
    // Purchase rules never propose revenue accounts; sales rules propose only revenue accounts (#430, #1452).
    if (!sale && isRevenueAccount(input.accountCode)) {
      throw new DomainError('REVENUE_ACCOUNT_ON_PURCHASE', 422, `Quy tắc dùng cho hàng hóa, dịch vụ mua vào nên không chọn tài khoản doanh thu ${input.accountCode}`, {
        account: input.accountCode,
      });
    }
    if (sale && !isRevenueAccount(input.accountCode)) {
      throw new DomainError(
        'NOT_REVENUE_ACCOUNT',
        422,
        `Quy tắc dùng cho hàng hóa, dịch vụ bán ra nên phải chọn tài khoản doanh thu (511, 515, 711, 3387 hoặc tài khoản con của chúng), không phải ${input.accountCode}`,
        { account: input.accountCode },
      );
    }
    await assertUsableAccounts(ctx, [input.accountCode]);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const vendorPartyId = input.vendorPartyId ?? null;
    if (vendorPartyId !== null) {
      const party = await ctx.trx.selectFrom('ludy_kernel.party').select('id').where('org_id', '=', ctx.orgId).where('id', '=', vendorPartyId).executeTakeFirst();
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, sale ? 'Không tìm thấy khách hàng' : 'Không tìm thấy nhà cung cấp');
    }
    const row = await ctx.trx
      .insertInto('ludy_finance.categorization_rule')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        direction: input.direction,
        vendor_party_id: vendorPartyId,
        match_kind: 'keyword',
        match_text: text,
        label: input.keyword.slice(0, 500),
        debit_account: input.accountCode,
        confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        confirmed_at: ctx.now,
      })
      .onConflict((oc) => oc.constraint('categorization_rule_match_uq').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new DomainError('RULE_EXISTS', 409, `Đã có quy tắc cho từ khóa "${input.keyword}"; hãy xóa quy tắc cũ trước nếu muốn đổi tài khoản`);
    ctx.audit({ ruleId: row.id, direction: input.direction, matchKind: 'keyword', matchText: text, accountCode: input.accountCode, vendorPartyId, legalEntityId });
    return { id: row.id };
  },
});

export const removeCategorizationRule = defineCommand({
  name: 'finance.categorization_rule.remove',
  input: z.object({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.categorization_rule', id: input.id }),
  handler: async (ctx, { id }) => {
    const removed = await ctx.trx
      .deleteFrom('ludy_finance.categorization_rule')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id)
      .returning(['direction', 'vendor_party_id', 'match_kind', 'match_text', 'debit_account', 'confirmed_by', 'source_document_id'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('RULE_NOT_FOUND', 404, 'Không tìm thấy quy tắc này; có thể đã có người xóa');
    // The audit row keeps what the rule said and where it came from.
    ctx.audit({
      ruleId: id,
      direction: removed.direction,
      vendorPartyId: removed.vendor_party_id,
      matchKind: removed.match_kind,
      matchText: removed.match_text,
      accountCode: removed.debit_account,
      confirmedBy: removed.confirmed_by,
      sourceDocumentId: removed.source_document_id,
    });
    return { id };
  },
});

export const categorizationCommands = [createCategorizationRule, removeCategorizationRule];
export const categorizationQueries = [categorizationRulesList];
