// SPDX-License-Identifier: AGPL-3.0-only
// The four eSign reads a company MCP grant (`ludy.read`) may run (#4441, eSign Slice 5c, ADR-0051):
//   - `ludy_sign_envelopes_list` (`sign.mcp.envelopes`)
//   - `ludy_sign_envelope_get` (`sign.mcp.envelope_get`)
//   - `ludy_sign_renewals_list` (`sign.mcp.renewals`)
//   - `ludy_sign_templates_list` (`sign.mcp.templates`)
// All are R0 reads for a COMPANY grant (`owner` or `admin`); member grants are refused.
// Reader-scoped confidential envelopes (`hr_contract` and `meeting_minutes`) are excluded in both
// PostgreSQL RLS (`hr_contract_select`, `meeting_minutes_select`) and explicit SQL filters here.
// Never returned: signing tokens, OTP codes, signer email addresses, signer phone numbers, signature
// images, counterparty PII (`counterparty_name`), unconfirmed AI obligation proposals, or storage keys.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  plainLine,
  vietnamToday,
  zMcpSignEnvelopeGetInput,
  zMcpSignEnvelopesInput,
  zMcpSignRenewalsInput,
  zMcpSignTemplatesInput,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { summarizeObligationUrgency, toObligationRecord, type ObligationDbRow } from './obligations.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
const CONFIDENTIAL_SOURCE_KINDS = ['hr_contract', 'meeting_minutes'] as const;
const TITLE_MAX = 300;
const ROLE_LABEL_MAX = 120;
const OBLIGATION_TITLE_MAX = 200;

export interface McpSignSignerCounts {
  total: number;
  signed: number;
  pending: number;
  declined: number;
}

export interface McpSignEnvelopeRow {
  id: string;
  title: string;
  status: string;
  routingMode: string;
  sourceKind: string;
  expiresAt: string | null;
  completedAt: string | null;
  createdAt: string;
  signerCounts: McpSignSignerCounts;
}

export interface McpSignEnvelopesResult {
  envelopes: McpSignEnvelopeRow[];
  total: number;
  truncated: boolean;
}

export interface McpSignMaskedSigner {
  id: string;
  routingOrder: number;
  signerRole: string;
  roleLabel: string;
  status: string;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
}

export interface McpSignConfirmedObligationItem {
  id: string;
  title: string;
  dueDate: string | null;
  status: 'pending' | 'completed';
  completedAt: string | null;
}

export interface McpSignConfirmedObligation {
  effectiveDate: string | null;
  expiryDate: string | null;
  renewalNoticeDays: number | null;
  autoRenew: boolean;
  contractValue: string | null;
  currency: string;
  items: McpSignConfirmedObligationItem[];
}

export interface McpSignEnvelopeDetail {
  id: string;
  title: string;
  status: string;
  routingMode: string;
  sourceKind: string;
  inspectStatus: string;
  sealStatus: string | null;
  certificateCode: string | null;
  pageCount: number | null;
  expiresAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  signerCounts: McpSignSignerCounts;
  signers: McpSignMaskedSigner[];
  obligation: McpSignConfirmedObligation | null;
}

export interface McpSignRenewalRow {
  envelopeId: string;
  title: string;
  effectiveDate: string | null;
  expiryDate: string | null;
  renewalNoticeDate: string | null;
  daysUntilNotice: number | null;
  daysUntilExpiry: number | null;
  autoRenew: boolean;
  currency: string;
  contractValue: string | null;
  pendingObligationCount: number;
  overdueObligationCount: number;
  nextObligationDueDate: string | null;
}

export interface McpSignRenewalsResult {
  items: McpSignRenewalRow[];
  total: number;
  truncated: boolean;
}

export interface McpSignTemplateRow {
  id: string;
  title: string;
  routingMode: string;
  roleCount: number;
  directLinkEnabled: boolean;
  updatedAt: string;
}

export interface McpSignTemplatesResult {
  templates: McpSignTemplateRow[];
  total: number;
  truncated: boolean;
}

function requireCompanyGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp || ctx.actor.mcp.kind === 'member') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
  }
}

const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

const emptyCounts = (): McpSignSignerCounts => ({ total: 0, signed: 0, pending: 0, declined: 0 });

