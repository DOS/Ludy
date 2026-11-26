-- SPDX-License-Identifier: AGPL-3.0-only
-- Native push registrations for the mobile app (#4883, ADR-0059):
--   * ludy_kernel.native_push_device stores a member's APNs/FCM token bound to their signed-in session_id,
--     indexed via fixed-size token_sha256 (avoiding B-tree key-size limits on 4096-char tokens) and versioned via
--     generation (preventing stale worker responses from penalizing or dropping rotated tokens).
--   * Each member sees and deletes only their own devices (RESTRICTIVE own_native_push_device using ctx_user_id());
--     tokens are sensitive and never leave SQL to API queries or logs.
--   * Triggers delete rows automatically on session revoke, org-scoped session revoke, user disable, and member removal;
--     native_push_claim_token unlinks any prior user's stale row holding the same physical (platform, token) on handoff.
--   * Worker definers claim unread recent kernel.conversation_new / kernel.approval_waiting notifications and load active
--     session-verified targets with live conversation / legal-entity read access checks.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_kernel.native_push_device (
  org_id        uuid NOT NULL,
  id            uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id       uuid NOT NULL,
  session_id    uuid NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('apns', 'fcm')),
  token         text NOT NULL CHECK (pg_catalog.char_length(token) BETWEEN 16 AND 4096 AND token !~ '[[:space:]]'),
  token_sha256  text NOT NULL DEFAULT '' CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  label         text CHECK (label IS NULL OR pg_catalog.char_length(label) <= 120),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  generation    integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  created_at    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  refreshed_at  timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_used_at  timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT native_push_device_member_fk FOREIGN KEY (org_id, user_id)
    REFERENCES ludy_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT native_push_device_session_unique UNIQUE (org_id, user_id, session_id, platform),
  CONSTRAINT native_push_device_token_unique UNIQUE (org_id, user_id, platform, token_sha256)
);

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_device_sync_token_sha256()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.token_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.token, 'UTF8')), 'hex');
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_device_sync_token_sha256()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS native_push_device_token_hash ON ludy_kernel.native_push_device;
CREATE TRIGGER native_push_device_token_hash
  BEFORE INSERT OR UPDATE OF token, token_sha256 ON ludy_kernel.native_push_device
  FOR EACH ROW
  EXECUTE FUNCTION ludy_kernel.native_push_device_sync_token_sha256();

CREATE INDEX IF NOT EXISTS native_push_device_session_idx
  ON ludy_kernel.native_push_device (user_id, session_id);

CREATE INDEX IF NOT EXISTS native_push_device_token_lookup_idx
  ON ludy_kernel.native_push_device (platform, token_sha256);

SELECT ludy_kernel.apply_tenant_rls('ludy_kernel.native_push_device');
REVOKE UPDATE ON ludy_kernel.native_push_device FROM ludy_tenant;
GRANT UPDATE (token, label, failure_count, last_used_at, generation, refreshed_at) ON ludy_kernel.native_push_device TO ludy_tenant;

DROP POLICY IF EXISTS own_native_push_device ON ludy_kernel.native_push_device;
CREATE POLICY own_native_push_device ON ludy_kernel.native_push_device AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR ((SELECT ludy_kernel.ctx_actor_type()) = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()))
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR ((SELECT ludy_kernel.ctx_actor_type()) = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()))
  );

-- Partial indexes keeping per-org and cross-org pending notification claims off full notification table scans.
CREATE INDEX IF NOT EXISTS notification_native_push_pending_idx
  ON ludy_kernel.notification (org_id, created_at, id)
  WHERE read_at IS NULL AND kind IN ('kernel.conversation_new', 'kernel.approval_waiting');

CREATE INDEX IF NOT EXISTS notification_native_push_recent_idx
  ON ludy_kernel.notification (created_at, id)
  WHERE read_at IS NULL AND kind IN ('kernel.conversation_new', 'kernel.approval_waiting');

