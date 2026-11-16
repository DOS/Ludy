// SPDX-License-Identifier: AGPL-3.0-only
// Lightweight recruiting (#3425, part of #3403 Stage 3 slice 3b-2): openings, candidate pipeline,
// calendar interview scheduling, 1-click hire to payroll_employee + payroll_employment, PDPL erase,
// and pseudonymized brief reads for recruiting coworker Ly (hr.recruiting_brief).
//
// Owners and admins only (MANAGERS / OWNERS), reinforced by RESTRICTIVE le_scope + owner_admin RLS policies.
// Audit facts carry IDs, stages, counts, and changed field names (plus auditValue on payroll baseWage),
// never candidate PII or raw notes. Calendar interview event titles carry the opening role only, never candidate PII.
import { sql } from 'kysely';
import { busyOf, kernelManifest, workingHoursOf } from '@crove/kernel';
import {
  CALENDAR_RANGE_MAX_DAYS,
  HR_ERASED_NAME,
  auditValue,
  isVietnamHoliday,
  tableWrite,
  weekdayOf,
  zHrCandidateAdd,
  zHrCandidateEdit,
  zHrCandidateHire,
  zHrCandidateList,
  zHrCandidateMoveStage,
  zHrCandidateRef,
  zHrCandidateScheduleInterview,
  zHrInterviewSlotsAsk,
  zHrOpeningAdd,
  zHrOpeningClose,
  zHrOpeningEdit,
  zHrOpeningList,
  zHrRecruitingBriefAsk,
  zHrRecruitingBriefAudit,
  zonedDate,
  zonedInstant,
  type HrCandidateEraseResult,
  type HrCandidateHireResult,
  type HrCandidateInterviewScheduled,
  type HrCandidateStage,
  type HrCandidateView,
  type HrCandidateWritten,
  type HrContractType,
  type HrInterviewSlotsResult,
  type HrJobOpeningStatus,
  type HrOpeningView,
  type HrOpeningWritten,
  type HrPayFunction,
  type HrRegion,
  type WorkingHours,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import {
  INTERVIEW_DURATION_MAX_MINUTES,
  INTERVIEW_DURATION_MIN_MINUTES,
  checkCandidateTransition,
  money,
  rankInterviewSlots,
  type InterviewInterval,
} from '@crove/l10n-vn';
import {
  EMPLOYMENT,
  EMPLOYMENT_COLUMNS,
  MANAGERS,
  OWNERS,
  prepareEmploymentTerms,
  resolveDepartment,
  resolveEntity,
  userOf,
} from './employees.ts';
import { hrManifest } from './manifest.ts';

const OPENING_INSERT_COLUMNS = [
  'org_id',
  'id',
  'legal_entity_id',
  'department_id',
  'title',
  'department_name',
  'contract_type',
  'region',
  'pay_function',
  'budget_min_wage',
  'budget_max_wage',
  'required_skills',
  'status',
  'closed_at',
  'created_by',
  'created_at',
  'updated_at',
] as const;

const OPENING_EDIT_COLUMNS = [
  'department_id',
  'title',
  'department_name',
  'contract_type',
  'region',
  'pay_function',
  'budget_min_wage',
  'budget_max_wage',
  'required_skills',
  'updated_at',
] as const;

const CANDIDATE = hrManifest.tables.crove_hr.candidate;
const CANDIDATE_INSERT_COLUMNS = [
  'org_id',
  'id',
  'legal_entity_id',
  'opening_id',
  'display_name',
  'email',
  'phone',
  'stage',
  'years_experience',
  'matched_skills',
  'expected_wage',
  'agreed_wage',
  'planned_start_on',
  'notes',
  'created_by',
  'created_at',
  'updated_at',
] as const;

const CANDIDATE_EDIT_COLUMNS = [
  'opening_id',
  'display_name',
  'email',
  'phone',
  'years_experience',
  'matched_skills',
  'expected_wage',
  'agreed_wage',
  'planned_start_on',
  'notes',
  'updated_at',
] as const;

const CANDIDATE_HIRE_EMPLOYEE_COLUMNS = [
  'org_id',
  'id',
  'legal_entity_id',
  'department_id',
  'job_title',
  'display_name',
  'created_by',
  'created_at',
  'updated_at',
] as const;

const CALENDAR_EVENT_COLUMNS = [
  'org_id',
  'id',
  'user_id',
  'starts_at',
  'ends_at',
  'time_zone',
  'title',
  'kind',
  'status',
  'cancelled_by',
  'cancelled_at',
  'created_by',
  'created_at',
] as const;

const isoInstant = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString());
const isoInstantNullable = (value: Date | string | null): string | null => (value === null ? null : isoInstant(value));
const isoDateNullable = (value: Date | string | null): string | null =>
  value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

