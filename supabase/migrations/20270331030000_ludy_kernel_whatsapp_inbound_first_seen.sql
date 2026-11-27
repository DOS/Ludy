-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (#5085, follow-up of #5047): a durable, cross-process "first seen" record for WhatsApp webhook events, so a Meta retry that
-- lands on another API pod, or after a restart, inside WHATSAPP_CLOCK_SKEW_MS never gets a fresh `received_at` later than the original.
-- Without it the per-process replay cache is empty on the retry, `conversation_inbound_enqueue` inserts a row dated now, and a notice
-- first received just before a WhatsApp number handover (whose event time Meta skewed forward) would pass the `received_at >= connected_at`
-- check of #5047 for the new holder.
--
-- Idempotent; applied files stay untouched.
--
-- 1. ludy_kernel.conversation_inbound_first_seen: a control-plane table (no tenant column, like conversation_inbound_pending: the org comes
--    from the stored connection, never from the notice, ADR-0039). The key is the SHA-256 of a domain-separated event id (business phone
--    number id, direction, wamid, failed-status code), never the id itself and never a customer's phone number or words.
-- 2. ludy_kernel.conversation_inbound_enqueue_seen(provider, body, keys): records the keys (first write wins), parks the notice through
--    the unchanged conversation_inbound_enqueue (same caps, same lock) and dates it the earliest first-seen time of its keys, never later
--    than now. A backlog refusal returns NULL instead of raising, so the keys recorded by this call survive the refusal and the platform's
--    retry still carries the original time. Called by the API login only.
-- 3. ludy_kernel.conversation_inbound_first_seen_purge(limit): worker login only; drops keys older than 8 days: the webhook accepts an
--    event up to 7 days after its own timestamp, which Meta's clock may run up to WHATSAPP_CLOCK_SKEW_MS (10 minutes) ahead of the first arrival, so
--    7 days plus the skew, rounded up to a day, is the longest a key can still matter. The enqueue
--    also drops a bounded batch, so the table stays small even if the worker is down.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_kernel.conversation_inbound_first_seen (
  key bytea PRIMARY KEY CHECK (pg_catalog.octet_length(key) = 32),
  first_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS conversation_inbound_first_seen_at_idx
  ON ludy_kernel.conversation_inbound_first_seen (first_seen_at);

REVOKE ALL ON TABLE ludy_kernel.conversation_inbound_first_seen FROM PUBLIC;
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
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_kernel.conversation_inbound_first_seen FROM %I', v_role);
  END LOOP;
END
$$;

ALTER TABLE ludy_kernel.conversation_inbound_first_seen ENABLE ROW LEVEL SECURITY;

-- An agent context writes none of it (ADR-0029): the guard every table carries.
SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.conversation_inbound_first_seen');

CREATE OR REPLACE FUNCTION ludy_kernel.conversation_inbound_enqueue_seen(p_provider text, p_body bytea, p_keys text[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_keys bytea[];
  v_first timestamptz;
  v_seq bigint;
BEGIN
  IF p_provider IS NULL OR p_body IS NULL OR p_keys IS NULL
     OR pg_catalog.cardinality(p_keys) > 1000
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_keys) AS k(h) WHERE k.h IS NULL OR k.h !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'CONVERSATION_INBOUND_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- The same lock the enqueue takes (it is re-entrant inside one transaction): every writer of this table queues here, so concurrent
  -- deliveries of one event cannot interleave and two deliveries with keys in opposite order cannot deadlock.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove.conversation_inbound_enqueue', 0));

  SELECT pg_catalog.array_agg(DISTINCT pg_catalog.decode(k.h, 'hex')) INTO v_keys FROM pg_catalog.unnest(p_keys) AS k(h);

  IF v_keys IS NOT NULL THEN
    INSERT INTO ludy_kernel.conversation_inbound_first_seen (key)
    SELECT k.key FROM pg_catalog.unnest(v_keys) AS k(key) ORDER BY k.key
    ON CONFLICT (key) DO NOTHING;
    SELECT pg_catalog.min(f.first_seen_at) INTO v_first
    FROM ludy_kernel.conversation_inbound_first_seen f WHERE f.key = ANY (v_keys);
  END IF;

  -- A small bounded batch of keys past their 8 days (the index is on first_seen_at; SKIP LOCKED so it never waits on the worker's purge), so the table stays
  -- small even without the worker, and the serialized section stays short. WhatsApp must come through this function, never the plain enqueue.
  DELETE FROM ludy_kernel.conversation_inbound_first_seen f
  WHERE f.key IN (
    SELECT o.key FROM ludy_kernel.conversation_inbound_first_seen o
    WHERE o.first_seen_at < pg_catalog.now() - pg_catalog.make_interval(days => 8)
    ORDER BY o.first_seen_at LIMIT 20 FOR UPDATE SKIP LOCKED
  );

  BEGIN
    v_seq := ludy_kernel.conversation_inbound_enqueue(p_provider, p_body);
  EXCEPTION WHEN SQLSTATE '53400' THEN
    -- Backlog: nothing parked, the keys stay recorded, and the API answers 503 so the platform retries.
    RETURN NULL;
  END;

  -- Only ever earlier than now: the notice cannot gain a later received_at by being retried, and a first-seen older than 7 days is
  -- dropped as expired by conversation_inbound_claim like any old notice.
  IF v_first IS NOT NULL THEN
    UPDATE ludy_kernel.conversation_inbound_pending p
    SET received_at = LEAST(p.received_at, v_first)
    WHERE p.seq = v_seq;
  END IF;
  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.conversation_inbound_enqueue_seen(text, bytea, text[])
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.conversation_inbound_enqueue_seen(text, bytea, text[]) TO ludy_app;

CREATE OR REPLACE FUNCTION ludy_kernel.conversation_inbound_first_seen_purge(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM ludy_kernel.conversation_inbound_first_seen f
  WHERE f.key IN (
    SELECT o.key FROM ludy_kernel.conversation_inbound_first_seen o
    WHERE o.first_seen_at < pg_catalog.now() - pg_catalog.make_interval(days => 8)
    ORDER BY o.first_seen_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 5000) FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.conversation_inbound_first_seen_purge(integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.conversation_inbound_first_seen_purge(integer) TO ludy_worker;
