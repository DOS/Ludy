// SPDX-License-Identifier: AGPL-3.0-only
// The "Báo giá" tab of the Reports screen (#2699, docs/plan/crm-quotes.md step Q6): crm.quote.report (every role reads) counts the org's quotes by status and sums
// their totals over the last 30, 90 or 365 days (by the day each quote was made) or ever. Read only, counts and decimal strings, no customer, number or text; the
// member sees what row-level security shows them, which is every quote of the org. `sent` is the quotes that left draft and were not replaced by a revision.
import { sql } from 'kysely';
import { QUOTE_STATUSES, zQuoteReportQuery, type QuoteReport, type QuoteStatus } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { money } from '@crove/l10n-vn';
import { defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DEFAULT_DAYS = 90;

export const quoteReport = defineQuery({
  name: 'crm.quote.report',
  input: zQuoteReportQuery,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteReport> => {
    const days = input.days === undefined ? DEFAULT_DAYS : input.days;
    const { rows } = await sql<{ status: QuoteStatus; n: number; total: string }>`
      SELECT q.status, pg_catalog.count(*)::int AS n, coalesce(pg_catalog.sum(q.total), 0)::text AS total
      FROM crove_crm.quote q
      WHERE q.org_id = ${ctx.orgId}::uuid
        AND (${days}::int IS NULL OR q.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => ${days}::int))
      GROUP BY q.status`.execute(ctx.trx);
    const byStatus = QUOTE_STATUSES.map((status) => {
      const row = rows.find((r) => r.status === status);
      return { status, count: row?.n ?? 0, total: money(row?.total ?? '0').toFixed() };
    });
    const sentStatuses: readonly QuoteStatus[] = ['sent', 'accepted', 'declined'];
    const sent = byStatus.filter((s) => sentStatuses.includes(s.status));
    return { days, sent: { count: sent.reduce((n, s) => n + s.count, 0), total: sent.reduce((t, s) => t.plus(s.total), money(0)).toFixed() }, byStatus };
  },
});
