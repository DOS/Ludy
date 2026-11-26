-- SPDX-License-Identifier: AGPL-3.0-only
-- Marketplace push hook follow-ups (#4326, parent #2524, design #4315): bind
-- ludy_finance.marketplace_hook_reject to the hook generation so rejections of
-- pushes claimed before a key rotation can never count against or stop the
-- rotated address.
--
-- Changes:
--   1. Add generation (integer, default 1, >= 1) and per-rotation reject_token
--      (uuid, NULL until first rotation) to ludy_finance.marketplace_hook.
--   2. Increment generation and mint a fresh reject_token on key rotation in
--      ludy_finance.marketplace_hook_set.
--   3. Return COALESCE(h.reject_token, h.id) as hook_id and append trailing
--      generation to ludy_finance.marketplace_hook_claim so both new 2-arg
--      workers and pre-PR/rolled-back 1-arg workers distinguish each key
--      generation (ADR-0001).
--   4. Add generation-bound ludy_finance.marketplace_hook_reject(uuid, integer)
--      while preserving post-stop batch refusal counts, and resolve the 1-arg
--      ludy_finance.marketplace_hook_reject(uuid) compatibility shim against
--      COALESCE(h.reject_token, h.id).
--
-- Note: the request_url Shopee-only guard on marketplace_hook_put_notice already
-- landed in 20270207100000_crove_finance_marketplace_hook_request_url_shopee.sql (#4327).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Track hook generation and per-rotation reject_token
-- ---------------------------------------------------------------------------
ALTER TABLE ludy_finance.marketplace_hook
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reject_token uuid;

ALTER TABLE ludy_finance.marketplace_hook
  DROP CONSTRAINT IF EXISTS marketplace_hook_generation_check,
  ADD CONSTRAINT marketplace_hook_generation_check CHECK (generation >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_hook_reject_token_uq
  ON ludy_finance.marketplace_hook (reject_token)
  WHERE reject_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Increment generation on rotation in ludy_finance.marketplace_hook_set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.marketplace_hook_set(p_connection uuid, p_key_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_new boolean;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_connection IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_finance.marketplace_connection m
    JOIN ludy_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
    WHERE m.org_id = v_org AND m.id = p_connection AND m.provider IN ('marketplace_lazada', 'marketplace_shopee', 'marketplace_tiktok_shop')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ludy_finance.marketplace_hook AS h (org_id, marketplace_connection_id, key_sha256)
  VALUES (v_org, p_connection, p_key_sha256)
  ON CONFLICT ON CONSTRAINT marketplace_hook_connection_uq DO UPDATE SET
    key_sha256 = EXCLUDED.key_sha256,
    generation = h.generation + 1,
    reject_token = pg_catalog.gen_random_uuid(),
    rotated_at = pg_catalog.clock_timestamp(),
    rejected_count = 0,
    rejected_window_start = NULL,
    stopped_at = NULL
  RETURNING (xmax = 0) INTO v_new;
  -- A rotation also drops the pushes still waiting for the old address: they were signed for the old hook's key and no one is to read them.
  IF NOT v_new THEN
    DELETE FROM ludy_finance.marketplace_hook_notice n USING ludy_finance.marketplace_hook h WHERE h.org_id = v_org AND h.marketplace_connection_id = p_connection AND n.org_id = h.org_id AND n.hook_id = h.id;
  END IF;
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Return hook generation and token from ludy_finance.marketplace_hook_claim
-- ---------------------------------------------------------------------------
-- ludy:contract adr=0045
DROP FUNCTION IF EXISTS ludy_finance.marketplace_hook_claim(integer);
CREATE FUNCTION ludy_finance.marketplace_hook_claim(p_limit integer)
RETURNS TABLE (org_id uuid, hook_id uuid, marketplace_connection_id uuid, channel_connection_id uuid, adapter text, platform text, dedupe_key text, authorization_header text, body bytea, request_url text, generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM ludy_finance.marketplace_hook_sweep();
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM ludy_finance.marketplace_hook_notice n
    WHERE (n.org_id, n.id) IN (
      SELECT q.org_id, q.id FROM ludy_finance.marketplace_hook_notice q ORDER BY q.received_at, q.id LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.dedupe_key AS c_dedupe, n.authorization_header AS c_authorization, n.body AS c_body, n.request_url AS c_url
  )
  SELECT cl.c_org, COALESCE(h.reject_token, h.id), m.id, m.channel_connection_id, pg_catalog.substr(m.provider, 13), m.platform, cl.c_dedupe, cl.c_authorization, cl.c_body, cl.c_url, h.generation
  FROM claimed cl
  JOIN ludy_finance.marketplace_hook h ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  JOIN ludy_finance.marketplace_connection m ON m.org_id = h.org_id AND m.id = h.marketplace_connection_id
  JOIN ludy_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
  JOIN ludy_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'finance');
END $$;

-- ---------------------------------------------------------------------------
-- 4. Require matching generation in ludy_finance.marketplace_hook_reject
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.marketplace_hook_reject(p_hook uuid, p_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_stopped boolean;
BEGIN
  IF p_hook IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RETURN false;
  END IF;
  UPDATE ludy_finance.marketplace_hook h SET
    rejected_count = CASE
      WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1
      ELSE h.rejected_count + 1
    END,
    rejected_window_start = CASE
      WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN v_now
      ELSE h.rejected_window_start
    END,
    stopped_at = CASE
      WHEN h.stopped_at IS NOT NULL THEN h.stopped_at
      WHEN (CASE WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1 ELSE h.rejected_count + 1 END) >= 10 THEN v_now
    END
  WHERE (h.id = p_hook OR h.reject_token = p_hook) AND h.generation = p_generation
  RETURNING h.stopped_at IS NOT NULL INTO v_stopped;
  RETURN COALESCE(v_stopped, false);
END $$;

-- Compatibility shim for workers deployed prior to this migration (or rolled back to one): resolves the per-rotation token claim returned in hook_id so stale pre-rotation rejections stay ignored while current-generation rejections still stop at 10.
CREATE OR REPLACE FUNCTION ludy_finance.marketplace_hook_reject(p_hook uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_hook uuid;
  v_generation integer;
BEGIN
  IF p_hook IS NULL THEN
    RETURN false;
  END IF;
  SELECT h.id, h.generation INTO v_hook, v_generation
  FROM ludy_finance.marketplace_hook h
  WHERE COALESCE(h.reject_token, h.id) = p_hook;
  IF v_hook IS NULL THEN
    RETURN false;
  END IF;
  RETURN ludy_finance.marketplace_hook_reject(v_hook, v_generation);
END $$;

REVOKE ALL ON FUNCTION
  ludy_finance.marketplace_hook_set(uuid, text),
  ludy_finance.marketplace_hook_claim(integer),
  ludy_finance.marketplace_hook_reject(uuid, integer),
  ludy_finance.marketplace_hook_reject(uuid)
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
      'REVOKE ALL ON FUNCTION ludy_finance.marketplace_hook_set(uuid, text), ludy_finance.marketplace_hook_claim(integer), ludy_finance.marketplace_hook_reject(uuid, integer), ludy_finance.marketplace_hook_reject(uuid) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  ludy_finance.marketplace_hook_set(uuid, text)
TO ludy_app;
GRANT EXECUTE ON FUNCTION
  ludy_finance.marketplace_hook_claim(integer),
  ludy_finance.marketplace_hook_reject(uuid, integer),
  ludy_finance.marketplace_hook_reject(uuid)
TO ludy_worker;
