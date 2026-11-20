-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4203, Tingee S3 of #2045, ADR-0039 as amended): the webhook of a bank feed whose provider signs with each customer's OWN secret (Tingee). Idempotent; applied files stay untouched.
--
-- Why a hook key: such a notice names no org, and its signature can only be checked with the secret of the connection it belongs to, which only the worker can open (the credential is sealed, ADR-0025). So the address
-- a customer pastes into its provider's portal carries a key of its own, `/api/bank-feed/<provider>/webhook/<hookKey>`, 128 random bits of which only the SHA-256 is kept here. The org and the connection come from OUR
-- row for that hash, never from the body. How a notice travels:
--   1. The API (rate limit per address and a 16 KB body cap first, then the timestamp window, then a per-hook budget) looks the hash up with bank_feed_hook_lookup and stores the raw notice with bank_feed_hook_put_notice:
--      the request id, the provider's timestamp and signature as sent, and the body. An unknown hash is a 404 with nothing stored; a repeated request id is a no-op.
--   2. The worker claims the waiting notices with bank_feed_hook_claim (deleted as they are claimed), opens the connection's sealed secret, checks the HMAC (constant-time, raw bytes then the minified form) and that the body
--      names the connection's own client, then queues one coalesced pull of the connection. A bad one is dropped and counted on the hook with bank_feed_hook_reject: ten in an hour stop the hook until it is rotated.
--   3. Nothing of a transaction is ever stored from a notice: lines come only from the pull Ludy makes with its own signed request.
--
-- The notice's body is personal data (transfer content and the payer's name): it lives here only until the worker verifies it, is deleted by the claim of anything older than ten minutes (and by the nightly
-- bank_feed_hook_sweep), is never logged or put in an error or audit row, is erased with a person (personal_data_erase_bank_feed_notice) and goes with the org (org_purge, the next file).
--
-- Both tables are definer-only (RLS enabled, no grant to any login role): the matrix lists them in MACHINERY (#4217). The API login looks up and puts; the worker login claims, rejects and sweeps; owners and admins
-- set (create or rotate) and read the status of their own org's hook through definers that check the caller's own sealed context.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_feed_hook (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  -- The SHA-256 (hex) of the key in the address: the key itself is shown once and never kept.
  key_sha256 text NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rotated_at timestamptz,
  last_seen_at timestamptz,
  -- Notices refused by the worker in the current hour; ten stop the hook (stopped_at) until it is rotated.
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  rejected_window_start timestamptz,
  stopped_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_feed_hook_connection_uq UNIQUE (org_id, channel_connection_id),
  CONSTRAINT bank_feed_hook_key_uq UNIQUE (key_sha256),
  CONSTRAINT bank_feed_hook_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_finance.bank_feed_hook ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_finance.bank_feed_webhook_notice (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  hook_id uuid NOT NULL,
  request_id text NOT NULL CHECK (pg_catalog.char_length(request_id) BETWEEN 1 AND 100),
  -- The provider's header as sent (Tingee: yyyyMMddHHmmssSSS in Vietnam time), and its signature as sent.
  notice_timestamp text NOT NULL CHECK (pg_catalog.char_length(notice_timestamp) BETWEEN 1 AND 40),
  signature text NOT NULL CHECK (pg_catalog.char_length(signature) BETWEEN 1 AND 256),
  -- The raw body, as received: personal data, kept only until the worker verifies it (at most ten minutes).
  body text NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 16384),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_feed_webhook_notice_request_uq UNIQUE (org_id, hook_id, request_id),
  CONSTRAINT bank_feed_webhook_notice_hook_fk FOREIGN KEY (org_id, hook_id) REFERENCES crove_finance.bank_feed_hook (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bank_feed_webhook_notice_received_idx ON crove_finance.bank_feed_webhook_notice (received_at);
ALTER TABLE crove_finance.bank_feed_webhook_notice ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_finance.bank_feed_hook, crove_finance.bank_feed_webhook_notice FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_finance.bank_feed_hook, crove_finance.bank_feed_webhook_notice FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard on tenant tables; an agent context never sets up a hook or sends a notice.
SELECT crove_kernel.agent_write_guard_install('crove_finance.bank_feed_hook');
SELECT crove_kernel.agent_write_guard_install('crove_finance.bank_feed_webhook_notice');

-- ---------------------------------------------------------------------------
-- The API login's side (no tenant context): look a hook up by the hash of its key, then store one notice.
-- ---------------------------------------------------------------------------
-- The hook whose key hashes to p_key_sha256, for a provider's connection that is active, of an active org whose Finance is on: its id, and whether it still takes notices ('ok') or was stopped by refused ones
-- ('stopped'). No row for anything else, so an unknown key, another provider's key, a closed connection and an org whose Finance is off all look the same (the route answers 404 and stores nothing).
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_lookup(p_provider text, p_key_sha256 text)
RETURNS TABLE (hook_id uuid, standing text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.id, CASE WHEN h.stopped_at IS NULL THEN 'ok' ELSE 'stopped' END
  FROM crove_finance.bank_feed_hook h
  JOIN crove_kernel.channel_connection c ON c.org_id = h.org_id AND c.id = h.channel_connection_id
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance')
  WHERE p_provider ~ '^bank_[a-z0-9_]{1,27}$' AND p_key_sha256 ~ '^[0-9a-f]{64}$'
    AND h.key_sha256 = p_key_sha256 AND c.provider = p_provider AND c.status = 'active'
$$;

-- Stores one notice for a hook found by bank_feed_hook_lookup and answers 'accepted', 'duplicate' (the request id is already waiting), 'busy' (the hook has twenty notices waiting, or the machine's backlog is full)
-- or 'gone' (the hook is no longer there, stopped, or its org or connection closed in between). The org comes from the hook row. It stores the raw notice and nothing else, and it wakes the worker.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_put_notice(p_hook uuid, p_request_id text, p_timestamp text, p_signature text, p_body text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_rows integer;
BEGIN
  IF p_hook IS NULL OR p_request_id IS NULL OR pg_catalog.char_length(p_request_id) NOT BETWEEN 1 AND 100
     OR p_timestamp IS NULL OR pg_catalog.char_length(p_timestamp) NOT BETWEEN 1 AND 40
     OR p_signature IS NULL OR pg_catalog.char_length(p_signature) NOT BETWEEN 1 AND 256
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_INVALID' USING ERRCODE = '22P02';
  END IF;
  SELECT h.org_id INTO v_org
  FROM crove_finance.bank_feed_hook h
  JOIN crove_kernel.channel_connection c ON c.org_id = h.org_id AND c.id = h.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance')
  WHERE h.id = p_hook AND h.stopped_at IS NULL
  FOR UPDATE OF h;
  IF v_org IS NULL THEN
    RETURN 'gone';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.bank_feed_webhook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook LIMIT 20) s) >= 20
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.bank_feed_webhook_notice LIMIT 10001) s) > 10000 THEN
    RETURN 'busy';
  END IF;
  INSERT INTO crove_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body)
  VALUES (v_org, p_hook, p_request_id, p_timestamp, p_signature, p_body)
  ON CONFLICT ON CONSTRAINT bank_feed_webhook_notice_request_uq DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;
  UPDATE crove_finance.bank_feed_hook h SET last_seen_at = pg_catalog.clock_timestamp() WHERE h.org_id = v_org AND h.id = p_hook;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN 'accepted';
END $$;

-- ---------------------------------------------------------------------------
-- The worker login's side: claim the waiting notices, count a refused one, sweep.
-- ---------------------------------------------------------------------------
-- Deletes every notice older than ten minutes, whatever it holds (the worker was away, or the notice is not one it can read), and answers how many went. Called by the claim and by the nightly sweep.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_sweep()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM crove_finance.bank_feed_webhook_notice n WHERE n.received_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- Claims up to p_limit waiting notices for the worker relay: the rows are deleted as they are claimed (a notice is only a hint to pull; one lost with a worker that dies is made up by the next notice and the daily
-- sweep), and what an org or connection that no longer takes notices left is deleted and not answered. Anything older than ten minutes is swept first. The answer is the raw notice with the hook, the connection and its provider:
-- the worker alone opens the connection's secret and checks it, and the body stays in its memory.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_claim(p_limit integer)
RETURNS TABLE (org_id uuid, hook_id uuid, connection_id uuid, provider text, request_id text, notice_timestamp text, signature text, body text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM crove_finance.bank_feed_hook_sweep();
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM crove_finance.bank_feed_webhook_notice n
    WHERE (n.org_id, n.id) IN (
      SELECT q.org_id, q.id FROM crove_finance.bank_feed_webhook_notice q ORDER BY q.received_at, q.id LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.request_id AS c_request, n.notice_timestamp AS c_timestamp, n.signature AS c_signature, n.body AS c_body
  )
  SELECT cl.c_org, cl.c_hook, h.channel_connection_id, c.provider, cl.c_request, cl.c_timestamp, cl.c_signature, cl.c_body
  FROM claimed cl
  JOIN crove_finance.bank_feed_hook h ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  JOIN crove_kernel.channel_connection c ON c.org_id = h.org_id AND c.id = h.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance');
END $$;

-- Counts a notice the worker refused (a signature that does not match, or a body naming another client): ten within an hour stop the hook until it is rotated. Answers whether the hook is now stopped.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_reject(p_hook uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_stopped boolean;
BEGIN
  UPDATE crove_finance.bank_feed_hook h SET
    rejected_count = CASE WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1 ELSE h.rejected_count + 1 END,
    rejected_window_start = CASE WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN v_now ELSE h.rejected_window_start END,
    stopped_at = CASE
      WHEN h.stopped_at IS NOT NULL THEN h.stopped_at
      WHEN (CASE WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1 ELSE h.rejected_count + 1 END) >= 10 THEN v_now
    END
  WHERE h.id = p_hook
  RETURNING h.stopped_at IS NOT NULL INTO v_stopped;
  RETURN COALESCE(v_stopped, false);
END $$;

-- ---------------------------------------------------------------------------
-- The owner's or admin's side (the caller's own sealed context): set the hook of a connection, read its status.
-- ---------------------------------------------------------------------------
-- Makes the hook of a bank feed connection of the caller's org, or replaces its key (the old address stops working at once, and a stopped hook takes notices again). p_key_sha256 is the SHA-256 (hex) of the new
-- key, which the command made and shows once. Answers true for a new hook and false for a rotation. Owners and admins only.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_set(p_connection uuid, p_key_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_new boolean;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_connection IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active' AND c.provider ~ '^bank_[a-z0-9_]{1,27}$') THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_finance.bank_feed_hook AS h (org_id, channel_connection_id, key_sha256)
  VALUES (v_org, p_connection, p_key_sha256)
  ON CONFLICT ON CONSTRAINT bank_feed_hook_connection_uq DO UPDATE SET
    key_sha256 = EXCLUDED.key_sha256,
    rotated_at = pg_catalog.clock_timestamp(),
    rejected_count = 0,
    rejected_window_start = NULL,
    stopped_at = NULL
  RETURNING (xmax = 0) INTO v_new;
  RETURN v_new;
END $$;

-- The status of the hook of a connection of the caller's org, never its key or its hash: when it was made and rotated, when a notice last arrived, the notices refused in the current hour and whether it is stopped. No
-- row when the connection has no hook. Owners and admins only.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_hook_status(p_connection uuid)
RETURNS TABLE (created_at timestamptz, rotated_at timestamptz, last_seen_at timestamptz, rejected_count integer, stopped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT h.created_at, h.rotated_at, h.last_seen_at,
         CASE WHEN h.rejected_window_start IS NOT NULL AND h.rejected_window_start >= pg_catalog.clock_timestamp() - interval '1 hour' THEN h.rejected_count ELSE 0 END,
         h.stopped_at IS NOT NULL
  FROM crove_finance.bank_feed_hook h
  WHERE h.org_id = v_org AND h.channel_connection_id = p_connection;
END $$;

-- ---------------------------------------------------------------------------
-- Erasure (kernel.personal_data.erase, R3, owners): the notices of the caller's org whose raw body mentions the value are deleted (the matching is crove_kernel.text_mentions, the finder's own). Answers how many went.
-- A kind or a value of the wrong shape is refused (22023) before any row is read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.personal_data_erase_bank_feed_notice(p_kind text, p_value text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_rows integer;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  DELETE FROM crove_finance.bank_feed_webhook_notice n WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- Who may call what. Every login role loses all of them first (a later role starts with none), then each gets its own.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_finance.bank_feed_hook_lookup(text, text),
  crove_finance.bank_feed_hook_put_notice(uuid, text, text, text, text),
  crove_finance.bank_feed_hook_sweep(),
  crove_finance.bank_feed_hook_claim(integer),
  crove_finance.bank_feed_hook_reject(uuid),
  crove_finance.bank_feed_hook_set(uuid, text),
  crove_finance.bank_feed_hook_status(uuid),
  crove_finance.personal_data_erase_bank_feed_notice(text, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_finance.bank_feed_hook_lookup(text, text), crove_finance.bank_feed_hook_put_notice(uuid, text, text, text, text), crove_finance.bank_feed_hook_sweep(), '
      'crove_finance.bank_feed_hook_claim(integer), crove_finance.bank_feed_hook_reject(uuid), crove_finance.bank_feed_hook_set(uuid, text), crove_finance.bank_feed_hook_status(uuid), '
      'crove_finance.personal_data_erase_bank_feed_notice(text, text) FROM %I',
      r.rolname);
  END LOOP;
END $$;
-- The API's own login: the route's lookup and put, the owner's or admin's set and status, and the owner's erasure.
GRANT EXECUTE ON FUNCTION
  crove_finance.bank_feed_hook_lookup(text, text),
  crove_finance.bank_feed_hook_put_notice(uuid, text, text, text, text),
  crove_finance.bank_feed_hook_set(uuid, text),
  crove_finance.bank_feed_hook_status(uuid),
  crove_finance.personal_data_erase_bank_feed_notice(text, text)
TO crove_app;
-- The worker's login alone: the claim, the count of a refused notice and the nightly sweep.
GRANT EXECUTE ON FUNCTION
  crove_finance.bank_feed_hook_sweep(),
  crove_finance.bank_feed_hook_claim(integer),
  crove_finance.bank_feed_hook_reject(uuid)
TO crove_worker;