export const mcpSignEnvelopes = defineQuery({
  name: 'sign.mcp.envelopes',
  input: zMcpSignEnvelopesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSignEnvelopesResult> => {
    requireCompanyGrant(ctx);
    const filtered = () => {
      let q = ctx.trx
        .selectFrom('crove_sign.envelope as e')
        .where('e.org_id', '=', ctx.orgId)
        .where('e.source_kind', 'not in', [...CONFIDENTIAL_SOURCE_KINDS]);
      if (input.status) q = q.where('e.status', '=', input.status);
      return q;
    };

    const rows = await filtered()
      .select([
        'e.id',
        'e.title',
        'e.status',
        'e.routing_mode',
        'e.source_kind',
        'e.expires_at',
        'e.completed_at',
        'e.created_at',
      ])
      .orderBy('e.created_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await filtered()
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();

    const total = Number(counted?.n ?? 0);
    if (rows.length === 0) {
      return { envelopes: [], total, truncated: total > 0 };
    }

    const signerRows = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['envelope_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'envelope_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('signer_role', '!=', 'cc')
      .execute();

    const countsByEnv = new Map<string, McpSignSignerCounts>();
    for (const s of signerRows) {
      let c = countsByEnv.get(s.envelope_id);
      if (!c) {
        c = emptyCounts();
        countsByEnv.set(s.envelope_id, c);
      }
      c.total += 1;
      if (s.status === 'signed') c.signed += 1;
      else if (s.status === 'declined') c.declined += 1;
      else if (s.status === 'waiting' || s.status === 'pending' || s.status === 'viewed') c.pending += 1;
    }

    const envelopes: McpSignEnvelopeRow[] = rows.map((r) => ({
      id: r.id,
      title: plainLine(r.title, TITLE_MAX),
      status: r.status,
      routingMode: r.routing_mode,
      sourceKind: r.source_kind,
      expiresAt: isoOrNull(r.expires_at),
      completedAt: isoOrNull(r.completed_at),
      createdAt: new Date(r.created_at).toISOString(),
      signerCounts: countsByEnv.get(r.id) ?? emptyCounts(),
    }));

    return { envelopes, total, truncated: total > envelopes.length };
  },
});

export const mcpSignEnvelopeGet = defineQuery({
  name: 'sign.mcp.envelope_get',
  input: zMcpSignEnvelopeGetInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSignEnvelopeDetail> => {
    requireCompanyGrant(ctx);
    const env = await ctx.trx
      .selectFrom('crove_sign.envelope as e')
      .select([
        'e.id',
        'e.title',
        'e.status',
        'e.routing_mode',
        'e.source_kind',
        'e.inspect_status',
        'e.seal_status',
        'e.certificate_code',
        'e.page_count',
        'e.expires_at',
        'e.sent_at',
        'e.completed_at',
        'e.declined_at',
        'e.voided_at',
        'e.expired_at',
        'e.created_at',
      ])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.id', '=', input.envelopeId)
      .where('e.source_kind', 'not in', [...CONFIDENTIAL_SOURCE_KINDS])
      .executeTakeFirst();

    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }

    const signerRows = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select([
        'id',
        'routing_order',
        'signer_role',
        'role_label',
        'status',
        'viewed_at',
        'signed_at',
        'declined_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const obligationRow = await ctx.trx
      .selectFrom('crove_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('status', '=', 'confirmed')
      .executeTakeFirst();

    const counts = emptyCounts();
    const signers: McpSignMaskedSigner[] = signerRows.map((s) => {
      if (s.signer_role !== 'cc') {
        counts.total += 1;
        if (s.status === 'signed') counts.signed += 1;
        else if (s.status === 'declined') counts.declined += 1;
        else if (s.status === 'waiting' || s.status === 'pending' || s.status === 'viewed') counts.pending += 1;
      }
      return {
        id: s.id,
        routingOrder: s.routing_order,
        signerRole: s.signer_role,
        roleLabel: plainLine(s.role_label, ROLE_LABEL_MAX),
        status: s.status,
        viewedAt: isoOrNull(s.viewed_at),
        signedAt: isoOrNull(s.signed_at),
        declinedAt: isoOrNull(s.declined_at),
      };
    });

    let obligation: McpSignConfirmedObligation | null = null;
    if (obligationRow) {
      const parsed = toObligationRecord(obligationRow as unknown as ObligationDbRow);
      obligation = {
        effectiveDate: parsed.effectiveDate,
        expiryDate: parsed.expiryDate,
        renewalNoticeDays: parsed.renewalNoticeDays,
        autoRenew: parsed.autoRenew,
        contractValue: parsed.contractValue,
        currency: parsed.currency,
        items: parsed.obligations.slice(0, 50).map((item) => ({
          id: item.id,
          title: plainLine(item.title, OBLIGATION_TITLE_MAX),
          dueDate: item.dueDate,
          status: item.status,
          completedAt: item.completedAt,
        })),
      };
    }

    return {
      id: env.id,
      title: plainLine(env.title, TITLE_MAX),
      status: env.status,
      routingMode: env.routing_mode,
      sourceKind: env.source_kind,
      inspectStatus: env.inspect_status,
      sealStatus: env.seal_status,
      certificateCode: env.certificate_code,
      pageCount: env.page_count,
      expiresAt: isoOrNull(env.expires_at),
      sentAt: isoOrNull(env.sent_at),
      completedAt: isoOrNull(env.completed_at),
      declinedAt: isoOrNull(env.declined_at),
      voidedAt: isoOrNull(env.voided_at),
      expiredAt: isoOrNull(env.expired_at),
      createdAt: new Date(env.created_at).toISOString(),
      signerCounts: counts,
      signers,
      obligation,
    };
  },
});

export const mcpSignRenewals = defineQuery({
  name: 'sign.mcp.renewals',
  input: zMcpSignRenewalsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSignRenewalsResult> => {
    requireCompanyGrant(ctx);
    const todayVn = vietnamToday(new Date());

    const rows = await ctx.trx
      .selectFrom('crove_sign.envelope_obligation as o')
      .innerJoin('crove_sign.envelope as e', (join) =>
        join.onRef('e.org_id', '=', 'o.org_id').onRef('e.id', '=', 'o.envelope_id'),
      )
      .selectAll('o')
      .select(['e.title as env_title', 'e.source_kind as env_source_kind'])
      .where('o.org_id', '=', ctx.orgId)
      .where('o.status', '=', 'confirmed')
      .where('e.status', '=', 'completed')
      .where('e.source_kind', 'not in', [...CONFIDENTIAL_SOURCE_KINDS])
      .orderBy(sql`(o.expiry_date - COALESCE(o.renewal_notice_days, 0)) ASC NULLS LAST`)
      .orderBy('o.updated_at', 'desc')
      .orderBy('e.id', 'asc')
      .limit(200)
      .execute();

    const ranked: Array<{ rank: number; dayEpoch: number; item: McpSignRenewalRow }> = [];
    for (const row of rows) {
      if ((CONFIDENTIAL_SOURCE_KINDS as readonly string[]).includes(row.env_source_kind)) continue;
      const obligation = toObligationRecord(row as unknown as ObligationDbRow);
      const summary = summarizeObligationUrgency(obligation, todayVn);
      const withinWindow =
        summary.pendingObligationCount > 0 ||
        (summary.daysUntilNotice !== null && summary.daysUntilNotice <= input.withinDays) ||
        (summary.daysUntilExpiry !== null && summary.daysUntilExpiry <= input.withinDays);
      if (!withinWindow) continue;

      ranked.push({
        rank: summary.urgencyRank,
        dayEpoch: summary.urgencyDayEpoch,
        item: {
          envelopeId: row.envelope_id,
          title: plainLine(row.env_title, TITLE_MAX),
          effectiveDate: obligation.effectiveDate,
          expiryDate: obligation.expiryDate,
          renewalNoticeDate: summary.renewalNoticeDate,
          daysUntilNotice: summary.daysUntilNotice,
          daysUntilExpiry: summary.daysUntilExpiry,
          autoRenew: obligation.autoRenew,
          currency: obligation.currency,
          contractValue: obligation.contractValue,
          pendingObligationCount: summary.pendingObligationCount,
          overdueObligationCount: summary.overdueObligationCount,
          nextObligationDueDate: summary.nextObligationDueDate,
        },
      });
    }

    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.dayEpoch === b.dayEpoch ? 0 : a.dayEpoch < b.dayEpoch ? -1 : 1) ||
        (a.item.envelopeId < b.item.envelopeId ? -1 : a.item.envelopeId > b.item.envelopeId ? 1 : 0),
    );

    const total = ranked.length;
    const items = ranked.slice(0, input.limit).map((r) => r.item);
    return { items, total, truncated: total > items.length };
  },
});

export const mcpSignTemplates = defineQuery({
  name: 'sign.mcp.templates',
  input: zMcpSignTemplatesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSignTemplatesResult> => {
    requireCompanyGrant(ctx);
    const base = () =>
      ctx.trx
        .selectFrom('crove_sign.template as t')
        .where('t.org_id', '=', ctx.orgId)
        .where('t.status', '=', 'active');

    const rows = await base()
      .select([
        't.id',
        't.title',
        't.routing_mode',
        't.updated_at',
        sql<boolean>`crove_sign.template_direct_link_enabled(t.id)`.as('direct_link_enabled'),
      ])
      .orderBy('t.updated_at', 'desc')
      .orderBy('t.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await base()
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();

    const total = Number(counted?.n ?? 0);
    if (rows.length === 0) {
      return { templates: [], total, truncated: total > 0 };
    }

    const roleRows = await ctx.trx
      .selectFrom('crove_sign.template_role')
      .select(['template_id'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'template_id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();

    const roleCountByTpl = new Map<string, number>();
    for (const r of roleRows) {
      roleCountByTpl.set(r.template_id, (roleCountByTpl.get(r.template_id) ?? 0) + 1);
    }

    const templates: McpSignTemplateRow[] = rows.map((r) => ({
      id: r.id,
      title: plainLine(r.title, TITLE_MAX),
      routingMode: r.routing_mode,
      roleCount: roleCountByTpl.get(r.id) ?? 0,
      directLinkEnabled: Boolean(r.direct_link_enabled),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));

    return { templates, total, truncated: total > templates.length };
  },
});

export const signMcpQueries = [
  mcpSignEnvelopes,
  mcpSignEnvelopeGet,
  mcpSignRenewals,
  mcpSignTemplates,
];