CREATE TABLE IF NOT EXISTS ludy_kernel.native_push_sent (
  org_id          uuid NOT NULL,
  id              uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  notification_id uuid NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT native_push_sent_once UNIQUE (org_id, notification_id),
  CONSTRAINT native_push_sent_notification_fk FOREIGN KEY (org_id, notification_id)
    REFERENCES ludy_kernel.notification (org_id, id) ON DELETE CASCADE
);

ALTER TABLE ludy_kernel.native_push_sent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ludy_kernel.native_push_sent FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.native_push_sent');

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_device_on_session_revoked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status = 'revoked' THEN
    DELETE FROM ludy_kernel.native_push_device d
    WHERE d.user_id = NEW.user_id AND d.session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_device_on_session_revoked()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS native_push_device_revoke ON ludy_kernel.auth_session;
CREATE TRIGGER native_push_device_revoke
  AFTER INSERT OR UPDATE OF status ON ludy_kernel.auth_session
  FOR EACH ROW WHEN (NEW.status = 'revoked')
  EXECUTE FUNCTION ludy_kernel.native_push_device_on_session_revoked();

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_device_on_org_session_revoked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status = 'revoked' THEN
    DELETE FROM ludy_kernel.native_push_device d
    WHERE d.org_id = NEW.org_id AND d.user_id = NEW.user_id AND d.session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_device_on_org_session_revoked()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS native_push_device_org_revoke ON ludy_kernel.auth_session_org;
CREATE TRIGGER native_push_device_org_revoke
  AFTER INSERT OR UPDATE OF status ON ludy_kernel.auth_session_org
  FOR EACH ROW WHEN (NEW.status = 'revoked')
  EXECUTE FUNCTION ludy_kernel.native_push_device_on_org_session_revoked();

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_device_on_user_disabled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.disabled_at IS NOT NULL THEN
    DELETE FROM ludy_kernel.native_push_device d
    WHERE d.user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_device_on_user_disabled()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS native_push_device_user_disable ON ludy_kernel.user_account;
