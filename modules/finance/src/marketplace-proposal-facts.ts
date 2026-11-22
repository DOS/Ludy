// SPDX-License-Identifier: AGPL-3.0-only
// The facts behind the coworker's note on a pending marketplace settlement or payout proposal (#4389, plan docs/plan/stock-and-marketplaces.md 8.6). Code reads the STORED proposal in the caller's own
// context (the proposal table's row security gives the Inbox's visibility: another org, or an entity outside the caller's scope, is not found), checks it is one of the two marketplace commands, and
// computes every figure in whole dong from its payload: nothing comes from the caller, nothing is written, and the model is never asked which points are uncertain. That is this file's closed table
// (`MARKETPLACE_UNCERTAIN`): each point names the rows of the posting map it is about and the condition that makes it relevant, so a proposal shows only the points of the rows it uses (a payout with no
// incentive line has no voucher point). A test pins every row name to the map, so a renamed row fails the build and the table is reviewed with it. The Uncertain (#2520) wording follows the map rows'
// own commentary and the research file (docs/research/marketplace-accounting-2026-11-21.md); L marks a legal reading, F a platform fact.
import { sql } from 'kysely';
import { zMarketplacePayoutProposal, zMarketplaceSettlementProposal, MARKETPLACE_PAYOUT_COMMAND, MARKETPLACE_SETTLEMENT_COMMAND, type MarketplacePayoutProposal } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { z } from 'zod';
import type { MarketplaceRow } from './marketplace-posting-map.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const zMarketplaceProposalFactsInput = z.strictObject({ proposalId: z.uuid() });

export type ProposalNoteFigure = 'sales' | 'sellerDiscount' | 'refund' | 'received' | 'fees' | 'taxWithheld' | 'incentive' | 'compensation' | 'compensationCost' | 'taxInError';
export type ProposalNoteLineKind = 'incentive' | 'carrier_compensation' | 'withheld_in_error';

export interface MarketplaceProposalFacts {
  kind: 'settlement' | 'payout';
  // Whole dong, digits only, told only when above zero.
  figures: Partial<Record<ProposalNoteFigure, string>>;
  lineKinds: ProposalNoteLineKind[];
  // The accounts of the entry's own lines, each once, in the order they appear.
  accounts: string[];
  // The Uncertain (#2520) points of the rows this proposal uses, by key, with the wording in both languages.
  uncertain: Array<{ key: string; vi: string; en: string }>;
}

interface UncertainPoint {
  key: string;
  // The rows of the posting map the point is about (every one must exist in the map).
  rows: readonly MarketplaceRow[];
  when: (facts: Pick<MarketplaceProposalFacts, 'kind' | 'figures' | 'accounts'>) => boolean;
  vi: string;
  en: string;
}

const above = (value: string | undefined): boolean => value !== undefined && money(value).gt(0);

