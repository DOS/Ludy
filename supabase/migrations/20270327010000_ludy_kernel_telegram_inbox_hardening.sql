-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (#3150, review notes of #3141 and #3203): harden Telegram inbox webhooks and shared backlog.
-- Idempotent; applied files stay untouched.
--
-- 1. Key rotation webhook rekeying: track chat_hook_key_id on ludy_kernel.channel_connection (which credential key
--    derived the currently registered webhook secret) plus worker-only scans (telegram_chat_hook_rekey_due and
--    telegram_chat_hook_rekey_counts) so rotating CREDENTIAL_KEY re-registers live webhooks under the current key
--    before CREDENTIAL_KEY_PREVIOUS is dropped.
-- 2. Cross-org bot takeover detection: worker-only ludy_kernel.telegram_chat_other_orgs_with_bot lists active/enabling
--    Telegram connections in other orgs holding the same chat_bot_id so a second org claiming the bot updates the
--    displaced org's connection cleanly via SYSTEM without any cross-org oracle.
-- 3. Per-org backlog share: ludy_kernel.conversation_inbound_pending gains bucket_key (SHA-256 hex of org_id; never
--    named org_id) indexed by (provider, bucket_key), and ludy_kernel.telegram_inbound_enqueue caps each org at 1,000
--    waiting notices inside the 10,000 telegram_chat cap and 50,000 table ceiling while ignoring retired/off hooks.
-- 4. Cross-column chat_hook / chat_hook_next uniqueness: enforce via SECURITY DEFINER trigger with sorted advisory
--    locks so one row's chat_hook cannot match another row's chat_hook_next; telegram_inbound_enqueue also fails
--    closed if more than one connection matches.
-- 5. Deterministic ordering on ludy_kernel.conversation_chat_hook_connections (ORDER BY c.org_id, c.id), matching its
--    sibling conversation_connections_for.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_hook_key_id text;
ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_displace_pending boolean NOT NULL DEFAULT false;
ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_hook_rekey_after timestamptz;
ALTER TABLE ludy_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_business_order jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.channel_connection'::regclass
      AND conname = 'channel_connection_chat_hook_key_check'
  ) THEN
    ALTER TABLE ludy_kernel.channel_connection
      ADD CONSTRAINT channel_connection_chat_hook_key_check CHECK (
        chat_hook_key_id IS NULL
        OR chat_hook_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'
      );
  END IF;
END $$;

GRANT UPDATE (chat_hook_key_id, chat_displace_pending, chat_hook_rekey_after, chat_business_order)
  ON ludy_kernel.channel_connection TO ludy_tenant;

