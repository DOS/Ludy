-- SPDX-License-Identifier: AGPL-3.0-only
-- DB-backed atomic rate limit buckets for OAuth and MCP endpoints (#3978).

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_kernel.mcp_rate_limit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL CHECK (bucket ~ '^[a-z][a-z0-9_]{1,40}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_rate_limit_lookup_idx
  ON ludy_kernel.mcp_rate_limit (bucket, key_hash, expires_at);

CREATE INDEX IF NOT EXISTS mcp_rate_limit_expires_idx
  ON ludy_kernel.mcp_rate_limit (expires_at);

REVOKE ALL ON TABLE ludy_kernel.mcp_rate_limit FROM PUBLIC;
REVOKE ALL ON TABLE ludy_kernel.mcp_rate_limit FROM ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_prober;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' ESCAPE '\' OR rolname LIKE 'crove\_%' ESCAPE '\')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_kernel.mcp_rate_limit FROM %I', v_role);
  END LOOP;
END
$$;

ALTER TABLE ludy_kernel.mcp_rate_limit ENABLE ROW LEVEL SECURITY;

SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.mcp_rate_limit');

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_rate_limit_take(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_lock_timeout text;
  v_now timestamptz;
  v_count bigint;
  v_oldest timestamptz;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[a-z][a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'MCP_RATE_LIMIT_INVALID_BUCKET' USING ERRCODE = '22023';
  END IF;
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MCP_RATE_LIMIT_INVALID_KEY' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'MCP_RATE_LIMIT_INVALID_LIMIT' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'MCP_RATE_LIMIT_INVALID_WINDOW' USING ERRCODE = '22023';
  END IF;

  v_prev_lock_timeout := pg_catalog.current_setting('lock_timeout', true);
  BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('mcp.rl:' || p_bucket || ':' || p_key_hash, 0)
    );
  EXCEPTION
    WHEN lock_not_available THEN
      PERFORM pg_catalog.set_config('lock_timeout', COALESCE(NULLIF(v_prev_lock_timeout, ''), '0'), true);
      RETURN QUERY SELECT false, 1;
      RETURN;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', COALESCE(NULLIF(v_prev_lock_timeout, ''), '0'), true);

  v_now := pg_catalog.clock_timestamp();

  DELETE FROM ludy_kernel.mcp_rate_limit AS target
  USING (
    SELECT expired_row.id
    FROM ludy_kernel.mcp_rate_limit AS expired_row
    WHERE expired_row.expires_at <= v_now
    ORDER BY expired_row.expires_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  ) AS expired
  WHERE target.id = expired.id;

  SELECT pg_catalog.count(*)::bigint, pg_catalog.min(active.expires_at)
  INTO v_count, v_oldest
  FROM ludy_kernel.mcp_rate_limit AS active
  WHERE active.bucket = p_bucket
    AND active.key_hash = p_key_hash
    AND active.expires_at > v_now;

  IF v_count >= p_limit THEN
    RETURN QUERY
      SELECT false, GREATEST(1, pg_catalog.ceil(EXTRACT(EPOCH FROM v_oldest - v_now))::integer);
    RETURN;
  END IF;

  INSERT INTO ludy_kernel.mcp_rate_limit (bucket, key_hash, created_at, expires_at)
  VALUES (
    p_bucket,
    p_key_hash,
    v_now,
    v_now + pg_catalog.make_interval(secs => p_window_seconds)
  );

  RETURN QUERY SELECT true, NULL::integer;
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION ludy_kernel.mcp_rate_limit_take(text, text, integer, integer) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' ESCAPE '\' OR rolname LIKE 'crove\_%' ESCAPE '\')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.mcp_rate_limit_take(text, text, integer, integer) FROM %I', v_role);
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION ludy_kernel.mcp_rate_limit_take(text, text, integer, integer) TO ludy_app;
