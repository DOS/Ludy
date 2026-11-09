-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2532, docs/plan/payroll.md 6.4 and 6.6): the totals of an approved pay run now cover its adjustment lines. A correction of an approved month is a signed line of a later run (kind
-- `adjustment`), which now carries the cost department of the line it corrects (its employment) and a per-fund split of its insurance (the same breakdown a pay line holds), so it is summed with
-- the pay lines, with its sign, in the department's total. The function is replaced as a whole (CREATE OR REPLACE); applied files stay untouched. Everything else is as in
-- 20261204213500: a user context only, an approver of the posting, the run in the caller's legal-entity scope and approved, nothing per person, never a raise on a stored value.
--
-- What changes: (1) the line identity check (net is gross less deductions, the per-fund split adds to the line's insurance) and the department groups take kind `pay` and `adjustment`;
-- (2) `adjustments` still counts the adjustment lines, and `adjustmentsIncomplete` counts those without a cost department or a well formed split or deductions (a line made before this change),
-- which the caller refuses with its own message; (3) `cashLarge` counts the pay lines at the cash limit, as before: an adjustment is a difference, not a person's pay.
SET LOCAL lock_timeout = '2s';

-- An adjustment line now names the terms of the line it corrects (its employment), which picks the cost department of its entry. The rule of 20261125000000 (an adjustment has no employment)
-- is replaced: a `pay` line names its terms and no run it corrects; an adjustment names the run it corrects and says why, is always calculated, and may name the terms it follows.
ALTER TABLE crove_hr.payroll_line DROP CONSTRAINT IF EXISTS payroll_line_kind_ck;
ALTER TABLE crove_hr.payroll_line ADD CONSTRAINT payroll_line_kind_ck CHECK (
  (kind = 'pay' AND adjusts_run_id IS NULL AND note IS NULL)
  OR (kind = 'adjustment' AND adjusts_run_id IS NOT NULL AND note IS NOT NULL AND status = 'calculated')
);

CREATE OR REPLACE FUNCTION crove_hr.payroll_run_totals(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_run record;
  v_groups jsonb;
  v_counts jsonb;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'payroll_run_totals: a user context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin'))
    OR crove_kernel.ctx_has_permission('finance.proposal.approve')
  ) THEN
    RAISE EXCEPTION 'payroll_run_totals: not an approver of a payroll posting' USING ERRCODE = '42501';
  END IF;
  SELECT r.id, r.legal_entity_id, r.month, r.status, r.approved_by, r.approval -> 'totals' AS approval_totals
    INTO v_run FROM crove_hr.payroll_run r WHERE r.org_id = v_org AND r.id = p_run;
  IF NOT FOUND OR NOT crove_kernel.ctx_le_allowed(v_run.legal_entity_id) THEN
    RETURN NULL;
  END IF;
  -- A run that is not approved is not posted: its status and no figure.
  IF v_run.status IS DISTINCT FROM 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('runId', v_run.id, 'status', v_run.status);
  END IF;
  -- One row per line with what can be summed safely: the amounts read as numbers only when they are numbers, and the per-fund elements kept only when each is well formed.
  WITH ln AS (
    SELECT l.kind, l.status, l.gross, l.employee_insurance, l.employer_insurance, l.union_fee, l.pit, l.net, e.pay_function, l.breakdown,
           -- Every flag below is TRUE or FALSE, never NULL: a missing key makes a typeof NULL, and a NULL would count as neither well formed nor malformed.
           coalesce(pg_catalog.jsonb_typeof(l.breakdown #> '{deductions}') = 'object'
             AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,advance}') = 'string' AND (l.breakdown #>> '{deductions,advance}') ~ '^-?[0-9]+(\.[0-9]+)?$'
             AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,damage}') = 'string' AND (l.breakdown #>> '{deductions,damage}') ~ '^-?[0-9]+(\.[0-9]+)?$'
             AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,other}') = 'string' AND (l.breakdown #>> '{deductions,other}') ~ '^-?[0-9]+(\.[0-9]+)?$', false) AS ded_ok,
           coalesce(CASE WHEN pg_catalog.jsonb_typeof(l.breakdown #> '{insurance,funds}') = 'array'
                THEN NOT EXISTS (
                  SELECT 1 FROM pg_catalog.jsonb_array_elements(l.breakdown #> '{insurance,funds}') x
                  WHERE (pg_catalog.jsonb_typeof(x -> 'fund') = 'string' AND (x ->> 'fund') IN ('retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment')
                             AND pg_catalog.jsonb_typeof(x -> 'employee') = 'string' AND (x ->> 'employee') ~ '^-?[0-9]+(\.[0-9]+)?$'
                             AND pg_catalog.jsonb_typeof(x -> 'employer') = 'string' AND (x ->> 'employer') ~ '^-?[0-9]+(\.[0-9]+)?$') IS NOT TRUE)
                ELSE false END, false) AS funds_ok,
           -- A line holds together: its net is its gross less its deductions, and its per-fund split adds to its own insurance, compared as numbers. Only a well formed line is judged (the others are
           -- counted above); a line that is not whole counts in badLines, which no sum can hide: two lines that are wrong by opposite amounts cancel in a department's total, never here.
           CASE WHEN l.status = 'calculated' AND l.kind IN ('pay', 'adjustment') AND l.gross IS NOT NULL AND l.employee_insurance IS NOT NULL AND l.employer_insurance IS NOT NULL AND l.pit IS NOT NULL AND l.net IS NOT NULL
                     AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions}') = 'object'
                     AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,advance}') = 'string' AND (l.breakdown #>> '{deductions,advance}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                     AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,damage}') = 'string' AND (l.breakdown #>> '{deductions,damage}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                     AND pg_catalog.jsonb_typeof(l.breakdown #> '{deductions,other}') = 'string' AND (l.breakdown #>> '{deductions,other}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                     AND pg_catalog.jsonb_typeof(l.breakdown #> '{insurance,funds}') = 'array'
                THEN coalesce((l.gross - l.employee_insurance - l.pit - (l.breakdown #>> '{deductions,advance}')::numeric - (l.breakdown #>> '{deductions,damage}')::numeric - (l.breakdown #>> '{deductions,other}')::numeric = l.net)
                     AND coalesce((SELECT pg_catalog.sum((x ->> 'employee')::numeric) FROM pg_catalog.jsonb_array_elements(l.breakdown #> '{insurance,funds}') x WHERE (x ->> 'employee') ~ '^-?[0-9]+(\.[0-9]+)?$'), 0) = l.employee_insurance
                     AND coalesce((SELECT pg_catalog.sum((x ->> 'employer')::numeric) FROM pg_catalog.jsonb_array_elements(l.breakdown #> '{insurance,funds}') x WHERE (x ->> 'employer') ~ '^-?[0-9]+(\.[0-9]+)?$'), 0) = l.employer_insurance, false)
                ELSE true END AS line_whole
    FROM crove_hr.payroll_line l
    LEFT JOIN crove_hr.payroll_employment e ON e.org_id = l.org_id AND e.id = l.employment_id
    WHERE l.org_id = v_org AND l.run_id = p_run
  )
  SELECT
    -- What the figures cannot be summed from, counted and never named: lines that are not pay lines, lines not calculated, lines whose employment holds no cost department, lines without a well
    -- formed per-fund split of their insurance or list of deductions. The caller refuses a run that has any.
    pg_catalog.jsonb_build_object(
      'lines', pg_catalog.count(*),
      'adjustments', pg_catalog.count(*) FILTER (WHERE kind <> 'pay'),
      'adjustmentsIncomplete', pg_catalog.count(*) FILTER (WHERE kind <> 'pay' AND (pay_function IS NULL OR NOT funds_ok OR NOT ded_ok)),
      'notCalculated', pg_catalog.count(*) FILTER (WHERE status <> 'calculated' OR gross IS NULL OR employee_insurance IS NULL OR employer_insurance IS NULL OR union_fee IS NULL OR pit IS NULL OR net IS NULL),
      'noFunction', pg_catalog.count(*) FILTER (WHERE pay_function IS NULL),
      'noFunds', pg_catalog.count(*) FILTER (WHERE NOT funds_ok),
      'noDeductions', pg_catalog.count(*) FILTER (WHERE NOT ded_ok),
      -- Lines that are not whole (see line_whole): a number only, never a figure.
      'badLines', pg_catalog.count(*) FILTER (WHERE funds_ok AND ded_ok AND NOT line_whole),
      -- How many people's net pay is at the cash limit (CASH_PAYMENT_LIMIT, 5,000,000 dong) or above: a number only.
      'cashLarge', pg_catalog.count(*) FILTER (WHERE kind = 'pay' AND net >= 5000000)),
    (SELECT coalesce(pg_catalog.jsonb_agg(g.obj ORDER BY g.pay_function), '[]'::jsonb)
     FROM (
       SELECT d.pay_function,
              pg_catalog.jsonb_build_object(
                'payFunction', d.pay_function,
                'gross', coalesce(pg_catalog.sum(d.gross), 0)::text,
                'unionFee', coalesce(pg_catalog.sum(d.union_fee), 0)::text,
                'pit', coalesce(pg_catalog.sum(d.pit), 0)::text,
                'net', coalesce(pg_catalog.sum(d.net), 0)::text,
                'advance', coalesce(pg_catalog.sum((d.breakdown #>> '{deductions,advance}')::numeric), 0)::text,
                'otherDeductions', coalesce(pg_catalog.sum((d.breakdown #>> '{deductions,damage}')::numeric + (d.breakdown #>> '{deductions,other}')::numeric), 0)::text,
                'employeeInsurance', coalesce(pg_catalog.sum(d.employee_insurance), 0)::text,
                'employerInsurance', coalesce(pg_catalog.sum(d.employer_insurance), 0)::text,
                'funds', (
                  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('fund', f.fund, 'employee', f.employee::text, 'employer', f.employer::text) ORDER BY f.fund), '[]'::jsonb)
                  FROM (
                    SELECT x ->> 'fund' AS fund, pg_catalog.sum((x ->> 'employee')::numeric) AS employee, pg_catalog.sum((x ->> 'employer')::numeric) AS employer
                    FROM ln l2
                    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(l2.breakdown #> '{insurance,funds}') AS x
                    WHERE l2.funds_ok AND l2.ded_ok AND l2.pay_function = d.pay_function AND l2.kind IN ('pay', 'adjustment')
                    GROUP BY x ->> 'fund'
                  ) f)) AS obj
       FROM ln d
       WHERE d.pay_function IS NOT NULL AND d.funds_ok AND d.ded_ok AND d.kind IN ('pay', 'adjustment')
       GROUP BY d.pay_function
     ) g)
  INTO v_counts, v_groups
  FROM ln;
  RETURN pg_catalog.jsonb_build_object(
    'runId', v_run.id,
    'legalEntityId', v_run.legal_entity_id,
    'month', v_run.month,
    'status', v_run.status,
    'approvedBy', v_run.approved_by,
    'approvalTotals', v_run.approval_totals,
    'counts', v_counts,
    'groups', v_groups);
END $$;
REVOKE ALL ON FUNCTION crove_hr.payroll_run_totals(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.payroll_run_totals(uuid) TO crove_tenant;