export const MARKETPLACE_UNCERTAIN: readonly UncertainPoint[] = Object.freeze([
  {
    key: 'receivable',
    rows: ['receivable'],
    when: () => true,
    vi: 'Khoản phải thu từ sàn ghi vào 131; một số kế toán dùng 1388 (chưa có kết luận).',
    en: 'The platform receivable is booked on 131; some accountants use 1388 (not settled).',
  },
  {
    key: 'revenue_voucher',
    rows: ['revenue'],
    when: (f) => f.kind === 'settlement' && above(f.figures.sellerDiscount),
    vi: 'Mã giảm giá của sàn khác mã của người bán: chưa tìm thấy quy định cho mã của sàn, và chỉ Shopee có cơ sở hóa đơn rõ.',
    en: "A platform voucher differs from the seller's: no ruling found for the platform's, and only Shopee's invoice base is first-party.",
  },
  {
    key: 'sales_return',
    rows: ['salesReturn'],
    when: (f) => f.kind === 'settlement' && above(f.figures.refund),
    vi: 'Hoàn trả cho người mua: chưa rõ ảnh hưởng thuế thu nhập doanh nghiệp khi hoàn sau khi đã khóa năm, và ai chịu khoản hoàn.',
    en: 'Refunds to buyers: the corporate income tax effect after the year closed and who funds a refund are not settled.',
  },
  {
    key: 'output_vat',
    rows: ['outputVat'],
    when: (f) => f.kind === 'settlement' && f.accounts.includes('33311'),
    vi: 'Thuế GTGT đầu ra tính theo thuế suất đang hiệu lực của từng hàng; thuế suất 8% hay 10% còn tùy quy định hiện hành.',
    en: 'Output VAT follows the rate in force on each item; whether 8% or 10% applies depends on the current rule.',
  },
  {
    key: 'household_tax',
    rows: ['vatPayable', 'pitPayable'],
    when: (f) => above(f.figures.taxWithheld),
    vi: 'Thuế sàn giữ lại là thuế đã nộp thay: chưa chắc có phải khai lại không, và các trường thuế của sàn đều có độ tin cậy thấp.',
    en: 'The withheld tax is tax already paid on your behalf: whether it must be declared again is not settled, and every platform tax field is low confidence.',
  },
  {
    key: 'fee_netting',
    rows: ['feePayable'],
    when: (f) => f.kind === 'payout' && above(f.figures.fees),
    vi: 'Phí sàn bù trừ ngay khi nhận tiền: chưa rõ có đủ điều kiện thanh toán không dùng tiền mặt để khấu trừ thuế GTGT đầu vào, và ai xuất hóa đơn phí.',
    en: 'Fees are netted when the money arrives: whether that meets the non-cash payment condition for input VAT, and who issues the fee invoice, are not settled.',
  },
  {
    key: 'other_income',
    rows: ['otherIncome'],
    when: (f) => f.kind === 'payout' && (above(f.figures.incentive) || (above(f.figures.compensation) && money(f.figures.compensation ?? '0').gt(f.figures.compensationCost ?? '0'))),
    vi: 'Khoản thưởng hoặc phần bồi thường vượt giá vốn ghi vào thu nhập khác (711): chưa rõ có bị coi là dịch vụ chịu thuế không.',
    en: 'An incentive, or compensation above cost, is booked as other income (711): whether it counts as a taxed service is not settled.',
  },
  {
    key: 'compensation_cost',
    rows: ['costOfGoods'],
    when: (f) => f.kind === 'payout' && above(f.figures.compensation),
    vi: 'Bồi thường hàng mất ghi giảm giá vốn (632) theo giá vốn người dùng nhập, phần còn lại vào 711: ghi thuần hay gộp là lựa chọn của kế toán.',
    en: 'Compensation for lost goods reduces cost of goods (632) up to the cost a person stated, the rest goes to 711: net or gross is the accountant\'s choice.',
  },
  {
    key: 'tax_in_error',
    rows: ['otherReceivable'],
    when: (f) => f.kind === 'payout' && above(f.figures.taxInError),
    vi: 'Thuế bị giữ nhầm ghi vào 1388: cơ quan thuế có thể hoàn thay vì sàn hoàn, chưa có kết luận.',
    en: 'Tax withheld by mistake is booked on 1388: the tax office may refund it instead of the platform, not settled.',
  },
]);

const whole = (value: string): string => money(value).toDecimalPlaces(0, 4).toFixed(0);

function figuresOf(entries: Array<[ProposalNoteFigure, string]>): Partial<Record<ProposalNoteFigure, string>> {
  const out: Partial<Record<ProposalNoteFigure, string>> = {};
  for (const [key, value] of entries) {
    const dong = whole(value);
    if (money(dong).gt(0)) out[key] = dong;
  }
  return out;
}

const accountsOf = (lines: ReadonlyArray<{ account: string }>): string[] => [...new Set(lines.map((l) => l.account).filter((a) => /^\d{3,5}$/.test(a)))];

