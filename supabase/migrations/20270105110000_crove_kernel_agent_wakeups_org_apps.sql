-- SPDX-License-Identifier: AGPL-3.0-only
-- Coworkers of an app the org switched off do not wake (ADR-0053 section 3, slice e of #3307, issue #3311). Idempotent;
-- applied files stay untouched.
--
-- The wake-up sweep, as in 20261120100000, that also leaves out the wake-ups of an agent whose template belongs to an
-- app the org turned off (crove_kernel.org_app_on). The pending row is kept, so the sweep finds it again when the app is
-- on: nothing is lost and no run starts, no audit row is written for a run that cannot start, and the LIMIT is not spent
-- on rows that cannot run. The grants of the function stay as they were.
CREATE OR REPLACE FUNCTION crove_kernel.agent_wakeups_due(p_limit int, p_modules text[] DEFAULT NULL)
RETURNS TABLE (org_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.org_id, w.agent_id
  FROM crove_kernel.agent_wakeup w
  JOIN crove_kernel.tenant t ON t.org_id = w.org_id AND t.status = 'active'
  JOIN crove_kernel.agent a ON a.org_id = w.org_id AND a.id = w.agent_id AND a.status = 'active'
  JOIN crove_kernel.agent_template tp ON tp.key = a.template_key
  JOIN crove_kernel.position p ON p.org_id = w.org_id AND p.holder_agent_id = w.agent_id AND p.status = 'active'
    AND p.role_key = tp.role_key
  WHERE w.status = 'pending'
    AND w.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 1)
    AND (p_modules IS NULL OR tp.module = ANY (p_modules))
    AND crove_kernel.org_app_on(w.org_id, tp.module)
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.ai_run r
      WHERE r.org_id = w.org_id AND r.agent_id = w.agent_id AND r.status = 'running' AND r.expires_at > pg_catalog.now())
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.kill_switch k
      WHERE k.org_id = w.org_id AND k.released_at IS NULL
        AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = p.module) OR (k.scope = 'agent' AND k.target = w.agent_id::text)))
    AND (SELECT pg_catalog.count(*) FROM crove_kernel.ai_run r
         WHERE r.org_id = w.org_id AND r.agent_id = w.agent_id
           AND r.started_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')
        < a.daily_run_cap
    AND NOT crove_kernel.ai_budget_exhausted(w.org_id, p.module, w.agent_id)
  ORDER BY w.updated_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