function normalizeSkills(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function assertBudgetOrder(minWage: string | null, maxWage: string | null): void {
  if (minWage !== null && maxWage !== null && money(maxWage).lessThan(money(minWage))) {
    throw new DomainError('HR_OPENING_BUDGET_ORDER', 422, 'Mức lương tối đa phải lớn hơn hoặc bằng tối thiểu');
  }
}

const openingNotFound = () => new DomainError('HR_OPENING_NOT_FOUND', 404, 'Không tìm thấy vị trí tuyển dụng này');
const candidateNotFound = () => new DomainError('HR_CANDIDATE_NOT_FOUND', 404, 'Không tìm thấy ứng viên này');
const candidateErased = () => new DomainError('HR_CANDIDATE_ERASED', 409, 'Hồ sơ ứng viên này đã được xóa theo yêu cầu');

async function hasActiveInterview(ctx: Pick<CommandContext, 'trx' | 'orgId'>, interviewEventId: string | null): Promise<boolean> {
  if (!interviewEventId) return false;
  const row = await ctx.trx
    .selectFrom('crove_kernel.calendar_event')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', interviewEventId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Boolean(row);
}

async function lockOpening(ctx: CommandContext, openingId: string) {
  const row = await ctx.trx
    .selectFrom('crove_hr.job_opening')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', openingId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw openingNotFound();
  return row;
}

async function lockCandidate(ctx: CommandContext, candidateId: string) {
  const row = await ctx.trx
    .selectFrom('crove_hr.candidate')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', candidateId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw candidateNotFound();
  return row;
}

async function loadOpeningForCandidate(ctx: CommandContext, openingId: string, expectedLegalEntityId?: string, allowClosed = false) {
  const opening = await ctx.trx
    .selectFrom('crove_hr.job_opening')
    .select(['id', 'legal_entity_id', 'department_id', 'department_name', 'title', 'status', 'contract_type', 'region', 'pay_function', 'required_skills', 'budget_min_wage', 'budget_max_wage'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', openingId)
    .forShare()
    .executeTakeFirst();
  if (!opening) throw openingNotFound();
  if (expectedLegalEntityId !== undefined && opening.legal_entity_id !== expectedLegalEntityId) {
    throw new DomainError('HR_CANDIDATE_WRONG_ENTITY', 422, 'Vị trí tuyển dụng không thuộc pháp nhân của ứng viên');
  }
  if (!allowClosed && opening.status !== 'open') {
    throw new DomainError('HR_OPENING_CLOSED', 409, 'Vị trí tuyển dụng này đã đóng, không thể nhận thêm ứng viên');
  }
  return opening;
}

function workingWindowsInRange(hours: WorkingHours, fromMs: number, toMs: number): InterviewInterval[] {
  if (toMs <= fromMs) return [];
  const out: InterviewInterval[] = [];
  let date = zonedDate(hours.timeZone, fromMs - DAY_MS);
  const lastDate = zonedDate(hours.timeZone, toMs + DAY_MS);
  const nextDate = (isoDay: string): string => {
    const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
  };
  for (let guard = 0; date <= lastDate && guard < CALENDAR_RANGE_MAX_DAYS + 3; guard++, date = nextDate(date)) {
    if (isVietnamHoliday(date)) continue;
    const weekday = weekdayOf(date);
    const dayWindows = hours.windows.filter((w) => w.weekday === weekday).sort((a, b) => a.start - b.start);
    for (const w of dayWindows) {
      const startMs = Math.max(fromMs, zonedInstant(hours.timeZone, date, w.start));
      const endMs = Math.min(toMs, zonedInstant(hours.timeZone, date, w.end));
      if (endMs > startMs) {
        out.push({ startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() });
      }
    }
  }
  return out;
}

const DAY_MS = 86_400_000;

export interface HrRecruitingBriefReadInput {
  language: 'vi' | 'en';
  openingTitle: string;
  departmentName: string | null;
  stage: HrCandidateStage;
  yearsExperience: number | null;
  matchedSkills: string[];
  missingSkills: string[];
  skillsRequiredCount: number;
  expectedWage: string | null;
  budgetMinWage: string | null;
  budgetMaxWage: string | null;
  agreedWage: string | null;
  startDate: string | null;
  hasScheduledInterview: boolean;
  notes: string[];
}

export interface HrRecruitingBriefSnapshot {
  candidateId: string;
  input: HrRecruitingBriefReadInput;
  forbidden: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------------

export const openingList = defineQuery({
  name: 'hr.recruiting.opening.list',
  input: zHrOpeningList,
  access: MANAGERS,
  handler: async (ctx, input): Promise<HrOpeningView[]> => {
    let q = ctx.trx
      .selectFrom('crove_hr.job_opening as o')
      .select([
        'o.id',
        'o.legal_entity_id',
        'o.department_id',
        'o.title',
        'o.department_name',
        'o.contract_type',
        'o.region',
        'o.pay_function',
        'o.budget_min_wage',
        'o.budget_max_wage',
        'o.required_skills',
        'o.status',
        'o.closed_at',
        'o.created_at',
        'o.updated_at',
        sql<number>`(SELECT pg_catalog.count(*)::int FROM crove_hr.candidate c WHERE c.org_id = o.org_id AND c.opening_id = o.id)`.as('candidate_count'),
      ])
      .where('o.org_id', '=', ctx.orgId);
    if (input.status !== 'all') q = q.where('o.status', '=', input.status);
    if (input.legalEntityId !== undefined) q = q.where('o.legal_entity_id', '=', input.legalEntityId);
    const rows = await q.orderBy('o.updated_at', 'desc').orderBy('o.id', 'desc').limit(input.limit).execute();
    return rows.map((r) => ({
      id: r.id,
      legalEntityId: r.legal_entity_id,
      departmentId: r.department_id,
      title: r.title,
      departmentName: r.department_name,
      contractType: r.contract_type as HrContractType,
      region: r.region as HrRegion,
      payFunction: r.pay_function as HrPayFunction,
      budgetMinWage: r.budget_min_wage,
      budgetMaxWage: r.budget_max_wage,
      requiredSkills: r.required_skills,
      status: r.status as HrJobOpeningStatus,
      closedAt: isoInstantNullable(r.closed_at),
      candidateCount: Number(r.candidate_count ?? 0),
      createdAt: isoInstant(r.created_at),
      updatedAt: isoInstant(r.updated_at),
    }));
  },
});

function toCandidateView(r: {
  id: string;
  legal_entity_id: string;
  opening_id: string | null;
  opening_title: string | null;
  opening_department_id: string | null;
  opening_department_name: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  stage: HrCandidateStage;
  years_experience: number | null;
  matched_skills: string[];
  expected_wage: string | null;
  agreed_wage: string | null;
  planned_start_on: Date | string | null;
  notes: string | null;
  active_interview_event_id: string | null;
  interview_starts_at: Date | string | null;
  interview_ends_at: Date | string | null;
  hired_employee_id: string | null;
  erased_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): HrCandidateView {
  const erased = r.erased_at !== null;
  const hasActive = r.active_interview_event_id !== null;
  return {
    id: r.id,
    legalEntityId: r.legal_entity_id,
    openingId: r.opening_id,
    openingTitle: r.opening_title ?? null,
    departmentId: r.opening_department_id ?? null,
    departmentName: r.opening_department_name ?? null,
    displayName: erased ? HR_ERASED_NAME : r.display_name,
    email: erased ? null : r.email,
    phone: erased ? null : r.phone,
    stage: r.stage,
    yearsExperience: r.years_experience,
    matchedSkills: r.matched_skills,
    expectedWage: r.expected_wage,
    agreedWage: r.agreed_wage,
    plannedStartOn: isoDateNullable(r.planned_start_on),
    notes: erased ? null : r.notes,
    interviewEventId: r.active_interview_event_id,
    interviewStartsAt: hasActive ? isoInstantNullable(r.interview_starts_at) : null,
    interviewEndsAt: hasActive ? isoInstantNullable(r.interview_ends_at) : null,
    hiredEmployeeId: r.hired_employee_id,
    erasedAt: isoInstantNullable(r.erased_at),
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
  };
}

export const candidateList = defineQuery({
  name: 'hr.recruiting.candidate.list',
  input: zHrCandidateList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrCandidateView[]> => {
    let q = ctx.trx
      .selectFrom('crove_hr.candidate as c')
      .leftJoin('crove_hr.job_opening as o', (join) => join.onRef('o.org_id', '=', 'c.org_id').onRef('o.id', '=', 'c.opening_id'))
      .leftJoin('crove_kernel.calendar_event as e', (join) =>
        join.onRef('e.org_id', '=', 'c.org_id').onRef('e.id', '=', 'c.interview_event_id').on('e.status', '=', 'active'),
      )
      .select([
        'c.id',
        'c.legal_entity_id',
        'c.opening_id',
        'o.title as opening_title',
        'o.department_id as opening_department_id',
        'o.department_name as opening_department_name',
        'c.display_name',
        'c.email',
        'c.phone',
        'c.stage',
        'c.years_experience',
        'c.matched_skills',
        'c.expected_wage',
        'c.agreed_wage',
        'c.planned_start_on',
        'c.notes',
        'e.id as active_interview_event_id',
        'c.interview_starts_at',
        'c.interview_ends_at',
        'c.hired_employee_id',
        'c.erased_at',
        'c.created_at',
        'c.updated_at',
      ])
      .where('c.org_id', '=', ctx.orgId);
    if (input.openingId !== undefined) q = q.where('c.opening_id', '=', input.openingId);
    if (input.stage !== undefined) q = q.where('c.stage', '=', input.stage);
    const rows = await q.orderBy('c.updated_at', 'desc').orderBy('c.id', 'desc').limit(input.limit).execute();
    return rows.map(toCandidateView);
  },
});

export const candidateGet = defineQuery({
  name: 'hr.recruiting.candidate.get',
  input: zHrCandidateRef,
  access: MANAGERS,
  sensitive: true,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  handler: async (ctx, input): Promise<HrCandidateView> => {
    const row = await ctx.trx
      .selectFrom('crove_hr.candidate as c')
      .leftJoin('crove_hr.job_opening as o', (join) => join.onRef('o.org_id', '=', 'c.org_id').onRef('o.id', '=', 'c.opening_id'))
      .leftJoin('crove_kernel.calendar_event as e', (join) =>
        join.onRef('e.org_id', '=', 'c.org_id').onRef('e.id', '=', 'c.interview_event_id').on('e.status', '=', 'active'),
      )
      .select([
        'c.id',
        'c.legal_entity_id',
        'c.opening_id',
        'o.title as opening_title',
        'o.department_id as opening_department_id',
        'o.department_name as opening_department_name',
        'c.display_name',
        'c.email',
        'c.phone',
        'c.stage',
        'c.years_experience',
        'c.matched_skills',
        'c.expected_wage',
        'c.agreed_wage',
        'c.planned_start_on',
        'c.notes',
        'e.id as active_interview_event_id',
        'c.interview_starts_at',
        'c.interview_ends_at',
        'c.hired_employee_id',
        'c.erased_at',
        'c.created_at',
        'c.updated_at',
      ])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.candidateId)
      .executeTakeFirst();
    if (!row) throw candidateNotFound();
    return toCandidateView(row);
  },
});

export const interviewSlotsQuery = defineQuery({
  name: 'hr.recruiting.interview_slots',
  input: zHrInterviewSlotsAsk,
  access: MANAGERS,
  handler: async (ctx, input): Promise<HrInterviewSlotsResult> => {
    const userId = userOf(ctx.actor);
    const nowMs = Date.now();
    const fromMs = input.from ? Date.parse(input.from) : nowMs;
    const toMs = input.to ? Date.parse(input.to) : fromMs + 14 * DAY_MS;
    if (toMs <= fromMs || toMs - fromMs > 31 * DAY_MS) {
      throw new DomainError('VALIDATION', 422, 'Khoảng tìm lịch phỏng vấn tối đa 31 ngày');
    }
    const { hours, saved } = await workingHoursOf(ctx, userId);
    const busy = await busyOf(ctx, userId, new Date(fromMs - DAY_MS), new Date(toMs + DAY_MS), input.exceptEventId);
    const workingWindows = workingWindowsInRange(hours, fromMs, toMs);
    const busyIntervals: InterviewInterval[] = busy.map((b) => ({
      startIso: new Date(b.start).toISOString(),
      endIso: new Date(b.end).toISOString(),
    }));
    const slots = rankInterviewSlots({
      workingWindows,
      busyIntervals,
      durationMinutes: input.durationMinutes,
      maxSlots: input.maxSlots,
      minGapMinutes: input.minGapMinutes,
      ...(input.stepMinutes === undefined ? {} : { stepMinutes: input.stepMinutes }),
      afterIso: new Date(Math.max(fromMs, nowMs)).toISOString(),
    });
    return {
      timeZone: hours.timeZone,
      hoursSaved: saved,
      slots,
    };
  },
});

// Audited sensitive read for recruiting coworker Ly: loads pseudonymized inputs + forbidden candidate PII.
export const recruitingBriefRead = defineQuery({
  name: 'hr.recruiting.brief.read',
  input: zHrRecruitingBriefAsk,
  access: MANAGERS,
  sensitive: true,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  auditDetail: (input) => ({ lang: input.lang }),
  handler: async (ctx, input): Promise<HrRecruitingBriefSnapshot> => {
    const row = await ctx.trx
      .selectFrom('crove_hr.candidate as c')
      .leftJoin('crove_hr.job_opening as o', (join) => join.onRef('o.org_id', '=', 'c.org_id').onRef('o.id', '=', 'c.opening_id'))
      .leftJoin('crove_kernel.calendar_event as e', (join) =>
        join.onRef('e.org_id', '=', 'c.org_id').onRef('e.id', '=', 'c.interview_event_id').on('e.status', '=', 'active'),
      )
      .select([
        'c.id',
        'c.display_name',
        'c.email',
        'c.phone',
        'c.stage',
        'c.years_experience',
        'c.matched_skills',
        'c.expected_wage',
        'c.agreed_wage',
        'c.planned_start_on',
        'c.notes',
        'e.id as active_interview_event_id',
        'c.erased_at',
        'o.title as opening_title',
        'o.department_name as opening_department_name',
        'o.required_skills as opening_required_skills',
        'o.budget_min_wage as opening_budget_min_wage',
        'o.budget_max_wage as opening_budget_max_wage',
      ])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.candidateId)
      .executeTakeFirst();
    if (!row) throw candidateNotFound();
    if (row.erased_at !== null) throw candidateErased();

    const requiredSkills = row.opening_required_skills ?? [];
    const matchedSkills = row.matched_skills ?? [];
    const matchedLower = new Set(matchedSkills.map((s) => s.trim().toLowerCase()));
    const missingSkills = requiredSkills.filter((s) => !matchedLower.has(s.trim().toLowerCase()));

    const forbiddenSet = new Set<string>();
    const addForbidden = (v: string | null | undefined) => {
      const trimmed = v?.trim();
      if (trimmed) forbiddenSet.add(trimmed);
    };
    addForbidden(row.display_name);
    const nameParts = row.display_name.trim().split(/\s+/).filter(Boolean);
    if (nameParts.length >= 3) {
      const given = nameParts.slice(1).join(' ');
      if (given.length >= 4) forbiddenSet.add(given);
    }
    addForbidden(row.email);
    addForbidden(row.phone);
    if (row.email) {
      const localPart = row.email.split('@')[0]?.trim();
      if (localPart && localPart.length >= 3) forbiddenSet.add(localPart);
    }

    const notes = row.notes && row.notes.trim() !== '' ? [row.notes.trim()] : [];
    return {
      candidateId: row.id,
      input: {
        language: input.lang,
        openingTitle: row.opening_title ?? (input.lang === 'vi' ? 'Tuyển dụng nhân sự' : 'Open role'),
        departmentName: row.opening_department_name ?? null,
        stage: row.stage,
        yearsExperience: row.years_experience,
        matchedSkills,
        missingSkills,
        skillsRequiredCount: requiredSkills.length,
        expectedWage: row.expected_wage,
        budgetMinWage: row.opening_budget_min_wage ?? null,
        budgetMaxWage: row.opening_budget_max_wage ?? null,
        agreedWage: row.agreed_wage,
        startDate: isoDateNullable(row.planned_start_on),
        hasScheduledInterview: row.active_interview_event_id !== null,
        notes,
      },
      forbidden: [...forbiddenSet],
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

export const openingAdd = defineCommand({
  name: 'hr.recruiting.opening.add',
  input: zHrOpeningAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'job_opening', OPENING_INSERT_COLUMNS)],
  handler: async (ctx, input): Promise<HrOpeningWritten> => {
    const userId = userOf(ctx.actor);
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    const dept = input.departmentId ? await resolveDepartment(ctx, input.departmentId, legalEntityId) : null;
    const minWage = input.budgetMinWage ?? null;
    const maxWage = input.budgetMaxWage ?? null;
    assertBudgetOrder(minWage, maxWage);
    const skills = normalizeSkills(input.requiredSkills);
    const payFunction = input.payFunction ?? dept?.payFunction ?? 'admin';
    const departmentName = input.departmentName !== undefined ? input.departmentName : (dept?.name ?? null);
    const row = await ctx.trx
      .insertInto('crove_hr.job_opening')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        department_id: dept?.id ?? null,
        title: input.title,
        department_name: departmentName,
        contract_type: input.contractType,
        region: input.region,
        pay_function: payFunction,
        budget_min_wage: minWage,
        budget_max_wage: maxWage,
        required_skills: skills,
        status: 'open',
        closed_at: null,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'legal_entity_id', 'status'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      openingId: row.id,
      legalEntityId: row.legal_entity_id,
      departmentId: dept?.id ?? null,
      contractType: input.contractType,
      region: input.region,
      payFunction,
      skillsCount: skills.length,
      hasBudget: minWage !== null || maxWage !== null,
    });
    return {
      openingId: row.id,
      legalEntityId: row.legal_entity_id,
      status: row.status as HrJobOpeningStatus,
    };
  },
});

export const openingEdit = defineCommand({
  name: 'hr.recruiting.opening.edit',
  input: zHrOpeningEdit,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.job_opening', id: input.openingId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'job_opening', OPENING_EDIT_COLUMNS)],
  handler: async (ctx, input): Promise<HrOpeningWritten> => {
    const existing = await lockOpening(ctx, input.openingId);
    const nextMin = input.budgetMinWage !== undefined ? input.budgetMinWage : existing.budget_min_wage;
    const nextMax = input.budgetMaxWage !== undefined ? input.budgetMaxWage : existing.budget_max_wage;
    assertBudgetOrder(nextMin, nextMax);

    const set: Partial<{
      department_id: string | null;
      title: string;
      department_name: string | null;
      contract_type: HrContractType;
      region: HrRegion;
      pay_function: HrPayFunction;
      budget_min_wage: string | null;
      budget_max_wage: string | null;
      required_skills: string[];
      updated_at: Date;
    }> = {};
    const changed: string[] = [];

    if (input.departmentId !== undefined) {
      if (input.departmentId === null) {
        set.department_id = null;
      } else {
        const dept = await resolveDepartment(ctx, input.departmentId, existing.legal_entity_id, existing.department_id);
        set.department_id = dept.id;
        if (input.departmentName === undefined && existing.department_name === null) {
          set.department_name = dept.name;
          changed.push('departmentName');
        }
      }
      changed.push('departmentId');
    }
    if (input.title !== undefined) {
      set.title = input.title;
      changed.push('title');
    }
    if (input.departmentName !== undefined) {
      set.department_name = input.departmentName;
      changed.push('departmentName');
    }
    if (input.contractType !== undefined) {
      set.contract_type = input.contractType;
      changed.push('contractType');
    }
    if (input.region !== undefined) {
      set.region = input.region;
      changed.push('region');
    }
    if (input.payFunction !== undefined) {
      set.pay_function = input.payFunction;
      changed.push('payFunction');
    }
    if (input.budgetMinWage !== undefined) {
      set.budget_min_wage = input.budgetMinWage;
      changed.push('budgetMinWage');
    }
    if (input.budgetMaxWage !== undefined) {
      set.budget_max_wage = input.budgetMaxWage;
      changed.push('budgetMaxWage');
    }
    if (input.requiredSkills !== undefined) {
      set.required_skills = normalizeSkills(input.requiredSkills);
      changed.push('requiredSkills');
    }

    if (changed.length > 0) {
      set.updated_at = ctx.now;
      await ctx.trx.updateTable('crove_hr.job_opening').set(set).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
    }
    ctx.audit({ openingId: existing.id, legalEntityId: existing.legal_entity_id, changed });
    return {
      openingId: existing.id,
      legalEntityId: existing.legal_entity_id,
      status: existing.status as HrJobOpeningStatus,
    };
  },
});

export const openingClose = defineCommand({
  name: 'hr.recruiting.opening.close',
  input: zHrOpeningClose,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.job_opening', id: input.openingId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'job_opening', ['status', 'closed_at', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOpeningWritten> => {
    const existing = await lockOpening(ctx, input.openingId);
    const nextStatus: HrJobOpeningStatus = input.reopen ? 'open' : 'closed';
    const closedAt = input.reopen ? null : (existing.closed_at ?? ctx.now);
    await ctx.trx
      .updateTable('crove_hr.job_opening')
      .set({ status: nextStatus, closed_at: closedAt, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();
    ctx.audit({ openingId: existing.id, legalEntityId: existing.legal_entity_id, status: nextStatus, reopened: input.reopen });
    return { openingId: existing.id, legalEntityId: existing.legal_entity_id, status: nextStatus };
  },
});

export const candidateAdd = defineCommand({
  name: 'hr.recruiting.candidate.add',
  input: zHrCandidateAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'candidate', CANDIDATE_INSERT_COLUMNS)],
  handler: async (ctx, input): Promise<HrCandidateWritten> => {
    const userId = userOf(ctx.actor);
    let legalEntityId: string;
    if (input.openingId) {
      const opening = await loadOpeningForCandidate(ctx, input.openingId, input.legalEntityId);
      legalEntityId = opening.legal_entity_id;
    } else {
      legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    }
    const skills = normalizeSkills(input.matchedSkills);
    const row = await ctx.trx
      .insertInto('crove_hr.candidate')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        opening_id: input.openingId ?? null,
        display_name: input.displayName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        stage: 'applied',
        years_experience: input.yearsExperience ?? null,
        matched_skills: skills,
        expected_wage: input.expectedWage ?? null,
        agreed_wage: input.agreedWage ?? null,
        planned_start_on: input.plannedStartOn ?? null,
        notes: input.notes ?? null,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'legal_entity_id', 'stage'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      candidateId: row.id,
      legalEntityId: row.legal_entity_id,
      openingId: input.openingId ?? null,
      email: auditValue(CANDIDATE, 'email', input.email ?? null),
      phone: auditValue(CANDIDATE, 'phone', input.phone ?? null),
      skillsCount: skills.length,
    });
    return { candidateId: row.id, legalEntityId: row.legal_entity_id, stage: row.stage };
  },
});

