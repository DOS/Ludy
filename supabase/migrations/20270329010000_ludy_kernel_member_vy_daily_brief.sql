-- SPDX-License-Identifier: AGPL-3.0-only
-- Narrow system-started daily run support for member-scoped Vy (#5073, ADR-0049 decisions 1 and 6 amendment):
--   member_vy_system_feature      migration-only catalog of member-Vy features a system run may start (seeded with meetings.brief_daily only);
--                                 read-only SELECT for ludy_tenant, zero write grants to PUBLIC or any non-owner role, protected by agent_write_guard;
--   agent_member_vy_bind          admits ctx_actor_type() = 'system' creating a member_vy agent (template_key 'kernel.member_vy') only when
--                                 member_vy_system_feature is non-empty and member_vy_member_active(org_id, member_user_id) holds;
--   ai_run_member_vy_bind         admits ctx_actor_type() = 'system' starting a member_vy run only when (feature, module) is listed in
--                                 member_vy_system_feature and member_vy_member_active(org_id, member_user_id) holds;
--   member_vy_result policies     split member_only into member_read, member_insert (TO ludy_tenant, zero worker-only helper references),
--                                 member_insert_system (AS RESTRICTIVE FOR INSERT TO ludy_worker, enforcing status = 'running', body IS NULL,
--                                 feature in member_vy_system_feature, and member_vy_member_active), member_update, and member_delete;
--   member_vy_result_bind         independently enforces the same system insert/update contract inside SECURITY DEFINER even if RLS is off.
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_kernel.member_vy_system_feature (
  feature text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]*$' AND pg_catalog.split_part(feature, '.', 1) = module),
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
REVOKE ALL ON TABLE ludy_kernel.member_vy_system_feature FROM PUBLIC;
REVOKE ALL ON TABLE ludy_kernel.member_vy_system_feature FROM ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_prober, ludy_reporter, ludy_auth_reader;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\'
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_kernel.member_vy_system_feature FROM %I', v_role);
  END LOOP;
END
$$;
GRANT SELECT ON TABLE ludy_kernel.member_vy_system_feature TO ludy_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.member_vy_system_feature');

INSERT INTO ludy_kernel.member_vy_system_feature (feature, module, adr)
VALUES ('meetings.brief_daily', 'meetings', 'ADR-0049')
ON CONFLICT (feature) DO NOTHING;

CREATE OR REPLACE FUNCTION ludy_kernel.agent_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'member_vy' THEN
      IF NEW.template_key IS DISTINCT FROM 'kernel.member_vy' THEN
        RAISE EXCEPTION 'MEMBER_VY_AGENT_BINDING' USING ERRCODE = '42501';
      END IF;
      IF ludy_kernel.ctx_actor_type() = 'user' THEN
        IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
           OR NEW.member_user_id IS DISTINCT FROM ludy_kernel.ctx_user_id() THEN
          RAISE EXCEPTION 'MEMBER_VY_AGENT_BINDING' USING ERRCODE = '42501';
        END IF;
      ELSIF ludy_kernel.ctx_actor_type() = 'system' THEN
        IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
           OR NOT EXISTS (SELECT 1 FROM ludy_kernel.member_vy_system_feature)
           OR NOT ludy_kernel.member_vy_member_active(NEW.org_id, NEW.member_user_id) THEN
          RAISE EXCEPTION 'MEMBER_VY_AGENT_BINDING' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'MEMBER_VY_AGENT_BINDING' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.member_user_id IS DISTINCT FROM OLD.member_user_id
     OR (OLD.kind = 'member_vy' AND NEW.template_key IS DISTINCT FROM OLD.template_key) THEN
    RAISE EXCEPTION 'MEMBER_VY_AGENT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.agent_member_vy_bind() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DROP TRIGGER IF EXISTS member_vy_bind ON ludy_kernel.agent;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE ON ludy_kernel.agent
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.agent_member_vy_bind();

CREATE OR REPLACE FUNCTION ludy_kernel.ai_run_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_member uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
       OR NEW.module IS DISTINCT FROM OLD.module
       OR NEW.feature IS DISTINCT FROM OLD.feature THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    IF (NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.started_at IS DISTINCT FROM OLD.started_at)
       AND EXISTS (SELECT 1 FROM ludy_kernel.agent a WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy')
       AND (NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.expires_at > OLD.started_at + interval '4 hours') THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.member_user_id INTO v_member FROM ludy_kernel.agent a
  WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy';
  IF v_member IS NOT NULL THEN
    IF ludy_kernel.ctx_actor_type() = 'user' THEN
      IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
         OR v_member IS DISTINCT FROM ludy_kernel.ctx_user_id()
         OR EXISTS (SELECT 1 FROM ludy_kernel.member_vy_system_feature f WHERE f.feature = NEW.feature) THEN
        RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
      END IF;
    ELSIF ludy_kernel.ctx_actor_type() = 'system' THEN
      IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
         OR NOT EXISTS (
           SELECT 1 FROM ludy_kernel.member_vy_system_feature f
           WHERE f.feature = NEW.feature AND f.module = NEW.module
         )
         OR NOT ludy_kernel.member_vy_member_active(NEW.org_id, v_member) THEN
        RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    IF NEW.expires_at > NEW.started_at + interval '4 hours' THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
    IF NEW.feature IS NULL THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_FEATURE' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.feature IS NOT NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_RUN_FEATURE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.ai_run_member_vy_bind() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DROP TRIGGER IF EXISTS member_vy_bind ON ludy_kernel.ai_run;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE OF agent_id, module, feature, started_at, expires_at ON ludy_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.ai_run_member_vy_bind();

CREATE OR REPLACE FUNCTION ludy_kernel.member_vy_result_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_body jsonb;
BEGIN
  IF TG_OP = 'INSERT' AND ludy_kernel.ctx_actor_type() = 'system' THEN
    IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
       OR NEW.status IS DISTINCT FROM 'running'
       OR NEW.body IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM ludy_kernel.ai_run r
         JOIN ludy_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
         JOIN ludy_kernel.member_vy_system_feature f ON f.feature = NEW.feature AND f.module = r.module
         WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND a.kind = 'member_vy'
           AND a.member_user_id = NEW.member_user_id AND r.feature = NEW.feature
       )
       OR NOT ludy_kernel.member_vy_member_active(NEW.org_id, NEW.member_user_id) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "member_vy_result"' USING ERRCODE = '42501', HINT = 'MEMBER_VY_RESULT_RUN_MISMATCH';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM ludy_kernel.ai_run r
      JOIN ludy_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
      WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND a.kind = 'member_vy' AND a.member_user_id = NEW.member_user_id AND r.feature = NEW.feature) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "member_vy_result"' USING ERRCODE = '42501', HINT = 'MEMBER_VY_RESULT_RUN_MISMATCH';
    END IF;
    -- System updates occur only via SECURITY DEFINER run completion/cancel definers failing an already-running row (zero body, zero ready writes).
    IF TG_OP = 'UPDATE' AND ludy_kernel.ctx_actor_type() = 'system' THEN
      IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
         OR OLD.status IS DISTINCT FROM 'running'
         OR NEW.status IS DISTINCT FROM 'failed'
         OR NEW.body IS NOT NULL
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.member_user_id IS DISTINCT FROM OLD.member_user_id
         OR NEW.run_id IS DISTINCT FROM OLD.run_id
         OR NEW.feature IS DISTINCT FROM OLD.feature
         OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
         OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
         OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
         OR NEW.tainted IS DISTINCT FROM OLD.tainted
         OR NEW.private_read IS DISTINCT FROM OLD.private_read
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'new row violates row-level security policy for table "member_vy_result"' USING ERRCODE = '42501', HINT = 'MEMBER_VY_RESULT_RUN_MISMATCH';
      END IF;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM ludy_kernel.member_vy_system_feature f WHERE f.feature = NEW.feature) THEN
    IF NEW.status = 'ready' THEN
      IF NEW.body IS NULL
         OR pg_catalog.length(NEW.body) < 2
         OR pg_catalog.length(NEW.body) > 160
         OR NEW.body !~ '^\{[[:space:]]*"[a-z_]{1,12}"[[:space:]]*:[[:space:]]*(0|[1-9][0-9]{0,9})([[:space:]]*,[[:space:]]*"[a-z_]{1,12}"[[:space:]]*:[[:space:]]*(0|[1-9][0-9]{0,9}))*[[:space:]]*\}$' THEN
        RAISE EXCEPTION 'MEMBER_VY_RESULT_COUNTS_ONLY' USING ERRCODE = '23514';
      END IF;
      BEGIN
        v_body := NEW.body::jsonb;
      EXCEPTION WHEN data_exception OR invalid_text_representation THEN
        RAISE EXCEPTION 'MEMBER_VY_RESULT_COUNTS_ONLY' USING ERRCODE = '23514';
      END;
      IF pg_catalog.jsonb_typeof(v_body) <> 'object'
         OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_body)) NOT BETWEEN 1 AND 6
         OR pg_catalog.regexp_count(NEW.body, '"[a-z_]{1,12}"[[:space:]]*:')
            IS DISTINCT FROM (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_body))::integer
         OR EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_each(v_body) AS e(k, v)
           WHERE e.k <> ALL (ARRAY['v', 'meetings', 'facts', 'sentences', 'lines', 'dropped'])
              OR pg_catalog.jsonb_typeof(e.v) <> 'number'
              OR (e.v::text) !~ '^(0|[1-9][0-9]{0,9})$'
         ) THEN
        RAISE EXCEPTION 'MEMBER_VY_RESULT_COUNTS_ONLY' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.body IS NOT NULL THEN
      RAISE EXCEPTION 'MEMBER_VY_RESULT_COUNTS_ONLY' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.created_at > pg_catalog.now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_CREATED_IN_FUTURE' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at > LEAST(NEW.created_at, pg_catalog.now()) + interval '31 days' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_EXPIRY_TOO_LONG' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.member_vy_result_bind() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DROP TRIGGER IF EXISTS member_vy_result_bind ON ludy_kernel.member_vy_result;