-- Cross-column uniqueness across chat_hook and chat_hook_next (#3150 item 4): one row's live hook cannot equal another
-- row's pending hook. Sorted advisory locks serialize concurrent updates/inserts on identical hook values without
-- deadlocks, and SECURITY DEFINER lets the trigger check across org RLS boundaries cleanly.
CREATE OR REPLACE FUNCTION ludy_kernel.channel_connection_chat_hook_unique()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hooks text[];
  v_hook text;
BEGIN
  SELECT pg_catalog.array_agg(DISTINCT h ORDER BY h)
  INTO v_hooks
  FROM pg_catalog.unnest(ARRAY[NEW.chat_hook, NEW.chat_hook_next]) AS u(h)
  WHERE h IS NOT NULL;

  IF v_hooks IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_hook IN ARRAY v_hooks LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy.chat_hook:' || v_hook, 0));
    IF EXISTS (
      SELECT 1
      FROM ludy_kernel.channel_connection c
      WHERE (c.org_id, c.id) IS DISTINCT FROM (NEW.org_id, NEW.id)
        AND (c.chat_hook = v_hook OR c.chat_hook_next = v_hook)
    ) THEN
      RAISE EXCEPTION 'TELEGRAM_CHAT_HOOK_DUPLICATE' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.channel_connection_chat_hook_unique()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS channel_connection_chat_hook_unique ON ludy_kernel.channel_connection;
CREATE TRIGGER channel_connection_chat_hook_unique
  BEFORE INSERT OR UPDATE OF chat_hook, chat_hook_next ON ludy_kernel.channel_connection
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.channel_connection_chat_hook_unique();

-- Deterministic order matching conversation_connections_for (#3150 item 5).
CREATE OR REPLACE FUNCTION ludy_kernel.conversation_chat_hook_connections(p_hook text)
RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE (c.chat_hook = p_hook OR c.chat_hook_next = p_hook)
    AND c.provider = 'telegram'
    AND c.status = 'active'
    AND c.chat_state IN ('enabling', 'on', 'disabling')
  ORDER BY c.org_id, c.id
$$;

REVOKE ALL ON FUNCTION ludy_kernel.conversation_chat_hook_connections(text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.conversation_chat_hook_connections(text) TO ludy_worker;

-- Live Telegram connections whose registered webhook secret is still derived from an older credential key (or NULL on
-- connections created before chat_hook_key_id existed), paged by (COALESCE(chat_hook_rekey_after, epoch), org_id, id)
-- so connections with persistent transient errors never starve healthy ones behind them (#3150 item 1). Worker-only.
CREATE OR REPLACE FUNCTION ludy_kernel.telegram_chat_hook_rekey_due(
  p_key_id text,
  p_limit integer,
  p_after_rekey_at timestamptz,
  p_after_org uuid,
  p_after_id uuid
)
RETURNS TABLE (org_id uuid, connection_id uuid, chat_hook_rekey_after timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id AS connection_id, c.chat_hook_rekey_after
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding')
  WHERE c.provider = 'telegram'
    AND c.status = 'active'
    AND c.chat_state = 'on'
    AND c.chat_hook IS NOT NULL
    AND c.chat_hook_key_id IS DISTINCT FROM p_key_id
    AND ludy_kernel.credential_usable(c.org_id, c.id)
    AND (
      p_after_org IS NULL
      OR p_after_id IS NULL
      OR (COALESCE(c.chat_hook_rekey_after, '1970-01-01T00:00:00Z'::timestamptz), c.org_id, c.id)
         > (COALESCE(p_after_rekey_at, '1970-01-01T00:00:00Z'::timestamptz), p_after_org, p_after_id)
    )
  ORDER BY COALESCE(c.chat_hook_rekey_after, '1970-01-01T00:00:00Z'::timestamptz), c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_chat_hook_rekey_due(text, integer, timestamptz, uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_chat_hook_rekey_due(text, integer, timestamptz, uuid, uuid) TO ludy_worker;

-- Live Telegram connections whose bot displacement sweep failed transiently and still need stale orgs cleared (#3150). Worker-only.
CREATE OR REPLACE FUNCTION ludy_kernel.telegram_chat_displace_due(p_limit integer)
RETURNS TABLE (org_id uuid, connection_id uuid, chat_bot_id text, chat_changed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id AS connection_id, c.chat_bot_id, c.chat_changed_at
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding')
  WHERE c.provider = 'telegram'
    AND c.status = 'active'
    AND c.chat_state = 'on'
    AND c.chat_displace_pending = true
    AND c.chat_bot_id IS NOT NULL
  ORDER BY c.chat_changed_at NULLS LAST, c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_chat_displace_due(integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_chat_displace_due(integer) TO ludy_worker;

-- Non-connection-blocking worker leases for per-bot webhook serialization and rekey sweep mutual exclusion (#3150),
-- avoiding advisory-lock pool deadlocks under WORKER_DATABASE_POOL_MAX=2. Definer-only.
CREATE TABLE IF NOT EXISTS ludy_kernel.telegram_webhook_lock (
  lock_key text PRIMARY KEY CHECK (lock_key ~ '^[a-z0-9:._-]{1,100}$'),
  owner_id uuid NOT NULL,
  locked_until timestamptz NOT NULL
);

REVOKE ALL ON TABLE ludy_kernel.telegram_webhook_lock FROM PUBLIC;
REVOKE ALL ON TABLE ludy_kernel.telegram_webhook_lock FROM ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_prober;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' ESCAPE '\' OR rolname LIKE 'crove\_%' ESCAPE '\')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_kernel.telegram_webhook_lock FROM %I', v_role);
  END LOOP;
END
$$;

ALTER TABLE ludy_kernel.telegram_webhook_lock ENABLE ROW LEVEL SECURITY;

SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.telegram_webhook_lock');

CREATE OR REPLACE FUNCTION ludy_kernel.telegram_webhook_lock_acquire(
  p_lock_key text,
  p_owner_id uuid,
  p_ttl_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_lock_key IS NULL OR p_lock_key !~ '^[a-z0-9:._-]{1,100}$' OR p_owner_id IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'TELEGRAM_WEBHOOK_LOCK_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  DELETE FROM ludy_kernel.telegram_webhook_lock
  WHERE locked_until <= v_now - interval '1 hour';

  INSERT INTO ludy_kernel.telegram_webhook_lock (lock_key, owner_id, locked_until)
  VALUES (p_lock_key, p_owner_id, v_now + pg_catalog.make_interval(secs => p_ttl_seconds))
  ON CONFLICT (lock_key) DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        locked_until = EXCLUDED.locked_until
    WHERE ludy_kernel.telegram_webhook_lock.locked_until <= v_now
       OR ludy_kernel.telegram_webhook_lock.owner_id = EXCLUDED.owner_id
  RETURNING lock_key INTO v_key;

  RETURN v_key IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_webhook_lock_acquire(text, uuid, integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_webhook_lock_acquire(text, uuid, integer) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.telegram_webhook_lock_release(
  p_lock_key text,
  p_owner_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_lock_key IS NULL OR p_owner_id IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM ludy_kernel.telegram_webhook_lock
  WHERE lock_key = p_lock_key AND owner_id = p_owner_id;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_webhook_lock_release(text, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_webhook_lock_release(text, uuid) TO ludy_worker;

-- Counts of hooked Telegram connections grouped by webhook secret key id, split by whether the worker can still
-- re-register them without an owner reconnecting (#3150 item 1). Worker-only.
CREATE OR REPLACE FUNCTION ludy_kernel.telegram_chat_hook_rekey_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT
    COALESCE(c.chat_hook_key_id, 'legacy') AS key_id,
    pg_catalog.count(*) FILTER (
      WHERE c.chat_state IN ('enabling', 'on')
        AND c.status = 'active'
        AND t.status IN ('active', 'offboarding')
        AND ludy_kernel.credential_usable(c.org_id, c.id)
    ) AS active,
    pg_catalog.count(*) FILTER (
      WHERE NOT (
        c.chat_state IN ('enabling', 'on')
        AND c.status = 'active'
        AND t.status IN ('active', 'offboarding')
        AND ludy_kernel.credential_usable(c.org_id, c.id)
      )
    ) AS inactive
  FROM ludy_kernel.channel_connection c
  LEFT JOIN ludy_kernel.tenant t ON t.org_id = c.org_id
  WHERE c.provider = 'telegram'
    AND c.chat_hook IS NOT NULL
  GROUP BY COALESCE(c.chat_hook_key_id, 'legacy')
$$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_chat_hook_rekey_counts()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_chat_hook_rekey_counts() TO ludy_worker;

-- Other orgs holding an active or enabling Telegram connection with the same bot id (#3150 item 2). Worker-only.
CREATE OR REPLACE FUNCTION ludy_kernel.telegram_chat_other_orgs_with_bot(
  p_bot_id text,
  p_exclude_org_id uuid
)
RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id AS connection_id
  FROM ludy_kernel.channel_connection c
  JOIN ludy_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding')
  WHERE c.provider = 'telegram'
    AND c.status = 'active'
    AND c.chat_bot_id = p_bot_id
    AND c.chat_state IN ('enabling', 'on')
    AND c.org_id <> p_exclude_org_id
  ORDER BY c.org_id, c.id
$$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_chat_other_orgs_with_bot(text, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_chat_other_orgs_with_bot(text, uuid) TO ludy_worker;

-- Shared Telegram notice backlog fairness (#3150 item 3): hashed bucket_key keeps tenant IDs out of this control-plane
-- table (ADR-0039) while enforcing a per-org cap of 1,000 notices within the 10,000 telegram_chat cap and 50,000 total.
ALTER TABLE ludy_kernel.conversation_inbound_pending ADD COLUMN IF NOT EXISTS bucket_key text;

CREATE INDEX IF NOT EXISTS conversation_inbound_provider_bucket_idx
  ON ludy_kernel.conversation_inbound_pending (provider, bucket_key)
  WHERE bucket_key IS NOT NULL;

CREATE OR REPLACE FUNCTION ludy_kernel.telegram_inbound_enqueue(p_hook text, p_body bytea)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_orgs uuid[];
  v_bucket text;
  v_seq bigint;
BEGIN
  IF p_hook IS NULL OR p_body IS NULL THEN
    RAISE EXCEPTION 'CONVERSATION_INBOUND_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(c.org_id ORDER BY c.org_id, c.connection_id)
  INTO v_orgs
  FROM (
    SELECT org_id, connection_id
    FROM ludy_kernel.conversation_chat_hook_connections(p_hook)
    LIMIT 2
  ) c;

  IF v_orgs IS NULL OR pg_catalog.cardinality(v_orgs) = 0 THEN
    RETURN NULL;
  END IF;

  IF pg_catalog.cardinality(v_orgs) > 1 THEN
    RAISE EXCEPTION 'TELEGRAM_CHAT_HOOK_AMBIGUOUS' USING ERRCODE = '23505';
  END IF;

  v_bucket := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_orgs[1]::text, 'UTF8')), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove.conversation_inbound_enqueue', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ludy_kernel.conversation_inbound_pending p WHERE p.provider = 'telegram_chat' AND p.bucket_key = v_bucket LIMIT 1001) s) >= 1000
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ludy_kernel.conversation_inbound_pending p WHERE p.provider = 'telegram_chat' LIMIT 10001) s) >= 10000
     OR (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ludy_kernel.conversation_inbound_pending LIMIT 50001) s) > 50000 THEN
    RAISE EXCEPTION 'CONVERSATION_BACKLOG' USING ERRCODE = '53400';
  END IF;

  INSERT INTO ludy_kernel.conversation_inbound_pending (provider, bucket_key, body)
  VALUES ('telegram_chat', v_bucket, p_body)
  RETURNING seq INTO v_seq;
  PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.telegram_inbound_enqueue(text, bytea)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.telegram_inbound_enqueue(text, bytea) TO ludy_app;
