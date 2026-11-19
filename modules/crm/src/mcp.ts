// SPDX-License-Identifier: AGPL-3.0-only
// The CRM reads an MCP grant may run (epic #3857, E1, issue #3860; ADR-0051 decisions 2 and 11): `ludy_deals_list` and `ludy_deal` (crm.mcp.deals, crm.mcp.deal), `ludy_quotes_list` and `ludy_quote`
// (crm.mcp.quotes, crm.mcp.quote) and `ludy_bookings_list` (crm.mcp.bookings). All are R0 reads over the CRM tables, which carry the org policy only (the migration of #3858 slice b says so, and a test pins it):
// a company grant reads the org's rows as its owner or admin does, and a member-bound grant reads the whole org's deals and quotes as that member does in person (a member sees every deal of the
// org on the pipeline; narrowing a member to their own deals, if a plan ever asks for it, belongs in the query layer and is not here). The role list is the screens': deals and quotes for every role,
// bookings (a guest's name, email and phone) for an owner or admin only, so a member or a viewer is not offered the booking tool and a member-bound grant of such a member never reaches it.
//
// Privacy review. What leaves:
//   deal      id, the party's id and name, the title, the amount (a decimal string in VND), the stage (id and kind), the expected close day, the owner's user id, the lost reason (free text),
//             when it closed, whether it waits on a next step (the reason key and since when), the day it was made and last changed;
//   quote     id, the deal's id and title, the party's id and name, the number, revision, status, whether it expired, the validity day, the subtotal, VAT and total (decimal strings), how many lines,
//             when it was sent and first viewed and by which way (link or email), the day it was made and last changed; the one quote adds the notes, the terms, the buyer's name and tax code and the lines
//             (number, kind, description, unit, quantity, unit price, discount percent, VAT rate, amount, VAT amount);
//   booking   id, status (confirmed or cancelled), start, end, time zone, the event type (id, slug, title), the guest's name, email, phone and note (typed by a visitor), the party's id, the linked
//             deal (id, title, stage name and kind) and the meeting's state.
// What is tainted: a party's name, a deal's title and lost reason, a quote's notes, terms, buyer and line descriptions, and above all a booking guest's name, note, email and phone are text a person or a
// visitor typed, so every one is cut to one plain line (plainLine) and reaches the client as data, never as an instruction; every deal, quote and booking says `tainted: true`, and a booking also says `sourceTrust: 'external'` (the visitor's own words). Never returned: the quote's links and their tokens or hashes, the buyer's address and email (the party read has the contact's own), the public quote page,
// who made a row (created_by), versions, canDelete, the duplicate-of chain of a party, the meeting's join link, the host and the calendar event, the booking's management token or requests, stock item ids,
// notes of the contact timeline, the sales orders, and anything of a query that is `sensitive`. A party merged into another is shown by the party it stands for in the deal screens; here the party id
// and name are the deal's own. Erased data is never sent: an erased party or message leaves no row for a read to find (erasure deletes it and keeps only a tombstone with no text). Row-level
// security and the `org_id` filters keep other orgs out.
import { sql } from 'kysely';
import { z } from 'zod';
import { DEAL_STAGE_KINDS, QUOTE_STATUSES, plainLine, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { base as dealBase, view as dealView } from './deals.ts';
import { loadQuote, quoteBase, quoteSummaryView } from './quotes.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_CRM_DEFAULT = 25;
export const MCP_CRM_MAX = 50;
const TEXT_MAX = 500;
const LONG_TEXT_MAX = 2000;

const zLimit = z.number().int().min(1).max(MCP_CRM_MAX).default(MCP_CRM_DEFAULT).describe(`How many to return (1 to ${MCP_CRM_MAX}, default ${MCP_CRM_DEFAULT}).`);
const zCursor = z.strictObject({ createdAt: z.iso.datetime(), id: zId }).describe('The `next` of the previous answer, to read the following page.');

export const zMcpDealsInput = z.strictObject({
  status: z.enum(DEAL_STAGE_KINDS).optional().describe('Only deals in this state: open, won or lost. Leave out for all.'),
  stageId: zId.optional().describe('Only deals in this pipeline stage.'),
  partyId: zId.optional().describe('Only deals of this customer (a party id from ludy_parties_list).'),
  limit: zLimit,
  cursor: zCursor.optional(),
});
export const zMcpDealInput = z.strictObject({ dealId: zId });
export const zMcpQuotesInput = z.strictObject({
  status: z.enum(QUOTE_STATUSES).optional().describe('Only quotes in this state. Leave out for all.'),
  dealId: zId.optional().describe('Only quotes of this deal.'),
  partyId: zId.optional().describe('Only quotes of this customer.'),
  limit: zLimit,
  cursor: zCursor.optional(),
});
export const zMcpQuoteInput = z.strictObject({ quoteId: zId });
export const zMcpBookingsInput = z.strictObject({
  period: z.enum(['upcoming', 'past']).default('upcoming').describe('upcoming (not ended yet, the earliest first) or past (ended, the latest first).'),
  dealId: zId.optional().describe('Only bookings linked to this deal.'),
  limit: zLimit,
});

const line = (value: string | null, max = TEXT_MAX): string | null => {
  if (value === null) return null;
  const text = plainLine(value, max);
  return text === '' ? null : text;
};
const iso = (value: Date | string): string => new Date(value).toISOString();

function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
}