// The classified amounts of a payout, in whole dong, from its stored adjustments.
function classified(adjustments: MarketplacePayoutProposal['adjustments']) {
  const total = (kind: ProposalNoteLineKind, pick: (a: MarketplacePayoutProposal['adjustments'][number]) => string) => toMoney(sum(adjustments.filter((a) => a.kind === kind).map(pick)));
  return {
    incentive: total('incentive', (a) => a.amount),
    compensation: total('carrier_compensation', (a) => a.amount),
    compensationCost: total('carrier_compensation', (a) => (a.kind === 'carrier_compensation' ? a.costAmount : '0')),
    taxInError: total('withheld_in_error', (a) => a.amount),
  };
}

/** The facts of a stored settlement or payout payload, or null when it is neither (or no longer fits its shape). Pure. */
export function marketplaceProposalFacts(command: string, payload: unknown): MarketplaceProposalFacts | null {
  if (command === MARKETPLACE_SETTLEMENT_COMMAND) {
    const parsed = zMarketplaceSettlementProposal.safeParse(payload);
    if (!parsed.success) return null;
    const p = parsed.data;
    const facts = { kind: 'settlement' as const, figures: figuresOf([['sales', p.sales], ['sellerDiscount', p.sellerDiscount], ['refund', p.refund], ['taxWithheld', p.taxEstimate?.withheld ?? '0']]), lineKinds: [], accounts: accountsOf(p.lines) };
    return { ...facts, uncertain: uncertainFor(facts) };
  }
  if (command === MARKETPLACE_PAYOUT_COMMAND) {
    const parsed = zMarketplacePayoutProposal.safeParse(payload);
    if (!parsed.success) return null;
    const p = parsed.data;
    const c = classified(p.adjustments);
    const lineKinds = (['incentive', 'carrier_compensation', 'withheld_in_error'] as const).filter((kind) => p.adjustments.some((a) => a.kind === kind));
    const facts = {
      kind: 'payout' as const,
      figures: figuresOf([['received', p.received], ['fees', p.fees], ['taxWithheld', p.taxWithheld], ['incentive', c.incentive], ['compensation', c.compensation], ['compensationCost', c.compensationCost], ['taxInError', c.taxInError]]),
      lineKinds,
      accounts: accountsOf(p.lines),
    };
    return { ...facts, uncertain: uncertainFor(facts) };
  }
  return null;
}

/** The points of the closed table whose rows this proposal uses, in table order. */
function uncertainFor(facts: Pick<MarketplaceProposalFacts, 'kind' | 'figures' | 'accounts'>): MarketplaceProposalFacts['uncertain'] {
  return MARKETPLACE_UNCERTAIN.filter((point) => point.when(facts)).map(({ key, vi, en }) => ({ key, vi, en }));
}

// The read: the stored proposal in the caller's own context. The proposal table's `le_scope` policy hides an entity outside the caller's scope and tenancy hides another org, so both read as not found
// (404, the same as kernel.inbox.get). A proposal the caller can see that is not a marketplace settlement or payout (any other voucher the Inbox shows with the same card) answers null: there is nothing
// to explain, and the screen shows no note. The payload is read from the stored row only; the caller names nothing but the id.
export const marketplaceProposalFactsQuery = defineQuery({
  name: 'finance.marketplace.proposal_facts',
  input: zMarketplaceProposalFactsInput,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceProposalFacts | null> => {
    const { rows } = await sql<{ command: string | null; payload: unknown }>`
      SELECT command, payload FROM crove_kernel.proposal WHERE org_id = ${ctx.orgId}::uuid AND id = ${input.proposalId}::uuid`.execute(ctx.trx);
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
    return row.command ? marketplaceProposalFacts(row.command, row.payload) : null;
  },
});

export const marketplaceProposalFactsQueries = [marketplaceProposalFactsQuery];
