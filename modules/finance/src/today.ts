// SPDX-License-Identifier: AGPL-3.0-only
// What needs the member in Accounting today, for Home's "Hôm nay cần bạn" (#2388, shape agreed on #2383). One read,
// finance.today: no write, no model call, and only what the caller could open, since every table it reads keeps its
// own row-level rules (the proposals, the bank lines and the extraction runs by legal entity) and the reads it
// borrows (kernel.inbox.originals, kernel.files.staged, kernel.notification.list) answer for the caller alone.
//
// Who sees what: owners, admins and members, the people who can act, get the proposals waiting for their own decision
// (grouped by vendor or customer, with the exact total), the proposals whose checks failed or warn, the originals still
// to fetch (#2286) and the ones that differ from a posting (#2335), the staged bank statements (#2142) and the bank
// lines with no voucher (#326). A viewer gets the tax deadlines only: nothing that shows money, nothing to act on.
// Deadlines come only from what the org has set up: the VAT filing period, and a period lock for the close. Nothing is
// guessed.
//
// Titles are message keys with params (catalogs in apps/app: today.items.finance*, resolved by Home against its today.items namespace), never rendered text. A href is a path
// inside the org (/inbox/<id>, /bank, /vat?period=...); with several legal entities in view it carries `entity=<id>` so
// the acting screen opens in the right books.
import { sql } from 'kysely';
import { z } from 'zod';
import { ORIGINAL_FLAGGED, taxDuesOf } from '@crove/kernel';
import { STOCK_LEAD_DAYS_DEFAULT, type TodayItem, type VatFilingPeriod } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery, sha256Hex, type QueryContext } from '@crove/kernel-runtime';
import { closingPeriod } from './notifications.ts';
import { readCollectionSetting } from './collection-settings.ts';
import { databaseToday } from './period-lock.ts';
import { remindersToSendThisWeek } from './payment-reminders.ts';
import { lowStockItems } from './stock-low.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ACTORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The most vendor or customer groups of waiting proposals one read lists, the longest waiting first.
export const TODAY_PROPOSAL_GROUPS_MAX = 30;

type Link = (path: string, entity?: string) => string;

interface GroupRow {
  entity: string;
  kind: string;
  direction: string;
  party: string;
  currency: string;
  n: string;
  amount: string | null;
  first_id: string;
  waiting: string;
}

interface FlagRow {
  entity: string;
  failed: string;
  warned: string;
}

const MONEY = '^-?[0-9]{1,16}([.][0-9]{1,8})?$';

export const financeToday = defineQuery({
  name: 'finance.today',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null) return [];
    const userId = ctx.actor.userId;
    const today = await databaseToday(ctx.trx);
    const entities = (await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).orderBy('id').execute()).map((e) => e.id);
    const several = entities.length > 1;
    const to: Link = (path, entity) => {
      if (!several || !entity) return path;
      return `${path}${path.includes('?') ? '&' : '?'}entity=${entity}`;
    };
    const items: TodayItem[] = [];
    if (ACTORS.includes(ctx.role)) {
      items.push(...(await waitingProposals(ctx, userId, to)));
      items.push(...(await flaggedProposals(ctx, to)));
      items.push(...(await einvoiceItems(ctx, to)));
      items.push(...(await originalItems(ctx)));
      items.push(...(await bankItems(ctx, entities, to)));
      items.push(...(await reminderItems(ctx, entities, today, to)));
      items.push(...(await lowStockToday(ctx, to)));
    }
    items.push(...(await deadlines(ctx, today, to, entities)));
    return items;
  },
});

