-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #4048, follow-up of #4046 / #3903):
--   1. L6: Add ludy_finance.misa_amis_callback_sweep() (worker only) to delete pending callback rows older than seven days and return the purged count so the relay logs one fixed code with the count only.
--   2. F2: Update ludy_finance.misa_amis_callback_claim(integer) (keeping its exact 13-column signature and grants) to count ALL org_id holders of org_refid in ludy_finance.misa_amis_push BEFORE filtering by
--      active tenant, Finance enabled, or product. Any org_refid held by more than one organisation returns NULL m_* columns so the relay refuses it, even when a second holder is inactive or has Finance off.
SET LOCAL lock_timeout = '2s';

-- Purges waiting callback results older than seven days (worker only) and returns how many rows were removed so the relay logs the count without PII.
CREATE OR REPLACE FUNCTION ludy_finance.misa_amis_callback_sweep()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_purged integer;
BEGIN
  DELETE FROM ludy_finance.misa_amis_callback_pending d
  WHERE d.received_at < pg_catalog.now() - interval '7 days';
  GET DIAGNOSTICS v_purged = ROW_COUNT;
  RETURN v_purged;
END $$;

-- Takes up to p_limit waiting results for the worker relay (worker only), oldest first, and marks them taken.
-- Results older than seven days are excluded here and swept/logged once per relay tick by misa_amis_callback_sweep().
-- Multi-organisation ambiguity is counted across all rows of ludy_finance.misa_amis_push BEFORE active-tenant, Finance-enabled, or product filters:
-- misa_amis_push_refid_uq guarantees at most one row per (org_id, org_refid), so holder_count = 1 means a single organisation holds the refid across the deployment.
CREATE OR REPLACE FUNCTION ludy_finance.misa_amis_callback_claim(p_limit integer)
RETURNS TABLE (
  seq bigint, org_refid uuid, voucher_type integer, org_company_code text, success boolean, error_code text, error_message text,
  m_org_id uuid, m_connection_id uuid, m_state text, m_attempts integer, m_voucher_type integer, m_org_company_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH taken AS (
    UPDATE ludy_finance.misa_amis_callback_pending p
    SET claimed_at = pg_catalog.now()
    WHERE p.seq IN (
      SELECT q.seq FROM ludy_finance.misa_amis_callback_pending q
      WHERE (q.claimed_at IS NULL OR q.claimed_at < pg_catalog.now() - interval '5 minutes')
        AND q.received_at >= pg_catalog.now() - interval '7 days'
      ORDER BY q.seq LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING p.seq, p.org_refid, p.voucher_type, p.org_company_code, p.success, p.error_code, p.error_message, p.product
  )
  SELECT t.seq, t.org_refid, t.voucher_type, t.org_company_code, t.success, t.error_code, t.error_message,
         h.org_id, h.connection_id, h.state, h.attempts, h.voucher_type, h.org_company_code
  FROM taken t
  LEFT JOIN LATERAL (
    SELECT x.org_id, x.connection_id, x.state, x.attempts, x.voucher_type, c.org_company_code
    FROM (
      SELECT p0.org_id, p0.connection_id, p0.state, p0.attempts, p0.voucher_type,
             pg_catalog.count(*) OVER () AS holder_count
      FROM ludy_finance.misa_amis_push p0
      WHERE p0.org_refid = t.org_refid
    ) x
    JOIN ludy_finance.misa_amis_connection c ON c.org_id = x.org_id AND c.id = x.connection_id AND c.product = t.product
    JOIN ludy_kernel.tenant tn ON tn.org_id = x.org_id AND tn.status = 'active'
    WHERE x.holder_count = 1 AND ludy_kernel.org_app_on(x.org_id, 'finance')
  ) h ON true
  ORDER BY t.seq;
END $$;

REVOKE ALL ON FUNCTION
  ludy_finance.misa_amis_callback_sweep(),
  ludy_finance.misa_amis_callback_claim(integer)
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
      'REVOKE ALL ON FUNCTION ludy_finance.misa_amis_callback_sweep(), ludy_finance.misa_amis_callback_claim(integer) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  ludy_finance.misa_amis_callback_sweep(),
  ludy_finance.misa_amis_callback_claim(integer)
TO ludy_worker;
