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
// Titles are message keys with params (catalogs in apps/app: financeToday.*), never rendered text. A href is a path
// inside the org (/inbox/<id>, /bank, /vat?period=...); with several legal entities in view it carries `entity=<id>` so
// the acting screen opens in the right books.
import { sql } from 'kysely';
import { z } from 'zod';
import { taxDuesOf } from '@crove/kernel';
import type { VatFilingPeriod } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { closingPeriod } from './notifications.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ACTORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The most vendor or customer groups of waiting proposals one read lists, the longest waiting first.
export const TODAY_PROPOSAL_GROUPS_MAX = 30;

// The item every line of Home exposes (#2383). The shared schema lives in the contract package once the Frontend line
// lands it; this is the same shape.
export interface TodayItem {
  kind: 'proposal' | 'flag' | 'message' | 'deadline';
  app: 'finance' | 'crm' | 'notes' | 'social' | 'ads';
  id: string;
  title: { key: string; params?: Record<string, string | number> };
  count?: number;
  amount?: string;
  currency?: string;
  dueAt?: string;
  severity?: 'info' | 'warn' | 'block';
  href: string;
}

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
      items.push(...(await originalItems(ctx)));
      items.push(...(await bankItems(ctx, entities, to)));
    }
    items.push(...(await deadlines(ctx, today, to)));
    return items;
  },
});

