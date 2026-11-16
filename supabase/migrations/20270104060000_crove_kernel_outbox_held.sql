-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3310, ADR-0053 slice c, C3b): the events of an app that is off wait, and flow when it is back on. Idempotent; applied files stay untouched.
--
-- The relay claims an event (outbox_claim deletes its outbox_pending row) and queues its jobs in the same transaction. For an event of an org whose app is off the
-- job would be refused and ended quietly, and the event lost. Instead the relay hands such an event to crove_kernel.outbox_hold, which parks its id here, and nothing is
-- queued. The worker's held sweep asks, for each org and app with parked events, whether the app is on now (the choice and the entitlement, in TypeScript), and
-- crove_kernel.outbox_release puts the parked events back on outbox_pending, oldest first, so the relay takes them like any other, in order. A parked event older
-- than the expiry (14 days, the worker's) is dropped instead of released: an alert or a reminder that old is no use, and the org purge leaves this table (ids only; the
-- events themselves are archived and deleted by the retention job).
--
-- outbox_hold_pairs lists the (org, app) pairs that have parked events, oldest first, for the sweep. All four functions are the worker's alone; they return ids and
-- counts, never an event.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.outbox_held (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  held_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- Also the lookup of one org's parked events of one app, which is how the release reads them.
  CONSTRAINT outbox_held_event_uq UNIQUE (org_id, module, event_id)
);
REVOKE ALL ON crove_kernel.outbox_held FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Parks events: three arrays of the same length (at most 1000), one entry per event. An event already parked for the app stays as it is.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_hold(p_orgs uuid[], p_events uuid[], p_modules text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_orgs IS NULL OR p_events IS NULL OR p_modules IS NULL
     OR pg_catalog.cardinality(p_orgs) <> pg_catalog.cardinality(p_events) OR pg_catalog.cardinality(p_orgs) <> pg_catalog.cardinality(p_modules)
     OR pg_catalog.cardinality(p_orgs) > 1000 THEN
    RAISE EXCEPTION 'OUTBOX_HOLD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.outbox_held (org_id, event_id, module)
  SELECT t.o, t.e, t.m FROM ROWS FROM (pg_catalog.unnest(p_orgs), pg_catalog.unnest(p_events), pg_catalog.unnest(p_modules)) AS t (o, e, m)
  ON CONFLICT (org_id, module, event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- The (org, app) pairs with parked events, the oldest first.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_hold_pairs(p_limit integer)
RETURNS TABLE (org_id uuid, module text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OUTBOX_HOLD_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT h.org_id, h.module FROM crove_kernel.outbox_held h GROUP BY h.org_id, h.module ORDER BY pg_catalog.min(h.seq) LIMIT p_limit;
END $$;

-- Puts up to p_limit parked events of one org and app back on outbox_pending, oldest first, and drops the ones older than p_ttl_days instead. Answers the counts.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_release(p_org uuid, p_module text, p_limit integer, p_ttl_days integer)
RETURNS TABLE (released integer, expired integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_expired integer;
  v_released integer;
BEGIN
  IF p_org IS NULL OR p_module IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_ttl_days IS NULL OR p_ttl_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'OUTBOX_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.outbox_held h WHERE h.org_id = p_org AND h.module = p_module AND h.held_at < pg_catalog.now() - pg_catalog.make_interval(days => p_ttl_days);
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  WITH taken AS (
    DELETE FROM crove_kernel.outbox_held h
    WHERE h.seq IN (SELECT q.seq FROM crove_kernel.outbox_held q WHERE q.org_id = p_org AND q.module = p_module ORDER BY q.seq LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING h.seq, h.org_id, h.event_id
  ), moved AS (
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT t.org_id, t.event_id FROM taken t ORDER BY t.seq RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_released FROM moved;
  RETURN QUERY SELECT v_released, v_expired;
END $$;

-- Drops every parked event older than p_ttl_days, of every org (the ones of an org that never switches the app on again, or that was closed).
CREATE OR REPLACE FUNCTION crove_kernel.outbox_hold_expire(p_ttl_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_ttl_days IS NULL OR p_ttl_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'OUTBOX_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.outbox_held h WHERE h.held_at < pg_catalog.now() - pg_catalog.make_interval(days => p_ttl_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.outbox_hold(uuid[], uuid[], text[]), crove_kernel.outbox_hold_pairs(integer), crove_kernel.outbox_release(uuid, text, integer, integer), crove_kernel.outbox_hold_expire(integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_hold(uuid[], uuid[], text[]), crove_kernel.outbox_hold_pairs(integer), crove_kernel.outbox_release(uuid, text, integer, integer), crove_kernel.outbox_hold_expire(integer) TO crove_worker;
