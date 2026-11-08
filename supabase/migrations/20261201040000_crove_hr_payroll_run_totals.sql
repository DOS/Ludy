-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2751, docs/plan/payroll.md section 6.6 "Totals in the books", ADR-0046): the totals of an approved pay run by cost department, for the verification of its posting and its
-- payments. Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_run_totals(p_run)  a SECURITY DEFINER function owned by the migration runner (which owns the tables and is not filtered by their row security, as the ledger checks of
--   20261105020000). It returns the run's figures summed per pay function (cost department) and nothing per person: no name, no employee id, no line id, no figure of one person's line.
--   The people tables stay owners and admins only (the RESTRICTIVE owner_admin policy of 20261125000000 is untouched); this one function lets whoever may approve the posting of the run
--   (an owner, an admin, or a member holding finance.proposal.approve through an org-wide assignment) rebuild the entry from totals, so a chief accountant who is a plain member can approve it.
--   The owner decided on 2026-11-08 (#2538) that the books show payroll totals by account to everyone who reads Kế toán; where a department has a single employee, its total is that person's pay
--   (the known limit of plan 6.6). The function checks itself: a user context only, in the sealed org, the run in its legal-entity scope and approved, the caller one of the approvers above.
SET LOCAL lock_timeout = '2s';

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
  -- What the figures cannot be summed from, counted and never named: lines that are not pay lines, lines not calculated, lines whose employment holds no cost department, lines without the
  -- per-fund split of their insurance. The caller refuses a run that has any.
  SELECT pg_catalog.jsonb_build_object(
           'lines', pg_catalog.count(*),
           'adjustments', pg_catalog.count(*) FILTER (WHERE l.kind <> 'pay'),
           'notCalculated', pg_catalog.count(*) FILTER (WHERE l.status <> 'calculated' OR l.gross IS NULL OR l.employee_insurance IS NULL OR l.employer_insurance IS NULL OR l.union_fee IS NULL OR l.pit IS NULL OR l.net IS NULL),
           'noFunction', pg_catalog.count(*) FILTER (WHERE e.pay_function IS NULL),
           'noFunds', pg_catalog.count(*) FILTER (WHERE pg_catalog.jsonb_typeof(l.breakdown #> '{insurance,funds}') IS DISTINCT FROM 'array'),
           'noDeductions', pg_catalog.count(*) FILTER (WHERE pg_catalog.jsonb_typeof(l.breakdown #> '{deductions}') IS DISTINCT FROM 'object'),
           -- How many people's net pay is at the cash limit (5,000,000 dong) or above: a number only.
           'cashLarge', pg_catalog.count(*) FILTER (WHERE l.net >= 5000000))
    INTO v_counts
  FROM crove_hr.payroll_line l
  LEFT JOIN crove_hr.payroll_employment e ON e.org_id = l.org_id AND e.id = l.employment_id
  WHERE l.org_id = v_org AND l.run_id = p_run;
  SELECT coalesce(pg_catalog.jsonb_agg(g.obj ORDER BY g.pay_function), '[]'::jsonb) INTO v_groups
  FROM (
    SELECT e.pay_function,
           pg_catalog.jsonb_build_object(
             'payFunction', e.pay_function,
             'gross', coalesce(pg_catalog.sum(l.gross), 0)::text,
             'unionFee', coalesce(pg_catalog.sum(l.union_fee), 0)::text,
             'pit', coalesce(pg_catalog.sum(l.pit), 0)::text,
             'net', coalesce(pg_catalog.sum(l.net), 0)::text,
             'advance', coalesce(pg_catalog.sum((l.breakdown #>> '{deductions,advance}')::numeric), 0)::text,
             'otherDeductions', coalesce(pg_catalog.sum(coalesce((l.breakdown #>> '{deductions,damage}')::numeric, 0) + coalesce((l.breakdown #>> '{deductions,other}')::numeric, 0)), 0)::text,
             'employeeInsurance', coalesce(pg_catalog.sum(l.employee_insurance), 0)::text,
             'employerInsurance', coalesce(pg_catalog.sum(l.employer_insurance), 0)::text,
             'funds', (
               SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('fund', f.fund, 'employee', f.employee::text, 'employer', f.employer::text) ORDER BY f.fund), '[]'::jsonb)
               FROM (
                 SELECT x ->> 'fund' AS fund, pg_catalog.sum((x ->> 'employee')::numeric) AS employee, pg_catalog.sum((x ->> 'employer')::numeric) AS employer
                 FROM crove_hr.payroll_line l2
                 JOIN crove_hr.payroll_employment e2 ON e2.org_id = l2.org_id AND e2.id = l2.employment_id
                 CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l2.breakdown #> '{insurance,funds}') = 'array' THEN l2.breakdown #> '{insurance,funds}' ELSE '[]'::jsonb END) AS x
                 WHERE l2.org_id = v_org AND l2.run_id = p_run AND e2.pay_function = e.pay_function
                 GROUP BY x ->> 'fund'
               ) f)) AS obj
    FROM crove_hr.payroll_line l
    JOIN crove_hr.payroll_employment e ON e.org_id = l.org_id AND e.id = l.employment_id
    WHERE l.org_id = v_org AND l.run_id = p_run
    GROUP BY e.pay_function
  ) g;
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