CREATE TRIGGER native_push_device_user_disable
  AFTER INSERT OR UPDATE OF disabled_at ON ludy_kernel.user_account
  FOR EACH ROW WHEN (NEW.disabled_at IS NOT NULL)
  EXECUTE FUNCTION ludy_kernel.native_push_device_on_user_disabled();

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_session_active(p_org_id uuid, p_user_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_org_id IS NULL OR p_user_id IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;
  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM p_org_id
     OR ludy_kernel.ctx_user_id() IS DISTINCT FROM p_user_id THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM ludy_kernel.user_account u
    WHERE u.id = p_user_id AND u.disabled_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM ludy_kernel.auth_session s
    WHERE s.user_id = p_user_id AND s.session_id = p_session_id AND s.status = 'revoked'
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM ludy_kernel.auth_session_org o
    WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id AND o.status = 'revoked'
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_session_active(uuid, uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.native_push_session_active(uuid, uuid, uuid) TO ludy_tenant;

-- Unlinks any prior user's stale registration for the same physical OS push token (e.g., offline sign-out on a shared
-- phone) before the newly signed-in user registers it, while keeping multi-org devices of the same user_id intact.
CREATE OR REPLACE FUNCTION ludy_kernel.native_push_claim_token(
  p_org_id uuid,
  p_user_id uuid,
  p_platform text,
  p_token text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sha256 text;
BEGIN
  IF p_org_id IS NULL OR p_user_id IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM p_org_id
     OR ludy_kernel.ctx_user_id() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'NATIVE_PUSH_USER_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_platform NOT IN ('apns', 'fcm')
     OR p_token IS NULL
     OR pg_catalog.char_length(p_token) NOT BETWEEN 16 AND 4096
     OR p_token ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'NATIVE_PUSH_TOKEN_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant t
    JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id AND m.user_id = p_user_id
    JOIN ludy_kernel.user_account u ON u.id = m.user_id
    WHERE t.org_id = p_org_id AND t.status = 'active' AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NATIVE_PUSH_NOT_MEMBER' USING ERRCODE = '42501';
  END IF;

  v_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  DELETE FROM ludy_kernel.native_push_device d
  WHERE d.platform = p_platform
    AND d.token_sha256 = v_sha256
    AND d.token = p_token
    AND d.user_id <> p_user_id;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_claim_token(uuid, uuid, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.native_push_claim_token(uuid, uuid, text, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_claim(p_limit integer DEFAULT 100, p_org_id uuid DEFAULT NULL)
 RETURNS TABLE(org_id uuid, notification_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NATIVE_PUSH_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_org_id IS NULL THEN
    RETURN QUERY
    WITH candidate AS (
      SELECT n.org_id, n.id AS notification_id
      FROM ludy_kernel.notification n
      JOIN ludy_kernel.tenant t ON t.org_id = n.org_id AND t.status = 'active'
      JOIN ludy_kernel.tenant_member m ON m.org_id = n.org_id AND m.user_id = n.user_id
      JOIN ludy_kernel.user_account u ON u.id = n.user_id AND u.disabled_at IS NULL
      WHERE n.kind IN ('kernel.conversation_new', 'kernel.approval_waiting')
        AND n.read_at IS NULL
        AND n.created_at >= pg_catalog.now() - interval '24 hours'
        AND m.role <> 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM ludy_kernel.native_push_sent s
          WHERE s.org_id = n.org_id AND s.notification_id = n.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ludy_kernel.notification_mute nm
          WHERE nm.org_id = n.org_id AND nm.user_id = n.user_id AND nm.kind = n.kind
        )
        AND (
          n.kind <> 'kernel.approval_waiting'
          OR (
            n.subject_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM ludy_kernel.proposal p
              WHERE p.org_id = n.org_id AND p.id = n.subject_id AND p.status = 'pending'
            )
          )
        )
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.native_push_device d
          WHERE d.org_id = n.org_id
            AND d.user_id = n.user_id
            AND d.failure_count < 10
            AND n.created_at >= d.created_at
            AND NOT EXISTS (
              SELECT 1 FROM ludy_kernel.auth_session s
              WHERE s.user_id = d.user_id AND s.session_id = d.session_id AND s.status = 'revoked'
            )
            AND NOT EXISTS (
              SELECT 1 FROM ludy_kernel.auth_session_org o
              WHERE o.org_id = d.org_id AND o.user_id = d.user_id AND o.session_id = d.session_id AND o.status = 'revoked'
            )
        )
      ORDER BY n.created_at ASC, n.id ASC
      LIMIT v_limit
      FOR UPDATE OF n SKIP LOCKED
    ),
    claimed AS (
      INSERT INTO ludy_kernel.native_push_sent (org_id, notification_id)
      SELECT c.org_id, c.notification_id FROM candidate c
      ON CONFLICT ON CONSTRAINT native_push_sent_once DO NOTHING
      RETURNING org_id, notification_id
    )
    SELECT cl.org_id, cl.notification_id FROM claimed cl;
  ELSE
    RETURN QUERY
    WITH candidate AS (
      SELECT n.org_id, n.id AS notification_id
      FROM ludy_kernel.notification n
      JOIN ludy_kernel.tenant t ON t.org_id = n.org_id AND t.status = 'active'
      JOIN ludy_kernel.tenant_member m ON m.org_id = n.org_id AND m.user_id = n.user_id
      JOIN ludy_kernel.user_account u ON u.id = n.user_id AND u.disabled_at IS NULL
      WHERE n.org_id = p_org_id
        AND n.kind IN ('kernel.conversation_new', 'kernel.approval_waiting')
        AND n.read_at IS NULL
        AND n.created_at >= pg_catalog.now() - interval '24 hours'
        AND m.role <> 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM ludy_kernel.native_push_sent s
          WHERE s.org_id = n.org_id AND s.notification_id = n.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ludy_kernel.notification_mute nm
          WHERE nm.org_id = n.org_id AND nm.user_id = n.user_id AND nm.kind = n.kind
        )
        AND (
          n.kind <> 'kernel.approval_waiting'
          OR (
            n.subject_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM ludy_kernel.proposal p
              WHERE p.org_id = n.org_id AND p.id = n.subject_id AND p.status = 'pending'
            )
          )
        )
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.native_push_device d
          WHERE d.org_id = n.org_id
            AND d.user_id = n.user_id
            AND d.failure_count < 10
            AND n.created_at >= d.created_at
            AND NOT EXISTS (
              SELECT 1 FROM ludy_kernel.auth_session s
              WHERE s.user_id = d.user_id AND s.session_id = d.session_id AND s.status = 'revoked'
            )
            AND NOT EXISTS (
              SELECT 1 FROM ludy_kernel.auth_session_org o
              WHERE o.org_id = d.org_id AND o.user_id = d.user_id AND o.session_id = d.session_id AND o.status = 'revoked'
            )
        )
      ORDER BY n.created_at ASC, n.id ASC
      LIMIT v_limit
      FOR UPDATE OF n SKIP LOCKED
    ),
    claimed AS (
      INSERT INTO ludy_kernel.native_push_sent (org_id, notification_id)
      SELECT c.org_id, c.notification_id FROM candidate c
      ON CONFLICT ON CONSTRAINT native_push_sent_once DO NOTHING
      RETURNING org_id, notification_id
    )
    SELECT cl.org_id, cl.notification_id FROM claimed cl;
  END IF;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_claim(integer, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.native_push_claim(integer, uuid) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_device_session_valid(
  p_org_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_refreshed_at timestamptz,
  p_disabled_at timestamptz,
  p_subject text,
  p_check_upstream boolean
)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p_disabled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ludy_kernel.auth_session s
      WHERE s.user_id = p_user_id AND s.session_id = p_session_id AND s.status = 'revoked'
    )
    AND NOT EXISTS (
      SELECT 1 FROM ludy_kernel.auth_session_org o
      WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id AND o.status = 'revoked'
    )
    AND (
      CASE
        WHEN p_check_upstream
             AND p_subject ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN ludy_kernel.auth_session_valid(p_session_id, p_subject::uuid)
        WHEN NOT p_check_upstream
          THEN GREATEST(
            p_refreshed_at,
            coalesce((
              SELECT ao.last_seen_at FROM ludy_kernel.auth_session_org ao
              WHERE ao.org_id = p_org_id AND ao.user_id = p_user_id AND ao.session_id = p_session_id
            ), p_refreshed_at)
          ) >= pg_catalog.now() - interval '30 days'
        ELSE false
      END
    );
