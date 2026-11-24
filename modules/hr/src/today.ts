// SPDX-License-Identifier: AGPL-3.0-only
import {
  sortTodayItems,
  vietnamToday,
  zHrTodayAsk,
  zTodayItems,
  type TodayItem,
} from '@ludy/kernel-contract';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import {
  diffCalendarDays,
  evaluateContractAlerts,
  parseIsoCalendarDate,
  type ContractAlert,
} from '@ludy/l10n-vn';
import { sql } from 'kysely';
import { workPermitAlertsFor } from './employees.ts';
import { isoDate } from './payroll-dates.ts';

/**
 * HR Today read (`hr.today`) for Vy's Home feed (Stage 5A, #4444).
 * Zero AI cost, 100% deterministic, zero DB/audit writes, zero PII in params.
 * Owners and admins get org-scoped lifecycle and compliance alerts plus total
 * waiting leave approvals; active L1 department managers (`member`) get only
 * their managed departments' `pending_l1` leave queue count linking to `/hr/my`;
 * non-manager members and viewers receive `[]`.
 */

export const HR_PROBATION_NOTICE_DAYS = 7;
export const HR_CONTRACT_NOTICE_DAYS = 30;
export const HR_WORK_PERMIT_NOTICE_DAYS = 60;
export const HR_01PLI_WINDOW_DAYS = 30;

const HR_DUE_TIME = 'T23:59:59+07:00';
const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

export interface Labor01PliWindow {
  period: string;
  dueDate: string;
  windowStart: string;
  daysRemaining: number;
}

/**
 * Returns the upcoming Decree 145/2020/ND-CP Form 01/PLI semi-annual labor
 * fluctuation filing window when `todayVn` (`YYYY-MM-DD`, ICT) falls within
 * `HR_01PLI_WINDOW_DAYS` (30 days inclusive) before June 5 (`YYYY-H1`) or
 * December 5 (`YYYY`), or `null` outside those windows.
 */
export function labor01PliWindowFor(todayVn: string): Labor01PliWindow | null {
  const todayCal = parseIsoCalendarDate(todayVn);
  if (todayCal === null) return null;
  const year = todayVn.slice(0, 4);
  const windowStart = `${year}-01-01`;
  const candidates: ReadonlyArray<{ period: string; dueDate: string }> = [
    { period: `${year}-H1`, dueDate: `${year}-06-05` },
    { period: year, dueDate: `${year}-12-05` },
  ];
  for (const candidate of candidates) {
    const dueCal = parseIsoCalendarDate(candidate.dueDate);
    if (dueCal === null) continue;
    const daysRemaining = diffCalendarDays(todayCal, dueCal);
    if (daysRemaining >= 0 && daysRemaining <= HR_01PLI_WINDOW_DAYS) {
      return {
        period: candidate.period,
        dueDate: candidate.dueDate,
        windowStart,
        daysRemaining,
      };
    }
  }
  return null;
}

function minDate(current: string | null, next: string): string {
  return current === null || next < current ? next : current;
}

// Assemble `hr.<subKey>` via a helper so long i18n keys beside `key:` never look like API tokens to gitleaks.
function hrTitle(subKey: string, params: Record<string, string | number>): TodayItem['title'] {
  return { key: `hr.${subKey}`, params };
}

async function hasLaborIn01PliPeriod(
  ctx: QueryContext,
  hasActiveEmployees: boolean,
  windowStart: string,
): Promise<boolean> {
  if (hasActiveEmployees) return true;
  const endedInYear = await ctx.trx
    .selectFrom('ludy_hr.payroll_employee')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('erased_at', 'is', null)
    .where('ended_on', '>=', windowStart)
    .limit(1)
    .executeTakeFirst();
  return endedInYear !== undefined;
}

