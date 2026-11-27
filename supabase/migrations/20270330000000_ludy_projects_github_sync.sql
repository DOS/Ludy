-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects GitHub Integration Slice 1 (#5158, ADR-0060, docs/plan/projects-github-integration.md):
-- - Nullable opt-in task_number on ludy_projects.project_task (remains NULL unless task_key_prefix is enabled)
-- - Per-project binding (App or PAT connection), repo allowlist (max 5/project), tainted PR/issue links, sync delivery log
-- - PAT per-connection webhook hook hashes, transient PAT notice buffer, and orgless App pending intake queue
-- - pg-boss queues projects-github-webhook ('none' egress) and projects-github-hydrate ('provider:github' egress)
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Opt-in task_number & composite project_task identity for GitHub task links
-- ---------------------------------------------------------------------------
ALTER TABLE ludy_projects.project_task
  ADD COLUMN IF NOT EXISTS task_number integer CHECK (task_number IS NULL OR task_number > 0);

CREATE UNIQUE INDEX IF NOT EXISTS project_task_project_task_number_uq
  ON ludy_projects.project_task (org_id, project_id, task_number)
  WHERE task_number IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_projects.project_task'::regclass
      AND conname = 'project_task_org_project_task_uq'
  ) THEN
    ALTER TABLE ludy_projects.project_task
      ADD CONSTRAINT project_task_org_project_task_uq UNIQUE (org_id, project_id, task_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Tenant tables: binding, repo allowlist, tainted task links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ludy_projects.github_project_binding (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  github_enabled boolean NOT NULL DEFAULT false,
  task_key_prefix text CHECK (task_key_prefix IS NULL OR task_key_prefix ~ '^[A-Z][A-Z0-9]{1,7}$'),
  next_task_number integer NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
  auto_sync_inbound boolean NOT NULL DEFAULT true,
  auto_link_mentions boolean NOT NULL DEFAULT true,
  auto_link_branch boolean NOT NULL DEFAULT true,
  inbound_in_progress_on_pr boolean NOT NULL DEFAULT true,
  inbound_done_on_merge boolean NOT NULL DEFAULT true,
  -- Reserved for Slice 2 (#5159) outbound Done <-> Close/Reopen; unused and stays false in Slice 1.
  outbound_close_issue_on_done boolean NOT NULL DEFAULT false,
  inbound_col_in_progress uuid,
  inbound_col_in_review uuid,
  inbound_col_done uuid,
  paused_reason text CHECK (paused_reason IS NULL OR pg_catalog.char_length(paused_reason) BETWEEN 1 AND 500),
  paused_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_project_binding_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_project_binding_project_uq UNIQUE (org_id, project_id),
  CONSTRAINT github_project_binding_connection_fk FOREIGN KEY (org_id, channel_connection_id)
    REFERENCES ludy_kernel.channel_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_project_binding_col_in_progress_fk FOREIGN KEY (org_id, inbound_col_in_progress)
    REFERENCES ludy_projects.project_column (org_id, id) ON DELETE SET NULL,
  CONSTRAINT github_project_binding_col_in_review_fk FOREIGN KEY (org_id, inbound_col_in_review)
    REFERENCES ludy_projects.project_column (org_id, id) ON DELETE SET NULL,
  CONSTRAINT github_project_binding_col_done_fk FOREIGN KEY (org_id, inbound_col_done)
    REFERENCES ludy_projects.project_column (org_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS github_project_binding_conn_idx
  ON ludy_projects.github_project_binding (org_id, channel_connection_id);
CREATE INDEX IF NOT EXISTS github_project_binding_col_prog_idx
  ON ludy_projects.github_project_binding (org_id, inbound_col_in_progress);
CREATE INDEX IF NOT EXISTS github_project_binding_col_rev_idx
  ON ludy_projects.github_project_binding (org_id, inbound_col_in_review);
CREATE INDEX IF NOT EXISTS github_project_binding_col_done_idx
  ON ludy_projects.github_project_binding (org_id, inbound_col_done);
CREATE UNIQUE INDEX IF NOT EXISTS github_project_binding_prefix_uq
  ON ludy_projects.github_project_binding (org_id, task_key_prefix)
  WHERE task_key_prefix IS NOT NULL;

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.github_project_binding');
DROP POLICY IF EXISTS project_visibility ON ludy_projects.github_project_binding;
CREATE POLICY project_visibility ON ludy_projects.github_project_binding
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

CREATE OR REPLACE FUNCTION ludy_projects.github_project_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_is_template boolean;
  v_provider text;
BEGIN
  SELECT p.is_template INTO v_is_template
  FROM ludy_projects.project p
  WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id;
  IF v_is_template IS TRUE THEN
    RAISE EXCEPTION 'GITHUB_TEMPLATE_PROJECT_FORBIDDEN' USING ERRCODE = '22023';
  END IF;

  SELECT c.provider INTO v_provider
  FROM ludy_kernel.channel_connection c
  WHERE c.org_id = NEW.org_id AND c.id = NEW.channel_connection_id;
  IF v_provider IS NULL OR v_provider NOT IN ('github_app', 'github_pat') THEN
    RAISE EXCEPTION 'GITHUB_CONNECTION_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NEW.inbound_col_in_progress IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ludy_projects.project_column pc
    WHERE pc.org_id = NEW.org_id AND pc.project_id = NEW.project_id AND pc.id = NEW.inbound_col_in_progress AND pc.task_status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'GITHUB_INBOUND_COLUMN_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NEW.inbound_col_in_review IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ludy_projects.project_column pc
    WHERE pc.org_id = NEW.org_id AND pc.project_id = NEW.project_id AND pc.id = NEW.inbound_col_in_review AND pc.task_status = 'in_review'
  ) THEN
    RAISE EXCEPTION 'GITHUB_INBOUND_COLUMN_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NEW.inbound_col_done IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ludy_projects.project_column pc
    WHERE pc.org_id = NEW.org_id AND pc.project_id = NEW.project_id AND pc.id = NEW.inbound_col_done AND pc.task_status = 'done'
  ) THEN
    RAISE EXCEPTION 'GITHUB_INBOUND_COLUMN_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS github_project_binding_guard_tr ON ludy_projects.github_project_binding;
CREATE TRIGGER github_project_binding_guard_tr
  AFTER INSERT OR UPDATE OF org_id, project_id, channel_connection_id, inbound_col_in_progress, inbound_col_in_review, inbound_col_done
  ON ludy_projects.github_project_binding
  FOR EACH ROW
  EXECUTE FUNCTION ludy_projects.github_project_binding_guard();

CREATE TABLE IF NOT EXISTS ludy_projects.github_project_repo (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  github_repo_id bigint NOT NULL CHECK (github_repo_id > 0),
  repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  default_branch text NOT NULL DEFAULT 'main' CHECK (pg_catalog.char_length(default_branch) BETWEEN 1 AND 200),
  webhook_configured boolean NOT NULL DEFAULT false,
  last_event_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_project_repo_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_project_repo_binding_fk FOREIGN KEY (org_id, binding_id)
    REFERENCES ludy_projects.github_project_binding (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_project_repo_project_repo_id_uq UNIQUE (org_id, project_id, github_repo_id)
);

CREATE INDEX IF NOT EXISTS github_project_repo_project_idx
  ON ludy_projects.github_project_repo (org_id, project_id);
CREATE INDEX IF NOT EXISTS github_project_repo_binding_idx
  ON ludy_projects.github_project_repo (org_id, binding_id);
CREATE UNIQUE INDEX IF NOT EXISTS github_project_repo_project_name_uq
  ON ludy_projects.github_project_repo (org_id, project_id, pg_catalog.lower(repo_full_name));
CREATE INDEX IF NOT EXISTS github_project_repo_repo_lookup_idx
  ON ludy_projects.github_project_repo (org_id, github_repo_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.github_project_repo');
DROP POLICY IF EXISTS project_visibility ON ludy_projects.github_project_repo;
CREATE POLICY project_visibility ON ludy_projects.github_project_repo
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

CREATE OR REPLACE FUNCTION ludy_projects.github_project_repo_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_binding_project uuid;
  v_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('ludy.github_repo_cap:' || NEW.project_id::text, 0)
    );
  END IF;

  SELECT b.project_id INTO v_binding_project
  FROM ludy_projects.github_project_binding b
  WHERE b.org_id = NEW.org_id AND b.id = NEW.binding_id
  FOR SHARE OF b;
  IF v_binding_project IS NULL OR v_binding_project <> NEW.project_id THEN
    RAISE EXCEPTION 'GITHUB_REPO_BINDING_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.count(*)::integer INTO v_count
    FROM ludy_projects.github_project_repo r
    WHERE r.org_id = NEW.org_id AND r.project_id = NEW.project_id;
    IF v_count > 5 THEN
      RAISE EXCEPTION 'GITHUB_REPO_LIMIT_REACHED' USING ERRCODE = '54000';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS github_project_repo_guard_tr ON ludy_projects.github_project_repo;
CREATE TRIGGER github_project_repo_guard_tr
  AFTER INSERT OR UPDATE OF org_id, project_id, binding_id
  ON ludy_projects.github_project_repo
  FOR EACH ROW
  EXECUTE FUNCTION ludy_projects.github_project_repo_guard();

CREATE TABLE IF NOT EXISTS ludy_projects.github_task_link (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  kind text NOT NULL CHECK (kind IN ('issue', 'pull_request')),
  external_number integer NOT NULL CHECK (external_number > 0),
  external_url text NOT NULL CHECK (external_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/[0-9]+$' AND pg_catalog.char_length(external_url) <= 500),
  external_title text NOT NULL CHECK (pg_catalog.char_length(external_title) BETWEEN 1 AND 300),
  external_state text NOT NULL CHECK (external_state IN ('open', 'closed', 'merged', 'draft')),
  branch_name text CHECK (branch_name IS NULL OR pg_catalog.char_length(branch_name) BETWEEN 1 AND 300),
  author_login text CHECK (author_login IS NULL OR author_login ~ '^[A-Za-z0-9-]{1,100}(?:\[bot\])?$'),
  link_source text NOT NULL CHECK (link_source IN ('manual', 'mention', 'branch')),
  closes_task boolean NOT NULL DEFAULT true,
  hydrating boolean NOT NULL DEFAULT false,
  tainted boolean NOT NULL DEFAULT true CHECK (tainted = true),
  last_remote_event_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_task_link_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_task_link_task_fk FOREIGN KEY (org_id, task_id)
    REFERENCES ludy_kernel.task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_task_link_project_task_fk FOREIGN KEY (org_id, project_id, task_id)
    REFERENCES ludy_projects.project_task (org_id, project_id, task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS github_task_link_project_idx
  ON ludy_projects.github_task_link (org_id, project_id);
CREATE INDEX IF NOT EXISTS github_task_link_task_idx
  ON ludy_projects.github_task_link (org_id, task_id);
CREATE INDEX IF NOT EXISTS github_task_link_project_task_idx
  ON ludy_projects.github_task_link (org_id, project_id, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS github_task_link_uq
  ON ludy_projects.github_task_link (org_id, project_id, task_id, pg_catalog.lower(repo_full_name), kind, external_number);

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.github_task_link');
DROP POLICY IF EXISTS project_visibility ON ludy_projects.github_task_link;
CREATE POLICY project_visibility ON ludy_projects.github_task_link
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

-- ---------------------------------------------------------------------------
-- 3. Machinery tables (definer-only, RLS enabled, zero login grants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ludy_projects.github_sync_delivery (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  delivery_id text NOT NULL CHECK (pg_catalog.char_length(delivery_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (pg_catalog.char_length(event_type) BETWEEN 1 AND 64),
  repo_full_name text CHECK (repo_full_name IS NULL OR repo_full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  external_number integer CHECK (external_number IS NULL OR external_number > 0),
  task_id uuid,
  idempotency_key text CHECK (idempotency_key IS NULL OR pg_catalog.char_length(idempotency_key) BETWEEN 1 AND 200),
  target_remote_state text CHECK (target_remote_state IS NULL OR target_remote_state IN ('open', 'closed')),
  status text NOT NULL CHECK (status IN ('queued', 'applied', 'skipped', 'deferred', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code text CHECK (error_code IS NULL OR pg_catalog.char_length(error_code) <= 64),
  summary text CHECK (summary IS NULL OR pg_catalog.char_length(summary) <= 500),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  processed_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_sync_delivery_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_sync_delivery_task_fk FOREIGN KEY (org_id, task_id)
    REFERENCES ludy_kernel.task (org_id, id) ON DELETE SET NULL,
  CONSTRAINT github_sync_delivery_dedupe_uq UNIQUE (org_id, project_id, direction, delivery_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS github_sync_delivery_idem_uq
  ON ludy_projects.github_sync_delivery (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS github_sync_delivery_project_idx
  ON ludy_projects.github_sync_delivery (org_id, project_id);
CREATE INDEX IF NOT EXISTS github_sync_delivery_task_idx
  ON ludy_projects.github_sync_delivery (org_id, task_id);
CREATE INDEX IF NOT EXISTS github_sync_delivery_project_recent_idx
  ON ludy_projects.github_sync_delivery (org_id, project_id, received_at DESC, id DESC);

ALTER TABLE ludy_projects.github_sync_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ludy_projects.github_sync_delivery FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_projects.github_sync_delivery');
DROP POLICY IF EXISTS project_visibility ON ludy_projects.github_sync_delivery;
CREATE POLICY project_visibility ON ludy_projects.github_sync_delivery
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

CREATE TABLE IF NOT EXISTS ludy_projects.github_webhook_hook (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  hook_key_sha256 text NOT NULL CHECK (hook_key_sha256 ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  reject_token uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  refusals integer NOT NULL DEFAULT 0 CHECK (refusals >= 0),
  refusals_window_started_at timestamptz,
  stopped_at timestamptz,
  last_seen_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rotated_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_webhook_hook_conn_fk FOREIGN KEY (org_id, channel_connection_id)
    REFERENCES ludy_kernel.channel_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_webhook_hook_conn_uq UNIQUE (org_id, channel_connection_id),
  CONSTRAINT github_webhook_hook_key_uq UNIQUE (hook_key_sha256),
  CONSTRAINT github_webhook_hook_reject_token_uq UNIQUE (reject_token)
);

ALTER TABLE ludy_projects.github_webhook_hook ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ludy_projects.github_webhook_hook FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_projects.github_webhook_hook');

CREATE TABLE IF NOT EXISTS ludy_projects.github_webhook_notice (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  hook_id uuid NOT NULL,
  delivery_id text NOT NULL CHECK (pg_catalog.char_length(delivery_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (pg_catalog.char_length(event_type) BETWEEN 1 AND 64),
  signature_256 text NOT NULL CHECK (pg_catalog.char_length(signature_256) BETWEEN 1 AND 128),
  body bytea NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 262144),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  claimed_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT github_webhook_notice_hook_fk FOREIGN KEY (org_id, hook_id)
    REFERENCES ludy_projects.github_webhook_hook (org_id, id) ON DELETE CASCADE,
  CONSTRAINT github_webhook_notice_delivery_uq UNIQUE (org_id, hook_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS github_webhook_notice_hook_idx
  ON ludy_projects.github_webhook_notice (org_id, hook_id);
CREATE INDEX IF NOT EXISTS github_webhook_notice_received_idx
  ON ludy_projects.github_webhook_notice (received_at, id);

ALTER TABLE ludy_projects.github_webhook_notice ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ludy_projects.github_webhook_notice FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_projects.github_webhook_notice');

-- Orgless App webhook intake buffer (definer-only, RLS enabled, zero login grants)
CREATE TABLE IF NOT EXISTS ludy_projects.github_webhook_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL CHECK (pg_catalog.char_length(delivery_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (pg_catalog.char_length(event_type) BETWEEN 1 AND 64),
  signature_256 text NOT NULL CHECK (pg_catalog.char_length(signature_256) BETWEEN 1 AND 128),
  installation_id bigint CHECK (installation_id IS NULL OR installation_id > 0),
  body bytea NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 262144),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS github_webhook_pending_received_idx
  ON ludy_projects.github_webhook_pending (received_at, seq);

REVOKE ALL ON ludy_projects.github_webhook_pending FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
ALTER TABLE ludy_projects.github_webhook_pending ENABLE ROW LEVEL SECURITY;
SELECT ludy_kernel.agent_write_guard_install('ludy_projects.github_webhook_pending');

-- ---------------------------------------------------------------------------
-- 4. Definer functions: App pending queue, PAT hook intake/rotate/reject, sweep
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_pending_enqueue(
  p_delivery_id text,
  p_event_type text,
  p_signature_256 text,
  p_installation_id bigint,
  p_body bytea
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  IF p_delivery_id IS NULL OR pg_catalog.char_length(p_delivery_id) NOT BETWEEN 1 AND 128
     OR p_event_type IS NULL OR p_event_type NOT IN ('issues', 'pull_request', 'push', 'installation', 'installation_repositories')
     OR p_signature_256 IS NULL OR pg_catalog.char_length(p_signature_256) NOT BETWEEN 1 AND 128
     OR (p_installation_id IS NOT NULL AND p_installation_id <= 0)
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 262144 THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy.github_webhook_pending_enqueue', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ludy_projects.github_webhook_pending LIMIT 10001) s) >= 10000 THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_BACKLOG' USING ERRCODE = '53400';
  END IF;

  INSERT INTO ludy_projects.github_webhook_pending (delivery_id, event_type, signature_256, installation_id, body)
  VALUES (p_delivery_id, p_event_type, p_signature_256, p_installation_id, p_body)
  RETURNING seq INTO v_seq;

  PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  RETURN v_seq;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cutoff timestamptz := pg_catalog.clock_timestamp() - interval '10 minutes';
  v_pending_deleted integer := 0;
  v_notice_deleted integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  DELETE FROM ludy_projects.github_webhook_pending WHERE received_at < v_cutoff;
  GET DIAGNOSTICS v_pending_deleted = ROW_COUNT;

  DELETE FROM ludy_projects.github_webhook_notice WHERE received_at < v_cutoff;
  GET DIAGNOSTICS v_notice_deleted = ROW_COUNT;

  RETURN v_pending_deleted + v_notice_deleted;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
    AND (
      EXISTS (SELECT 1 FROM ludy_projects.github_webhook_pending)
      OR EXISTS (SELECT 1 FROM ludy_projects.github_webhook_notice)
    );
$$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_pending_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (
  seq bigint,
  delivery_id text,
  event_type text,
  signature_256 text,
  installation_id bigint,
  body bytea,
  attempts integer,
  dropped boolean,
  reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_lease integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 10), 600);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_org_id() IS NOT NULL
     OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  PERFORM ludy_projects.github_webhook_sweep();

  RETURN QUERY
  WITH due AS (
    SELECT p.seq AS row_seq, (p.received_at < pg_catalog.clock_timestamp() - interval '10 minutes') AS stale
    FROM ludy_projects.github_webhook_pending p
    WHERE p.claimed_until IS NULL OR p.claimed_until < pg_catalog.clock_timestamp()
    ORDER BY p.seq
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), expired AS (
    DELETE FROM ludy_projects.github_webhook_pending p USING due WHERE p.seq = due.row_seq AND due.stale
    RETURNING p.seq, p.delivery_id, p.event_type, p.signature_256, p.installation_id, p.attempts
  ), poison AS (
    DELETE FROM ludy_projects.github_webhook_pending p USING due WHERE p.seq = due.row_seq AND NOT due.stale AND p.attempts >= 5
    RETURNING p.seq, p.delivery_id, p.event_type, p.signature_256, p.installation_id, p.attempts
  ), taken AS (
    UPDATE ludy_projects.github_webhook_pending p
    SET claimed_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_lease),
        attempts = p.attempts + 1
    FROM due
    WHERE p.seq = due.row_seq AND NOT due.stale AND p.attempts < 5
    RETURNING p.seq, p.delivery_id, p.event_type, p.signature_256, p.installation_id, p.body, p.attempts
  )
  SELECT t.seq, t.delivery_id, t.event_type, t.signature_256, t.installation_id, t.body, t.attempts, false, NULL::text FROM taken t
  UNION ALL
  SELECT d.seq, d.delivery_id, d.event_type, d.signature_256, d.installation_id, NULL::bytea, d.attempts, true, 'poison'::text FROM poison d
  UNION ALL
  SELECT e.seq, e.delivery_id, e.event_type, e.signature_256, e.installation_id, NULL::bytea, e.attempts, true, 'expired'::text FROM expired e
  ORDER BY 1;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_pending_done(p_seq bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_org_id() IS NOT NULL
     OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM ludy_projects.github_webhook_pending WHERE seq = p_seq;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_set(p_connection_id uuid, p_hook_key_sha256 text)
RETURNS TABLE (hook_id uuid, created boolean, generation integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_existing_id uuid;
  v_gen integer;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'GITHUB_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_connection_id IS NULL OR p_hook_key_sha256 IS NULL OR p_hook_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GITHUB_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.channel_connection c
    WHERE c.org_id = v_org AND c.id = p_connection_id AND c.provider = 'github_pat' AND c.status = 'active'
  ) THEN
    RAISE EXCEPTION 'GITHUB_HOOK_CONNECTION_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT h.id INTO v_existing_id
  FROM ludy_projects.github_webhook_hook h
  WHERE h.org_id = v_org AND h.channel_connection_id = p_connection_id
  FOR UPDATE;

  IF v_existing_id IS NULL THEN
    INSERT INTO ludy_projects.github_webhook_hook (org_id, channel_connection_id, hook_key_sha256, created_by)
    VALUES (v_org, p_connection_id, p_hook_key_sha256, v_user)
    RETURNING ludy_projects.github_webhook_hook.id, ludy_projects.github_webhook_hook.generation
      INTO v_existing_id, v_gen;
    RETURN QUERY SELECT v_existing_id, true, v_gen;
    RETURN;
  END IF;

  DELETE FROM ludy_projects.github_webhook_notice n
  WHERE n.org_id = v_org AND n.hook_id = v_existing_id;

  UPDATE ludy_projects.github_webhook_hook h
  SET hook_key_sha256 = p_hook_key_sha256,
      generation = h.generation + 1,
      reject_token = ludy_kernel.uuid_v7(),
      refusals = 0,
      refusals_window_started_at = NULL,
      stopped_at = NULL,
      rotated_at = pg_catalog.clock_timestamp()
  WHERE h.org_id = v_org AND h.id = v_existing_id
  RETURNING h.generation INTO v_gen;

  RETURN QUERY SELECT v_existing_id, false, v_gen;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_status(p_connection_id uuid)
RETURNS TABLE (
  hook_id uuid,
  configured boolean,
  standing text,
  last_seen_at timestamptz,
  stopped_at timestamptz,
  rotated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS NULL OR NOT (
    ludy_kernel.ctx_actor_type() = 'system'
    OR (
      ludy_kernel.ctx_actor_type() = 'user'
      AND ludy_kernel.ctx_user_id() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
      )
    )
    OR EXISTS (
      SELECT 1 FROM ludy_projects.github_project_binding b
      WHERE b.org_id = v_org
        AND b.channel_connection_id = p_connection_id
        AND ludy_projects.project_visible(v_org, b.project_id)
    )
  ) THEN
    RAISE EXCEPTION 'GITHUB_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT h.id,
         true,
         CASE WHEN h.stopped_at IS NOT NULL THEN 'stopped'::text ELSE 'active'::text END,
         h.last_seen_at,
         h.stopped_at,
         h.rotated_at
  FROM ludy_projects.github_webhook_hook h
  WHERE h.org_id = v_org AND h.channel_connection_id = p_connection_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, false, 'none'::text, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_find(p_key_sha256 text)
RETURNS TABLE (hook_id uuid, org_id uuid, generation integer, stopped boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hook uuid;
  v_org uuid;
  v_conn uuid;
  v_gen integer;
  v_stopped boolean;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  SELECT h.id, h.org_id, h.channel_connection_id, h.generation, (h.stopped_at IS NOT NULL)
  INTO v_hook, v_org, v_conn, v_gen, v_stopped
  FROM ludy_projects.github_webhook_hook h
  WHERE h.hook_key_sha256 = p_key_sha256;

  IF v_hook IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant t
    WHERE t.org_id = v_org AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'projects')
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.channel_connection c
    WHERE c.org_id = v_org AND c.id = v_conn AND c.provider = 'github_pat' AND c.status = 'active'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_hook, v_org, v_gen, v_stopped;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_put(
  p_hook_id uuid,
  p_key_sha256 text,
  p_generation integer,
  p_delivery_id text,
  p_event_type text,
  p_signature_256 text,
  p_body bytea
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid;
  v_conn uuid;
  v_waiting integer;
  v_rows integer;
BEGIN
  IF p_hook_id IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$'
     OR p_generation IS NULL OR p_generation < 1
     OR p_delivery_id IS NULL OR pg_catalog.char_length(p_delivery_id) NOT BETWEEN 1 AND 128
     OR p_event_type IS NULL OR p_event_type NOT IN ('issues', 'pull_request', 'push', 'installation', 'installation_repositories')
     OR p_signature_256 IS NULL OR pg_catalog.char_length(p_signature_256) NOT BETWEEN 1 AND 128
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 262144 THEN
    RAISE EXCEPTION 'GITHUB_HOOK_PUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT h.org_id INTO v_org
  FROM ludy_projects.github_webhook_hook h
  WHERE h.id = p_hook_id AND h.hook_key_sha256 = p_key_sha256 AND h.generation = p_generation AND h.stopped_at IS NULL;
  IF v_org IS NULL THEN
    RETURN 'gone';
  END IF;

  PERFORM 1 FROM ludy_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR SHARE OF t;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  PERFORM 1 FROM ludy_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'projects');
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  SELECT h.channel_connection_id INTO v_conn
  FROM ludy_projects.github_webhook_hook h
  WHERE h.org_id = v_org AND h.id = p_hook_id AND h.hook_key_sha256 = p_key_sha256 AND h.generation = p_generation AND h.stopped_at IS NULL
  FOR UPDATE OF h;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  PERFORM 1 FROM ludy_kernel.channel_connection c
  WHERE c.org_id = v_org AND c.id = v_conn AND c.provider = 'github_pat' AND c.status = 'active'
  FOR SHARE OF c;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_projects.github_webhook_notice n
    WHERE n.org_id = v_org AND n.hook_id = p_hook_id AND n.delivery_id = p_delivery_id
  ) THEN
    RETURN 'duplicate';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_waiting
  FROM (SELECT 1 FROM ludy_projects.github_webhook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook_id LIMIT 20) s;
  IF v_waiting >= 20 THEN
    RETURN 'busy';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy.github_webhook_notice_put', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ludy_projects.github_webhook_notice LIMIT 10001) s) >= 10000 THEN
    RETURN 'busy';
  END IF;

  INSERT INTO ludy_projects.github_webhook_notice (org_id, hook_id, delivery_id, event_type, signature_256, body)
  VALUES (v_org, p_hook_id, p_delivery_id, p_event_type, p_signature_256, p_body)
  ON CONFLICT ON CONSTRAINT github_webhook_notice_delivery_uq DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;

  UPDATE ludy_projects.github_webhook_hook h
  SET last_seen_at = pg_catalog.clock_timestamp()
  WHERE h.org_id = v_org AND h.id = p_hook_id;

  PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  RETURN 'accepted';
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_claim(p_limit integer)
RETURNS TABLE (
  org_id uuid,
  reject_token uuid,
  connection_id uuid,
  delivery_id text,
  event_type text,
  signature_256 text,
  body bytea,
  generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_org_id() IS NOT NULL
     OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  PERFORM ludy_projects.github_webhook_sweep();
  v_cutoff := pg_catalog.clock_timestamp() - interval '10 minutes';

  RETURN QUERY
  WITH claimed AS (
    DELETE FROM ludy_projects.github_webhook_notice n
    WHERE (n.org_id, n.id) IN (
      SELECT q.org_id, q.id
      FROM ludy_projects.github_webhook_notice q
      ORDER BY q.received_at, q.id
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 200)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.delivery_id AS c_delivery_id, n.event_type AS c_event_type, n.signature_256 AS c_signature_256, n.body AS c_body, n.received_at AS c_received_at, n.id AS c_id
  )
  SELECT CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_org END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.reject_token END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.channel_connection_id END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_delivery_id END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_event_type END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_signature_256 END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_body END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.generation END
  FROM claimed cl
  LEFT JOIN ludy_projects.github_webhook_hook h
    ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  LEFT JOIN ludy_kernel.channel_connection c
    ON c.org_id = h.org_id AND c.id = h.channel_connection_id AND c.provider = 'github_pat' AND c.status = 'active'
  LEFT JOIN ludy_kernel.tenant t
    ON t.org_id = c.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'projects')
  ORDER BY cl.c_received_at, cl.c_id;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_webhook_hook_reject(p_reject_token uuid, p_generation integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_stopped boolean;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_reject_token IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RETURN false;
  END IF;

  UPDATE ludy_projects.github_webhook_hook h
  SET refusals_window_started_at = CASE
        WHEN h.refusals_window_started_at IS NULL OR h.refusals_window_started_at < v_now - interval '1 hour'
        THEN v_now
        ELSE h.refusals_window_started_at
      END,
      refusals = CASE
        WHEN h.refusals_window_started_at IS NULL OR h.refusals_window_started_at < v_now - interval '1 hour'
        THEN 1
        ELSE h.refusals + 1
      END,
      stopped_at = CASE
        WHEN (
          CASE
            WHEN h.refusals_window_started_at IS NULL OR h.refusals_window_started_at < v_now - interval '1 hour'
            THEN 1
            ELSE h.refusals + 1
          END
        ) >= 10 THEN v_now
        ELSE h.stopped_at
      END
  WHERE h.reject_token = p_reject_token AND h.generation = p_generation AND h.stopped_at IS NULL
  RETURNING (stopped_at IS NOT NULL) INTO v_stopped;

  RETURN COALESCE(v_stopped, false);
END $$;

-- ---------------------------------------------------------------------------
-- 5. Definer lookups & sync delivery ledger helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_projects.github_app_org_bindings(p_installation_id bigint, p_repo_full_name text)
RETURNS TABLE (
  org_id uuid,
  project_id uuid,
  binding_id uuid,
  channel_connection_id uuid,
  task_key_prefix text,
  auto_link_mentions boolean,
  auto_link_branch boolean,
  inbound_in_progress_on_pr boolean,
  inbound_done_on_merge boolean,
  inbound_col_in_progress uuid,
  inbound_col_in_review uuid,
  inbound_col_done uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_installation_id IS NULL OR p_installation_id <= 0 OR p_repo_full_name IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT b.org_id, b.project_id, b.id, b.channel_connection_id, b.task_key_prefix,
         b.auto_link_mentions, b.auto_link_branch, b.inbound_in_progress_on_pr, b.inbound_done_on_merge,
         b.inbound_col_in_progress, b.inbound_col_in_review, b.inbound_col_done
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'projects')
  JOIN ludy_projects.github_project_binding b ON b.org_id = c.org_id AND b.channel_connection_id = c.id
  JOIN ludy_projects.project p ON p.org_id = b.org_id AND p.id = b.project_id AND p.status <> 'archived' AND NOT p.is_template
  JOIN ludy_projects.github_project_repo r ON r.org_id = b.org_id AND r.binding_id = b.id
  WHERE c.provider = 'github_app'
    AND c.status = 'active'
    AND c.external_account_id = p_installation_id::text
    AND b.github_enabled = true
    AND b.auto_sync_inbound = true
    AND b.paused_at IS NULL
    AND pg_catalog.lower(r.repo_full_name) = pg_catalog.lower(p_repo_full_name)
  ORDER BY b.org_id, b.project_id;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_pat_org_bindings(p_connection_id uuid, p_repo_full_name text)
RETURNS TABLE (
  org_id uuid,
  project_id uuid,
  binding_id uuid,
  channel_connection_id uuid,
  task_key_prefix text,
  auto_link_mentions boolean,
  auto_link_branch boolean,
  inbound_in_progress_on_pr boolean,
  inbound_done_on_merge boolean,
  inbound_col_in_progress uuid,
  inbound_col_in_review uuid,
  inbound_col_done uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_connection_id IS NULL OR p_repo_full_name IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT b.org_id, b.project_id, b.id, b.channel_connection_id, b.task_key_prefix,
         b.auto_link_mentions, b.auto_link_branch, b.inbound_in_progress_on_pr, b.inbound_done_on_merge,
         b.inbound_col_in_progress, b.inbound_col_in_review, b.inbound_col_done
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'projects')
  JOIN ludy_projects.github_project_binding b ON b.org_id = c.org_id AND b.channel_connection_id = c.id
  JOIN ludy_projects.project p ON p.org_id = b.org_id AND p.id = b.project_id AND p.status <> 'archived' AND NOT p.is_template
  JOIN ludy_projects.github_project_repo r ON r.org_id = b.org_id AND r.binding_id = b.id
  WHERE c.id = p_connection_id
    AND c.provider = 'github_pat'
    AND c.status = 'active'
    AND b.github_enabled = true
    AND b.auto_sync_inbound = true
    AND b.paused_at IS NULL
    AND pg_catalog.lower(r.repo_full_name) = pg_catalog.lower(p_repo_full_name)
  ORDER BY b.org_id, b.project_id;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_sync_delivery_begin(
  p_org_id uuid,
  p_project_id uuid,
  p_direction text,
  p_delivery_id text,
  p_event_type text,
  p_repo_full_name text,
  p_external_number integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_id uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'GITHUB_SYNC_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;

  INSERT INTO ludy_projects.github_sync_delivery (
    org_id, project_id, direction, delivery_id, event_type, repo_full_name, external_number, status
  )
  VALUES (
    p_org_id, p_project_id, p_direction, p_delivery_id, p_event_type, p_repo_full_name, p_external_number, 'queued'
  )
  ON CONFLICT ON CONSTRAINT github_sync_delivery_dedupe_uq DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_sync_delivery_finish(
  p_org_id uuid,
  p_id uuid,
  p_status text,
  p_task_id uuid,
  p_error_code text,
  p_summary text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_SYNC_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'GITHUB_SYNC_ORG_MISMATCH' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_projects.github_sync_delivery d
  SET status = p_status,
      task_id = p_task_id,
      error_code = CASE WHEN p_error_code IS NULL THEN NULL ELSE pg_catalog.left(p_error_code, 64) END,
      summary = CASE WHEN p_summary IS NULL THEN NULL ELSE pg_catalog.left(p_summary, 500) END,
      processed_at = pg_catalog.clock_timestamp()
  WHERE d.org_id = p_org_id AND d.id = p_id;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_sync_delivery_list(p_project_id uuid, p_limit integer DEFAULT 30)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  direction text,
  delivery_id text,
  event_type text,
  repo_full_name text,
  external_number integer,
  task_id uuid,
  status text,
  error_code text,
  summary text,
  received_at timestamptz,
  processed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS NULL THEN
    RAISE EXCEPTION 'GITHUB_SYNC_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT (ludy_projects.actor_bypasses_private_projects() OR ludy_projects.project_visible(v_org, p_project_id)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.id, d.project_id, d.direction, d.delivery_id, d.event_type, d.repo_full_name, d.external_number,
         d.task_id, d.status, d.error_code, d.summary, d.received_at, d.processed_at
  FROM ludy_projects.github_sync_delivery d
  WHERE d.org_id = v_org AND d.project_id = p_project_id
  ORDER BY d.received_at DESC, d.id DESC
  LIMIT v_limit;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_app_installation_handle(
  p_installation_id bigint,
  p_action text,
  p_removed_repo_ids bigint[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'GITHUB_WEBHOOK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_installation_id IS NULL OR p_installation_id <= 0 THEN
    RETURN 0;
  END IF;

  IF p_action IN ('deleted', 'suspend') THEN
    UPDATE ludy_projects.github_project_binding b
    SET paused_reason = CASE WHEN p_action = 'deleted' THEN 'app_uninstalled' ELSE 'app_suspended' END,
        paused_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    FROM ludy_kernel.channel_connection c
    WHERE c.org_id = b.org_id
      AND c.id = b.channel_connection_id
      AND c.provider = 'github_app'
      AND c.external_account_id = p_installation_id::text
      AND c.status = 'active';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF p_action = 'deleted' THEN
      UPDATE ludy_kernel.channel_connection c
      SET status = 'revoked',
          status_reason = 'github_app_uninstalled',
          updated_at = pg_catalog.clock_timestamp()
      WHERE c.provider = 'github_app'
        AND c.external_account_id = p_installation_id::text
        AND c.status = 'active';
    END IF;
    RETURN v_rows;
  END IF;

  IF p_action = 'unsuspend' THEN
    UPDATE ludy_projects.github_project_binding b
    SET paused_reason = NULL,
        paused_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    FROM ludy_kernel.channel_connection c
    WHERE c.org_id = b.org_id
      AND c.id = b.channel_connection_id
      AND c.provider = 'github_app'
      AND c.external_account_id = p_installation_id::text
      AND b.paused_reason = 'app_suspended';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
  END IF;

  IF p_action = 'removed' AND p_removed_repo_ids IS NOT NULL AND pg_catalog.cardinality(p_removed_repo_ids) > 0 THEN
    DELETE FROM ludy_projects.github_project_repo r
    USING ludy_projects.github_project_binding b, ludy_kernel.channel_connection c
    WHERE r.org_id = b.org_id
      AND r.binding_id = b.id
      AND c.org_id = b.org_id
      AND c.id = b.channel_connection_id
      AND c.provider = 'github_app'
      AND c.external_account_id = p_installation_id::text
      AND r.github_repo_id = ANY (p_removed_repo_ids);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
  END IF;

  RETURN 0;
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.github_notice_search_text(p_body bytea)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_text text;
BEGIN
  v_text := pg_catalog.convert_from(p_body, 'UTF8');
  IF pg_catalog.strpos(v_text, '\') > 0 THEN
    BEGIN
      IF pg_catalog.pg_input_is_valid(v_text, 'json') THEN
        RETURN v_text || E'\n' || (v_text::jsonb)::text;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END IF;
  RETURN v_text;
EXCEPTION
  WHEN character_not_in_repertoire THEN
    RETURN '';
END $$;

CREATE OR REPLACE FUNCTION ludy_projects.personal_data_erase_github_notice(p_kind text, p_value text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_rows integer := 0;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (ludy_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  DELETE FROM ludy_projects.github_webhook_notice n
  WHERE n.org_id = v_org
    AND ludy_kernel.text_mentions(ludy_projects.github_notice_search_text(n.body), p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Function privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  ludy_projects.github_project_binding_guard(),
  ludy_projects.github_project_repo_guard(),
  ludy_projects.github_webhook_pending_enqueue(text, text, text, bigint, bytea),
  ludy_projects.github_webhook_sweep(),
  ludy_projects.github_webhook_has_work(),
  ludy_projects.github_webhook_pending_claim(integer, integer),
  ludy_projects.github_webhook_pending_done(bigint),
  ludy_projects.github_webhook_hook_set(uuid, text),
  ludy_projects.github_webhook_hook_status(uuid),
  ludy_projects.github_webhook_hook_find(text),
  ludy_projects.github_webhook_hook_put(uuid, text, integer, text, text, text, bytea),
  ludy_projects.github_webhook_hook_claim(integer),
  ludy_projects.github_webhook_hook_reject(uuid, integer),
  ludy_projects.github_app_org_bindings(bigint, text),
  ludy_projects.github_pat_org_bindings(uuid, text),
  ludy_projects.github_sync_delivery_begin(uuid, uuid, text, text, text, text, integer),
  ludy_projects.github_sync_delivery_finish(uuid, uuid, text, uuid, text, text),
  ludy_projects.github_sync_delivery_list(uuid, integer),
  ludy_projects.github_app_installation_handle(bigint, text, bigint[]),
  ludy_projects.github_notice_search_text(bytea),
  ludy_projects.personal_data_erase_github_notice(text, text)
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
      'REVOKE ALL ON FUNCTION ludy_projects.github_project_binding_guard(), ludy_projects.github_project_repo_guard(), ludy_projects.github_webhook_pending_enqueue(text, text, text, bigint, bytea), ludy_projects.github_webhook_sweep(), ludy_projects.github_webhook_has_work(), ludy_projects.github_webhook_pending_claim(integer, integer), ludy_projects.github_webhook_pending_done(bigint), ludy_projects.github_webhook_hook_set(uuid, text), ludy_projects.github_webhook_hook_status(uuid), ludy_projects.github_webhook_hook_find(text), ludy_projects.github_webhook_hook_put(uuid, text, integer, text, text, text, bytea), ludy_projects.github_webhook_hook_claim(integer), ludy_projects.github_webhook_hook_reject(uuid, integer), ludy_projects.github_app_org_bindings(bigint, text), ludy_projects.github_pat_org_bindings(uuid, text), ludy_projects.github_sync_delivery_begin(uuid, uuid, text, text, text, text, integer), ludy_projects.github_sync_delivery_finish(uuid, uuid, text, uuid, text, text), ludy_projects.github_sync_delivery_list(uuid, integer), ludy_projects.github_app_installation_handle(bigint, text, bigint[]), ludy_projects.github_notice_search_text(bytea), ludy_projects.personal_data_erase_github_notice(text, text) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_projects.github_webhook_pending_enqueue(text, text, text, bigint, bytea),
  ludy_projects.github_webhook_hook_find(text),
  ludy_projects.github_webhook_hook_put(uuid, text, integer, text, text, text, bytea)
TO ludy_app;

GRANT EXECUTE ON FUNCTION
  ludy_projects.github_webhook_hook_set(uuid, text),
  ludy_projects.github_webhook_hook_status(uuid),
  ludy_projects.github_sync_delivery_list(uuid, integer),
  ludy_projects.personal_data_erase_github_notice(text, text)
TO ludy_tenant;

GRANT EXECUTE ON FUNCTION
  ludy_projects.github_webhook_sweep(),
  ludy_projects.github_webhook_has_work(),
  ludy_projects.github_webhook_pending_claim(integer, integer),
  ludy_projects.github_webhook_pending_done(bigint),
  ludy_projects.github_webhook_hook_claim(integer),
  ludy_projects.github_webhook_hook_reject(uuid, integer),
  ludy_projects.github_app_org_bindings(bigint, text),
  ludy_projects.github_pat_org_bindings(uuid, text),
  ludy_projects.github_sync_delivery_begin(uuid, uuid, text, text, text, text, integer),
  ludy_projects.github_sync_delivery_finish(uuid, uuid, text, uuid, text, text),
  ludy_projects.github_app_installation_handle(bigint, text, bigint[])
TO ludy_worker;

-- ---------------------------------------------------------------------------
-- 7. Queues (QUEUES in apps/kernel/src/jobs-schema.ts; create_queue skips existing ones)
-- ---------------------------------------------------------------------------
-- migration-lint: cross-module Projects GitHub integration registers its webhook and hydration pg-boss queues in ludy_jobs
SELECT ludy_jobs.create_queue('projects-github-webhook', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
-- migration-lint: cross-module Projects GitHub integration registers its hydration queue in ludy_jobs
SELECT ludy_jobs.create_queue('projects-github-hydrate', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
