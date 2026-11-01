-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads A3 (issue #2219, plan docs/plan/ads.md sections 5.3, 9 and 11): deleting an account's history, and Meta's data
-- deletion callback. Idempotent; applied files stay untouched.
--
-- 1. crove_ads.ad_account.granted_by_hash: a keyed hash (HMAC-SHA256 under the deployment's Meta app secret) of the Meta
--    user who granted the connection, set when the account is linked. The callback of section 9 receives a Meta user id and
--    can only ask "which accounts did this person grant"; the id itself is stored nowhere, so a copy of the database says
--    nothing about who the person is. Null for an account linked before this migration or on a platform with no such
--    callback: Meta's request then finds nothing of it, and the owner deletes its history by hand.
-- 2. crove_ads.account_history_delete(): the one way figures and sync runs leave an account (a tenant role may not delete
--    ad_sync_run or ad_account rows). The owner's "delete history" and the callback both go through it: it removes every
--    figure and sync run of the account, resets its cursors (a connected account reads its 13 months again), and, when
--    asked and the connection is closed, the account's own row.
-- 3. crove_ads.deletion_request and its four definers: a global machinery table (no org_id, nothing about an org) for
--    Meta's callback. The API checks Meta's signature, then writes the confirmation code and the keyed hash; the worker
--    claims the requests, erases the accounts that hash names in each org and marks the request completed; the status page
--    the person is sent to reads it by the code. Only the definers touch it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_ads.ad_account ADD COLUMN IF NOT EXISTS granted_by_hash text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_account_granted_by_hash_ck' AND conrelid = 'crove_ads.ad_account'::regclass) THEN
    ALTER TABLE crove_ads.ad_account ADD CONSTRAINT ad_account_granted_by_hash_ck CHECK (granted_by_hash IS NULL OR granted_by_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ad_account_granted_by_idx ON crove_ads.ad_account (granted_by_hash) WHERE granted_by_hash IS NOT NULL;
GRANT UPDATE (granted_by_hash) ON crove_ads.ad_account TO crove_tenant;

-- Deletes the figures and sync runs of one ad account of the org in context. p_remove_account also deletes the account's row,
-- and is refused unless its connection is closed (revoked) or the caller is the system (the callback's erasure). A user
-- caller must be an owner or admin and may only touch an account of an entity its context names. Returns what it removed.
CREATE OR REPLACE FUNCTION crove_ads.account_history_delete(p_account_id uuid, p_remove_account boolean, p_backfill_from date)
RETURNS TABLE (days bigint, runs bigint, removed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_entity uuid;
  v_status text;
  v_days bigint;
  v_runs bigint;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND v_actor_type = 'user' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'ADS_HISTORY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT a.legal_entity_id, c.status INTO v_entity, v_status
  FROM crove_ads.ad_account a
  JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id
  WHERE a.org_id = v_org AND a.id = p_account_id
  FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADS_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- A member limited to other entities reads and deletes none of this account's.
  -- Fails closed: a context with no entity scope at all (NULL) reads and deletes none, as the row policies do.
  IF v_actor_type IS DISTINCT FROM 'system'
     AND NOT COALESCE('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR v_entity::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]), false) THEN
    RAISE EXCEPTION 'ADS_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_remove_account AND v_actor_type IS DISTINCT FROM 'system' AND v_status IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION 'ADS_CONNECTION_STILL_OPEN' USING ERRCODE = '55000';
  END IF;
  DELETE FROM crove_ads.ad_spend_day d WHERE d.org_id = v_org AND d.ad_account_id = p_account_id;
  GET DIAGNOSTICS v_days = ROW_COUNT;
  DELETE FROM crove_ads.ad_sync_run r WHERE r.org_id = v_org AND r.ad_account_id = p_account_id;
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  IF p_remove_account THEN
    DELETE FROM crove_ads.ad_account a WHERE a.org_id = v_org AND a.id = p_account_id;
  ELSE
    -- Cursors back to the start: the next sync of a connected account reads its 13 months again.
    UPDATE crove_ads.ad_account a
       SET settled_through = NULL, synced_through = NULL, last_run_at = NULL, last_error_kind = NULL, next_run_at = NULL,
           backfill_from = COALESCE(p_backfill_from, a.backfill_from), updated_at = pg_catalog.now()
     WHERE a.org_id = v_org AND a.id = p_account_id;
  END IF;
  RETURN QUERY SELECT v_days, v_runs, p_remove_account;
END $$;
REVOKE ALL ON FUNCTION crove_ads.account_history_delete(uuid, boolean, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.account_history_delete(uuid, boolean, date) TO crove_app, crove_worker;

-- Meta's data deletion requests: one row per request, by its confirmation code (128 random bits as 32 hex digits).
CREATE TABLE IF NOT EXISTS crove_ads.deletion_request (
  code text PRIMARY KEY CHECK (code ~ '^[0-9a-f]{32}$'),
  user_hash text NOT NULL CHECK (user_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  accounts integer CHECK (accounts IS NULL OR accounts >= 0),
  -- A request whose erasure failed waits until this time (a few minutes) before the worker claims it again, so a request that
  -- keeps failing cannot hold the ones behind it.
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
-- At most one open request per person: a replay of a signed request while one is open gets that request's code, not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS deletion_request_open_hash_uq ON crove_ads.deletion_request (user_hash) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS deletion_request_open_idx ON crove_ads.deletion_request (next_attempt_at, requested_at) WHERE completed_at IS NULL;
REVOKE ALL ON crove_ads.deletion_request FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_ads.deletion_request ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_ads.deletion_request');

-- Records a verified request and answers its confirmation code (API login only). A person with a request still open gets that
-- request's code. The API is not trusted with volume: with 100000 rows (open and kept completed ones together) it raises 53400,
-- which the API answers with 503 and Meta retries.
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_enqueue(p_code text, p_user_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
  v_code text;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9a-f]{32}$' OR p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ADS_DELETION_INVALID' USING ERRCODE = '22P02';
  END IF;
  SELECT r.code INTO v_code FROM crove_ads.deletion_request r WHERE r.user_hash = p_user_hash AND r.completed_at IS NULL;
  IF FOUND THEN
    RETURN v_code;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_ads.deletion_request LIMIT 100001) s) > 100000 THEN
    RAISE EXCEPTION 'ADS_DELETION_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_ads.deletion_request (code, user_hash) VALUES (p_code, p_user_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
    RETURN p_code;
  END IF;
  -- Another call opened one for this person at the same moment, or the code was already recorded.
  SELECT r.code INTO v_code FROM crove_ads.deletion_request r WHERE r.code = p_code OR (r.user_hash = p_user_hash AND r.completed_at IS NULL) ORDER BY (r.code = p_code) DESC LIMIT 1;
  RETURN v_code;
END $$;

-- What the status page shows for a code (API login only): when the request came in and when it was completed; no row, no
-- answer.
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_status(p_code text)
RETURNS TABLE (requested_at timestamptz, completed_at timestamptz, accounts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.requested_at, r.completed_at, r.accounts FROM crove_ads.deletion_request r WHERE r.code = p_code AND p_code ~ '^[0-9a-f]{32}$'
$$;

-- The worker's claim: for each open request that is due, one row per ad account of an org that is not closed (its accounts
-- are deleted with it) that the request's hash granted, and one row with null ids for a request that names none. Nothing is
-- deleted here: a worker that dies leaves the request open and the next claim finds it again, and the erasure it asks for is
-- idempotent. At most p_limit requests, the longest waiting first.
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_claim(p_limit integer)
RETURNS TABLE (code text, org_id uuid, ad_account_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH due AS (
    SELECT q.code, q.user_hash FROM crove_ads.deletion_request q
    WHERE q.completed_at IS NULL AND q.next_attempt_at <= pg_catalog.now()
    ORDER BY q.next_attempt_at, q.requested_at, q.code LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  )
  SELECT d.code, a.org_id, a.id, a.channel_connection_id
  FROM due d
  JOIN crove_ads.ad_account a ON a.granted_by_hash = d.user_hash
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status IN ('active', 'offboarding')
  UNION ALL
  SELECT d.code, NULL::uuid, NULL::uuid, NULL::uuid FROM due d
  WHERE NOT EXISTS (SELECT 1 FROM crove_ads.ad_account a JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status IN ('active', 'offboarding') WHERE a.granted_by_hash = d.user_hash)
$$;

-- Marks a request completed (worker login only), with how many accounts it erased, and drops the completed ones older than
-- 90 days so the table never grows without bound.
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_complete(p_code text, p_accounts integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.deletion_request r SET completed_at = pg_catalog.now(), accounts = GREATEST(p_accounts, 0) WHERE r.code = p_code AND r.completed_at IS NULL;
  DELETE FROM crove_ads.deletion_request r WHERE r.completed_at < pg_catalog.now() - interval '90 days';
END $$;

-- A request whose erasure failed waits five minutes before the worker claims it again (worker login only).
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_defer(p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.deletion_request r SET next_attempt_at = pg_catalog.now() + interval '5 minutes' WHERE r.code = p_code AND r.completed_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION crove_ads.deletion_request_enqueue(text, text), crove_ads.deletion_request_status(text), crove_ads.deletion_request_claim(integer), crove_ads.deletion_request_complete(text, integer), crove_ads.deletion_request_defer(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.deletion_request_enqueue(text, text), crove_ads.deletion_request_status(text) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_ads.deletion_request_claim(integer), crove_ads.deletion_request_complete(text, integer), crove_ads.deletion_request_defer(text) TO crove_worker;