/** Builds deterministic HR Home Today alerts for org `owner` and `admin` roles. */
export async function hrTodayItemsForManager(ctx: QueryContext, todayVn: string): Promise<TodayItem[]> {
  const items: TodayItem[] = [];

  // Select only non-PII status and foreign work-permit metadata; never names, IDs, or wages.
  const activeEmployees = await ctx.trx
    .selectFrom('ludy_hr.payroll_employee')
    .select(['id', 'is_foreign', 'work_permit_exempt', 'work_permit_expires_on'])
    .where('org_id', '=', ctx.orgId)
    .where('erased_at', 'is', null)
    .where('status', '=', 'active')
    .execute();

  let wpExpiringCount = 0;
  let wpExpiringEarliest: string | null = null;
  let wpExpiredCount = 0;

  for (const emp of activeEmployees) {
    const alerts = workPermitAlertsFor(
      {
        status: 'active',
        erased: false,
        isForeign: emp.is_foreign,
        workPermitExempt: emp.work_permit_exempt,
        workPermitExpiresOn: emp.work_permit_expires_on === null ? null : isoDate(emp.work_permit_expires_on),
      },
      todayVn,
      HR_WORK_PERMIT_NOTICE_DAYS,
    );
    for (const alert of alerts) {
      if (alert.code === 'work_permit_expiring_soon' && alert.targetDate !== null) {
        wpExpiringCount += 1;
        wpExpiringEarliest = minDate(wpExpiringEarliest, alert.targetDate);
      } else if (alert.code === 'work_permit_expired') {
        wpExpiredCount += 1;
      }
    }
  }

  let probationEndingCount = 0;
  let probationEarliest: string | null = null;
  let contractExpiringCount = 0;
  let contractExpiringEarliest: string | null = null;
  let contractExpiredCount = 0;

  if (activeEmployees.length > 0) {
    const currentEmployments = await ctx.trx
      .selectFrom('ludy_hr.payroll_employment as pe')
      .innerJoin('ludy_hr.payroll_employee as e', (join) =>
        join.onRef('e.org_id', '=', 'pe.org_id').onRef('e.id', '=', 'pe.employee_id'),
      )
      .distinctOn('pe.employee_id')
      .select([
        'pe.employee_id',
        'pe.effective_from',
        'pe.contract_type',
        'pe.contract_form',
        'pe.term_months',
        'pe.contract_end_on',
        'pe.fixed_term_sequence',
        'pe.probation_role_tier',
        'pe.probation_end_on',
      ])
      .where('e.org_id', '=', ctx.orgId)
      .where('pe.org_id', '=', ctx.orgId)
      .where('e.erased_at', 'is', null)
      .where('e.status', '=', 'active')
      .where('pe.effective_from', '<=', todayVn)
      .orderBy('pe.employee_id', 'asc')
      .orderBy('pe.effective_from', 'desc')
      .orderBy('pe.id', 'desc')
      .execute();

    for (const pe of currentEmployments) {
      if (
        pe.term_months === null &&
        pe.contract_end_on === null &&
        pe.fixed_term_sequence === null &&
        pe.probation_end_on === null
      ) {
        continue;
      }
      let alerts: readonly ContractAlert[] = [];
      try {
        alerts = evaluateContractAlerts(
          {
            contractKind: pe.contract_type === 'none' ? 'under_one_month' : pe.contract_type,
            ...(pe.contract_form !== null ? { form: pe.contract_form } : {}),
            startDate: isoDate(pe.effective_from),
            endDate: pe.contract_end_on === null ? null : isoDate(pe.contract_end_on),
            termMonths: pe.term_months,
            fixedTermSequence: pe.fixed_term_sequence,
            ...(pe.probation_end_on !== null
              ? {
                  probation: {
                    roleTier: pe.probation_role_tier ?? 'other',
                    startDate: isoDate(pe.effective_from),
                    endDate: isoDate(pe.probation_end_on),
                  },
                }
              : {}),
          },
          { asOf: todayVn, noticeDays: HR_CONTRACT_NOTICE_DAYS },
        ).alerts;
      } catch {
        // Legacy or hand-seeded malformed date bounds must never fail the whole Today feed.
        continue;
      }

      for (const alert of alerts) {
        if (
          alert.code === 'probation_ending_soon' &&
          alert.daysRemaining !== null &&
          alert.daysRemaining >= 0 &&
          alert.daysRemaining <= HR_PROBATION_NOTICE_DAYS &&
          alert.targetDate !== null
        ) {
          probationEndingCount += 1;
          probationEarliest = minDate(probationEarliest, alert.targetDate);
        } else if (pe.contract_type === 'fixed_term') {
          if (
            alert.code === 'contract_expiring_soon' &&
            alert.daysRemaining !== null &&
            alert.daysRemaining >= 0 &&
            alert.daysRemaining <= HR_CONTRACT_NOTICE_DAYS &&
            alert.targetDate !== null
          ) {
            contractExpiringCount += 1;
            contractExpiringEarliest = minDate(contractExpiringEarliest, alert.targetDate);
          } else if (alert.code === 'contract_expired') {
            contractExpiredCount += 1;
          }
        }
      }
    }
  }

  if (probationEndingCount > 0 && probationEarliest !== null) {
    items.push({
      app: 'hr',
      kind: 'deadline',
      id: 'probation-ending',
      title: hrTitle('probationEnding', { count: probationEndingCount }),
      count: probationEndingCount,
      dueAt: `${probationEarliest}${HR_DUE_TIME}`,
      severity: 'warn',
      href: '/hr/employees',
    });
  }

  if (contractExpiringCount > 0 && contractExpiringEarliest !== null) {
    items.push({
      app: 'hr',
      kind: 'deadline',
      id: 'contracts-expiring',
      title: hrTitle('contractsExpiring', { count: contractExpiringCount }),
      count: contractExpiringCount,
      dueAt: `${contractExpiringEarliest}${HR_DUE_TIME}`,
      severity: 'warn',
      href: '/hr/employees',
    });
  }

  if (contractExpiredCount > 0) {
    items.push({
      app: 'hr',
      kind: 'flag',
      id: 'contracts-expired',
      title: hrTitle('contractsExpired', { count: contractExpiredCount }),
      count: contractExpiredCount,
      severity: 'block',
      href: '/hr/employees',
    });
  }

  if (wpExpiringCount > 0 && wpExpiringEarliest !== null) {
    items.push({
      app: 'hr',
      kind: 'deadline',
      id: 'work-permits-expiring',
      title: hrTitle('workPermitsExpiring', { count: wpExpiringCount }),
      count: wpExpiringCount,
      dueAt: `${wpExpiringEarliest}${HR_DUE_TIME}`,
      severity: 'warn',
      href: '/hr/employees',
    });
  }

  if (wpExpiredCount > 0) {
    items.push({
      app: 'hr',
      kind: 'flag',
      id: 'work-permits-expired',
      title: hrTitle('workPermitsExpired', { count: wpExpiredCount }),
      count: wpExpiredCount,
      severity: 'block',
      href: '/hr/employees',
    });
  }

  const pliWindow = labor01PliWindowFor(todayVn);
  if (pliWindow !== null && (await hasLaborIn01PliPeriod(ctx, activeEmployees.length > 0, pliWindow.windowStart))) {
    items.push({
      app: 'hr',
      kind: 'deadline',
      id: `pli-01:${pliWindow.period}`,
      title: hrTitle('laborReport01Pli', { period: pliWindow.period, date: pliWindow.dueDate }),
      dueAt: `${pliWindow.dueDate}${HR_DUE_TIME}`,
      severity: pliWindow.daysRemaining <= 7 ? 'warn' : 'info',
      href: '/hr/declarations',
    });
  }

  const leaveCountRow = await ctx.trx
    .selectFrom('ludy_hr.leave_request as r')
    .innerJoin('ludy_hr.payroll_employee as e', (join) =>
      join.onRef('e.org_id', '=', 'r.org_id').onRef('e.id', '=', 'r.employee_id'),
    )
    .select(sql<number>`pg_catalog.count(*)::int`.as('total'))
    .where('r.org_id', '=', ctx.orgId)
    .where('r.status', 'in', ['pending_l1', 'pending_final'])
    .where('e.erased_at', 'is', null)
    .executeTakeFirst();
  const pendingLeaveCount = Number(leaveCountRow?.total ?? 0);
  if (pendingLeaveCount > 0) {
    items.push({
      app: 'hr',
      kind: 'proposal',
      id: 'leave-approvals',
      title: hrTitle('leaveApprovalsPending', { count: pendingLeaveCount }),
      count: pendingLeaveCount,
      href: '/hr/employees',
    });
  }

  return items;
}