// The finance proposals waiting for the caller's own decision, one item per party, direction and currency in each
// entity, with the exact total of their invoices. "Waiting for me": the caller is in the proposal's approver snapshot,
// and either did not write it or, when every approver in the snapshot wrote it, is an owner (the four-eyes rule then lets
// only the owner decide, P10). A co-author (the person a proposal rests on besides its writer, #2736) is shown it only while no
// approver in the snapshot is neither a writer nor a co-author: co-authors only restrict, so the owner override stays on the writers. Money: a purchase invoice's total in its own currency, never converted. A foreign-currency
// invoice booked in VND (#918) has its amounts in VND already, so it counts as VND; one still waiting for its rate has
// the invoice's own amounts, so it is a group of its own currency. Vouchers and other proposals have no invoice total
// and show no amount. A group list is capped, and the rest is one more item that says how many.
async function waitingProposals(ctx: QueryContext, userId: string, to: Link): Promise<TodayItem[]> {
  const author = (who: ReturnType<typeof sql>) => sql`p.authors @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', ${who}))`;
  const everyApproverWrote = sql`NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.eligible_approvers) e(u) WHERE NOT ${author(sql`e.u::text`)})`;
  const coAuthor = (who: ReturnType<typeof sql>) => sql`coalesce(p.co_authors @> ARRAY[${who}::uuid], false)`;
  const someoneElseMayDecide = sql`EXISTS (SELECT 1 FROM pg_catalog.unnest(p.eligible_approvers) e(u) WHERE NOT ${author(sql`e.u::text`)} AND NOT ${coAuthor(sql`e.u`)})`;
  const { rows } = await sql<GroupRow>`
    WITH w AS (
      SELECT p.legal_entity_id::text AS entity,
             p.kind,
             p.id,
             p.created_at,
             CASE WHEN p.kind = 'finance.purchase' THEN coalesce(p.payload ->> 'direction', '') ELSE '' END AS direction,
             CASE WHEN p.kind = 'finance.purchase'
                  THEN coalesce(nullif(pg_catalog.btrim(CASE WHEN p.payload ->> 'direction' = 'sale' THEN p.payload #>> '{buyer,name}' ELSE p.payload #>> '{seller,name}' END), ''), '')
                  ELSE '' END AS party,
             CASE WHEN p.kind <> 'finance.purchase' OR (p.payload #> '{invoice,foreign}') IS NOT NULL THEN 'VND'
                  ELSE coalesce(nullif(p.payload #>> '{invoice,currency}', ''), 'VND') END AS currency,
             CASE WHEN p.kind = 'finance.purchase' AND (p.payload #>> '{invoice,total}') ~ ${MONEY} THEN (p.payload #>> '{invoice,total}')::numeric END AS total
      FROM crove_kernel.proposal p
      WHERE p.org_id = ${ctx.orgId}
        AND p.status = 'pending'
        AND p.command LIKE 'finance.%'
        AND p.eligible_approvers @> ARRAY[${userId}::uuid]
        AND (CASE WHEN ${author(sql`${userId}::text`)} THEN ${ctx.role === 'owner' ? everyApproverWrote : sql`false`}
                  WHEN ${coAuthor(sql`${userId}`)} THEN NOT ${someoneElseMayDecide}
                  ELSE true END)
    )
    SELECT entity, kind, direction, pg_catalog.min(party) AS party, currency,
           pg_catalog.count(*)::text AS n,
           pg_catalog.sum(total)::text AS amount,
           (pg_catalog.array_agg(id ORDER BY created_at, id))[1]::text AS first_id,
           pg_catalog.sum(pg_catalog.count(*)) OVER ()::text AS waiting
    FROM w
    GROUP BY entity, kind, direction, pg_catalog.lower(party), currency
    ORDER BY pg_catalog.min(created_at), first_id
    LIMIT ${TODAY_PROPOSAL_GROUPS_MAX}`.execute(ctx.trx);
  const items = rows.map((r): TodayItem => {
    const count = Number(r.n);
    const sale = r.direction === 'sale';
    const named = r.party !== '';
    return {
      kind: 'proposal',
      app: 'finance',
      // The party enters the id as a digest of its lower-cased name, so two parties never share an id however long their names.
      id: `proposals:${r.entity}:${r.kind}:${r.direction}:${r.currency}:${sha256Hex(r.party.toLowerCase()).slice(0, 24)}`,
      title: named ? { key: sale ? 'financeProposalsCustomer' : 'financeProposalsVendor', params: { count, party: r.party.slice(0, 500) } } : { key: 'financeProposalsOther', params: { count } },
      count,
      ...(r.amount !== null ? { amount: r.amount, ...(r.currency !== 'VND' ? { currency: r.currency } : {}) } : {}),
      // One proposal opens itself; a group opens the Inbox.
      href: count === 1 ? to(`/inbox/${r.first_id}`, r.entity) : to('/inbox', r.entity),
    };
  });
  const waiting = Number(rows[0]?.waiting ?? 0);
  const listed = items.reduce((n, i) => n + (i.count ?? 0), 0);
  if (waiting > listed) {
    items.push({ kind: 'proposal', app: 'finance', id: 'proposals-more', title: { key: 'financeProposalsMore', params: { count: waiting - listed } }, count: waiting - listed, href: '/inbox' });
  }
  return items;
}

