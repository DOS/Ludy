-- SPDX-License-Identifier: AGPL-3.0-only
-- The AI budget meter (issue #2382, recommendation 5 of the AI-first reference study). Idempotent; applied files stay
-- untouched.
--
-- One ledger, one set of limits, no parallel tables:
--   * crove_kernel.org_usage already counts what an org used, and its metric 'ai_cost' is the AI cost. A model call now
--     writes one 'ai_cost' row of its own with the feature that made it, the module, the agent (when an agent run made
--     it) and the tokens the provider reported. Ids, a feature key, counts and the estimated cost only: never a prompt,
--     a document's text or a model's answer. The 24 hour abuse cap (#675) and the monthly meter read the same rows.
--   * crove_kernel.budget_policy (ADR-0029 section 7, set by kernel.agent.budget.set: R3, owner only, fresh second
--     factor) is the monthly limit of the org, a module or an agent. Until now it summed ai_run.cost, which nothing ever
--     wrote, so a hard stop could never trip; it now sums org_usage through the one function below.
--   * The worker's sweep tells the owners and admins once per budget, month and level (ai_budget_crossings) and gives orgs
--     with no budget the deployment's default (ai_budget_seed_due).
--   * crove_kernel.usage_deferral may name 'ai_budget': a document that needs the model and waits for the budget (the
--     month's, or a raised one) with nothing lost; its read is asked again every few minutes.
--
-- The month is the calendar month in Asia/Ho_Chi_Minh, as the run gate always counted it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.org_usage ADD COLUMN IF NOT EXISTS feature text;
ALTER TABLE crove_kernel.org_usage ADD COLUMN IF NOT EXISTS module text;
ALTER TABLE crove_kernel.org_usage ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE crove_kernel.org_usage ADD COLUMN IF NOT EXISTS input_tokens int;
ALTER TABLE crove_kernel.org_usage ADD COLUMN IF NOT EXISTS output_tokens int;

ALTER TABLE crove_kernel.org_usage DROP CONSTRAINT IF EXISTS org_usage_ai_detail_check;
ALTER TABLE crove_kernel.org_usage ADD CONSTRAINT org_usage_ai_detail_check CHECK (
  (feature IS NULL OR (feature ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND pg_catalog.length(feature) <= 60))
  AND (module IS NULL OR module ~ '^[a-z][a-z0-9_]*$')
  AND (input_tokens IS NULL OR input_tokens >= 0)
  AND (output_tokens IS NULL OR output_tokens >= 0)
  AND (metric = 'ai_cost' OR (feature IS NULL AND module IS NULL AND agent_id IS NULL AND input_tokens IS NULL AND output_tokens IS NULL)));

-- This month's use by module, by agent and by feature: the meter's reads and the budgets' sums.
CREATE INDEX IF NOT EXISTS org_usage_ai_idx ON crove_kernel.org_usage (org_id, created_at) WHERE metric = 'ai_cost';
CREATE INDEX IF NOT EXISTS org_usage_agent_idx ON crove_kernel.org_usage (org_id, agent_id, created_at) WHERE agent_id IS NOT NULL;

-- A document waiting for the AI budget.
ALTER TABLE crove_kernel.usage_deferral DROP CONSTRAINT IF EXISTS usage_deferral_metric_check;
ALTER TABLE crove_kernel.usage_deferral ADD CONSTRAINT usage_deferral_metric_check
  CHECK (metric IN ('inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost', 'ai_budget'));

-- ---------------------------------------------------------------------------
-- The one place that says what a budget has spent and whether it is spent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.ai_month_start() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
$$;

-- What this month's model calls cost for a budget's scope: the org ('*'), a module or an agent.
CREATE OR REPLACE FUNCTION crove_kernel.ai_budget_spent(p_org uuid, p_scope text, p_target text) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.sum(u.amount), 0)
  FROM crove_kernel.org_usage u
  WHERE u.org_id = p_org AND u.metric = 'ai_cost' AND u.created_at >= crove_kernel.ai_month_start()
    AND (p_scope = 'org' OR (p_scope = 'module' AND u.module = p_target) OR (p_scope = 'agent' AND u.agent_id::text = p_target))
$$;

-- Whether a hard-stop budget that covers the org, the module or the agent is spent. Null module or agent: not asked.
CREATE OR REPLACE FUNCTION crove_kernel.ai_budget_exhausted(p_org uuid, p_module text, p_agent uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM crove_kernel.budget_policy b
    WHERE b.org_id = p_org AND b.hard_stop
      AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = p_module) OR (b.scope = 'agent' AND b.target = p_agent::text))
      AND crove_kernel.ai_budget_spent(p_org, b.scope, b.target) >= b.monthly_limit)
$$;