$$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_device_session_valid(uuid, uuid, uuid, timestamptz, timestamptz, text, boolean)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_kernel.native_push_targets(
  p_notification_id uuid,
  p_check_upstream boolean DEFAULT false
)
 RETURNS TABLE(
   user_id uuid,
   org_slug text,
   kind text,
   subject_id uuid,
   device_id uuid,
   generation integer,
   platform text,
   token text,
   session_valid boolean
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_auth_ready boolean := ludy_kernel.auth_grants_ready();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NATIVE_PUSH_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NATIVE_PUSH_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_check_upstream AND NOT v_auth_ready THEN
    RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT
    n.user_id AS user_id,
    t.slug AS org_slug,
    n.kind AS kind,
    n.subject_id AS subject_id,
    d.id AS device_id,
    d.generation AS generation,
    d.platform AS platform,
    d.token AS token,
    ludy_kernel.native_push_device_session_valid(
      d.org_id,
      d.user_id,
      d.session_id,
      d.refreshed_at,
      u.disabled_at,
      u.subject,
      p_check_upstream
    ) AS session_valid
  FROM ludy_kernel.notification n
  JOIN ludy_kernel.tenant t ON t.org_id = n.org_id AND t.status = 'active'
  JOIN ludy_kernel.tenant_member m ON m.org_id = n.org_id AND m.user_id = n.user_id
  JOIN ludy_kernel.user_account u ON u.id = n.user_id
  JOIN ludy_kernel.native_push_device d ON d.org_id = n.org_id AND d.user_id = n.user_id
  WHERE n.org_id = v_org
    AND n.id = p_notification_id
    AND n.kind IN ('kernel.conversation_new', 'kernel.approval_waiting')
    AND n.read_at IS NULL
    AND n.created_at >= pg_catalog.now() - interval '24 hours'
    AND m.role <> 'viewer'
    AND d.failure_count < 10
    AND n.created_at >= d.created_at
    AND NOT EXISTS (
      SELECT 1 FROM ludy_kernel.notification_mute nm
      WHERE nm.org_id = n.org_id AND nm.user_id = n.user_id AND nm.kind = n.kind
    )
    AND (
      n.kind <> 'kernel.conversation_new'
      OR n.subject_id IS NULL
      OR EXISTS (
        SELECT 1 FROM ludy_kernel.conversation_readers(n.subject_id) cr
        WHERE cr.user_id = n.user_id
      )
    )
    AND (
      n.kind <> 'kernel.approval_waiting'
      OR (
        n.subject_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.proposal p
          WHERE p.org_id = n.org_id
            AND p.id = n.subject_id
            AND p.status = 'pending'
            AND (
              m.role IN ('owner', 'admin')
              OR NOT EXISTS (
                SELECT 1 FROM ludy_kernel.role_assignment ra
                WHERE ra.org_id = m.org_id AND ra.user_id = m.user_id
              )
              OR EXISTS (
                SELECT 1 FROM ludy_kernel.role_assignment ra
                WHERE ra.org_id = m.org_id
                  AND ra.user_id = m.user_id
                  AND (ra.legal_entity_id IS NULL OR ra.legal_entity_id = p.legal_entity_id)
              )
            )
        )
      )
    )
  ORDER BY d.created_at ASC, d.id ASC;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_targets(uuid, boolean)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.native_push_targets(uuid, boolean) TO ludy_worker;

