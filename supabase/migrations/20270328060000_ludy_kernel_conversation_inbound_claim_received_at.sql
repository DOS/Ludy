-- SPDX-License-Identifier: AGPL-3.0-only
-- Expose queued notice `received_at` from `ludy_kernel.conversation_inbound_claim` (#5047, ADR-0041) so the worker
-- can anchor WhatsApp clock-skew checks to PostgreSQL `received_at` and reject pre-handover notices whose
-- upstream Meta timestamp was skewed forward past `channel_connection.connected_at`.
--
-- Trailing column addition preserves existing named-column callers (`seq, provider, body, attempts, dropped, reason`)
-- and keeps the previous release working during rolling deploy/rollback.
SET LOCAL lock_timeout = '2s';

-- ludy:contract adr=0041
DROP FUNCTION IF EXISTS ludy_kernel.conversation_inbound_claim(integer, integer);
CREATE FUNCTION ludy_kernel.conversation_inbound_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (seq bigint, provider text, body bytea, attempts integer, dropped boolean, reason text, received_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH due AS (
    SELECT p.seq, (p.received_at < pg_catalog.now() - pg_catalog.make_interval(days => 7)) AS stale
    FROM ludy_kernel.conversation_inbound_pending p
    WHERE p.claimed_until IS NULL OR p.claimed_until < pg_catalog.now() OR p.received_at < pg_catalog.now() - pg_catalog.make_interval(days => 7)
    ORDER BY p.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), expired AS (
    DELETE FROM ludy_kernel.conversation_inbound_pending p USING due WHERE p.seq = due.seq AND due.stale
    RETURNING p.seq, p.provider, p.attempts, p.received_at
  ), poison AS (
    DELETE FROM ludy_kernel.conversation_inbound_pending p USING due WHERE p.seq = due.seq AND NOT due.stale AND p.attempts >= 5
    RETURNING p.seq, p.provider, p.attempts, p.received_at
  ), taken AS (
    UPDATE ludy_kernel.conversation_inbound_pending p
    SET claimed_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), attempts = p.attempts + 1
    FROM due WHERE p.seq = due.seq AND NOT due.stale AND p.attempts < 5
    RETURNING p.seq, p.provider, p.body, p.attempts, p.received_at
  )
  SELECT t.seq, t.provider, t.body, t.attempts, false, NULL::text, t.received_at FROM taken t
  UNION ALL
  SELECT d.seq, d.provider, NULL::bytea, d.attempts, true, 'poison'::text, d.received_at FROM poison d
  UNION ALL
  SELECT e.seq, e.provider, NULL::bytea, e.attempts, true, 'expired'::text, e.received_at FROM expired e
  ORDER BY 1
$$;

REVOKE ALL ON FUNCTION ludy_kernel.conversation_inbound_claim(integer, integer) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.conversation_inbound_claim(integer, integer) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.conversation_inbound_claim(integer, integer) TO ludy_worker;