export const candidateEdit = defineCommand({
  name: 'hr.recruiting.candidate.edit',
  input: zHrCandidateEdit,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'candidate', CANDIDATE_EDIT_COLUMNS)],
  handler: async (ctx, input): Promise<HrCandidateWritten> => {
    const existing = await lockCandidate(ctx, input.candidateId);
    if (existing.erased_at !== null) throw candidateErased();
    if (existing.stage === 'hired') {
      throw new DomainError('HR_CANDIDATE_HIRED', 409, 'Ứng viên đã nhận việc; hãy cập nhật hồ sơ bên Nhân viên');
    }

    const set: Partial<{
      opening_id: string | null;
      display_name: string;
      email: string | null;
      phone: string | null;
      years_experience: number | null;
      matched_skills: string[];
      expected_wage: string | null;
      agreed_wage: string | null;
      planned_start_on: string | null;
      notes: string | null;
      updated_at: Date;
    }> = {};
    const changed: string[] = [];

    if (input.openingId !== undefined) {
      if (input.openingId !== null) {
        await loadOpeningForCandidate(ctx, input.openingId, existing.legal_entity_id, existing.opening_id === input.openingId);
      }
      set.opening_id = input.openingId;
      changed.push('openingId');
    }
    if (input.displayName !== undefined) {
      set.display_name = input.displayName;
      changed.push('displayName');
    }
    if (input.email !== undefined) {
      set.email = input.email;
      changed.push('email');
    }
    if (input.phone !== undefined) {
      set.phone = input.phone;
      changed.push('phone');
    }
    if (input.yearsExperience !== undefined) {
      set.years_experience = input.yearsExperience;
      changed.push('yearsExperience');
    }
    if (input.matchedSkills !== undefined) {
      set.matched_skills = normalizeSkills(input.matchedSkills);
      changed.push('matchedSkills');
    }
    if (input.expectedWage !== undefined) {
      set.expected_wage = input.expectedWage;
      changed.push('expectedWage');
    }
    if (input.agreedWage !== undefined) {
      set.agreed_wage = input.agreedWage;
      changed.push('agreedWage');
    }
    if (input.plannedStartOn !== undefined) {
      set.planned_start_on = input.plannedStartOn;
      changed.push('plannedStartOn');
    }
    if (input.notes !== undefined) {
      set.notes = input.notes;
      changed.push('notes');
    }

    if (changed.length > 0) {
      set.updated_at = ctx.now;
      await ctx.trx.updateTable('crove_hr.candidate').set(set).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
    }
    ctx.audit({ candidateId: existing.id, legalEntityId: existing.legal_entity_id, changed });
    return { candidateId: existing.id, legalEntityId: existing.legal_entity_id, stage: existing.stage };
  },
});

