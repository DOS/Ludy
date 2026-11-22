-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4327, S3a of the marketplace push receiver of #4315; the review of #4324 and the Accounting PO's decision on #4326): the push address is kept ONLY for a Shopee hook. Shopee signs the address it
-- calls, so its push is checked against it; TikTok Shop and Lazada do not sign it, and the address carries the hook key, so a stored copy would be personal data for nothing. marketplace_hook_put_notice (the 20270206100000
-- statement) stored whatever the API passed; this restatement keeps the address when the hook's connection is a Shopee one and stores NULL for any other adapter, whatever the caller sends. Same signature, so the
-- grants of 20270206100000 stay (CREATE OR REPLACE keeps them); nothing else changes.

CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_put_notice(p_hook uuid, p_key_sha256 text, p_dedupe_key text, p_authorization text, p_body bytea, p_request_url text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_provider text;
  v_rows integer;
BEGIN
  IF p_hook IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' OR p_dedupe_key IS NULL OR p_dedupe_key !~ '^[0-9a-f]{64}$'
     OR p_authorization IS NULL OR pg_catalog.char_length(p_authorization) NOT BETWEEN 1 AND 256
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 16384
     OR (p_request_url IS NOT NULL AND pg_catalog.char_length(p_request_url) NOT BETWEEN 1 AND 400) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_INVALID' USING ERRCODE = '22P02';
  END IF;
  SELECT h.org_id, m.provider INTO v_org, v_provider
  FROM crove_finance.marketplace_hook h
  JOIN crove_finance.marketplace_connection m ON m.org_id = h.org_id AND m.id = h.marketplace_connection_id
  JOIN crove_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance')
  WHERE h.id = p_hook AND h.key_sha256 = p_key_sha256 AND h.stopped_at IS NULL
  FOR UPDATE OF h;
  IF v_org IS NULL THEN
    RETURN 'gone';
  END IF;
  -- The ten-minute limit does not wait for the worker: a put also deletes what this hook still holds older than that, so the retention holds even before the relay and the nightly sweep exist.
  DELETE FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook AND n.received_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  -- A retry of a push that is already waiting is acknowledged whatever the backlog (the platform stops retrying).
  IF EXISTS (SELECT 1 FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook AND n.dedupe_key = p_dedupe_key) THEN
    RETURN 'duplicate';
  END IF;
  -- The machine's cap counts and inserts under one transaction lock, so two puts for different hooks cannot both pass the count (a put is a few statements; the lock is held to its commit).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_finance.marketplace_hook_notice.capacity', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook LIMIT 20) s) >= 20
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.marketplace_hook_notice LIMIT 10000) s) >= 10000 THEN
    RETURN 'busy';
  END IF;
  INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, request_url)
  VALUES (v_org, p_hook, p_dedupe_key, p_authorization, p_body, CASE WHEN v_provider = 'marketplace_shopee' THEN p_request_url END)
  ON CONFLICT ON CONSTRAINT marketplace_hook_notice_dedupe_uq DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;
  UPDATE crove_finance.marketplace_hook h SET last_seen_at = pg_catalog.clock_timestamp() WHERE h.org_id = v_org AND h.id = p_hook;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN 'accepted';
END $$;