CREATE TRIGGER member_vy_result_bind BEFORE INSERT OR UPDATE ON ludy_kernel.member_vy_result
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.member_vy_result_bind();

DROP POLICY IF EXISTS member_only ON ludy_kernel.member_vy_result;
DROP POLICY IF EXISTS member_read ON ludy_kernel.member_vy_result;
CREATE POLICY member_read ON ludy_kernel.member_vy_result AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (member_user_id = (SELECT ludy_kernel.ctx_acting_user_id()));
DROP POLICY IF EXISTS member_insert ON ludy_kernel.member_vy_result;
CREATE POLICY member_insert ON ludy_kernel.member_vy_result AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    member_user_id = (SELECT ludy_kernel.ctx_acting_user_id())
    OR (
      ludy_kernel.ctx_actor_type() = 'system'
      AND status = 'running'
      AND body IS NULL
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.member_vy_system_feature f
        WHERE f.feature = member_vy_result.feature
      )
    )
  );
DROP POLICY IF EXISTS member_insert_system ON ludy_kernel.member_vy_result;
CREATE POLICY member_insert_system ON ludy_kernel.member_vy_result AS RESTRICTIVE FOR INSERT TO ludy_worker
  WITH CHECK (
    ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
    OR (
      status = 'running'
      AND body IS NULL
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.member_vy_system_feature f
        WHERE f.feature = member_vy_result.feature
      )
      AND ludy_kernel.member_vy_member_active(org_id, member_user_id)
    )
  );