export const candidateMoveStage = defineCommand({
  name: 'hr.recruiting.candidate.move_stage',
  input: zHrCandidateMoveStage,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'candidate', ['stage', 'agreed_wage', 'planned_start_on', 'updated_at'])],
  handler: async (ctx, input): Promise<HrCandidateWritten> => {
    const existing = await lockCandidate(ctx, input.candidateId);
    if (existing.erased_at !== null) throw candidateErased();
    const nextAgreedWage = input.agreedWage !== undefined ? input.agreedWage : existing.agreed_wage;
    const nextPlannedStart = input.plannedStartOn !== undefined ? input.plannedStartOn : isoDateNullable(existing.planned_start_on);
    const transition = checkCandidateTransition({
      from: existing.stage,
      to: input.toStage,
      hasScheduledInterview: await hasActiveInterview(ctx, existing.interview_event_id),
      agreedWage: nextAgreedWage,
      startDate: nextPlannedStart,
      allowReopen: input.allowReopen,
    });
    if (!transition.allowed) {
      throw new DomainError('HR_RECRUITING_TRANSITION_REFUSED', 422, transition.errors[0]?.messageVi ?? 'Không thể chuyển giai đoạn tuyển dụng');
    }
    await ctx.trx
      .updateTable('crove_hr.candidate')
      .set({
        stage: input.toStage,
        ...(input.agreedWage !== undefined ? { agreed_wage: input.agreedWage } : {}),
        ...(input.plannedStartOn !== undefined ? { planned_start_on: input.plannedStartOn } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();
    ctx.audit({
      candidateId: existing.id,
      legalEntityId: existing.legal_entity_id,
      fromStage: existing.stage,
      toStage: input.toStage,
      warnings: transition.warningCodes,
    });
    return { candidateId: existing.id, legalEntityId: existing.legal_entity_id, stage: input.toStage };
  },
});

export const candidateScheduleInterview = defineCommand({
  name: 'hr.recruiting.candidate.schedule_interview',
  input: zHrCandidateScheduleInterview,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [
    tableWrite(kernelManifest.tables, 'crove_kernel', 'calendar_event', CALENDAR_EVENT_COLUMNS),
    tableWrite(hrManifest.tables, 'crove_hr', 'candidate', ['interview_event_id', 'interview_starts_at', 'interview_ends_at', 'stage', 'updated_at']),
  ],
  handler: async (ctx, input): Promise<HrCandidateInterviewScheduled> => {
    const userId = userOf(ctx.actor);
    const startMs = Date.parse(input.startsAt);
    const endMs = Date.parse(input.endsAt);
    const durationMin = (endMs - startMs) / 60_000;
    if (
      !Number.isFinite(durationMin) ||
      durationMin < INTERVIEW_DURATION_MIN_MINUTES ||
      durationMin > INTERVIEW_DURATION_MAX_MINUTES
    ) {
      throw new DomainError(
        'HR_INTERVIEW_DURATION_INVALID',
        422,
        `Thời lượng phỏng vấn từ ${INTERVIEW_DURATION_MIN_MINUTES} đến ${INTERVIEW_DURATION_MAX_MINUTES} phút`,
      );
    }

    const existing = await lockCandidate(ctx, input.candidateId);
    if (existing.erased_at !== null) throw candidateErased();
    if (existing.stage === 'hired' || existing.stage === 'rejected') {
      throw new DomainError('HR_CANDIDATE_STAGE_FINAL', 409, 'Không thể đặt lịch phỏng vấn cho ứng viên đã nhận việc hoặc đã từ chối');
    }

    // Serialize concurrent HR interview bookings on this interviewer's calendar inside this org (modules stay isolated per ADR-0031).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_hr.interview:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);

    let prevEvent: { id: string; user_id: string; kind: string; status: string } | undefined;
    if (existing.interview_event_id) {
      prevEvent = await ctx.trx
        .selectFrom('crove_kernel.calendar_event')
        .select(['id', 'user_id', 'kind', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.interview_event_id)
        .forUpdate()
        .executeTakeFirst();
    }

    const startsAt = new Date(startMs);
    const endsAt = new Date(endMs);
    const exceptEventId = prevEvent && prevEvent.user_id === userId ? prevEvent.id : undefined;
    const { hours } = await workingHoursOf(ctx, userId);
    const busy = await busyOf(ctx, userId, startsAt, endsAt, exceptEventId);
    if (busy.some((b) => b.start < endMs && b.end > startMs)) {
      throw new DomainError('HR_INTERVIEW_SLOT_TAKEN', 409, 'Khung giờ này đã có lịch bận, hãy chọn giờ khác');
    }

    if (prevEvent && prevEvent.kind === 'manual' && prevEvent.status === 'active') {
      await ctx.trx
        .updateTable('crove_kernel.calendar_event')
        .set({ status: 'cancelled', cancelled_by: userId, cancelled_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', prevEvent.id)
        .execute();
    }

    let openingTitle: string | null = null;
    if (existing.opening_id) {
      const opening = await ctx.trx
        .selectFrom('crove_hr.job_opening')
        .select('title')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.opening_id)
        .executeTakeFirst();
      openingTitle = opening?.title ?? null;
    }
    // Role-only calendar event title: never copy candidate PII into calendar_event.
    const calendarTitle = (openingTitle ? `Phỏng vấn: ${openingTitle}` : 'Phỏng vấn tuyển dụng').slice(0, 200);

    let eventId: string;
    try {
      const created = await ctx.trx
        .insertInto('crove_kernel.calendar_event')
        .values({
          org_id: ctx.orgId,
          user_id: userId,
          starts_at: startsAt,
          ends_at: endsAt,
          time_zone: hours.timeZone,
          title: calendarTitle,
          kind: 'manual',
          created_by: userId,
          created_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      eventId = created.id;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === '23P01') {
        throw new DomainError('HR_INTERVIEW_SLOT_TAKEN', 409, 'Khung giờ này đã có lịch bận, hãy chọn giờ khác');
      }
      throw error;
    }

    const nextStage: HrCandidateStage = existing.stage === 'applied' || existing.stage === 'screening' ? 'interview' : existing.stage;
    await ctx.trx
      .updateTable('crove_hr.candidate')
      .set({
        interview_event_id: eventId,
        interview_starts_at: startsAt,
        interview_ends_at: endsAt,
        stage: nextStage,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      candidateId: existing.id,
      legalEntityId: existing.legal_entity_id,
      eventId,
      fromStage: existing.stage,
      toStage: nextStage,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    return {
      candidateId: existing.id,
      eventId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      stage: nextStage,
    };
  },
});

export const candidateHire = defineCommand({
  name: 'hr.recruiting.candidate.hire',
  input: zHrCandidateHire,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', CANDIDATE_HIRE_EMPLOYEE_COLUMNS),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employment', EMPLOYMENT_COLUMNS),
    tableWrite(hrManifest.tables, 'crove_hr', 'candidate', ['stage', 'agreed_wage', 'planned_start_on', 'hired_employee_id', 'updated_at']),
  ],
  handler: async (ctx, input): Promise<HrCandidateHireResult> => {
    const userId = userOf(ctx.actor);
    const existing = await lockCandidate(ctx, input.candidateId);
    if (existing.erased_at !== null) throw candidateErased();
    if (existing.stage === 'hired' || existing.hired_employee_id !== null) {
      throw new DomainError('HR_CANDIDATE_ALREADY_HIRED', 409, 'Ứng viên này đã được nhận việc rồi');
    }

    const opening = existing.opening_id
      ? await ctx.trx
          .selectFrom('crove_hr.job_opening')
          .select(['id', 'department_id', 'title', 'contract_type', 'region', 'pay_function'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.opening_id)
          .forShare()
          .executeTakeFirst()
      : undefined;

    const effectiveFrom = input.effectiveFrom ?? isoDateNullable(existing.planned_start_on);
    const baseWage = input.baseWage ?? existing.agreed_wage;
    const transition = checkCandidateTransition({
      from: existing.stage,
      to: 'hired',
      hasScheduledInterview: await hasActiveInterview(ctx, existing.interview_event_id),
      agreedWage: baseWage,
      startDate: effectiveFrom,
      allowDirectHire: input.allowDirectHire,
    });
    if (!transition.allowed || effectiveFrom === null || baseWage === null) {
      throw new DomainError('HR_RECRUITING_TRANSITION_REFUSED', 422, transition.errors[0]?.messageVi ?? 'Cần đủ mức lương thỏa thuận và ngày bắt đầu trước khi nhận việc');
    }

    const resolvedDepartmentId = input.departmentId !== undefined ? input.departmentId : (opening?.department_id ?? null);
    const dept = resolvedDepartmentId ? await resolveDepartment(ctx, resolvedDepartmentId, existing.legal_entity_id) : null;
    const defaultPayFunction: HrPayFunction = dept?.payFunction ?? (opening?.pay_function as HrPayFunction | undefined) ?? 'admin';
    const contractType = input.contractType ?? (opening?.contract_type as HrContractType | undefined) ?? 'indefinite';
    const region = input.region ?? (opening?.region as HrRegion | undefined) ?? 'I';
    const payFunction = input.payFunction ?? defaultPayFunction;
    const jobTitle = input.jobTitle !== undefined ? input.jobTitle : (opening?.title ?? null);

    if (
      contractType === 'fixed_term' &&
      (input.termMonths === undefined || input.termMonths === null) &&
      (input.contractEndOn === undefined || input.contractEndOn === null)
    ) {
      throw new DomainError(
        'HR_CONTRACT_INVALID',
        422,
        'Hợp đồng xác định thời hạn cần nhập thời hạn (tháng) hoặc ngày hết hạn hợp đồng',
      );
    }

    const prepared = prepareEmploymentTerms(
      {
        effectiveFrom,
        contractType,
        region,
        baseWage,
        payFunction,
        contractForm: input.contractForm,
        termMonths: input.termMonths,
        contractEndOn: input.contractEndOn,
        fixedTermSequence: input.fixedTermSequence,
        probationRoleTier: input.probationRoleTier,
        probationEndOn: input.probationEndOn,
        probationWage: input.probationWage,
      },
      payFunction,
    );

    const employee = await ctx.trx
      .insertInto('crove_hr.payroll_employee')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: existing.legal_entity_id,
        department_id: dept?.id ?? null,
        job_title: jobTitle,
        display_name: existing.display_name,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const employment = await ctx.trx
      .insertInto('crove_hr.payroll_employment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: existing.legal_entity_id,
        employee_id: employee.id,
        ...prepared,
        created_by: userId,
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await ctx.trx
      .updateTable('crove_hr.candidate')
      .set({
        stage: 'hired',
        agreed_wage: prepared.base_wage,
        planned_start_on: prepared.effective_from,
        hired_employee_id: employee.id,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      candidateId: existing.id,
      employeeId: employee.id,
      employmentId: employment.id,
      legalEntityId: existing.legal_entity_id,
      departmentId: dept?.id ?? null,
      hasJobTitle: jobTitle !== null,
      stage: 'hired',
      effectiveFrom: prepared.effective_from,
      contractType: prepared.contract_type,
      region: prepared.region,
      payFunction: prepared.pay_function,
      baseWage: auditValue(EMPLOYMENT, 'base_wage', prepared.base_wage),
    });

    return {
      candidateId: existing.id,
      employeeId: employee.id,
      employmentId: employment.id,
      legalEntityId: existing.legal_entity_id,
      stage: 'hired',
    };
  },
});

export const candidateErase = defineCommand({
  name: 'hr.recruiting.candidate.erase',
  input: zHrCandidateRef,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: OWNERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'candidate', ['display_name', 'email', 'phone', 'notes', 'erased_at', 'updated_at'])],
  handler: async (ctx, input): Promise<HrCandidateEraseResult> => {
    const existing = await lockCandidate(ctx, input.candidateId);
    if (existing.erased_at !== null) throw candidateErased();
    if (existing.stage !== 'hired' && existing.stage !== 'rejected') {
      throw new DomainError('HR_CANDIDATE_STILL_IN_PIPELINE', 409, 'Chỉ xóa dữ liệu ứng viên sau khi đã nhận việc hoặc đã từ chối');
    }
    await ctx.trx
      .updateTable('crove_hr.candidate')
      .set({
        display_name: HR_ERASED_NAME,
        email: null,
        phone: null,
        notes: null,
        erased_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();
    ctx.audit({
      candidateId: existing.id,
      legalEntityId: existing.legal_entity_id,
      stage: existing.stage,
      erasedAt: ctx.now.toISOString(),
      cleared: ['displayName', 'email', 'phone', 'notes'],
    });
    return { candidateId: existing.id, erasedAt: ctx.now.toISOString() };
  },
});

export const recruitingBriefAudit = defineCommand({
  name: 'hr.recruiting.brief.audit',
  input: zHrRecruitingBriefAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({ candidateId: input.candidateId, aiReason: input.aiReason });
    return { ok: true };
  },
});

export const hrRecruitingCommands = [
  openingAdd,
  openingEdit,
  openingClose,
  candidateAdd,
  candidateEdit,
  candidateMoveStage,
  candidateScheduleInterview,
  candidateHire,
  candidateErase,
  recruitingBriefAudit,
];

export const hrRecruitingQueries = [
  openingList,
  candidateList,
  candidateGet,
  interviewSlotsQuery,
  recruitingBriefRead,
];
