// SPDX-License-Identifier: AGPL-3.0-only
// The figures of "Tuần này" on Home (Vy plan C5, slice V6, #3257): how the business did in the last 7 days. Nothing is stored and nothing is written. Each figure comes
// from a read a line already exposes, run through ctx.query in the member's own transaction and role, so each line's own rules decide what the member sees and no
// table of any app is read here:
//   - Engage's CRM: `crm.signals.won_deals` (deals won in the window: their number and the sum of their amounts) and `crm.signals.open_deals` (deals still open);
//   - Accounting: `finance.overview` run twice (as of today and as of the day before the window): cash, receivables and payables, now and a week ago;
//   - the kernel's own `kernel.task.list`, the member's own seats: open tasks past their due time.
// A group is null when its read is not registered, its module is off, it refuses the member (no right to the books, or several entities and no default one) or it answers outside its contract,
// (a member who can open only one non-default entity gets that entity's books: it is what they can open, and the deal and task figures are the org's own),
// and also when the answer was cut by the read's own cap so the figure would be an undercount: a figure the member cannot see, or cannot trust, is never shown as 0.
// The words come later (packages/agent weekly.ts) and are told these figures only. Amounts stay decimal strings; the one sum is made by PostgreSQL's numeric.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  CRM_OPEN_DEALS_SIGNALS_READ,
  CRM_WON_DEALS_SIGNALS_READ,
  SIGNALS_MAX_CRM,
  WEEKLY_DAYS,
  vietnamToday,
  zCrmOpenDealSignals,
  zCrmWonDealSignals,
  zFinanceOverview,
  type WeeklyFigures,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { TASK_LIST_LIMIT } from './agents.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DAY_MS = 86_400_000;

export const TODAY_WEEKLY_READ = 'kernel.today_weekly.figures';

/** The calendar day `days` after (or, negative, before) a Vietnam calendar day, YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// What one read gave, held to its contract: the value, or null (not registered, module off, refused, or outside its contract). Only a refusal by the line (a DomainError,
// thrown before any SQL) is taken as "nothing to show"; anything else, such as a database error, may have left the transaction unusable and fails the answer.
async function readOne<T>(ctx: QueryContext, name: string, schema: z.ZodType<T>, input: unknown = {}): Promise<T | null> {
  let answer;
  try {
    answer = await ctx.query<unknown>(name, input);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
  if (answer.status !== 'ok') return null;
  const parsed = schema.safeParse(answer.value);
  return parsed.success ? parsed.data : null;
}

const zOpenTasks = z.object({ tasks: z.array(z.object({ status: z.string(), due: z.string().nullable() })) });
const OPEN_TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review'] as const;

async function dealFigures(ctx: QueryContext, from: string, to: string): Promise<WeeklyFigures['deals']> {
  const won = await readOne(ctx, CRM_WON_DEALS_SIGNALS_READ, zCrmWonDealSignals);
  if (won === null) return null;
  // The read lists the most recent wins up to its cap: when the cap was reached and the oldest win listed is still inside the window, wins of the window may be missing.
  if (won.length >= SIGNALS_MAX_CRM && won.every((d) => d.wonOn >= from)) return null;
  const inWindow = won.filter((d) => d.wonOn >= from && d.wonOn <= to);
  let total = '0';
  if (inWindow.length > 0) {
    const { rows } = await sql<{ total: string }>`SELECT COALESCE(sum(a), 0)::text AS total FROM unnest(${inWindow.map((d) => d.amount)}::numeric[]) AS a`.execute(ctx.trx);
    total = (rows[0] as { total: string }).total;
  }
  // The open deals are a second read: when it is missing or cut, only that count is left out.
  const open = await readOne(ctx, CRM_OPEN_DEALS_SIGNALS_READ, zCrmOpenDealSignals);
  return { won: { count: inWindow.length, amount: total }, open: open !== null && open.length < SIGNALS_MAX_CRM ? open.length : null };
}

async function moneyFigures(ctx: QueryContext, to: string, before: string): Promise<WeeklyFigures['money']> {
  const now = await readOne(ctx, 'finance.overview', zFinanceOverview, { range: 'last_30_days', asOf: to });
  // Books that hold no entry at all have nothing to compare; the screen of Kế toán points at the first steps instead.
  if (now === null || now.empty) return null;
  const then = await readOne(ctx, 'finance.overview', zFinanceOverview, { range: 'last_30_days', asOf: before });
  if (then === null) return null;
  return {
    cash: { amount: now.cash.amount, previous: then.cash.amount },
    receivables: { amount: now.receivables.amount, previous: then.receivables.amount },
    payables: { amount: now.payables.amount, previous: then.payables.amount },
  };
}

async function taskFigures(ctx: QueryContext, now: Date): Promise<WeeklyFigures['tasks']> {
  const open = await readOne(ctx, 'kernel.task.list', zOpenTasks, { mine: true, status: [...OPEN_TASK_STATUSES] });
  // The list is cut at its cap, newest first, so the cut ones are the oldest and likeliest to be late: a full list gives no count.
  if (open === null || open.tasks.length >= TASK_LIST_LIMIT) return null;
  const late = open.tasks.filter((t) => t.due !== null && Date.parse(t.due) < now.getTime()).length;
  return { late };
}

export function todayWeeklyQuery(options: { today?: () => string; now?: () => Date } = {}) {
  const today = options.today ?? (() => vietnamToday());
  const clock = options.now ?? (() => new Date());
  return defineQuery({
    name: TODAY_WEEKLY_READ,
    input: z.object({}),
    access: ALL,
    handler: async (ctx): Promise<WeeklyFigures> => {
      const to = today();
      const from = addDays(to, -(WEEKLY_DAYS - 1));
      const before = addDays(to, -WEEKLY_DAYS);
      // One group after the other: they share the member's transaction.
      const deals = await dealFigures(ctx, from, to);
      const money = await moneyFigures(ctx, to, before);
      const tasks = await taskFigures(ctx, clock());
      return { from, to, before, deals, money, tasks };
    },
  });
}
