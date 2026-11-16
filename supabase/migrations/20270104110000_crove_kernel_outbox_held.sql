-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3310, ADR-0053 slice c, C3b): the events of an app that is off wait, and flow when it is back on. Idempotent; applied files stay untouched.
--
-- The relay claims an event (outbox_claim deletes its outbox_pending row) and queues its jobs in the same transaction. For an event of an org whose app is off the
-- job would be refused and ended quietly, and the event lost. Instead the relay hands such an event to crove_kernel.outbox_hold, which parks its id here, and nothing is
-- queued. The worker's held sweep asks, for each org and app with parked events, whether the app is on now (the choice and the entitlement, in TypeScript), and
-- crove_kernel.outbox_release puts the parked events back on outbox_pending, oldest first, so the relay takes them like any other. There is no expiry (ADR-0053
-- section 4: an event that nothing finds again is held, not dropped); the number of parked events per org and app is what outbox_hold_pairs answers, and the worker logs it.
-- The retention job leaves the day of a parked event unarchived-away: outbox_archive_purge answers -1 for it, as for one that still waits for the relay.
--
-- All four functions are the worker's alone; they return ids and counts, never an event. The table has RLS on and no grant to any login role.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.outbox_held (
  id bigint GENERATED ALWAYS AS IDENTITY,
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  held_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- Also the lookup of one org's parked events of one app, which is how the release reads them.
  CONSTRAINT outbox_held_event_uq UNIQUE (org_id, module, event_id),
  PRIMARY KEY (org_id, id)
);
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN PERFORM set_config('lock_timeout', '2s', true); ALTER TABLE crove_kernel.outbox_held ENABLE ROW LEVEL SECURITY; EXIT; EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random()); END; END LOOP; END $$;
REVOKE ALL ON crove_kernel.outbox_held FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.outbox_held');

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

-- The (org, app) pairs of active orgs with parked events, in key order after the given one (the first page: NULLs), with how many events wait.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_hold_pairs(p_limit integer, p_after_org uuid, p_after_module text)
RETURNS TABLE (org_id uuid, module text, waiting bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR (p_after_org IS NULL) <> (p_after_module IS NULL) THEN
    RAISE EXCEPTION 'OUTBOX_HOLD_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT h.org_id, h.module, pg_catalog.count(*)
    FROM crove_kernel.outbox_held h
    JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active'
    WHERE p_after_org IS NULL OR (h.org_id, h.module) > (p_after_org, p_after_module)
    GROUP BY h.org_id, h.module ORDER BY h.org_id, h.module LIMIT p_limit;
END $$;

-- Puts up to p_limit parked events of one active org and app back on outbox_pending, oldest first. Answers how many (none for an org that is not active).
CREATE OR REPLACE FUNCTION crove_kernel.outbox_release(p_org uuid, p_module text, p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_released integer;
BEGIN
  IF p_org IS NULL OR p_module IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OUTBOX_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org AND t.status = 'active') THEN
    RETURN 0;
  END IF;
  WITH taken AS (
    DELETE FROM crove_kernel.outbox_held h
    WHERE h.org_id = p_org AND h.id IN (SELECT q.id FROM crove_kernel.outbox_held q WHERE q.org_id = p_org AND q.module = p_module ORDER BY q.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING h.id, h.org_id, h.event_id
  ), moved AS (
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT t.org_id, t.event_id FROM taken t ORDER BY t.id RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_released FROM moved;
  RETURN v_released;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.outbox_hold(uuid[], uuid[], text[]), crove_kernel.outbox_hold_pairs(integer, uuid, text), crove_kernel.outbox_release(uuid, text, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_hold(uuid[], uuid[], text[]), crove_kernel.outbox_hold_pairs(integer, uuid, text), crove_kernel.outbox_release(uuid, text, integer) TO crove_worker;

-- outbox_archive_purge of 20261028100000_crove_kernel_outbox_retention.sql, with one addition: the day of an event that waits while its app is off is not purged (-1, the
-- next run tries again), as the day of an event that waits for the relay is not.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_archive_purge(p_org_id uuid, p_day date, p_keep_days int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_archive crove_kernel.outbox_archive;
  v_from timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_to timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_deleted int;
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  IF p_day >= crove_kernel.outbox_retention_cutoff(p_keep_days) THEN
    RAISE EXCEPTION 'OUTBOX_DAY_TOO_RECENT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_archive FROM crove_kernel.outbox_archive a WHERE a.org_id = p_org_id AND a.day = p_day FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTBOX_DAY_NOT_ARCHIVED' USING ERRCODE = '42501';
  END IF;
  IF v_archive.purged_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.outbox_pending p
    JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
    WHERE p.org_id = p_org_id AND e.created_at >= v_from AND e.created_at < v_to
  ) THEN
    RETURN -1;
  END IF;
  -- An event of the day that waits while its app is off is not archived away: it is still to be delivered (ADR-0053).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.outbox_held h
    JOIN crove_kernel.outbox_event e ON e.org_id = h.org_id AND e.id = h.event_id
    WHERE h.org_id = p_org_id AND e.created_at >= v_from AND e.created_at < v_to
  ) THEN
    RETURN -1;
  END IF;
  PERFORM pg_catalog.set_config('crove.outbox_purge', p_org_id::text || ':' || p_day::text, true);
  DELETE FROM crove_kernel.outbox_event e WHERE e.org_id = p_org_id AND e.created_at >= v_from AND e.created_at < v_to;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM pg_catalog.set_config('crove.outbox_purge', '', true);
  IF v_deleted <> v_archive.row_count THEN
    RAISE EXCEPTION 'OUTBOX_PURGE_MISMATCH' USING ERRCODE = '40001',
      DETAIL = pg_catalog.format('archived %s, found %s', v_archive.row_count, v_deleted);
  END IF;
  UPDATE crove_kernel.outbox_archive a SET purged_at = pg_catalog.now(), purged_rows = v_deleted
  WHERE a.org_id = p_org_id AND a.day = p_day;
  RETURN v_deleted;
END $$;
