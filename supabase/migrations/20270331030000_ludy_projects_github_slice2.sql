-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects GitHub Integration Slice 2 (#5159, ADR-0060):
--   1. Adds outbound loop-breaker columns (last_outbound_state, last_outbound_at) to ludy_projects.github_task_link
--      and link_id FK + next_attempt_at deferral schedule on ludy_projects.github_sync_delivery.
--   2. Adds context-bound github_outbound_enqueue_for_task (called inside kernel.task.set_status) and
--      worker-only outbound sweep/claim/defer definers (org_app_on gate, 8h TTL expiry, per-org deferral, zero seq scans).
--   3. Registers projects-github-sweep (standard) and projects-github-outbound (stately) queues in ludy_jobs.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_projects.github_task_link
  ADD COLUMN IF NOT EXISTS last_outbound_state text,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'ludy_projects.github_task_link'::regclass
       AND conname = 'github_task_link_last_outbound_state_check'
  ) THEN
    ALTER TABLE ludy_projects.github_task_link
      ADD CONSTRAINT github_task_link_last_outbound_state_check
      CHECK (last_outbound_state IS NULL OR last_outbound_state IN ('open', 'closed'));
  END IF;
END $$;

ALTER TABLE ludy_projects.github_sync_delivery
  ADD COLUMN IF NOT EXISTS link_id uuid,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'ludy_projects.github_sync_delivery'::regclass
       AND conname = 'github_sync_delivery_link_fk'
  ) THEN
    ALTER TABLE ludy_projects.github_sync_delivery
      ADD CONSTRAINT github_sync_delivery_link_fk FOREIGN KEY (org_id, link_id)
      REFERENCES ludy_projects.github_task_link (org_id, id) ON DELETE SET NULL (link_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS github_sync_delivery_outbound_queued_idx
  ON ludy_projects.github_sync_delivery (received_at, id)
  WHERE direction = 'outbound' AND status = 'queued';

CREATE INDEX IF NOT EXISTS github_sync_delivery_outbound_due_idx
  ON ludy_projects.github_sync_delivery (next_attempt_at, received_at, id)
  WHERE direction = 'outbound' AND status = 'queued';

CREATE INDEX IF NOT EXISTS github_sync_delivery_outbound_org_due_idx
  ON ludy_projects.github_sync_delivery (org_id, next_attempt_at, received_at)
  WHERE direction = 'outbound' AND status = 'queued';

CREATE INDEX IF NOT EXISTS github_sync_delivery_outbound_poison_idx
  ON ludy_projects.github_sync_delivery (id)
  WHERE direction = 'outbound' AND status = 'queued' AND attempt_count >= 5;

CREATE INDEX IF NOT EXISTS github_sync_delivery_link_idx
  ON ludy_projects.github_sync_delivery (org_id, link_id)
  WHERE link_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS github_sync_delivery_outbound_link_idx
  ON ludy_projects.github_sync_delivery (org_id, link_id)
  WHERE link_id IS NOT NULL AND direction = 'outbound' AND status = 'queued';

-- Context-bound enqueue invoked via projects.github.outbound_enqueue (user in-tx) or projects.github.outbound_enqueue_system (agent outbox relay)
-- when a task crosses the 'done' boundary. Enforces opt-in binding (outbound_close_issue_on_done = true), 'issue'-only links,
-- active projects app gate, and Layer 2 state equality check; kernel.task.sync_external_status (inbound sync) never invokes it (Layer 1).
-- migration-lint: cross-module verifies org_app_on('projects'), active tenant, and active GitHub channel_connection in the caller's tx
CREATE OR REPLACE FUNCTION ludy_projects.github_outbound_enqueue_for_task(
  p_task_id uuid,
  p_prev_status text,
  p_next_status text,
  p_event_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_now timestamptz := COALESCE(p_event_at, pg_catalog.clock_timestamp());
  v_target_state text;
  v_delivery_id uuid;
  v_count integer := 0;
  v_link record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'GITHUB_SYNC_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Reject 'agent' actor contexts because agent_write_guard restricts direct agent writes on github_sync_delivery;
  -- agent task transitions emit an outbox event relayed as 'system' via projects.github.outbound_enqueue_system.
  IF v_actor NOT IN ('user', 'system') THEN
    RETURN 0;
  END IF;

  IF p_task_id IS NULL OR p_prev_status IS NULL OR p_next_status IS NULL OR p_prev_status = p_next_status THEN
    RETURN 0;
  END IF;

  IF p_next_status = 'done' THEN
    v_target_state := 'closed';
  ELSIF p_prev_status = 'done' AND p_next_status IN ('todo', 'in_progress', 'waiting', 'in_review') THEN
    v_target_state := 'open';
  ELSE
    RETURN 0;
  END IF;

  IF NOT ludy_kernel.org_app_on(v_org, 'projects') THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant t
    WHERE t.org_id = v_org AND t.status = 'active'
  ) THEN
    RETURN 0;
  END IF;

  FOR v_link IN
    SELECT l.id AS link_id, l.project_id, l.repo_full_name, l.external_number, l.external_state
    FROM ludy_projects.project_task pt
    JOIN ludy_projects.project p
      ON p.org_id = pt.org_id AND p.id = pt.project_id
    JOIN ludy_projects.github_project_binding b
      ON b.org_id = pt.org_id AND b.project_id = pt.project_id
    JOIN ludy_kernel.channel_connection c
      ON c.org_id = b.org_id AND c.id = b.channel_connection_id
    JOIN ludy_projects.github_task_link l
      ON l.org_id = pt.org_id AND l.project_id = pt.project_id AND l.task_id = pt.task_id
    JOIN ludy_projects.github_project_repo r
      ON r.org_id = l.org_id AND r.project_id = l.project_id
     AND pg_catalog.lower(r.repo_full_name) = pg_catalog.lower(l.repo_full_name)
    WHERE pt.org_id = v_org
      AND pt.task_id = p_task_id
      AND p.status <> 'archived'
      AND NOT p.is_template
      AND (
        ludy_projects.actor_bypasses_private_projects()
        OR ludy_projects.project_visible(v_org, p.id)
      )
      AND b.github_enabled = true
      AND b.outbound_close_issue_on_done = true
      AND b.paused_at IS NULL
      AND c.status = 'active'
      AND l.kind = 'issue'
      AND l.hydrating = false
    ORDER BY l.created_at ASC, l.id ASC
  LOOP
    -- Cancel superseded queued outbound deliveries for the same linked issue so rapid toggles cannot replay out of order.
    UPDATE ludy_projects.github_sync_delivery d
       SET status = 'skipped',
           summary = 'Superseded by newer task status transition',
           processed_at = v_now
     WHERE d.org_id = v_org
       AND d.link_id = v_link.link_id
       AND d.direction = 'outbound'
       AND d.status = 'queued';

    -- Layer 2 loop-breaker: skip enqueue when linked issue state already matches desired remote state.
    IF v_link.external_state NOT IN ('open', 'closed') OR v_link.external_state = v_target_state THEN
      CONTINUE;
    END IF;

    v_delivery_id := ludy_kernel.uuid_v7();
    INSERT INTO ludy_projects.github_sync_delivery (
      id, org_id, project_id, direction, delivery_id, event_type,
      repo_full_name, external_number, task_id, link_id,
      idempotency_key, target_remote_state, status, received_at, next_attempt_at
    )
    VALUES (
      v_delivery_id,
      v_org,
      v_link.project_id,
      'outbound',
      'outbound:' || v_delivery_id::text,
      'issues.state',
      v_link.repo_full_name,
      v_link.external_number,
      p_task_id,
      v_link.link_id,
      'outbound:' || v_delivery_id::text,
      v_target_state,
      'queued',
      v_now,
      v_now
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- Worker-only readiness probe: ignores off-app and deferred rows while allowing due active-org work, stale >=8h expiry, or >=5 poison cleanup.
-- migration-lint: cross-module checks ludy_kernel.org_app_on('projects') before waking outbound sweep
CREATE OR REPLACE FUNCTION ludy_projects.github_outbound_has_work()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF ludy_kernel.ctx_org_id() IS NOT NULL OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_SYNC_NO_CONTEXT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM ludy_projects.github_sync_delivery d
    WHERE d.direction = 'outbound'
      AND d.status = 'queued'
      AND d.attempt_count < 5
      AND d.next_attempt_at <= v_now
      AND d.received_at > v_now - interval '8 hours'
      AND ludy_kernel.org_app_on(d.org_id, 'projects')
    LIMIT 1
  )
  OR EXISTS (
    SELECT 1
    FROM ludy_projects.github_sync_delivery d
    WHERE d.direction = 'outbound'
      AND d.status = 'queued'
      AND d.received_at <= v_now - interval '8 hours'
    LIMIT 1
  )
  OR EXISTS (
    SELECT 1
    FROM ludy_projects.github_sync_delivery d
    WHERE d.direction = 'outbound'
      AND d.status = 'queued'
      AND d.attempt_count >= 5
    LIMIT 1
  );
END $$;

-- Worker sweep (egress 'none'): expires stale (>= 8h) rows, fails poison (>= 5 attempts) rows, and lists due active-org rows.
-- migration-lint: cross-module checks ludy_kernel.org_app_on('projects') to exclude off-app orgs from sweep dispatch
CREATE OR REPLACE FUNCTION ludy_projects.github_outbound_sweep(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  project_id uuid,
  task_id uuid,
  link_id uuid,
  repo_full_name text,
  external_number integer,
  target_remote_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF ludy_kernel.ctx_org_id() IS NOT NULL OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_SYNC_NO_CONTEXT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_projects.github_sync_delivery d
     SET status = 'skipped',
         error_code = 'EXPIRED',
         summary = 'Outbound delivery expired before execution',
         processed_at = v_now
   WHERE d.direction = 'outbound'
     AND d.status = 'queued'
     AND d.received_at <= v_now - interval '8 hours';

  UPDATE ludy_projects.github_sync_delivery d
     SET status = 'failed',
         error_code = 'MAX_ATTEMPTS',
         summary = 'Outbound delivery retry cap reached',
         processed_at = v_now
   WHERE d.direction = 'outbound'
     AND d.status = 'queued'
     AND d.attempt_count >= 5;

  RETURN QUERY
  SELECT d.id, d.org_id, d.project_id, d.task_id, d.link_id,
         d.repo_full_name, d.external_number, d.target_remote_state
  FROM ludy_projects.github_sync_delivery d
  WHERE d.direction = 'outbound'
    AND d.status = 'queued'
    AND d.attempt_count < 5
    AND d.next_attempt_at <= v_now
    AND d.received_at > v_now - interval '8 hours'
    AND ludy_kernel.org_app_on(d.org_id, 'projects')
  ORDER BY d.next_attempt_at ASC, d.received_at ASC, d.id ASC
  LIMIT v_limit;
END $$;

-- Worker deferral helper: pushes next_attempt_at forward for unentitled/paused org rows so neither sweep nor relay spins or starves active orgs.
CREATE OR REPLACE FUNCTION ludy_projects.github_outbound_defer(
  p_org_id uuid,
  p_delivery_id uuid DEFAULT NULL,
  p_delay_seconds integer DEFAULT 900
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_delay integer := LEAST(GREATEST(COALESCE(p_delay_seconds, 900), 1), 3600);
  v_count integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS NULL THEN
    RETURN 0;
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'GITHUB_SYNC_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_projects.github_sync_delivery d
     SET next_attempt_at = v_now + pg_catalog.make_interval(secs => v_delay)
   WHERE d.org_id = p_org_id
     AND d.direction = 'outbound'
     AND d.status = 'queued'
     AND d.attempt_count < 5
     AND d.received_at > v_now - interval '8 hours'
     AND d.next_attempt_at <= v_now
     AND (p_delivery_id IS NULL OR d.id = p_delivery_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_outbound_delivery_claim(p_org_id uuid, p_delivery_id uuid)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  task_id uuid,
  link_id uuid,
  repo_full_name text,
  external_number integer,
  target_remote_state text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'GITHUB_SYNC_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE ludy_projects.github_sync_delivery d
     SET attempt_count = d.attempt_count + 1
   WHERE d.org_id = p_org_id
     AND d.id = p_delivery_id
     AND d.direction = 'outbound'
     AND d.status = 'queued'
     AND d.attempt_count < 5
     AND d.received_at > v_now - interval '8 hours'
  RETURNING d.id, d.project_id, d.task_id, d.link_id,
            d.repo_full_name, d.external_number, d.target_remote_state, d.attempt_count;
END $$;

REVOKE ALL ON FUNCTION
  ludy_projects.github_outbound_enqueue_for_task(uuid, text, text, timestamptz),
  ludy_projects.github_outbound_has_work(),
  ludy_projects.github_outbound_sweep(integer),
  ludy_projects.github_outbound_defer(uuid, uuid, integer),
  ludy_projects.github_outbound_delivery_claim(uuid, uuid)
FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_projects.github_outbound_enqueue_for_task(uuid, text, text, timestamptz), ludy_projects.github_outbound_has_work(), ludy_projects.github_outbound_sweep(integer), ludy_projects.github_outbound_defer(uuid, uuid, integer), ludy_projects.github_outbound_delivery_claim(uuid, uuid) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_projects.github_outbound_enqueue_for_task(uuid, text, text, timestamptz)
TO ludy_tenant;

GRANT EXECUTE ON FUNCTION
  ludy_projects.github_outbound_has_work(),
  ludy_projects.github_outbound_sweep(integer),
  ludy_projects.github_outbound_defer(uuid, uuid, integer),
  ludy_projects.github_outbound_delivery_claim(uuid, uuid)
TO ludy_worker;

-- migration-lint: cross-module Projects GitHub Slice 2 registers outbound sweep and delivery pg-boss queues in ludy_jobs
SELECT ludy_jobs.create_queue('projects-github-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
-- migration-lint: cross-module Projects GitHub Slice 2 registers stately outbound PATCH delivery queue in ludy_jobs
SELECT ludy_jobs.create_queue('projects-github-outbound', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
