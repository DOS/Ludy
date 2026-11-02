-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2348, from the security review of #2330): the backlog cap of the intake table is per provider, so notices of
-- the sandbox (demo comments of many orgs) can never fill the room a real platform's notices need, and a platform that does not
-- retry an error status (Zalo [S]) is not refused for another provider's backlog. Idempotent; applied files stay untouched.
--
-- crove_kernel.conversation_inbound_enqueue keeps its signature and its advisory lock (the count and the insert are one step). The cap
-- is 1000 waiting notices for 'sandbox' and 10000 for any other provider, with 50000 in all as a ceiling on the table. An index on the
-- provider makes the count cheap.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS conversation_inbound_provider_idx ON crove_kernel.conversation_inbound_pending (provider);

CREATE OR REPLACE FUNCTION crove_kernel.conversation_inbound_enqueue(p_provider text, p_body bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_seq bigint;
  v_cap integer := CASE WHEN p_provider = 'sandbox' THEN 1000 ELSE 10000 END;
BEGIN
  -- The count and the insert are one step: concurrent calls near a limit queue here, so the caps hold exactly.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove.conversation_inbound_enqueue', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_kernel.conversation_inbound_pending p WHERE p.provider = p_provider LIMIT v_cap + 1) s) >= v_cap
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_kernel.conversation_inbound_pending LIMIT 50001) s) > 50000 THEN
    RAISE EXCEPTION 'CONVERSATION_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) VALUES (p_provider, p_body) RETURNING seq INTO v_seq;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_inbound_enqueue(text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_inbound_enqueue(text, bytea) TO crove_app;
