-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4316, S1 of the marketplace push receiver of #4315, parent #2524): the push (webhook) of a marketplace that signs with the seller's OWN app secret (TikTok Shop, Shopee, Lazada). Idempotent;
-- applied files stay untouched. Dormant: no route and no worker code uses it yet (S2 is the route in http.ts, S3 the worker relay).
--
-- Why a hook key: such a push names no org, and its signature can only be checked with the secret of the connection it belongs to, which only the worker can open (the credential is sealed, ADR-0025). So the address
-- a seller pastes into its own app's push setting carries a key of its own, `/api/marketplace/<adapter>/webhook/<hookKey>`, 128 random bits of which only the SHA-256 is kept here. The org and the connection come from OUR
-- row for that hash, never from the body (the same shape as the bank feed hook of #4203, 20270128080000). How a push travels:
--   1. The API (rate limit per address and a 16 KB body cap first, then a per-hook budget) looks the hash up with marketplace_hook_lookup and stores the raw push with marketplace_hook_put_notice: the Authorization
--      header as sent, a dedupe key (the SHA-256 of the header and the body, made by the API) and the body as bytes. An unknown hash is a 404 with nothing stored; a repeated dedupe key is a no-op.
--   2. The worker claims the waiting pushes with marketplace_hook_claim (DELETED as they are claimed), opens the connection's sealed secret, checks the HMAC (constant-time) and that the body names the connection's own
--      shop or seller, then queues ONE coalesced poll of the connection. A bad one is dropped and counted on the hook with marketplace_hook_reject: ten in an hour stop the hook until it is rotated.
--   3. Nothing of a push is ever stored beyond this table: orders and income come only from the poll Ludy makes with its own signed requests.
--
-- THE CARRIER OF THE RAW BODY IS THIS ONE TABLE ROW AND NOTHING ELSE: never job data (pg-boss keeps completed jobs in its archive), never an outbox or event row, never an audit row, an error or a log line. The wake-up
-- is pg_notify('crove_outbox', '') with an EMPTY payload. The body leaves the table when the worker claims it (before it is verified, so it then lives only in the worker's memory for one HMAC check), a push older than
-- ten minutes is deleted by the next put for its hook, the next claim and the nightly marketplace_hook_sweep, at most 20 wait for a hook and 10,000 in all, the table goes with its hook, its connection and the org (org_purge, the next file), and an
-- erasure (personal_data_erase_marketplace_hook_notice) deletes a push whose text mentions the value. The bodies of the subscribed order, return and authorization topics hold ids, statuses and times; the table is treated as
-- if it held personal data because a seller can subscribe more (chat and address topics).
--
-- Both tables are definer-only (RLS enabled, no grant to any login role): the matrix lists them in MACHINERY. The API login looks up and puts; the worker login claims, rejects and sweeps; owners and admins set (create or
-- rotate) and read the status of their own org's hook through definers that check the caller's own sealed context.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_hook (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  marketplace_connection_id uuid NOT NULL,
  -- The SHA-256 (hex) of the key in the address: the key itself is shown once and never kept.
  key_sha256 text NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rotated_at timestamptz,
  last_seen_at timestamptz,
  -- Pushes refused by the worker in the current hour; ten stop the hook (stopped_at) until it is rotated.
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  rejected_window_start timestamptz,
  stopped_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT marketplace_hook_connection_uq UNIQUE (org_id, marketplace_connection_id),
  CONSTRAINT marketplace_hook_key_uq UNIQUE (key_sha256),
  CONSTRAINT marketplace_hook_connection_fk FOREIGN KEY (org_id, marketplace_connection_id) REFERENCES crove_finance.marketplace_connection (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_finance.marketplace_hook ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_hook_notice (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  hook_id uuid NOT NULL,
  -- The SHA-256 (hex) of the header and the body as received, made by the API: a retry of the same push is the same key.
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  -- The platform's Authorization header as sent (a hex digest).
  authorization_header text NOT NULL CHECK (pg_catalog.char_length(authorization_header) BETWEEN 1 AND 256),
  -- The address the push arrived at, kept only for an adapter whose signature covers it (Shopee signs `callback_url|body`): it carries the hook key (a credential for pushing, which only its hash is kept of), so it lives
  -- exactly as long as the body, in this row, and is deleted with it. NULL for the adapters that do not sign the address.
  request_url text CHECK (request_url IS NULL OR pg_catalog.char_length(request_url) BETWEEN 1 AND 400),
  -- The raw body, as received: kept only until the worker claims it (at most ten minutes).
  body bytea NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 16384),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT marketplace_hook_notice_dedupe_uq UNIQUE (org_id, hook_id, dedupe_key),
  CONSTRAINT marketplace_hook_notice_hook_fk FOREIGN KEY (org_id, hook_id) REFERENCES crove_finance.marketplace_hook (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS marketplace_hook_notice_received_idx ON crove_finance.marketplace_hook_notice (received_at);
ALTER TABLE crove_finance.marketplace_hook_notice ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_finance.marketplace_hook, crove_finance.marketplace_hook_notice FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_finance.marketplace_hook, crove_finance.marketplace_hook_notice FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard on tenant tables; an agent context never sets up a hook or sends a push.
SELECT crove_kernel.agent_write_guard_install('crove_finance.marketplace_hook');
SELECT crove_kernel.agent_write_guard_install('crove_finance.marketplace_hook_notice');

-- ---------------------------------------------------------------------------
-- The API login's side (no tenant context): look a hook up by the hash of its key, then store one push.
-- ---------------------------------------------------------------------------
-- The hook whose key hashes to p_key_sha256, for the marketplace connection of that adapter (`lazada`, `shopee` or `tiktok_shop`: the offline adapter has no push) whose channel connection is active, of an active org
-- whose Finance is on: its id, and whether it still takes pushes ('ok') or was stopped by refused ones ('stopped'). No row for anything else, so an unknown key, another adapter's key, a closed connection and an org whose
-- Finance is off all look the same (the route answers 404 and stores nothing).
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_lookup(p_adapter text, p_key_sha256 text)
RETURNS TABLE (hook_id uuid, standing text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.id, CASE WHEN h.stopped_at IS NULL THEN 'ok' ELSE 'stopped' END
  FROM crove_finance.marketplace_hook h
  JOIN crove_finance.marketplace_connection m ON m.org_id = h.org_id AND m.id = h.marketplace_connection_id
  JOIN crove_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance')
  WHERE p_adapter IN ('lazada', 'shopee', 'tiktok_shop') AND p_key_sha256 ~ '^[0-9a-f]{64}$'
    AND h.key_sha256 = p_key_sha256 AND m.provider = 'marketplace_' || p_adapter
$$;

-- Stores one push for a hook found by marketplace_hook_lookup and answers 'accepted', 'duplicate' (the same header and body are already waiting), 'busy' (the hook has twenty pushes waiting, or the machine's backlog is
-- full) or 'gone' (the hook is no longer there, stopped, its key was rotated since the lookup, or its org or connection closed in between). The caller passes the hash the lookup accepted: the push is stored only while
-- that is still the hook's current key, so a request that passed with a retired key stores nothing. A push already waiting is acknowledged ('duplicate') before the capacity check. The org comes from the hook row. It
-- stores the raw push (and, for an adapter that signs its address, that address) and nothing else, and it wakes the worker with an empty notification (the body is never in the notification).
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_put_notice(p_hook uuid, p_key_sha256 text, p_dedupe_key text, p_authorization text, p_body bytea, p_request_url text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_rows integer;
BEGIN
  IF p_hook IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' OR p_dedupe_key IS NULL OR p_dedupe_key !~ '^[0-9a-f]{64}$'
     OR p_authorization IS NULL OR pg_catalog.char_length(p_authorization) NOT BETWEEN 1 AND 256
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 16384
     OR (p_request_url IS NOT NULL AND pg_catalog.char_length(p_request_url) NOT BETWEEN 1 AND 400) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_INVALID' USING ERRCODE = '22P02';
  END IF;
  SELECT h.org_id INTO v_org
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
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook LIMIT 20) s) >= 20
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.marketplace_hook_notice LIMIT 10001) s) > 10000 THEN
    RETURN 'busy';
  END IF;
  INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, request_url)
  VALUES (v_org, p_hook, p_dedupe_key, p_authorization, p_body, p_request_url)
  ON CONFLICT ON CONSTRAINT marketplace_hook_notice_dedupe_uq DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;
  UPDATE crove_finance.marketplace_hook h SET last_seen_at = pg_catalog.clock_timestamp() WHERE h.org_id = v_org AND h.id = p_hook;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN 'accepted';
END $$;

-- ---------------------------------------------------------------------------
-- The worker login's side: claim the waiting pushes, count a refused one, sweep.
-- ---------------------------------------------------------------------------
-- Deletes every push older than ten minutes, whatever it holds (the worker was away, or the push is not one it can read), and answers how many went. Called by the claim and by the nightly sweep.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_sweep()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM crove_finance.marketplace_hook_notice n WHERE n.received_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- Claims up to p_limit waiting pushes for the worker relay: the rows are DELETED as they are claimed (a push is only a hint to poll; one lost with a worker that dies is made up by the next push and the periodic poll),
-- and what an org or connection that no longer takes pushes left is deleted and not answered. Anything older than ten minutes is swept first. The answer is the raw push with the hook, the marketplace connection, its
-- channel connection, its adapter and platform: the worker alone opens the connection's secret and checks it, and the body stays in its memory.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_claim(p_limit integer)
RETURNS TABLE (org_id uuid, hook_id uuid, marketplace_connection_id uuid, channel_connection_id uuid, adapter text, platform text, dedupe_key text, authorization_header text, body bytea, request_url text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM crove_finance.marketplace_hook_sweep();
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM crove_finance.marketplace_hook_notice n
    WHERE (n.org_id, n.id) IN (
      SELECT q.org_id, q.id FROM crove_finance.marketplace_hook_notice q ORDER BY q.received_at, q.id LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.dedupe_key AS c_dedupe, n.authorization_header AS c_authorization, n.body AS c_body, n.request_url AS c_url
  )
  SELECT cl.c_org, cl.c_hook, m.id, m.channel_connection_id, pg_catalog.substr(m.provider, 13), m.platform, cl.c_dedupe, cl.c_authorization, cl.c_body, cl.c_url
  FROM claimed cl
  JOIN crove_finance.marketplace_hook h ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  JOIN crove_finance.marketplace_connection m ON m.org_id = h.org_id AND m.id = h.marketplace_connection_id
  JOIN crove_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance');
END $$;

-- Counts a push the worker refused (a signature that does not match, or a body naming another shop or seller): ten within an hour stop the hook until it is rotated. Answers whether the hook is now stopped.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_reject(p_hook uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_stopped boolean;
BEGIN
  UPDATE crove_finance.marketplace_hook h SET
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
-- Makes the hook of a marketplace connection of the caller's org, or replaces its key (the old address stops working at once, and a stopped hook takes pushes again). p_key_sha256 is the SHA-256 (hex) of the new key,
-- which the command made and shows once. Answers true for a new hook and false for a rotation. Owners and admins only; the connection must be a real adapter's (not the offline one) and its channel connection active.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_set(p_connection uuid, p_key_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_new boolean;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_connection IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.marketplace_connection m
    JOIN crove_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
    WHERE m.org_id = v_org AND m.id = p_connection AND m.provider IN ('marketplace_lazada', 'marketplace_shopee', 'marketplace_tiktok_shop')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_finance.marketplace_hook AS h (org_id, marketplace_connection_id, key_sha256)
  VALUES (v_org, p_connection, p_key_sha256)
  ON CONFLICT ON CONSTRAINT marketplace_hook_connection_uq DO UPDATE SET
    key_sha256 = EXCLUDED.key_sha256,
    rotated_at = pg_catalog.clock_timestamp(),
    rejected_count = 0,
    rejected_window_start = NULL,
    stopped_at = NULL
  RETURNING (xmax = 0) INTO v_new;
  -- A rotation also drops the pushes still waiting for the old address: they were signed for the old hook's key and no one is to read them.
  IF NOT v_new THEN
    DELETE FROM crove_finance.marketplace_hook_notice n USING crove_finance.marketplace_hook h WHERE h.org_id = v_org AND h.marketplace_connection_id = p_connection AND n.org_id = h.org_id AND n.hook_id = h.id;
  END IF;
  RETURN v_new;
END $$;

-- The status of the hook of a connection of the caller's org, never its key or its hash: when it was made and rotated, when a push last arrived, the pushes refused in the current hour and whether it is stopped. No row
-- when the connection has no hook. Owners and admins only.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_hook_status(p_connection uuid)
RETURNS TABLE (created_at timestamptz, rotated_at timestamptz, last_seen_at timestamptz, rejected_count integer, stopped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT h.created_at, h.rotated_at, h.last_seen_at,
         CASE WHEN h.rejected_window_start IS NOT NULL AND h.rejected_window_start >= pg_catalog.clock_timestamp() - interval '1 hour' THEN h.rejected_count ELSE 0 END,
         h.stopped_at IS NOT NULL
  FROM crove_finance.marketplace_hook h
  WHERE h.org_id = v_org AND h.marketplace_connection_id = p_connection;
END $$;

-- ---------------------------------------------------------------------------
-- Erasure (kernel.personal_data.erase, R3, owners): the pushes of the caller's org whose raw body mentions the value are deleted (the matching is crove_kernel.text_mentions, the finder's own, over the body as text, or as escaped bytes when it
-- is not valid UTF-8). Answers how many went. A kind or a value of the wrong shape is refused (22023) before any row is read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.personal_data_erase_marketplace_hook_notice(p_kind text, p_value text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_rows integer := 0;
  v_text text;
  r record;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  -- A body that is valid UTF-8 is read as the text it is (so a phone after a Vietnamese letter, or with no-break spaces, is found); only a body that is not valid UTF-8 is read as escaped bytes.
  FOR r IN SELECT n.id, n.body FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org LOOP
    BEGIN
      v_text := pg_catalog.convert_from(r.body, 'UTF8');
    EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      v_text := pg_catalog.encode(r.body, 'escape');
    END;
    IF crove_kernel.text_mentions(v_text, p_kind, p_value) THEN
      DELETE FROM crove_finance.marketplace_hook_notice n WHERE n.org_id = v_org AND n.id = r.id;
      v_rows := v_rows + 1;
    END IF;
  END LOOP;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- Who may call what. Every login role loses all of them first (a later role starts with none), then each gets its own.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_finance.marketplace_hook_lookup(text, text),
  crove_finance.marketplace_hook_put_notice(uuid, text, text, text, bytea, text),
  crove_finance.marketplace_hook_sweep(),
  crove_finance.marketplace_hook_claim(integer),
  crove_finance.marketplace_hook_reject(uuid),
  crove_finance.marketplace_hook_set(uuid, text),
  crove_finance.marketplace_hook_status(uuid),
  crove_finance.personal_data_erase_marketplace_hook_notice(text, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_finance.marketplace_hook_lookup(text, text), crove_finance.marketplace_hook_put_notice(uuid, text, text, text, bytea, text), crove_finance.marketplace_hook_sweep(), '
      'crove_finance.marketplace_hook_claim(integer), crove_finance.marketplace_hook_reject(uuid), crove_finance.marketplace_hook_set(uuid, text), crove_finance.marketplace_hook_status(uuid), '
      'crove_finance.personal_data_erase_marketplace_hook_notice(text, text) FROM %I',
      r.rolname);
  END LOOP;
END $$;
-- The API's own login: the route's lookup and put, the owner's or admin's set and status, and the owner's erasure.
GRANT EXECUTE ON FUNCTION
  crove_finance.marketplace_hook_lookup(text, text),
  crove_finance.marketplace_hook_put_notice(uuid, text, text, text, bytea, text),
  crove_finance.marketplace_hook_set(uuid, text),
  crove_finance.marketplace_hook_status(uuid),
  crove_finance.personal_data_erase_marketplace_hook_notice(text, text)
TO crove_app;
-- The worker's login alone: the claim, the count of a refused push and the nightly sweep.
GRANT EXECUTE ON FUNCTION
  crove_finance.marketplace_hook_sweep(),
  crove_finance.marketplace_hook_claim(integer),
  crove_finance.marketplace_hook_reject(uuid)
TO crove_worker;
