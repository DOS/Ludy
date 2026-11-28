-- SPDX-License-Identifier: AGPL-3.0-only
-- Materialize picked CTE in ludy_finance.bank_feed_hook_claim (#5262, ADR-0039) so PostgreSQL never
-- re-evaluates an IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED) subquery per outer row and always
-- claims strictly at most p_limit notices regardless of planner statistics.
SET LOCAL lock_timeout = '2s';

-- ludy:contract adr=0039
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_claim(p_limit integer)
RETURNS TABLE (org_id uuid, hook_id uuid, connection_id uuid, provider text, request_id text, notice_timestamp text, signature text, body text, generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz;
BEGIN
  -- ADR-0039: sweep every notice older than 10 minutes first, separately from p_limit.
  PERFORM ludy_finance.bank_feed_hook_sweep();
  v_cutoff := pg_catalog.clock_timestamp() - interval '10 minutes';
  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT q.org_id, q.id
    FROM ludy_finance.bank_feed_webhook_notice q
    ORDER BY q.received_at, q.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    DELETE FROM ludy_finance.bank_feed_webhook_notice n
    USING picked
    WHERE n.org_id = picked.org_id AND n.id = picked.id
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.request_id AS c_request, n.notice_timestamp AS c_timestamp, n.signature AS c_signature, n.body AS c_body, n.received_at AS c_received_at, n.id AS c_id
  )
  SELECT CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_org END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN COALESCE(h.reject_token, h.id) END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.channel_connection_id END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN c.provider END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_request END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_timestamp END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_signature END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_body END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.generation END
  FROM claimed cl
  LEFT JOIN ludy_finance.bank_feed_hook h
    ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  LEFT JOIN ludy_kernel.channel_connection c
    ON c.org_id = h.org_id AND c.id = h.channel_connection_id AND c.status = 'active'
  LEFT JOIN ludy_kernel.tenant t
    ON t.org_id = c.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'finance')
  ORDER BY cl.c_received_at, cl.c_id;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.bank_feed_hook_claim(integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_finance.bank_feed_hook_claim(integer) TO ludy_worker;