// ---- deals ----
export interface McpDeal {
  id: string;
  partyId: string;
  partyName: string;
  title: string;
  amount: string;
  currency: 'VND';
  stageId: string;
  stageKind: 'open' | 'won' | 'lost';
  expectedClose: string | null;
  ownerUserId: string | null;
  lostReason: string | null;
  closedAt: string | null;
  followUp: { reason: string; sinceOn: string } | null;
  createdAt: string;
  updatedAt: string;
  // The names, the title and the lost reason are text people typed or a visitor's form brought: data, never instructions.
  tainted: true;
}
export interface McpDeals {
  deals: McpDeal[];
  next: { createdAt: string; id: string } | null;
}

function dealOf(row: Parameters<typeof dealView>[0]): McpDeal {
  const d = dealView(row, false);
  return {
    id: d.id,
    partyId: d.partyId,
    partyName: plainLine(d.partyName, TEXT_MAX),
    title: plainLine(d.title, TEXT_MAX),
    amount: d.amount,
    currency: 'VND',
    stageId: d.stageId,
    stageKind: d.stageKind,
    expectedClose: d.expectedClose,
    ownerUserId: d.ownerUserId,
    lostReason: line(d.lostReason),
    closedAt: d.closedAt,
    followUp: d.followUp === null ? null : { reason: d.followUp.reason, sinceOn: d.followUp.sinceOn },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    tainted: true,
  };
}