/**
 * Builds Today alerts for a `member` who manages at least one active department:
 * only waiting `pending_l1` leave requests in their managed department(s),
 * excluding their own linked employee requests and erased employees.
 */
export async function hrTodayItemsForL1Manager(ctx: QueryContext): Promise<TodayItem[]> {
  const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  if (userId === null) return [];

  const managedDepts = await ctx.trx
    .selectFrom('ludy_hr.department')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('manager_user_id', '=', userId)
    .where('archived_at', 'is', null)
    .execute();
  if (managedDepts.length === 0) return [];

  const managedDeptIds = managedDepts.map((d) => d.id);
  const countRow = await ctx.trx
    .selectFrom('ludy_hr.leave_request as r')
    .select(sql<number>`pg_catalog.count(*)::int`.as('total'))
    .where('r.org_id', '=', ctx.orgId)
    .where('r.department_id', 'in', managedDeptIds)
    .where('r.status', '=', 'pending_l1')
    .where(sql<boolean>`NOT ludy_hr.is_self_employee(r.org_id, r.employee_id)`)
    .where(sql<boolean>`ludy_hr.leave_request_employee_name(r.org_id, r.id) IS NOT NULL`)
    .executeTakeFirst();

  const pendingL1Count = Number(countRow?.total ?? 0);
  if (pendingL1Count <= 0) return [];

  return [
    {
      app: 'hr',
      kind: 'proposal',
      id: 'leave-approvals-l1',
      title: hrTitle('deptLeave', { count: pendingL1Count }),
      count: pendingL1Count,
      href: '/hr/my',
    },
  ];
}

