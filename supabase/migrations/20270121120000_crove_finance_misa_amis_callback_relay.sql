-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3903, S4 of #3854): the result MISA AMIS posts to the callback route travels to the worker, which records it. Idempotent; applied files stay untouched.
--
-- How a result travels (as a bank feed provider's notice does, ADR-0039, 20261108130000):
--   1. MISA posts the result to POST /api/webhooks/misa-amis. The API checks the HMAC of the signed `data` before anything else (a forged or malformed message is refused and stored nowhere) and hands the
--      signed results to misa_amis_callback_enqueue(), which writes machinery rows and nothing else: the API holds no tenant context at this edge, cannot enter a system context (that is the worker's alone,
--      gate T5), reads no tenant row and so never learns whether an org_refid exists.
--   2. The worker relay claims them with misa_amis_callback_claim(), which finds the organisation and the stored push row of each result by org_refid in SQL (never from the envelope) and answers what the relay
--      needs to decide: the relay records an answer through the one write path, finance.misa_amis.push_record, as the system actor, and tells the table it is done with misa_amis_callback_done().
--
-- The HMAC key is one per deployment, so a good signature proves the sender, not the organisation. The claim therefore answers every organisation that holds the refid (the relay refuses a refid held by two),
-- the connection's own org_company_code (the unsigned envelope's company code must equal it), the voucher type, the state and the attempt of the row; nothing for an organisation whose Finance is off or that
-- is not active (ADR-0053: acknowledged and dropped).
--
-- misa_amis_callback_pending is a global machinery table (no org_id: the organisation is unknown until the claim): readable by no login role and no tenant role, written by the definers below alone. It holds
-- MISA's own capped text for a refusal (untrusted), so a row lives only until the relay is done with it, or seven days.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.misa_amis_callback_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_refid uuid NOT NULL,
  voucher_type integer NOT NULL CHECK (voucher_type BETWEEN 1 AND 99),
  -- The unsigned envelope's hint (of the first copy received): compared with the located connection's own code, never believed.
  org_company_code text NOT NULL CHECK (org_company_code ~ '^[A-Za-z0-9_.-]{1,64}$'),
  success boolean NOT NULL,
  -- MISA's error code when it is a plain word.
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_.-]{1,64}$'),
  -- MISA's text (untrusted: shown escaped, never logged), without control characters, at most 500 characters.
  error_message text CHECK (error_message IS NULL OR pg_catalog.char_length(error_message) <= 500),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- Set when the relay takes the row; a row not marked done within five minutes is taken again (the relay may have stopped), and recording is idempotent.
  claimed_at timestamptz,
  -- A replay of the same signed result is one row, whatever company code the unsigned envelope carried: the first copy wins (a replay with varied codes cannot fill the backlog; a first copy with a wrong code is dropped by the
  -- claim's comparison and polling recovers the result).
  CONSTRAINT misa_amis_callback_pending_replay_uq UNIQUE (org_refid, voucher_type, success)
);
CREATE INDEX IF NOT EXISTS misa_amis_callback_pending_claim_idx ON crove_finance.misa_amis_callback_pending (seq) WHERE claimed_at IS NULL;
REVOKE ALL ON crove_finance.misa_amis_callback_pending FROM PUBLIC;
ALTER TABLE crove_finance.misa_amis_callback_pending ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_finance.misa_amis_callback_pending');

-- The lookup the claim does is by org_refid across every organisation, and the only index that holds it (misa_amis_push_refid_uq) leads with org_id: without this one each claimed result would scan every
-- organisation's push rows, which nothing deletes. Not a hot table (AGENTS.md lists audit_event, the outbox and crove_jobs), so a plain build in the transaction is the rule.
CREATE INDEX IF NOT EXISTS misa_amis_push_refid_idx ON crove_finance.misa_amis_push (org_refid);

-- Records the signed results of one verified message, for the worker (API login only): at most 1000, parallel arrays of equal length, the company code of the envelope. Reads nothing and writes no tenant data.
-- A result already waiting (a replay) is skipped. The API role is not trusted with volume: past 10000 waiting rows it raises 53400 (configuration_limit_exceeded), which the API answers with 503 and MISA retries.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_callback_enqueue(
  p_org_company_code text, p_org_refids uuid[], p_voucher_types integer[], p_successes boolean[], p_error_codes text[], p_error_messages text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_org_company_code IS NULL OR p_org_company_code !~ '^[A-Za-z0-9_.-]{1,64}$'
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
  INSERT INTO crove_finance.misa_amis_callback_pending (org_refid, voucher_type, org_company_code, success, error_code, error_message)
  SELECT r.refid, r.vtype, p_org_company_code, r.ok, NULLIF(r.code, ''), r.message
  FROM ROWS FROM (pg_catalog.unnest(p_org_refids), pg_catalog.unnest(p_voucher_types), pg_catalog.unnest(p_successes), pg_catalog.unnest(p_error_codes), pg_catalog.unnest(p_error_messages)) AS r(refid, vtype, ok, code, message)
  WHERE r.refid IS NOT NULL AND r.vtype BETWEEN 1 AND 99 AND r.ok IS NOT NULL
    AND (r.code IS NULL OR r.code = '' OR r.code ~ '^[A-Za-z0-9_.-]{1,64}$')
    AND (r.message IS NULL OR pg_catalog.char_length(r.message) <= 500)
  ON CONFLICT (org_refid, voucher_type, success) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_count;
END $$;

-- Takes up to p_limit waiting results for the worker relay (worker only), oldest first, and marks them taken. One row per result and organisation that holds its org_refid (and is active, with Finance on), and
-- one row with no organisation for a result nothing holds (dropped by the relay), so the relay sees every result it was given. Results older than seven days are deleted first, and a result taken more than five
-- minutes ago and not marked done is taken again.
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
    RETURNING p.seq, p.org_refid, p.voucher_type, p.org_company_code, p.success, p.error_code, p.error_message
  )
  SELECT t.seq, t.org_refid, t.voucher_type, t.org_company_code, t.success, t.error_code, t.error_message,
         h.org_id, h.connection_id, h.state, h.attempts, h.voucher_type, h.org_company_code
  FROM taken t
  LEFT JOIN LATERAL (
    SELECT x.org_id, x.connection_id, x.state, x.attempts, x.voucher_type, c.org_company_code
    FROM crove_finance.misa_amis_push x
    JOIN crove_finance.misa_amis_connection c ON c.org_id = x.org_id AND c.id = x.connection_id
    JOIN crove_kernel.tenant tn ON tn.org_id = x.org_id AND tn.status = 'active'
    WHERE x.org_refid = t.org_refid AND crove_kernel.org_app_on(x.org_id, 'finance')
  ) h ON true
  ORDER BY t.seq;
END $$;

-- Deletes the results the relay is done with (worker only), by the seq of the rows it took.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_callback_done(p_seqs bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_seqs IS NULL OR pg_catalog.cardinality(p_seqs) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'MISA_AMIS_CALLBACK_INVALID' USING ERRCODE = '22P02';
  END IF;
  DELETE FROM crove_finance.misa_amis_callback_pending d WHERE d.seq = ANY (p_seqs) AND d.claimed_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_finance.misa_amis_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[]), crove_finance.misa_amis_callback_claim(integer), crove_finance.misa_amis_callback_done(bigint[])
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_callback_enqueue(text, uuid[], integer[], boolean[], text[], text[]) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_callback_claim(integer), crove_finance.misa_amis_callback_done(bigint[]) TO crove_worker;
