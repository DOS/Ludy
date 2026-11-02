-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations CV6 (issue #2305, plan docs/plan/conversations.md, ADR-0041): how long customers' messages are
-- kept, and how they leave on request. Idempotent; applied files stay untouched.
--
-- 1. crove_kernel.conversation_setting: the org's one row of conversation settings. Today only the retention: how many months
--    a thread is kept after its last message (6, 12 or 24; NULL keeps threads until a person deletes them). With no row the
--    deployment default (24 months) applies. Only an owner or admin of the org (or the system) writes it.
-- 2. crove_kernel.channel_connection.granted_by_hash: a keyed hash (HMAC-SHA256 under the deployment's Meta app secret) of the
--    Meta user who granted a connection, set by the connector when it links the account. Meta's data deletion callback gets a
--    user id and can only ask "which connections did this person grant"; the id itself is stored nowhere (as Ads does, A3).
-- 3. crove_kernel.conversation_deletion_request and its five definers: a global machinery table (no org_id, nothing about an
--    org) for the one Meta data deletion callback. The API checks Meta's signature, then writes a confirmation code and the
--    keyed hash; the worker claims the requests, erases the conversations of the connections that hash names in each org and
--    marks the request completed; the status page reads it by the code. Only the definers touch it.
-- 4. crove_kernel.conversation_purge_due: the orgs that hold a thread past their retention, or an old erase tombstone, for the
--    worker's daily purge.
-- 5. crove_kernel.conversation_identity.erased_at: the tombstone of an erased customer (#2348). The identity row stays, with no name and
--    no party, and the intake refuses any message of that customer dated at or before the erasure, so a signed body captured and
--    replayed (Zalo and Meta resend, and a body is a bearer token for 24 hours) cannot bring an erased message back. A message dated
--    later is the customer writing again and is taken. The retention job drops a tombstone after 30 days, longer than any redelivery.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 5. The tombstone of an erased customer
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.conversation_identity ADD COLUMN IF NOT EXISTS erased_at timestamptz;
GRANT UPDATE (erased_at) ON crove_kernel.conversation_identity TO crove_tenant;
CREATE INDEX IF NOT EXISTS conversation_identity_erased_idx ON crove_kernel.conversation_identity (erased_at) WHERE erased_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. The org's conversation settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Months a thread is kept after its last message; NULL keeps it until a person deletes it.
  -- Written as a chain of equalities: the numbers are the product's (CONVERSATION_RETENTION_MONTHS), not a text set schema.ts refines.
  retention_months smallint DEFAULT 24 CHECK (retention_months IS NULL OR retention_months = 6 OR retention_months = 12 OR retention_months = 24),
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_setting_org_uq UNIQUE (org_id),
  CONSTRAINT conversation_setting_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS conversation_setting_set_by_idx ON crove_kernel.conversation_setting (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_setting');
REVOKE UPDATE ON crove_kernel.conversation_setting FROM crove_tenant;
GRANT UPDATE (retention_months, set_by, updated_at) ON crove_kernel.conversation_setting TO crove_tenant;
-- Every member of the org reads it (the screen shows the retention); only an owner or admin, or the system, writes it.
DROP POLICY IF EXISTS conversation_setting_insert ON crove_kernel.conversation_setting;
CREATE POLICY conversation_setting_insert ON crove_kernel.conversation_setting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS conversation_setting_update ON crove_kernel.conversation_setting;
CREATE POLICY conversation_setting_update ON crove_kernel.conversation_setting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS conversation_setting_delete ON crove_kernel.conversation_setting;
CREATE POLICY conversation_setting_delete ON crove_kernel.conversation_setting AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- ---------------------------------------------------------------------------
-- 2. Who granted a connection (keyed hash of the Meta user id)
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS granted_by_hash text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'channel_connection_granted_by_hash_ck' AND conrelid = 'crove_kernel.channel_connection'::regclass) THEN
    ALTER TABLE crove_kernel.channel_connection ADD CONSTRAINT channel_connection_granted_by_hash_ck CHECK (granted_by_hash IS NULL OR granted_by_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS channel_connection_granted_by_idx ON crove_kernel.channel_connection (granted_by_hash) WHERE granted_by_hash IS NOT NULL;
GRANT UPDATE (granted_by_hash) ON crove_kernel.channel_connection TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Meta's data deletion requests, for the conversations of the connections a person granted
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_deletion_request (
  code text PRIMARY KEY CHECK (code ~ '^[0-9a-f]{32}$'),
  user_hash text NOT NULL CHECK (user_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  connections integer CHECK (connections IS NULL OR connections >= 0),
  -- A request whose erasure failed waits until this time before the worker claims it again.
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_deletion_open_hash_uq ON crove_kernel.conversation_deletion_request (user_hash) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_deletion_open_idx ON crove_kernel.conversation_deletion_request (next_attempt_at, requested_at) WHERE completed_at IS NULL;
REVOKE ALL ON crove_kernel.conversation_deletion_request FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.conversation_deletion_request ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.conversation_deletion_request');

-- Records a verified request (API login only); with p_code a code the caller chose, a person with a request still open gets
-- that request's code. With 100000 rows it raises 53400, which the API answers with 503 and Meta retries.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_deletion_enqueue(p_code text, p_user_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
  v_code text;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9a-f]{32}$' OR p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'CONVERSATION_DELETION_INVALID' USING ERRCODE = '22P02';
  END IF;
  SELECT r.code INTO v_code FROM crove_kernel.conversation_deletion_request r WHERE r.user_hash = p_user_hash AND r.completed_at IS NULL;
  IF FOUND THEN
    RETURN v_code;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_kernel.conversation_deletion_request LIMIT 100001) s) > 100000 THEN
    RAISE EXCEPTION 'CONVERSATION_DELETION_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_kernel.conversation_deletion_request (code, user_hash) VALUES (p_code, p_user_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
    RETURN p_code;
  END IF;
  SELECT r.code INTO v_code FROM crove_kernel.conversation_deletion_request r WHERE r.code = p_code OR (r.user_hash = p_user_hash AND r.completed_at IS NULL) ORDER BY (r.code = p_code) DESC LIMIT 1;
  RETURN v_code;
END $$;

-- What the status page shows for a code (API login only); no row, no answer.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_deletion_status(p_code text)
RETURNS TABLE (requested_at timestamptz, completed_at timestamptz, connections integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.requested_at, r.completed_at, r.connections FROM crove_kernel.conversation_deletion_request r WHERE r.code = p_code AND p_code ~ '^[0-9a-f]{32}$'
$$;

-- The worker's claim: for each open request that is due, one row per connection of an org that is not closed that the request's
-- hash granted, and one row with null ids for a request that names none. Nothing is deleted here (a worker that dies leaves
-- the request open, and the erasure it asks for is idempotent). At most p_limit requests, the longest waiting first.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_deletion_claim(p_limit integer)
RETURNS TABLE (code text, org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH due AS (
    SELECT q.code, q.user_hash FROM crove_kernel.conversation_deletion_request q
    WHERE q.completed_at IS NULL AND q.next_attempt_at <= pg_catalog.now()
    ORDER BY q.next_attempt_at, q.requested_at, q.code LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  )
  SELECT d.code, c.org_id, c.id
  FROM due d
  JOIN crove_kernel.channel_connection c ON c.granted_by_hash = d.user_hash
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding')
  UNION ALL
  SELECT d.code, NULL::uuid, NULL::uuid FROM due d
  WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.channel_connection c JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding') WHERE c.granted_by_hash = d.user_hash)
$$;

-- Marks a request completed (worker login only), and drops the completed ones older than 90 days.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_deletion_complete(p_code text, p_connections integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.conversation_deletion_request r SET completed_at = pg_catalog.now(), connections = GREATEST(p_connections, 0) WHERE r.code = p_code AND r.completed_at IS NULL;
  DELETE FROM crove_kernel.conversation_deletion_request r WHERE r.completed_at < pg_catalog.now() - interval '90 days';
END $$;

-- A request whose erasure failed waits five minutes before the worker claims it again (worker login only).
CREATE OR REPLACE FUNCTION crove_kernel.conversation_deletion_defer(p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.conversation_deletion_request r SET next_attempt_at = pg_catalog.now() + interval '5 minutes' WHERE r.code = p_code AND r.completed_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_deletion_enqueue(text, text), crove_kernel.conversation_deletion_status(text),
  crove_kernel.conversation_deletion_claim(integer), crove_kernel.conversation_deletion_complete(text, integer), crove_kernel.conversation_deletion_defer(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_deletion_enqueue(text, text), crove_kernel.conversation_deletion_status(text) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_deletion_claim(integer), crove_kernel.conversation_deletion_complete(text, integer), crove_kernel.conversation_deletion_defer(text) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 4. The orgs that hold a thread past their retention (worker login only)
-- ---------------------------------------------------------------------------
-- A thread is past it when its last message (its opening, with none) is older than the org's retention months; an org with no
-- settings row has 24 months, and one that chose to keep everything (NULL) has none. Only active orgs: a closing org's
-- conversations go with the org purge. The oldest thread first, at most p_limit orgs.
CREATE INDEX IF NOT EXISTS conversation_age_idx ON crove_kernel.conversation ((COALESCE(last_message_at, opened_at)));
CREATE OR REPLACE FUNCTION crove_kernel.conversation_purge_due(p_limit integer)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.org_id FROM (
    SELECT c.org_id, pg_catalog.min(COALESCE(c.last_message_at, c.opened_at)) AS oldest
    FROM crove_kernel.conversation c
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
    LEFT JOIN crove_kernel.conversation_setting s ON s.org_id = c.org_id
    WHERE COALESCE(c.last_message_at, c.opened_at) < pg_catalog.now() - pg_catalog.make_interval(months => CASE WHEN s.id IS NULL THEN 24 ELSE s.retention_months::integer END)
    GROUP BY c.org_id
    UNION ALL
    -- An org with an erase tombstone older than 30 days, whatever its retention.
    SELECT i.org_id, pg_catalog.min(i.erased_at)
    FROM crove_kernel.conversation_identity i
    JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
    WHERE i.erased_at < pg_catalog.now() - interval '30 days'
    GROUP BY i.org_id
  ) d
  GROUP BY d.org_id
  ORDER BY pg_catalog.min(d.oldest), d.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_purge_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_purge_due(integer) TO crove_worker;
