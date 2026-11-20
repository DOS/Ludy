-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4113, S4 of #4103): MISA ASP posts its results to the same callback address as MISA AMIS, signed with its own ClientID, and a result signed under one product's ClientID must never settle a
-- voucher of the other product's connection (the Accounting PO's condition: an AMIS-signed callback must not settle an ASP row, and the reverse). Idempotent; applied files stay untouched.
--
-- The route knows which product's key verified the signature and hands the results to the enqueue of that product; the machinery row keeps it (`product`, `amis` for every row already there), a replay is one row per
-- product, and the claim finds the stored push row only through a connection of that same product: a result with no connection of its product is a result nothing holds, which the relay drops, as it does for a refid
-- no organisation holds. The pinned shapes stay as they were (the invariant suite guards them): the AMIS enqueue keeps its signature and its grants (the API login only), the claim keeps its signature and the
-- columns it answers, and the table stays closed to every login and tenant role. New: misa_asp_callback_enqueue, the same definer for ASP's results (API login only), over one private function,
-- misa_callback_enqueue_for, which no login or tenant role may run (the two definers call it as their owner).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_callback_pending ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT 'amis';
ALTER TABLE crove_finance.misa_amis_callback_pending DROP CONSTRAINT IF EXISTS misa_amis_callback_pending_product_ck;
ALTER TABLE crove_finance.misa_amis_callback_pending ADD CONSTRAINT misa_amis_callback_pending_product_ck CHECK (product IN ('amis', 'asp'));
-- A replay of the same signed result is one row per product (the first copy wins within a product): a result signed under the other product's key cannot take the place of the real one while it waits.
ALTER TABLE crove_finance.misa_amis_callback_pending DROP CONSTRAINT IF EXISTS misa_amis_callback_pending_replay_uq;
ALTER TABLE crove_finance.misa_amis_callback_pending ADD CONSTRAINT misa_amis_callback_pending_replay_uq UNIQUE (org_refid, voucher_type, success, product);

-- The body of the enqueue, once, for a product. Not a definer and granted to nobody: the two definers below call it as their owner.
CREATE OR REPLACE FUNCTION crove_finance.misa_callback_enqueue_for(
  p_product text, p_org_company_code text, p_org_refids uuid[], p_voucher_types integer[], p_successes boolean[], p_error_codes text[], p_error_messages text[])
RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_product IS NULL OR p_product NOT IN ('amis', 'asp') OR p_org_company_code IS NULL OR p_org_company_code !~ '^[A-Za-z0-9_.-]{1,64}$'
     OR p_org_refids IS NULL OR pg_catalog.cardinality(p_org_refids) NOT BETWEEN 1 AND 1000
     OR p_voucher_types IS NULL OR p_successes IS NULL OR p_error_codes IS NULL OR p_error_messages IS NULL
     OR pg_catalog.cardinality(p_voucher_types) <> pg_catalog.cardinality(p_org_refids)
     OR pg_catalog.cardinality(p_successes) <> pg_catalog.cardinality(p_org_refids)
     OR pg_catalog.cardinality(p_error_codes) <> pg_catalog.cardinality(p_org_refids)
     OR pg_catalog.cardinality(p_error_messages) <> pg_catalog.cardinality(p_org_refids) THEN
    RAISE EXCEPTION 'MISA_AMIS_CALLBACK_INVALID' USING ERRCODE = '22P02';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.misa_amis_callback_pending LIMIT 10001) s) > 10000 THEN
    RAISE EXCEPTION 'MISA_AMIS_CALLBACK_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_finance.misa_amis_callback_pending (org_refid, voucher_type, org_company_code, success, error_code, error_message, product)
  SELECT r.refid, r.vtype, p_org_company_code, r.ok, NULLIF(r.code, ''), r.message, p_product
  FROM ROWS FROM (pg_catalog.unnest(p_org_refids), pg_catalog.unnest(p_voucher_types), pg_catalog.unnest(p_successes), pg_catalog.unnest(p_error_codes), pg_catalog.unnest(p_error_messages)) AS r(refid, vtype, ok, code, message)
  WHERE r.refid IS NOT NULL AND r.vtype BETWEEN 1 AND 99 AND r.ok IS NOT NULL
    AND (r.code IS NULL OR r.code = '' OR r.code ~ '^[A-Za-z0-9_.-]{1,64}$')
    AND (r.message IS NULL OR pg_catalog.char_length(r.message) <= 500)
  ON CONFLICT (org_refid, voucher_type, success, product) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_finance.misa_callback_enqueue_for(text, text, uuid[], integer[], boolean[], text[], text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- AMIS's enqueue, as it was (same signature, same grants), writing the product `amis`.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_callback_enqueue(
  p_org_company_code text, p_org_refids uuid[], p_voucher_types integer[], p_successes boolean[], p_error_codes text[], p_error_messages text[])
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_finance.misa_callback_enqueue_for('amis', p_org_company_code, p_org_refids, p_voucher_types, p_successes, p_error_codes, p_error_messages)
$$;

-- ASP's enqueue: the same, writing the product `asp`.
CREATE OR REPLACE FUNCTION crove_finance.misa_asp_callback_enqueue(
  p_org_company_code text, p_org_refids uuid[], p_voucher_types integer[], p_successes boolean[], p_error_codes text[], p_error_messages text[])
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_finance.misa_callback_enqueue_for('asp', p_org_company_code, p_org_refids, p_voucher_types, p_successes, p_error_codes, p_error_messages)
$$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[]), crove_finance.misa_asp_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[])
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[]), crove_finance.misa_asp_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[]) TO crove_app;

-- The claim, as it was (same signature, same answer), finding the stored push row only through a connection of the product that signed the result.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_callback_claim(p_limit integer)
RETURNS TABLE (
  seq bigint, org_refid uuid, voucher_type integer, org_company_code text, success boolean, error_code text, error_message text,
  m_org_id uuid, m_connection_id uuid, m_state text, m_attempts integer, m_voucher_type integer, m_org_company_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM crove_finance.misa_amis_callback_pending d WHERE d.received_at < pg_catalog.now() - interval '7 days';
  RETURN QUERY
  WITH taken AS (
    UPDATE crove_finance.misa_amis_callback_pending p
    SET claimed_at = pg_catalog.now()
    WHERE p.seq IN (
      SELECT q.seq FROM crove_finance.misa_amis_callback_pending q
      WHERE q.claimed_at IS NULL OR q.claimed_at < pg_catalog.now() - interval '5 minutes'
      ORDER BY q.seq LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING p.seq, p.org_refid, p.voucher_type, p.org_company_code, p.success, p.error_code, p.error_message, p.product
  )
  SELECT t.seq, t.org_refid, t.voucher_type, t.org_company_code, t.success, t.error_code, t.error_message,
         h.org_id, h.connection_id, h.state, h.attempts, h.voucher_type, h.org_company_code
  FROM taken t
  LEFT JOIN LATERAL (
    SELECT x.org_id, x.connection_id, x.state, x.attempts, x.voucher_type, c.org_company_code
    FROM crove_finance.misa_amis_push x
    JOIN crove_finance.misa_amis_connection c ON c.org_id = x.org_id AND c.id = x.connection_id AND c.product = t.product
    JOIN crove_kernel.tenant tn ON tn.org_id = x.org_id AND tn.status = 'active'
    WHERE x.org_refid = t.org_refid AND crove_kernel.org_app_on(x.org_id, 'finance')
  ) h ON true
  ORDER BY t.seq;
END $$;

REVOKE ALL ON FUNCTION crove_finance.misa_amis_callback_claim(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_callback_claim(integer) TO crove_worker;
