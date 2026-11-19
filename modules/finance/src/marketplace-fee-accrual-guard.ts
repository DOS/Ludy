// SPDX-License-Identifier: AGPL-3.0-only
// The key of a month-end accrual of platform fees and the rule that there is one at a time (#2516 rework, slice F, option 2 of the Accounting PO; plan docs/plan/stock-and-marketplaces.md section 8.4,
// rows 15 and 16 of section 5). The accrual (Dr 6421 / Cr 335 for the fees the platform kept at a payout whose invoice has not come) is an ordinary general journal voucher a person approves, so it has
// no command of its own and nothing in the voucher's tables names it. Its STABLE KEY is a tag in the voucher's description: `[fee-accrual:<platform>:<YYYY-MM>]`, read back from
// crove_finance.journal_entry.description (a voucher's entry carries the description). The generic voucher commands ask this module before they build and before they post:
// - a platform's accrual that still stands (an original entry with that key and no reversal) refuses a second one, of any month: reverse the standing accrual first (MARKETPLACE_FEE_ACCRUAL_STANDS);
// - another accrual of the same platform and month waiting for approval refuses a second request (MARKETPLACE_FEE_ACCRUAL_PENDING).
// A description with no key is none of this module's business. Facts only, no model.
import { sql } from 'kysely';
import { JOURNAL_VOUCHER_KIND } from '@ludy/kernel-contract';
import { DomainError, type QueryContext } from '@ludy/kernel-runtime';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

const KEY = /\[fee-accrual:([a-z0-9_]+):(\d{4}-\d{2})\]/;

export const feeAccrualKey = (platform: string, month: string): string => `[fee-accrual:${platform}:${month}]`;

// The platform and month a description's key names, or null for a description with none.
export function parseFeeAccrualKey(description: string): { platform: string; month: string } | null {
  const m = KEY.exec(description);
  return m ? { platform: m[1] as string, month: m[2] as string } : null;
}

// "Trích trước phí sàn tháng 10/2026, ước tính (Shopee) [fee-accrual:shopee:2026-10]": the proposal's title is made from this text, so it says what it is for the approver.
export const feeAccrualDescription = (platformName: string, platform: string, month: string): string =>
  `Trích trước phí sàn tháng ${month.slice(5, 7)}/${month.slice(0, 4)}, ước tính (${platformName}) ${feeAccrualKey(platform, month)}`;

export interface StandingFeeAccrual {
  entryId: string;
  entryDate: string;
  month: string;
}

// Every accrual entry of a platform in an entity: `standing` ones are not reversed, `everMonths` are the months an accrual was ever posted for (reversed or not).
export async function feeAccrualsOf(ctx: Ctx, legalEntityId: string, platform: string): Promise<{ standing: StandingFeeAccrual[]; everMonths: Set<string> }> {
  const prefix = `[fee-accrual:${platform}:`;
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_entry as e')
    .select(['e.id', 'e.entry_date', 'e.description'])
    .select(sql<boolean>`EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)`.as('reversed'))
    .where('e.org_id', '=', ctx.orgId)
    .where('e.legal_entity_id', '=', legalEntityId)
    .where('e.source_type', '=', 'finance.journal_voucher')
    .where('e.reverses_entry_id', 'is', null)
    .where(sql<boolean>`pg_catalog.strpos(e.description, ${prefix}) > 0`)
    // A tag typed on any other voucher is not an accrual: it must credit the accrued expense account (335) and debit an expense account of class 6.
    .where(sql<boolean>`EXISTS (SELECT 1 FROM crove_finance.journal_line c WHERE c.org_id = e.org_id AND c.entry_id = e.id AND c.account_code LIKE '335%' AND c.credit > 0)`)
    .where(sql<boolean>`EXISTS (SELECT 1 FROM crove_finance.journal_line d WHERE d.org_id = e.org_id AND d.entry_id = e.id AND d.account_code LIKE '64%' AND d.debit > 0)`)
    .execute();
  const standing: StandingFeeAccrual[] = [];
  const everMonths = new Set<string>();
  for (const r of rows) {
    const key = parseFeeAccrualKey(r.description);
    if (!key || key.platform !== platform) continue;
    everMonths.add(key.month);
    if (!r.reversed) standing.push({ entryId: r.id, entryDate: String(r.entry_date).slice(0, 10), month: key.month });
  }
  return { standing, everMonths };
}

// The id of an accrual proposal of that platform and month waiting for approval (or approved and not yet run), other than `ownProposalId`.
export async function pendingFeeAccrualProposal(ctx: Ctx, legalEntityId: string, platform: string, month: string, ownProposalId?: string): Promise<string | null> {
  let query = ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', JOURNAL_VOUCHER_KIND)
    .where('status', 'in', ['pending', 'approved'])
    .where(sql<boolean>`payload->>'legalEntityId' = ${legalEntityId}`)
    .where(sql<boolean>`pg_catalog.strpos(payload->>'description', ${feeAccrualKey(platform, month)}) > 0`)
    .orderBy('created_at')
    .orderBy('id');
  if (ownProposalId) query = query.where('id', '<>', ownProposalId);
  return (await query.executeTakeFirst())?.id ?? null;
}

// The rule, asked when a general journal voucher is requested and again when it is approved (`ownProposalId`: the proposal being approved, which is not "another"). The platform's lock serializes two
// requests at once, as the reversal request does for one entry.
export async function refuseSecondFeeAccrual(ctx: Ctx, legalEntityId: string, description: string, ownProposalId?: string): Promise<void> {
  const key = parseFeeAccrualKey(description);
  if (!key) return;
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`fee_accrual:${ctx.orgId}:${legalEntityId}:${key.platform}`}, 0))`.execute(ctx.trx);
  const { standing } = await feeAccrualsOf(ctx, legalEntityId, key.platform);
  const first = standing[0];
  if (first) {
    throw new DomainError('MARKETPLACE_FEE_ACCRUAL_STANDS', 409, 'Đã có khoản trích trước phí sàn chưa đảo: hãy đảo khoản trích trước đó trước khi lập khoản mới', { entryId: first.entryId, month: first.month });
  }
  if (await pendingFeeAccrualProposal(ctx, legalEntityId, key.platform, key.month, ownProposalId)) {
    throw new DomainError('MARKETPLACE_FEE_ACCRUAL_PENDING', 409, 'Đã có đề xuất trích trước phí sàn của tháng này đang chờ duyệt: hãy duyệt hoặc từ chối đề xuất đó');
  }
}