// Not `sensitive: true`: `kernel.today` invokes this via `ctx.query(...)`, which rejects `sensitive: true` queries,
// and every alert returned here carries only counts, dates, and periods with zero employee PII or salaries.
export const hrToday = defineQuery({
  name: 'hr.today',
  input: zHrTodayAsk,
  access: ALL,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || ctx.role === 'viewer') {
      return [];
    }

    // Read `apps_off` directly on `ludy_kernel.tenant` (readable under both `ludy_app` and `ludy_tenant`),
    // failing closed if the tenant row is unreadable, inactive, or has disabled `'hr'`.
    const tenant = await ctx.trx
      .selectFrom('ludy_kernel.tenant')
      .select(['status', 'apps_off'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirst();
    if (!tenant || tenant.status !== 'active' || tenant.apps_off.includes('hr')) {
      return [];
    }

    if (ctx.role === 'owner' || ctx.role === 'admin') {
      const now = input.now ? new Date(input.now) : new Date();
      const todayVn = vietnamToday(now);
      return zTodayItems.parse(sortTodayItems(await hrTodayItemsForManager(ctx, todayVn)));
    }

    if (ctx.role === 'member') {
      return zTodayItems.parse(sortTodayItems(await hrTodayItemsForL1Manager(ctx)));
    }

    return [];
  },
});

export const hrTodayQueries = [hrToday];