-- The agent context, as in 20261023130000, with the budget read from the meter.
CREATE OR REPLACE FUNCTION crove_kernel.enter_agent_context(p_org_id uuid, p_agent_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run_status text;
  v_run_expires timestamptz;
  v_run_tainted boolean;
  v_agent_status text;
  v_agent_risk text;
  v_template_risk text;
  v_template_role text;
  v_position uuid;
  v_role text;
  v_module text;
  v_le text[];
  v_flags text[];
  v_risk text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'AGENT_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT r.status, r.expires_at, r.tainted INTO v_run_status, v_run_expires, v_run_tainted
  FROM crove_kernel.ai_run r WHERE r.org_id = p_org_id AND r.id = p_run_id AND r.agent_id = p_agent_id;
  IF NOT FOUND OR v_run_status <> 'running' OR v_run_expires <= pg_catalog.now() THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_LIVE' USING ERRCODE = '42501';
  END IF;
  SELECT a.status, a.max_risk, t.max_risk, t.role_key INTO v_agent_status, v_agent_risk, v_template_risk, v_template_role
  FROM crove_kernel.agent a JOIN crove_kernel.agent_template t ON t.key = a.template_key
  WHERE a.org_id = p_org_id AND a.id = p_agent_id;
  IF NOT FOUND OR v_agent_status <> 'active' THEN
    RAISE EXCEPTION 'AGENT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT p.id, p.role_key, p.module, p.le_scope, p.flags INTO v_position, v_role, v_module, v_le, v_flags
  FROM crove_kernel.position p WHERE p.org_id = p_org_id AND p.holder_agent_id = p_agent_id AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NO_POSITION' USING ERRCODE = '42501';
  END IF;
  IF v_role <> v_template_role THEN
    RAISE EXCEPTION 'AGENT_ROLE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k
    WHERE k.org_id = p_org_id AND k.released_at IS NULL
      AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = v_module) OR (k.scope = 'agent' AND k.target = p_agent_id::text))
  ) THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  -- The deployment-wide switch for AI (#886), engaged by the operator.
  IF crove_kernel.global_kill_switch_on('ai') THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ai_budget_exhausted(p_org_id, v_module, p_agent_id) THEN
    RAISE EXCEPTION 'BUDGET_EXHAUSTED' USING ERRCODE = '42501';
  END IF;
  v_risk := CASE WHEN v_agent_risk < v_template_risk THEN v_agent_risk ELSE v_template_risk END;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_agent_id,
    'run', p_run_id,
    'position', v_position,
    'module', v_module,
    'max_risk', v_risk,
    'tainted', v_run_tainted,
    'le_scope', pg_catalog.to_jsonb(v_le),
    'flags', pg_catalog.to_jsonb(v_flags)));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'position', v_position, 'module', v_module, 'maxRisk', v_risk, 'tainted', v_run_tainted);
END $$;

-- The wake-up sweep, as in 20261018160000, with the budget read from the meter.
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

-- ---------------------------------------------------------------------------
-- Notices and the deployment's default budget, for the worker's sweep
-- ---------------------------------------------------------------------------
-- The budgets that crossed their warning percentage ('warn') or, for a hard stop, 100% ('stop') this month and whose
-- owners and admins were not told yet (no notification of that kind under the one key per budget, month and level).
-- The worker sends the notice as the org's system context. Worker only: it reads across orgs.
CREATE OR REPLACE FUNCTION crove_kernel.ai_budget_crossings(p_limit int)
RETURNS TABLE (org_id uuid, scope text, target text, level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT b.org_id, b.scope, b.target, l.level
  FROM crove_kernel.budget_policy b
  JOIN crove_kernel.tenant t ON t.org_id = b.org_id AND t.status = 'active'
  CROSS JOIN LATERAL (SELECT crove_kernel.ai_budget_spent(b.org_id, b.scope, b.target) AS spent) s
  CROSS JOIN LATERAL (VALUES ('warn'), ('stop')) AS l(level)
  WHERE s.spent > 0
    AND (l.level = 'warn' OR b.hard_stop)
    AND s.spent * 100 >= b.monthly_limit * CASE l.level WHEN 'warn' THEN b.warn_percent ELSE 100 END
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.notification n
      WHERE n.org_id = b.org_id AND n.kind = 'kernel.ai_budget'
        AND n.dedupe_key = 'ai_budget:' || b.scope || ':' || b.target || ':'
                           || pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') || ':' || l.level)
  ORDER BY b.org_id, b.scope, b.target, l.level
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- The active orgs that have no budget of their own: the worker gives each the deployment's default (when one is set).
CREATE OR REPLACE FUNCTION crove_kernel.ai_budget_seed_due(p_limit int)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id FROM crove_kernel.tenant t
  WHERE t.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM crove_kernel.budget_policy b WHERE b.org_id = t.org_id AND b.scope = 'org')
  ORDER BY t.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the helpers for the runtime roles (the gates and the meter's reads run as the tenant), the sweep for
-- the worker only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.ai_month_start(),
  crove_kernel.ai_budget_spent(uuid, text, text),
  crove_kernel.ai_budget_exhausted(uuid, text, uuid),
  crove_kernel.ai_budget_crossings(int),
  crove_kernel.ai_budget_seed_due(int)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ai_month_start(), crove_kernel.ai_budget_spent(uuid, text, text), crove_kernel.ai_budget_exhausted(uuid, text, uuid) TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ai_budget_crossings(int), crove_kernel.ai_budget_seed_due(int) TO crove_worker;