-- Conditionally evicts devices whose session appeared expired at claim/target time ONLY if the session is still
-- invalid when recording completes (a concurrent same-token refresh updates refreshed_at without changing generation).
CREATE OR REPLACE FUNCTION ludy_kernel.native_push_evict_expired(
  p_device_ids uuid[],
  p_generations integer[],
  p_check_upstream boolean DEFAULT false
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_deleted integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NATIVE_PUSH_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NATIVE_PUSH_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_check_upstream AND NOT ludy_kernel.auth_grants_ready() THEN
    RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
  END IF;
  IF coalesce(pg_catalog.array_length(p_device_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH pairs AS (
    SELECT DISTINCT u.device_id, u.generation
    FROM ROWS FROM (pg_catalog.unnest(p_device_ids), pg_catalog.unnest(p_generations)) AS u(device_id, generation)
  ),
  deleted AS (
    DELETE FROM ludy_kernel.native_push_device d
    USING pairs p, ludy_kernel.user_account ua
    WHERE d.org_id = v_org
      AND d.id = p.device_id
      AND d.generation = p.generation
      AND ua.id = d.user_id
      AND NOT ludy_kernel.native_push_device_session_valid(
        d.org_id,
        d.user_id,
        d.session_id,
        d.refreshed_at,
        ua.disabled_at,
        ua.subject,
        p_check_upstream
      )
    RETURNING d.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_deleted FROM deleted;

  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.native_push_evict_expired(uuid[], integer[], boolean)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.native_push_evict_expired(uuid[], integer[], boolean) TO ludy_worker;

-- One job per claimed notification (singleton key: the notification's id). create_queue skips a queue that exists.
SELECT ludy_jobs.create_queue('kernel-native-push', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