// The finance proposals waiting for the caller's own decision, one item per party, direction and currency in each
// entity, with the exact total of their invoices. "Waiting for me": the caller is in the proposal's approver snapshot,
// and either did not write it or every approver in the snapshot did (the four-eyes rule then lets the owner decide,
// P10). A total in a foreign currency stays in it: never converted.
async function waitingProposals(ctx: QueryContext, userId: string, to: Link): Promise<TodayItem[]> {
  const author = (who: ReturnType<typeof sql>) => sql`p.authors @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', ${who}))`;
  const { rows } = await sql<GroupRow>`
    SELECT p.legal_entity_id::text AS entity,
           p.kind,
           CASE WHEN p.kind = 'finance.purchase' THEN coalesce(p.payload ->> 'direction', '') ELSE '' END AS direction,
           CASE WHEN p.kind = 'finance.purchase'
                THEN coalesce(nullif(pg_catalog.btrim(CASE WHEN p.payload ->> 'direction' = 'sale' THEN p.payload #>> '{buyer,name}' ELSE p.payload #>> '{seller,name}' END), ''), '')
                ELSE '' END AS party,
           CASE WHEN p.kind = 'finance.purchase' THEN coalesce(nullif(p.payload #>> '{invoice,currency}', ''), 'VND') ELSE 'VND' END AS currency,
           pg_catalog.count(*)::text AS n,
           pg_catalog.sum(CASE WHEN coalesce(p.payload #>> '{invoice,total}', p.payload ->> 'total') ~ ${MONEY}
                               THEN coalesce(p.payload #>> '{invoice,total}', p.payload ->> 'total')::numeric END)::text AS amount,
           (pg_catalog.array_agg(p.id ORDER BY p.created_at, p.id))[1]::text AS first_id
    FROM crove_kernel.proposal p
    WHERE p.org_id = ${ctx.orgId}
      AND p.status = 'pending'
      AND p.command LIKE 'finance.%'
      AND p.eligible_approvers @> ARRAY[${userId}::uuid]
      AND (NOT ${author(sql`${userId}::text`)}
           OR NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.eligible_approvers) e(u) WHERE NOT ${author(sql`e.u::text`)}))
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY pg_catalog.min(p.created_at), first_id
    LIMIT ${TODAY_PROPOSAL_GROUPS_MAX}`.execute(ctx.trx);
  return rows.map((r) => {
    const count = Number(r.n);
    const sale = r.direction === 'sale';
    const named = r.party !== '';
    return {
      kind: 'proposal' as const,
      app: 'finance' as const,
      id: `proposals:${r.entity}:${r.kind}:${r.direction}:${r.currency}:${named ? r.party.toLowerCase() : ''}`.slice(0, 200),
      title: named ? { key: sale ? 'financeToday.proposalsCustomer' : 'financeToday.proposalsVendor', params: { count, party: r.party } } : { key: 'financeToday.proposalsOther', params: { count } },
      count,
      ...(r.amount !== null ? { amount: r.amount, ...(r.currency !== 'VND' ? { currency: r.currency } : {}) } : {}),
      // One proposal opens itself; a group opens the Inbox.
      href: count === 1 ? to(`/inbox/${r.first_id}`, r.entity) : to('/inbox', r.entity),
    };
  });
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
    if (failed > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-failed:${r.entity}`, title: { key: 'financeToday.checksFailed', params: { count: failed } }, count: failed, severity: 'block', href: to('/inbox', r.entity) });
    if (warned > 0) items.push({ kind: 'flag', app: 'finance', id: `checks-warn:${r.entity}`, title: { key: 'financeToday.checksWarn', params: { count: warned } }, count: warned, severity: 'warn', href: to('/inbox', r.entity) });
  }
  return items;
}

// The originals still to fetch (a mail with only a lookup link or code, #2286: the kernel's read answers owners, admins
// and members of the whole org only) and the originals attached to a posted invoice that differ from it or are not
// verified, which the caller was told about and has not opened yet (#2335).
async function originalItems(ctx: QueryContext): Promise<TodayItem[]> {
  const items: TodayItem[] = [];
  const needed = await ctx.query<{ total: number }>('kernel.inbox.originals', {});
  if (needed.status === 'ok' && needed.value.total > 0) {
    items.push({ kind: 'flag', app: 'finance', id: 'originals-needed', title: { key: 'financeToday.originalsNeeded', params: { count: needed.value.total } }, count: needed.value.total, severity: 'info', href: '/inbox' });
  }
  const notices = await ctx.query<{ items: Array<{ kind: string; subjectId: string | null; read: boolean }> }>('kernel.notification.list', {});
  if (notices.status === 'ok') {
    const flagged = notices.value.items.filter((n) => n.kind === 'kernel.original_flagged' && !n.read);
    const only = flagged.length === 1 ? flagged[0]?.subjectId : null;
    if (flagged.length > 0) {
      items.push({ kind: 'flag', app: 'finance', id: 'originals-flagged', title: { key: 'financeToday.originalsFlagged', params: { count: flagged.length } }, count: flagged.length, severity: 'warn', href: only ? `/inbox/${only}` : '/inbox' });
    }
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
    if (waiting > 0) items.push({ kind: 'message', app: 'finance', id: 'statements-staged', title: { key: 'financeToday.statementsStaged', params: { count: waiting } }, count: waiting, href: '/inbox' });
  }
  for (const entity of entities) {
    const open = await ctx.query<{ accounts: Array<{ open: number }> }>('finance.bank.open_lines', { legalEntityId: entity });
    if (open.status !== 'ok') break;
    const lines = open.value.accounts.reduce((n, a) => n + a.open, 0);
    if (lines > 0) items.push({ kind: 'message', app: 'finance', id: `bank-open-lines:${entity}`, title: { key: 'financeToday.bankLinesOpen', params: { count: lines } }, count: lines, href: to('/bank', entity) });
  }
  return items;
}

// End of the due day in Vietnam, as the instant a deadline is due.
const DUE_TIME = 'T23:59:59+07:00';

// The next VAT return still to file and the period close, only when the org has the data to compute them: a filing
// period set in the org's settings, and, for the close, a period lock. The return comes from the tax calendar, which
// leaves out what every entity marked done (and an entity the caller does not see); the close from the rule of the
// closing reminder (#671), so the two never disagree.
async function deadlines(ctx: QueryContext, today: string, to: Link): Promise<TodayItem[]> {
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
      title: { key: 'financeToday.vatDue', params: { period: due.period, date: due.dueDate, days: due.daysLeft } },
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
    const through = locks.some((l) => l.through === null) ? null : (locks.map((l) => l.through as string).sort()[0] ?? null);
    const closing = closingPeriod(kind, through, today);
    if (closing) {
      items.push({
        kind: 'deadline',
        app: 'finance',
        id: `close:${closing.period}`,
        title: { key: 'financeToday.periodClose', params: { period: closing.period, date: closing.dueDate } },
        dueAt: `${closing.dueDate}${DUE_TIME}`,
        severity: 'warn',
        href: '/ledger',
      });
    }
  }
  return items;
}