// Pending finance proposals with a failed check (block) or a warning (warn), by entity: what to fix before approving.
async function flaggedProposals(ctx: QueryContext, to: Link): Promise<TodayItem[]> {
  const check = (status: string) => sql`EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(coalesce(p.payload -> 'checks', '[]'::jsonb)) c WHERE c ->> 'status' = ${status})`;
  const { rows } = await sql<FlagRow>`
    SELECT p.legal_entity_id::text AS entity,
           pg_catalog.count(*) FILTER (WHERE ${check('fail')})::text AS failed,
           pg_catalog.count(*) FILTER (WHERE NOT ${check('fail')} AND ${check('warn')})::text AS warned
    FROM crove_kernel.proposal p
    WHERE p.org_id = ${ctx.orgId} AND p.status = 'pending' AND p.command LIKE 'finance.%'
    GROUP BY 1
    ORDER BY 1`.execute(ctx.trx);
  const items: TodayItem[] = [];
  for (const r of rows) {
    const failed = Number(r.failed);
    const warned = Number(r.warned);
    if (failed > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-failed:${r.entity}`, title: { key: 'financeChecksFailed', params: { count: failed } }, count: failed, severity: 'block', href: to('/inbox', r.entity) });
    if (warned > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-warn:${r.entity}`, title: { key: 'financeChecksWarn', params: { count: warned } }, count: warned, severity: 'warn', href: to('/inbox', r.entity) });
  }
  return items;
}

// The sales e-invoices that need a person (#2502): failed, with a code on the draft; sent back to a draft with the reason (a rejection) and not asked for again; sent more than an hour
// ago and still unanswered, or issued with the signed XML still not stored. One flag per entity with how many.
async function einvoiceItems(ctx: QueryContext, to: Link): Promise<TodayItem[]> {
  const { rows } = await sql<{ entity: string; n: string }>`
    SELECT d.legal_entity_id::text AS entity, pg_catalog.count(*)::text AS n
    FROM crove_finance.einvoice_draft d
    WHERE d.org_id = ${ctx.orgId}
      AND (d.state = 'failed'
           OR (d.state = 'draft' AND d.error_code IS NOT NULL)
           OR (d.state IN ('submitting', 'pending') AND d.submitted_at < pg_catalog.now() - interval '1 hour')
           OR (d.state = 'issued' AND d.signed_file_id IS NULL AND d.issued_at < pg_catalog.now() - interval '1 hour'))
    GROUP BY 1
    ORDER BY 1`.execute(ctx.trx);
  return rows.map((r) => {
    const count = Number(r.n);
    return { kind: 'flag', app: 'finance', id: `einvoice-attention:${r.entity}`, title: { key: 'financeEinvoiceAttention', params: { count } }, count, severity: 'warn', href: to('/sales-invoices', r.entity) } satisfies TodayItem;
  });
}

// The originals still to fetch (a mail with only a lookup link or code, #2286: the kernel's read answers owners, admins
// and members of the whole org only) and the originals attached to a posted invoice that differ from it or are not
// verified, which the caller was told about and has not opened yet (#2335).
async function originalItems(ctx: QueryContext): Promise<TodayItem[]> {
  const items: TodayItem[] = [];
  const needed = await ctx.query<{ total: number }>('kernel.inbox.originals', {});
  if (needed.status === 'ok' && needed.value.total > 0) {
    items.push({ kind: 'flag', app: 'finance', id: 'originals-needed', title: { key: 'financeOriginalsNeeded', params: { count: needed.value.total } }, count: needed.value.total, severity: 'info', href: '/inbox' });
  }
  // The caller's own unread notices of that kind (the policy keeps a member to their own rows), counted here rather than read
  // from kernel.notification.list, which stops at its newest 30.
  const { rows } = await sql<{ n: string; subject: string | null }>`
    SELECT pg_catalog.count(*)::text AS n, pg_catalog.min(subject_id::text) AS subject
    FROM crove_kernel.notification
    WHERE org_id = ${ctx.orgId} AND kind = ${ORIGINAL_FLAGGED} AND read_at IS NULL`.execute(ctx.trx);
  const flagged = Number(rows[0]?.n ?? 0);
  if (flagged > 0) {
    items.push({
      kind: 'flag',
      app: 'finance',
      id: 'originals-flagged',
      title: { key: 'financeOriginalsFlagged', params: { count: flagged } },
      count: flagged,
      severity: 'warn',
      href: flagged === 1 && rows[0]?.subject ? `/inbox/${rows[0].subject}` : '/inbox',
    });
  }
  return items;
}

// A staged bank statement waits for a member to confirm it (#2142), and the lines of the imported ones that no voucher
// settles yet, in each entity the caller sees (#326).
async function bankItems(ctx: QueryContext, entities: readonly string[], to: Link): Promise<TodayItem[]> {
  const items: TodayItem[] = [];
  const staged = await ctx.query<Array<{ statement: { state?: string } | null }>>('kernel.files.staged', {});
  if (staged.status === 'ok') {
    const waiting = staged.value.filter((f) => f.statement?.state === 'staged').length;
    if (waiting > 0) items.push({ kind: 'message', app: 'finance', id: 'statements-staged', title: { key: 'financeStatementsStaged', params: { count: waiting } }, count: waiting, href: '/inbox' });
  }
  for (const entity of entities) {
    const open = await ctx.query<{ accounts: Array<{ open: number }> }>('finance.bank.open_lines', { legalEntityId: entity });
    if (open.status !== 'ok') break;
    const lines = open.value.accounts.reduce((n, a) => n + a.open, 0);
    if (lines > 0) items.push({ kind: 'message', app: 'finance', id: `bank-open-lines:${entity}`, title: { key: 'financeBankLinesOpen', params: { count: lines } }, count: lines, href: to('/bank', entity) });
  }
  return items;
}

