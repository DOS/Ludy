-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3903, S4 of #3854): finding the organisation of a MISA AMIS callback. Idempotent; applied files stay untouched.
--
-- MISA posts the result of a save to POST /api/webhooks/misa-amis. The API checks the HMAC of `data` first (one key per deployment, the ClientID), so a good signature proves the message
-- came from MISA, not which organisation it is for; org_company_code, app_id and data_type are not signed. The organisation therefore comes only from our own stored push row by org_refid.
-- The API holds no tenant context at that edge, so this one read-only SECURITY DEFINER function (the shape of bank_feed_notice_enqueue, ADR-0039) answers, for at most 1000 org_refids that
-- came out of the SIGNED `data`, the rows we stored for them. It writes nothing. org_refid is unique per organisation (misa_amis_push_refid_uq), not across the deployment, so the answer
-- may hold one refid in two organisations: the caller refuses such a refid as ambiguous and records nothing for it, and for that it must see every state, not only `sent` and `ambiguous`.
--
-- What it returns is the minimum the route needs and nothing a caller could read as data about an organisation: the refid it asked about, the organisation and the connection (ids), the
-- state and the attempt of the row (what the recording command compares), the voucher type and the connection's own org_company_code (what the envelope's hint must equal). No name,
-- amount, reason, digest, parameter or source id. A tenant whose Finance is off or that is not active gets no row, so its callbacks are acknowledged and dropped (ADR-0053).
-- Granted to the API login (crove_app) alone.
SET LOCAL lock_timeout = '2s';

-- The lookup is by org_refid across every organisation, and the only index that holds it (misa_amis_push_refid_uq) leads with org_id: without this one each verified callback would scan every
-- organisation's push rows, which nothing deletes. Not a hot table (AGENTS.md lists audit_event, the outbox and crove_jobs), so a plain build in the transaction is the rule.
CREATE INDEX IF NOT EXISTS misa_amis_push_refid_idx ON crove_finance.misa_amis_push (org_refid);

CREATE OR REPLACE FUNCTION crove_finance.misa_amis_push_locate(p_org_refids uuid[])
RETURNS TABLE (org_refid uuid, org_id uuid, connection_id uuid, state text, attempts integer, voucher_type integer, org_company_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_org_refids IS NULL OR pg_catalog.cardinality(p_org_refids) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'MISA_AMIS_LOCATE_INVALID' USING ERRCODE = '22P02';
  END IF;
  RETURN QUERY
  SELECT p.org_refid, p.org_id, p.connection_id, p.state, p.attempts, p.voucher_type, c.org_company_code
  FROM crove_finance.misa_amis_push p
  JOIN crove_finance.misa_amis_connection c ON c.org_id = p.org_id AND c.id = p.connection_id
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.org_refid = ANY (p_org_refids)
    AND crove_kernel.org_app_on(p.org_id, 'finance');
END $$;

REVOKE ALL ON FUNCTION crove_finance.misa_amis_push_locate(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_push_locate(uuid[]) TO crove_app;