DROP POLICY IF EXISTS member_update ON ludy_kernel.member_vy_result;
CREATE POLICY member_update ON ludy_kernel.member_vy_result AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (member_user_id = (SELECT ludy_kernel.ctx_acting_user_id()))
  WITH CHECK (member_user_id = (SELECT ludy_kernel.ctx_acting_user_id()));
DROP POLICY IF EXISTS member_delete ON ludy_kernel.member_vy_result;
CREATE POLICY member_delete ON ludy_kernel.member_vy_result AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (member_user_id = (SELECT ludy_kernel.ctx_acting_user_id()));

-- Worker-only cleanup helper for kernel.member_vy.run.start_daily (#5073): system context cannot read member_vy ai_run rows under RLS,
-- so this definer locks any live running run for an explicitly registered system feature, returns false if still unexpired (VY_RUN_BUSY),
-- or closes expired rows via ludy_kernel.member_vy_run_finish so future daily runs are never stranded.
CREATE OR REPLACE FUNCTION ludy_kernel.member_vy_close_expired_system_run(p_agent_id uuid, p_feature text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_run record;
BEGIN
  IF v_org IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_agent_id IS NULL
     OR p_feature IS NULL
     OR NOT EXISTS (SELECT 1 FROM ludy_kernel.member_vy_system_feature f WHERE f.feature = p_feature) THEN
    RAISE EXCEPTION 'MEMBER_VY_SYSTEM_FEATURE' USING ERRCODE = '22023';
  END IF;
  FOR v_run IN
    SELECT r.id, r.expires_at
    FROM ludy_kernel.ai_run r
    JOIN ludy_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
    WHERE r.org_id = v_org
      AND r.agent_id = p_agent_id
      AND r.feature = p_feature
      AND r.status = 'running'
      AND a.kind = 'member_vy'
    ORDER BY r.id
    FOR UPDATE OF r
  LOOP
    IF v_run.expires_at > pg_catalog.now() THEN
      RETURN false;
    END IF;
    BEGIN
      PERFORM ludy_kernel.member_vy_run_finish(v_run.id, NULL, NULL);
    EXCEPTION WHEN invalid_parameter_value THEN
      -- Preserves an already-failed result error_code (e.g. AI_STOPPED) and marks an un-stored running result failed with AGENT_RUN_NOT_LIVE.
      PERFORM ludy_kernel.member_vy_run_finish(v_run.id, NULL, 'AGENT_RUN_NOT_LIVE');
    END;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.member_vy_close_expired_system_run(uuid, text) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.member_vy_close_expired_system_run(uuid, text) TO ludy_worker;
