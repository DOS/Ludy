-- SPDX-License-Identifier: AGPL-3.0-only
-- Channel refresh failure tracking and exponential backoff (#4251, follow-up of #4249). Idempotent; applied files stay
-- untouched.
--
-- Adds consecutive failure count, sanitized failure code, and next-attempt backoff timestamp to
-- ludy_kernel.channel_connection, and updates ludy_kernel.channel_refresh_due to skip connections still in backoff.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS refresh_failures integer NOT NULL DEFAULT 0;
ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS refresh_last_error text;
ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS refresh_next_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.channel_connection'::regclass
      AND conname = 'channel_connection_refresh_failures_check'
  ) THEN
    ALTER TABLE ludy_kernel.channel_connection
      ADD CONSTRAINT channel_connection_refresh_failures_check CHECK (refresh_failures >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.channel_connection'::regclass
      AND conname = 'channel_connection_refresh_last_error_check'
  ) THEN
    ALTER TABLE ludy_kernel.channel_connection
      ADD CONSTRAINT channel_connection_refresh_last_error_check CHECK (
        refresh_last_error IS NULL
        OR refresh_last_error ~ '^[A-Za-z0-9_.-]{1,64}$'
      );
  END IF;
END $$;

GRANT UPDATE (refresh_failures, refresh_last_error, refresh_next_at)
  ON ludy_kernel.channel_connection TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_kernel.channel_refresh_due(p_limit int, p_providers text[], p_horizon_seconds int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text, version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider, c.updated_at
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active'
    AND c.provider = ANY (p_providers)
    AND c.expires_at IS NOT NULL
    AND c.expires_at < pg_catalog.now() + pg_catalog.make_interval(secs => LEAST(GREATEST(p_horizon_seconds, 60), 7 * 86400))
    AND (c.refresh_next_at IS NULL OR c.refresh_next_at <= pg_catalog.now())
  ORDER BY c.expires_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION ludy_kernel.channel_refresh_due(int, text[], int)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.channel_refresh_due(int, text[], int) TO ludy_worker;
