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
import { approvalPolicies, LEDGER_APPROVE_PERMISSION, liveApprovalCommands, ORIGINAL_FLAGGED, taxDuesOf } from '@ludy/kernel';
import { type TodayItem, type VatFilingPeriod } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineQuery, sha256Hex, type QueryContext } from '@ludy/kernel-runtime';
import { closingPeriod } from './notifications.ts';
import { readCollectionSetting } from './collection-settings.ts';
import { databaseToday } from './period-lock.ts';
import { remindersToSendThisWeek } from './payment-reminders.ts';
import { lowStockItems } from './stock-low.ts';
import { readStockLeadDays } from './stock-settings.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ACTORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const FINANCE_LEDGER_COMMANDS = approvalPolicies()
  .filter((p) => p.ledger && p.command.startsWith('finance.'))
  .map((p) => p.command);
const FINANCE_LIVE_COMMANDS = liveApprovalCommands().filter((c) => c.startsWith('finance.'));
// The most vendor or customer groups of waiting proposals one read lists, the longest waiting first.
export const TODAY_PROPOSAL_GROUPS_MAX = 30;

type Link = (path: string, entity?: string) => string;

interface ProposalTodayRow {
  row_kind: 'group' | 'flag';
  entity: string;
  kind: string | null;
  direction: string | null;
  party: string | null;
  currency: string | null;
  n: string | null;
  amount: string | null;
  first_id: string | null;
  waiting: string | null;
  failed: string | null;
  warned: string | null;
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
    const entities = (await ctx.trx.selectFrom('ludy_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).orderBy('id').execute()).map((e) => e.id);
    const several = entities.length > 1;
    const to: Link = (path, entity) => {
      if (!several || !entity) return path;
      return `${path}${path.includes('?') ? '&' : '?'}entity=${entity}`;
    };
    const items: TodayItem[] = [];
    if (ACTORS.includes(ctx.role)) {
      items.push(...(await proposalTodayItems(ctx, userId, to)));
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

const RFC_UUID = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';

// The proposals of `p` waiting for the caller's own decision, evaluated against the org's precomputed `role_sets` CTE
// (preset + live roles + org-wide finance.proposal.approve holders) in the same SQL statement snapshot (#2749).
function waitingForCaller(ctx: QueryContext, userId: string) {
  const isLedger = sql`p.command = ANY(${FINANCE_LEDGER_COMMANDS}::text[])`;
  const isLive = sql`p.command = ANY(${FINANCE_LIVE_COMMANDS}::text[])`;
  const callerEligible = sql`((${isLedger} AND r.ledger_ids @> ARRAY[${userId}::uuid] AND coalesce(p.eligible_approvers, ARRAY[]::uuid[]) @> ARRAY[${userId}::uuid])
    OR (${isLive} AND r.live_ids @> ARRAY[${userId}::uuid]))`;
  // Match parseAuthors in approval.ts: malformed authors (including a stray co_author entry in authors) fail closed.
  const validAuthors = sql`pg_catalog.jsonb_typeof(p.authors) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p.authors) a
      WHERE (pg_catalog.jsonb_typeof(a) = 'object' AND (
        (a ->> 'type' = 'user' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ ${RFC_UUID})
        OR (a ->> 'type' = 'system' AND pg_catalog.jsonb_typeof(a -> 'component') = 'string')
        OR (a ->> 'type' = 'agent' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ ${RFC_UUID}
            AND pg_catalog.jsonb_typeof(a -> 'run') = 'string' AND a ->> 'run' ~ ${RFC_UUID}))) IS NOT TRUE)`;
  const author = (who: ReturnType<typeof sql>) => sql`p.authors @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', ${who}))`;
  const coAuthor = (who: ReturnType<typeof sql>) => sql`coalesce(p.co_authors @> ARRAY[${who}::uuid], false)`;
  const unnestEligible = () =>
    sql`pg_catalog.unnest(CASE WHEN ${isLive} THEN r.live_ids ELSE coalesce(p.eligible_approvers, ARRAY[]::uuid[]) END) e(u)
      WHERE (${isLive} OR e.u = ANY(r.ledger_ids))`;
  const everyApproverWrote = sql`NOT EXISTS (SELECT 1 FROM ${unnestEligible()} AND NOT ${author(sql`e.u::text`)})`;
  const soleApprover = sql`NOT EXISTS (SELECT 1 FROM ${unnestEligible()} AND e.u <> ${userId}::uuid)`;
  const someoneElseMayDecide = sql`EXISTS (SELECT 1 FROM ${unnestEligible()} AND NOT ${author(sql`e.u::text`)} AND NOT ${coAuthor(sql`e.u`)})`;
  const authorAllowed = sql`CASE WHEN ${isLedger} AND r.accountant THEN false WHEN r.caller_owner THEN ${everyApproverWrote} ELSE ${soleApprover} END`;
  const coAuthorAllowed = sql`CASE WHEN ${isLedger} AND r.accountant THEN false ELSE NOT ${someoneElseMayDecide} END`;
  return sql`p.org_id = ${ctx.orgId}
        AND p.status = 'pending'
        AND p.command LIKE 'finance.%'
        AND ${validAuthors}
        AND ${callerEligible}
        AND (CASE WHEN ${author(sql`${userId}::text`)} THEN ${authorAllowed}
                  WHEN ${coAuthor(sql`${userId}`)} THEN ${coAuthorAllowed}
                  ELSE true END)`;
}

// The finance proposals waiting for the caller's own decision and their failed/warn check flags, computed in one SQL
// statement so the waiting groups and the flags that annotate them always observe the same snapshot (#2749).
// "Waiting for me": the caller is currently eligible under the org's preset and live roles (in the proposal's approver
// snapshot for ledger commands, or any owner/admin for live commands), and either did not write it or, when every
// eligible approver wrote it (owner override) or they are the sole eligible approver, may decide it under four-eyes
// (never for ledger proposals under the accountant preset). A co-author (the person a proposal rests on besides its
// writer, #2736) is shown it only when the preset allows it (not under the accountant preset for ledger proposals) and
// no currently eligible approver is neither a writer nor a co-author: co-authors only restrict, so the owner override
// stays on the writers. Money: a purchase invoice's total in its own currency, never converted. A foreign-currency
// invoice booked in VND (#918) has its amounts in VND already, so it counts as VND; one still waiting for its rate has
// the invoice's own amounts, so it is a group of its own currency. Vouchers and other proposals have no invoice total
// and show no amount. A group list is capped, and the rest is one more item that says how many.
async function proposalTodayItems(ctx: QueryContext, userId: string, to: Link): Promise<TodayItem[]> {
  const check = (status: string) =>
    sql`EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(p.payload -> 'checks') = 'array' THEN p.payload -> 'checks' ELSE '[]'::jsonb END) c WHERE c ->> 'status' = ${status})`;
  const { rows } = await sql<ProposalTodayRow>`
    WITH org_policy AS (
      SELECT NOT EXISTS (
        SELECT 1 FROM ludy_kernel.tenant t
        JOIN ludy_kernel.approval_preset ap ON ap.key = t.approval_preset
        WHERE t.org_id = ${ctx.orgId} AND NOT ap.ledger_chief_accountant_only
      ) AS accountant
    ),
    live_approvers AS (
      SELECT m.user_id,
             (m.role IN ('owner', 'admin')) AS is_base,
             (m.role = 'owner') AS is_owner,
             (m.role <> 'viewer' AND EXISTS (
               SELECT 1 FROM ludy_kernel.role_assignment a
               JOIN ludy_kernel.role_permission rp ON rp.role_key = a.role_key
               WHERE a.org_id = m.org_id
                 AND a.user_id = m.user_id
                 AND a.legal_entity_id IS NULL
                 AND rp.permission = ${LEDGER_APPROVE_PERMISSION}
             )) AS has_perm
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = ${ctx.orgId}
    ),
    role_sets AS (
      SELECT (SELECT accountant FROM org_policy) AS accountant,
             coalesce(pg_catalog.array_agg(user_id) FILTER (WHERE is_base), ARRAY[]::uuid[]) AS live_ids,
             coalesce(pg_catalog.array_agg(user_id) FILTER (WHERE (NOT (SELECT accountant FROM org_policy) AND is_base) OR has_perm), ARRAY[]::uuid[]) AS ledger_ids,
             coalesce(pg_catalog.bool_or(user_id = ${userId}::uuid AND is_owner), false) AS caller_owner
      FROM live_approvers
    ),
    w AS (
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
             CASE WHEN p.kind = 'finance.purchase' AND (p.payload #>> '{invoice,total}') ~ ${MONEY} THEN (p.payload #>> '{invoice,total}')::numeric END AS total,
             ${check('fail')} AS has_fail,
             ${check('warn')} AS has_warn
      FROM ludy_kernel.proposal p
      CROSS JOIN role_sets r
      WHERE ${waitingForCaller(ctx, userId)}
    ),
    groups AS (
      SELECT entity, kind, direction, pg_catalog.min(party) AS party, currency,
             pg_catalog.count(*)::text AS n,
             pg_catalog.sum(total)::text AS amount,
             (pg_catalog.array_agg(id ORDER BY created_at, id))[1]::text AS first_id,
             pg_catalog.sum(pg_catalog.count(*)) OVER ()::text AS waiting,
             pg_catalog.min(created_at) AS first_at
      FROM w
      GROUP BY entity, kind, direction, pg_catalog.lower(party), currency
      ORDER BY pg_catalog.min(created_at), first_id
      LIMIT ${TODAY_PROPOSAL_GROUPS_MAX}
    ),
    flags AS (
      SELECT entity,
             pg_catalog.count(*) FILTER (WHERE has_fail)::text AS failed,
             pg_catalog.count(*) FILTER (WHERE NOT has_fail AND has_warn)::text AS warned
      FROM w
      GROUP BY entity
    ),
    combined AS (
      SELECT 'group'::text AS row_kind, 0 AS ord, pg_catalog.row_number() OVER (ORDER BY first_at, first_id) AS seq,
             entity, kind, direction, party, currency, n, amount, first_id, waiting, NULL::text AS failed, NULL::text AS warned
      FROM groups
      UNION ALL
      SELECT 'flag'::text AS row_kind, 1 AS ord, pg_catalog.row_number() OVER (ORDER BY entity) AS seq,
             entity, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, failed, warned
      FROM flags
    )
    SELECT row_kind, entity, kind, direction, party, currency, n, amount, first_id, waiting, failed, warned
    FROM combined
    ORDER BY ord, seq`.execute(ctx.trx);

  const items: TodayItem[] = [];
  const groupRows = rows.filter((r) => r.row_kind === 'group');
  for (const r of groupRows) {
    const count = Number(r.n);
    const sale = r.direction === 'sale';
    const party = r.party ?? '';
    const named = party !== '';
    items.push({
      kind: 'proposal',
      app: 'finance',
      // The party enters the id as a digest of its lower-cased name, so two parties never share an id however long their names.
      id: `proposals:${r.entity}:${r.kind}:${r.direction}:${r.currency}:${sha256Hex(party.toLowerCase()).slice(0, 24)}`,
      title: named ? { key: sale ? 'financeProposalsCustomer' : 'financeProposalsVendor', params: { count, party: party.slice(0, 500) } } : { key: 'financeProposalsOther', params: { count } },
      count,
      ...(r.amount !== null ? { amount: r.amount, ...(r.currency !== 'VND' ? { currency: r.currency as string } : {}) } : {}),
      // One proposal opens itself; a group opens the Inbox.
      href: count === 1 ? to(`/inbox/${r.first_id}`, r.entity) : to('/inbox', r.entity),
    });
  }
  const waiting = Number(groupRows[0]?.waiting ?? 0);
  const listed = items.reduce((n, i) => n + (i.count ?? 0), 0);
  if (waiting > listed) {
    items.push({ kind: 'proposal', app: 'finance', id: 'proposals-more', title: { key: 'financeProposalsMore', params: { count: waiting - listed } }, count: waiting - listed, href: '/inbox' });
  }
  for (const r of rows) {
    if (r.row_kind !== 'flag') continue;
    const failed = Number(r.failed);
    const warned = Number(r.warned);
    if (failed > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-failed:${r.entity}`, title: { key: 'financeChecksFailed', params: { count: failed } }, count: failed, severity: 'block', annotates: 'proposal', href: to('/inbox', r.entity) });
    if (warned > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-warn:${r.entity}`, title: { key: 'financeChecksWarn', params: { count: warned } }, count: warned, severity: 'warn', annotates: 'proposal', href: to('/inbox', r.entity) });
  }
  return items;
}

// The sales e-invoices that need a person (#2502): failed, with a code on the draft; sent back to a draft with the reason (a rejection) and not asked for again; sent more than an hour
// ago and still unanswered, or issued with the signed XML still not stored. One flag per entity with how many.
async function einvoiceItems(ctx: QueryContext, to: Link): Promise<TodayItem[]> {
  const { rows } = await sql<{ entity: string; n: string }>`
    SELECT d.legal_entity_id::text AS entity, pg_catalog.count(*)::text AS n
    FROM ludy_finance.einvoice_draft d
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
    FROM ludy_kernel.notification
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

// The items running low (#2514, #2685), one count per legal entity: the same list as the Hàng hóa screen's "Hàng sắp hết" (finance.stock.low, the org's lead days setting). It counts and links to the
// screen; it orders and sends nothing, and it clears itself as stock is bought in or the pace of sales falls.
async function lowStockToday(ctx: QueryContext, to: Link): Promise<TodayItem[]> {
  // Every low item is counted (the list's own limit would cut an entity's count), and no supplier is looked up for a count.
  const low = await lowStockItems(ctx, { leadDays: await readStockLeadDays(ctx), limit: Number.MAX_SAFE_INTEGER, suppliers: false });
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
  const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
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
    .selectFrom('ludy_finance.period_lock')
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