export const mcpDeals = defineQuery({
  name: 'crm.mcp.deals',
  input: zMcpDealsInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpDeals> => {
    requireGrant(ctx);
    let q = dealBase(ctx);
    if (input.stageId) q = q.where('d.stage_id', '=', input.stageId);
    if (input.partyId) q = q.where('d.party_id', '=', input.partyId);
    if (input.status) q = q.where('s.kind', '=', input.status);
    if (input.cursor) q = q.where(sql<boolean>`(d.created_at, d.id) < (${new Date(input.cursor.createdAt)}::timestamptz, ${input.cursor.id}::uuid)`);
    const rows = await q.orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(input.limit + 1).execute();
    const deals = rows.slice(0, input.limit).map(dealOf);
    const last = deals.at(-1);
    return { deals, next: rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  },
});

export const mcpDeal = defineQuery({
  name: 'crm.mcp.deal',
  input: zMcpDealInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpDeal> => {
    requireGrant(ctx);
    const row = await dealBase(ctx).where('d.id', '=', input.dealId).executeTakeFirst();
    if (!row) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    return dealOf(row);
  },
});

// ---- quotes ----
export interface McpQuote {
  id: string;
  dealId: string;
  dealTitle: string;
  partyId: string;
  partyName: string;
  number: string | null;
  revision: number;
  status: string;
  expired: boolean;
  validUntil: string;
  subtotal: string;
  vatAmount: string;
  total: string;
  lineCount: number;
  sentAt: string | null;
  sentVia: string | null;
  firstViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tainted: true;
}
export interface McpQuoteLine {
  lineNo: number;
  kind: string;
  description: string;
  unit: string | null;
  quantity: string | null;
  unitPrice: string | null;
  discountPercent: string;
  vatRate: string | number | null;
  amount: string;
  vatAmount: string;
}
export interface McpQuoteFull extends McpQuote {
  notes: string | null;
  terms: string | null;
  buyer: { name: string; taxCode: string | null } | null;
  lines: McpQuoteLine[];
}
export interface McpQuotes {
  quotes: McpQuote[];
  next: { createdAt: string; id: string } | null;
}

function quoteOf(s: ReturnType<typeof quoteSummaryView>): McpQuote {
  return {
    id: s.id,
    dealId: s.dealId,
    dealTitle: plainLine(s.dealTitle, TEXT_MAX),
    partyId: s.partyId,
    partyName: plainLine(s.partyName, TEXT_MAX),
    number: s.number,
    revision: s.revision,
    status: s.status,
    expired: s.expired,
    validUntil: s.validUntil,
    subtotal: s.subtotal,
    vatAmount: s.vatAmount,
    total: s.total,
    lineCount: s.lineCount,
    sentAt: s.sentAt,
    sentVia: s.sentVia,
    firstViewedAt: s.firstViewedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    tainted: true,
  };
}

export const mcpQuotes = defineQuery({
  name: 'crm.mcp.quotes',
  input: zMcpQuotesInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpQuotes> => {
    requireGrant(ctx);
    let q = quoteBase(ctx);
    if (input.dealId) q = q.where('q.deal_id', '=', input.dealId);
    if (input.partyId) q = q.where('q.party_id', '=', input.partyId);
    if (input.status) q = q.where('q.status', '=', input.status);
    if (input.cursor) q = q.where(sql<boolean>`(q.created_at, q.id) < (${new Date(input.cursor.createdAt)}::timestamptz, ${input.cursor.id}::uuid)`);
    const rows = await q.orderBy('q.created_at', 'desc').orderBy('q.id', 'desc').limit(input.limit + 1).execute();
    const now = new Date();
    const quotes = rows.slice(0, input.limit).map((r) => quoteOf(quoteSummaryView(r, now)));
    const last = quotes.at(-1);
    return { quotes, next: rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  },
});

export const mcpQuote = defineQuery({
  name: 'crm.mcp.quote',
  input: zMcpQuoteInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpQuoteFull> => {
    requireGrant(ctx);
    // loadQuote reads the quote, its lines and its links; the links (hashes and view counts) are dropped below and never leave.
    const full = await loadQuote(ctx, input.quoteId);
    const { links: _links, ...rest } = full;
    return {
      ...quoteOf(rest),
      notes: line(full.notes, LONG_TEXT_MAX),
      terms: line(full.terms, LONG_TEXT_MAX),
      buyer: full.buyer === null ? null : { name: plainLine(full.buyer.name, TEXT_MAX), taxCode: line(full.buyer.taxCode, 30) },
      lines: full.lines.map((l) => ({
        lineNo: l.lineNo,
        kind: l.kind,
        description: plainLine(l.description, TEXT_MAX),
        unit: line(l.unit, 40),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent,
        vatRate: l.vatRate,
        amount: l.amount,
        vatAmount: l.vatAmount,
      })),
    };
  },
});

// ---- bookings ----
export interface McpBooking {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  eventType: { id: string; slug: string; title: string };
  guest: { name: string; email: string | null; phone: string | null; note: string | null };
  sourceTrust: 'external';
  tainted: true;
  partyId: string | null;
  deal: { id: string; title: string; stage: string; status: string } | null;
  meetingState: string | null;
}
export interface McpBookings {
  bookings: McpBooking[];
  truncated: boolean;
}

export const mcpBookings = defineQuery({
  name: 'crm.mcp.bookings',
  input: zMcpBookingsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpBookings> => {
    requireGrant(ctx);
    const upcoming = input.period === 'upcoming';
    let q = ctx.trx
      .selectFrom('crove_crm.booking as b')
      .innerJoin('crove_crm.event_type as e', (j) => j.onRef('e.org_id', '=', 'b.org_id').onRef('e.id', '=', 'b.event_type_id'))
      .leftJoin('crove_crm.deal as dl', (j) => j.onRef('dl.org_id', '=', 'b.org_id').onRef('dl.id', '=', 'b.deal_id'))
      .leftJoin('crove_crm.pipeline_stage as ds', (j) => j.onRef('ds.org_id', '=', 'dl.org_id').onRef('ds.id', '=', 'dl.stage_id'))
      .select(['b.id', 'b.status', 'b.starts_at', 'b.ends_at', 'b.time_zone', 'b.visitor_name', 'b.email', 'b.phone', 'b.note', 'b.party_id', 'b.meeting_state', 'b.deal_id', 'dl.title as deal_title', 'ds.name as deal_stage', 'ds.kind as deal_status', 'e.id as type_id', 'e.slug', 'e.title'])
      .where('b.org_id', '=', ctx.orgId)
      // The bookings the screen lists: confirmed and cancelled ones (requests the worker refused are not bookings).
      .where('b.status', 'in', ['confirmed', 'cancelled'])
      .where('b.ends_at', upcoming ? '>' : '<=', new Date());
    if (input.dealId) q = q.where('b.deal_id', '=', input.dealId);
    const rows = await q.orderBy('b.starts_at', upcoming ? 'asc' : 'desc').orderBy('b.id').limit(input.limit + 1).execute();
    const bookings = rows.slice(0, input.limit).map(
      (r): McpBooking => ({
        id: r.id,
        status: r.status,
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
        timeZone: plainLine(r.time_zone, 64),
        eventType: { id: r.type_id, slug: plainLine(r.slug, 100), title: plainLine(r.title, TEXT_MAX) },
        guest: { name: plainLine(r.visitor_name ?? '', TEXT_MAX), email: line(r.email, 254), phone: line(r.phone, 40), note: line(r.note) },
        sourceTrust: 'external',
        tainted: true,
        partyId: r.party_id,
        deal: r.deal_id !== null && r.deal_title !== null && r.deal_stage !== null && r.deal_status !== null ? { id: r.deal_id, title: plainLine(r.deal_title, TEXT_MAX), stage: plainLine(r.deal_stage, TEXT_MAX), status: r.deal_status } : null,
        meetingState: r.meeting_state,
      }),
    );
    return { bookings, truncated: rows.length > bookings.length };
  },
});

export const mcpCrmQueries = [mcpDeals, mcpDeal, mcpQuotes, mcpQuote, mcpBookings];