// The weekly payment reminder item (#2488, slice 3), only where the org turned it on: per entity, how many overdue customers have had no reminder since Monday.
// It counts and links to Nhắc thu nợ; it drafts and sends nothing, and it clears itself as the week's reminders go out.
async function reminderItems(ctx: QueryContext, entities: readonly string[], today: string, to: Link): Promise<TodayItem[]> {
  if (!(await readCollectionSetting(ctx)).weeklyItem) return [];
  const items: TodayItem[] = [];
  for (const entity of entities) {
    const { monday, count } = await remindersToSendThisWeek(ctx, entity, today);
    if (count > 0) items.push({ kind: 'message', app: 'finance', id: `payment-reminders:${entity}:${monday}`, title: { key: 'financeRemindersDue', params: { count } }, count, href: to('/payment-reminders', entity) });
  }
  return items;
}

// The items running low (#2514), one count per legal entity: the same list as the Hàng hóa screen's "Hàng sắp hết" (finance.stock.low, the default lead days). It counts and links to the
// screen; it orders and sends nothing, and it clears itself as stock is bought in or the pace of sales falls.
async function lowStockToday(ctx: QueryContext, to: Link): Promise<TodayItem[]> {
  // Every low item is counted (the list's own limit would cut an entity's count), and no supplier is looked up for a count.
  const low = await lowStockItems(ctx, { leadDays: STOCK_LEAD_DAYS_DEFAULT, limit: Number.MAX_SAFE_INTEGER, suppliers: false });
  const byEntity = new Map<string, number>();
  for (const item of low) byEntity.set(item.legalEntityId, (byEntity.get(item.legalEntityId) ?? 0) + 1);
  return [...byEntity]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entity, count]) => ({ kind: 'message', app: 'finance', id: `stock-low:${entity}`, title: { key: 'financeStockLow', params: { count } }, count, href: to('/stock', entity) }) satisfies TodayItem);
}

// End of the due day in Vietnam, as the instant a deadline is due.
const DUE_TIME = 'T23:59:59+07:00';

// The next VAT return still to file and the period close, only when the org has the data to compute them: a filing
// period set in the org's settings, and, for the close, a period lock. The return comes from the tax calendar, which
// leaves out what every entity marked done (and an entity the caller does not see); the close from the rule of the
// closing reminder (#671), so the two never disagree.
async function deadlines(ctx: QueryContext, today: string, to: Link, entities: readonly string[]): Promise<TodayItem[]> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const kind = (org?.vat_filing_period as VatFilingPeriod | null | undefined) ?? null;
  if (kind === null) return [];
  const items: TodayItem[] = [];
  const due = (await taxDuesOf(ctx, kind, today)).filter((d) => d.obligation === 'vat_return').sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  if (due) {
    const only = due.openEntities.length === 1 ? due.openEntities[0]?.id : undefined;
    items.push({
      kind: 'deadline',
      app: 'finance',
      id: `vat:${due.period}`,
      title: { key: 'financeVatDue', params: { period: due.period, date: due.dueDate, days: due.daysLeft } },
      dueAt: `${due.dueDate}${DUE_TIME}`,
      severity: due.daysLeft < 0 ? 'block' : due.daysLeft <= 5 ? 'warn' : 'info',
      href: to(`/vat?period=${due.period}`, only),
    });
  }
  // The earliest lock counts: the period is open while any entity's books are, and an entity that never locked leaves
  // it open (as the closing reminder reads it).
  const locks = await ctx.trx
    .selectFrom('crove_finance.period_lock')
    .select(sql<string | null>`pg_catalog.to_char(locked_through, 'YYYY-MM-DD')`.as('through'))
    .where('org_id', '=', ctx.orgId)
    .execute();
  if (locks.length > 0) {
    // An entity with no lock row has locked nothing: it leaves the period open, as an entity whose lock is empty does.
    const through = locks.length < entities.length || locks.some((l) => l.through === null) ? null : (locks.map((l) => l.through as string).sort()[0] ?? null);
    const closing = closingPeriod(kind, through, today);
    if (closing) {
      items.push({
        kind: 'deadline',
        app: 'finance',
        id: `close:${closing.period}`,
        title: { key: 'financePeriodClose', params: { period: closing.period, date: closing.dueDate } },
        dueAt: `${closing.dueDate}${DUE_TIME}`,
        severity: 'warn',
        href: '/ledger',
      });
    }
  }
  return items;
}
