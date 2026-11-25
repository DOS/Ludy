// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic recruiting funnel BI query (#4446 Stage 5D): pure SQL aggregation per legal_entity_id
// with stage counts, conversion/drop-off %, SQL average/median time-to-hire, and acquisition source metrics.
// Zero LLM cost; erased candidates (erased_at IS NOT NULL) are excluded and never unmasked.
import { sql } from 'kysely';
import {
  HR_CANDIDATE_SOURCES,
  HR_CANDIDATE_STAGES,
  type HrCandidateSource,
  type HrCandidateStage,
  type HrRecruitingAnalyticsResult,
  type HrRecruitingConversionStep,
  type HrRecruitingSourceMetric,
  type HrRecruitingStageMetric,
  zHrRecruitingAnalyticsQuery,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { Decimal } from '@ludy/l10n-vn';
import { MANAGERS, resolveEntity } from './employees.ts';
import { openingNotFound } from './recruiting.ts';

const DAY_MS = 86_400_000;

function pctString(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0.0';
  return new Decimal(numerator).mul(100).div(denominator).toDecimalPlaces(1).toFixed(1);
}

function nullablePctString(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  return new Decimal(numerator).mul(100).div(denominator).toDecimalPlaces(1).toFixed(1);
}

function vnDayStart(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00.000+07:00`);
}

export const recruitingAnalyticsQuery = defineQuery({
  name: 'hr.recruiting.analytics',
  input: zHrRecruitingAnalyticsQuery,
  access: MANAGERS,
  handler: async (ctx, input): Promise<HrRecruitingAnalyticsResult> => {
    let targetEntityId = input.legalEntityId;
    if (input.openingId !== undefined) {
      const opening = await ctx.trx
        .selectFrom('ludy_hr.job_opening')
        .select(['id', 'legal_entity_id'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.openingId)
        .executeTakeFirst();
      if (!opening) throw openingNotFound();
      if (targetEntityId !== undefined && opening.legal_entity_id !== targetEntityId) {
        throw new DomainError('HR_CANDIDATE_WRONG_ENTITY', 422, 'Vị trí tuyển dụng không thuộc pháp nhân đã chọn');
      }
      targetEntityId = opening.legal_entity_id;
    }
    const legalEntityId = await resolveEntity(ctx, targetEntityId);

    if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
      throw new DomainError('VALIDATION', 422, 'Ngày bắt đầu không được sau ngày kết thúc');
    }

    const fromTs = input.from ? vnDayStart(input.from) : null;
    const toExclusiveTs = input.to ? new Date(vnDayStart(input.to).getTime() + DAY_MS) : null;

    const commonFilters = (erasedOnly: boolean) =>
      sql`
        c.org_id = ${ctx.orgId}::uuid
        AND c.legal_entity_id = ${legalEntityId}::uuid
        AND ${erasedOnly ? sql`c.erased_at IS NOT NULL` : sql`c.erased_at IS NULL`}
        ${input.openingId !== undefined ? sql`AND c.opening_id = ${input.openingId}::uuid` : sql``}
        ${fromTs !== null ? sql`AND c.created_at >= ${fromTs}::timestamptz` : sql``}
        ${toExclusiveTs !== null ? sql`AND c.created_at < ${toExclusiveTs}::timestamptz` : sql``}
      `;

    const erasedRes = await sql<{ count: number }>`
      SELECT pg_catalog.count(*)::int AS count
      FROM ludy_hr.candidate c
      WHERE ${commonFilters(true)}
    `.execute(ctx.trx);
    const erasedExcludedCount = Number(erasedRes.rows[0]?.count ?? 0);

    const stageRowsRes = await sql<{ stage: string; count: number }>`
      SELECT c.stage, pg_catalog.count(*)::int AS count
      FROM ludy_hr.candidate c
      WHERE ${commonFilters(false)}
      GROUP BY c.stage
    `.execute(ctx.trx);

    const stageCountMap = new Map<HrCandidateStage, number>();
    for (const s of HR_CANDIDATE_STAGES) stageCountMap.set(s, 0);
    for (const row of stageRowsRes.rows) {
      const stage = row.stage as HrCandidateStage;
      if (stageCountMap.has(stage)) {
        stageCountMap.set(stage, Number(row.count));
      }
    }

    const appliedCount = stageCountMap.get('applied') ?? 0;
    const screeningCount = stageCountMap.get('screening') ?? 0;
    const interviewCount = stageCountMap.get('interview') ?? 0;
    const offerCount = stageCountMap.get('offer') ?? 0;
    const hiredCount = stageCountMap.get('hired') ?? 0;
    const rejectedCount = stageCountMap.get('rejected') ?? 0;
    const activeCandidates = appliedCount + screeningCount + interviewCount + offerCount;
    const totalCandidates = activeCandidates + hiredCount + rejectedCount;

    const stages: HrRecruitingStageMetric[] = HR_CANDIDATE_STAGES.map((stage) => {
      const count = stageCountMap.get(stage) ?? 0;
      return {
        stage,
        count,
        sharePct: pctString(count, totalCandidates),
      };
    });

    const funnelStepsRes = await sql<{
      from_stage: string;
      to_stage: string;
      entered_count: number;
      reached_count: number;
    }>`
      WITH cohort AS (
        SELECT c.org_id, c.legal_entity_id, c.id
        FROM ludy_hr.candidate c
        WHERE ${commonFilters(false)}
      ),
      steps(ord, from_stage, to_stage) AS (
        VALUES
          (1, 'applied'::text, 'screening'::text),
          (2, 'screening'::text, 'interview'::text),
          (3, 'interview'::text, 'offer'::text),
          (4, 'offer'::text, 'hired'::text)
      )
      SELECT
        s.from_stage,
        s.to_stage,
        pg_catalog.count(DISTINCT t_from.candidate_id)::int AS entered_count,
        pg_catalog.count(DISTINCT CASE WHEN EXISTS (
          SELECT 1
          FROM ludy_hr.candidate_stage_transition t_to
          WHERE t_to.org_id = t_from.org_id
            AND t_to.legal_entity_id = t_from.legal_entity_id
            AND t_to.candidate_id = t_from.candidate_id
            AND t_to.to_stage = s.to_stage
            AND (t_to.occurred_at, t_to.seq) > (t_from.occurred_at, t_from.seq)
        ) THEN t_from.candidate_id END)::int AS reached_count
      FROM steps s
      LEFT JOIN cohort c ON true
      LEFT JOIN ludy_hr.candidate_stage_transition t_from
        ON t_from.org_id = c.org_id
       AND t_from.legal_entity_id = c.legal_entity_id
       AND t_from.candidate_id = c.id
       AND t_from.to_stage = s.from_stage
      GROUP BY s.ord, s.from_stage, s.to_stage
      ORDER BY s.ord
    `.execute(ctx.trx);

    const step = (
      fromStage: HrRecruitingConversionStep['fromStage'],
      toStage: HrRecruitingConversionStep['toStage'],
      enteredFromCount: number,
      reachedToCount: number,
    ): HrRecruitingConversionStep => {
      const conversionPct = nullablePctString(reachedToCount, enteredFromCount);
      const dropOffPct =
        conversionPct === null
          ? null
          : new Decimal(100).minus(new Decimal(conversionPct)).toDecimalPlaces(1).toFixed(1);
      return {
        fromStage,
        toStage,
        enteredFromCount,
        reachedToCount,
        conversionPct,
        dropOffPct,
      };
    };

    const funnel: HrRecruitingConversionStep[] = funnelStepsRes.rows.map((row) =>
      step(
        row.from_stage as HrRecruitingConversionStep['fromStage'],
        row.to_stage as HrRecruitingConversionStep['toStage'],
        Number(row.entered_count),
        Number(row.reached_count),
      ),
    );

    const tthRes = await sql<{ sample_size: number; avg_days: string | null; median_days: string | null }>`
      SELECT
        pg_catalog.count(*)::int AS sample_size,
        pg_catalog.round(
          (pg_catalog.avg(EXTRACT(EPOCH FROM (c.hired_at - c.created_at)) / 86400.0))::numeric,
          1
        )::text AS avg_days,
        pg_catalog.round(
          (
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (c.hired_at - c.created_at)) / 86400.0
            )
          )::numeric,
          1
        )::text AS median_days
      FROM ludy_hr.candidate c
      WHERE ${commonFilters(false)}
        AND c.stage = 'hired'
        AND c.hired_at IS NOT NULL
        AND c.hired_at >= c.created_at
    `.execute(ctx.trx);

    const tthRow = tthRes.rows[0];

    const sourceRowsRes = await sql<{
      source: string;
      total_count: number;
      active_count: number;
      hired_count: number;
      rejected_count: number;
      avg_time_to_hire_days: string | null;
    }>`
      SELECT
        c.source,
        pg_catalog.count(*)::int AS total_count,
        pg_catalog.count(*) FILTER (WHERE c.stage IN ('applied', 'screening', 'interview', 'offer'))::int AS active_count,
        pg_catalog.count(*) FILTER (WHERE c.stage = 'hired')::int AS hired_count,
        pg_catalog.count(*) FILTER (WHERE c.stage = 'rejected')::int AS rejected_count,
        pg_catalog.round(
          (
            pg_catalog.avg(EXTRACT(EPOCH FROM (c.hired_at - c.created_at)) / 86400.0)
              FILTER (WHERE c.stage = 'hired' AND c.hired_at IS NOT NULL AND c.hired_at >= c.created_at)
          )::numeric,
          1
        )::text AS avg_time_to_hire_days
      FROM ludy_hr.candidate c
      WHERE ${commonFilters(false)}
      GROUP BY c.source
    `.execute(ctx.trx);

    const sourceMap = new Map<HrCandidateSource, (typeof sourceRowsRes.rows)[number]>();
    for (const row of sourceRowsRes.rows) {
      sourceMap.set(row.source as HrCandidateSource, row);
    }

    const sources: HrRecruitingSourceMetric[] = HR_CANDIDATE_SOURCES.map((source) => {
      const row = sourceMap.get(source);
      const total = Number(row?.total_count ?? 0);
      const active = Number(row?.active_count ?? 0);
      const hired = Number(row?.hired_count ?? 0);
      const rejected = Number(row?.rejected_count ?? 0);
      return {
        source,
        totalCount: total,
        activeCount: active,
        hiredCount: hired,
        rejectedCount: rejected,
        hireRatePct: nullablePctString(hired, total),
        avgTimeToHireDays: row?.avg_time_to_hire_days ?? null,
      };
    });

    return {
      legalEntityId,
      openingId: input.openingId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      llmCost: 0,
      totalCandidates,
      activeCandidates,
      hiredCount,
      rejectedCount,
      erasedExcludedCount,
      timeToHire: {
        sampleSize: Number(tthRow?.sample_size ?? 0),
        avgDays: tthRow?.avg_days ?? null,
        medianDays: tthRow?.median_days ?? null,
      },
      stages,
      funnel,
      sources,
    };
  },
});

export const hrRecruitingAnalyticsQueries = [recruitingAnalyticsQuery];
