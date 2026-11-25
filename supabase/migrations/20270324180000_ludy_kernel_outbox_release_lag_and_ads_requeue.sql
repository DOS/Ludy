-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel and Ads (issue #3409, ADR-0053 C3b follow-up):
--   1. Add enqueued_at (NOT NULL DEFAULT pg_catalog.now()) on ludy_kernel.outbox_pending, set it to pg_catalog.now() in
--      ludy_kernel.outbox_release, and measure lag/age from p.enqueued_at in ludy_kernel.outbox_lag_seconds() and
--      ludy_kernel.health(integer) so a released parked event does not read as days of lag from its original created_at.
--   2. Restate ludy_ads.launch_requeue(text[], integer) and ludy_ads.activate_requeue(text[], integer) to skip orgs where
--      ludy_kernel.org_app_on(t.org_id, 'ads') is false instead of queueing duplicate events into outbox_held.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  n int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
      ALTER TABLE ludy_kernel.outbox_pending
        ADD COLUMN IF NOT EXISTS enqueued_at timestamptz NOT NULL DEFAULT pg_catalog.now();
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      n := n + 1;
      IF n >= 15 THEN
        RAISE;
      END IF;
      PERFORM pg_catalog.pg_sleep(1 + pg_catalog.random());
    END;
  END LOOP;
END $$;

-- Puts up to p_limit parked events of one active org and app back on outbox_pending, oldest first, with enqueued_at
-- stamped to pg_catalog.now() so lag measures time since release. Answers how many (none for an org that is not active).
CREATE OR REPLACE FUNCTION ludy_kernel.outbox_release(p_org uuid, p_module text, p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_released integer;
BEGIN
  IF p_org IS NULL OR p_module IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OUTBOX_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant t WHERE t.org_id = p_org AND t.status = 'active') THEN
    RETURN 0;
  END IF;
  -- One org's release and its day purge never run at once: the purge checks outbox_pending and deletes the day's events in several statements.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy_kernel.outbox:' || p_org::text, 0));
  WITH taken AS (
    DELETE FROM ludy_kernel.outbox_held h
    WHERE h.org_id = p_org AND h.id IN (SELECT q.id FROM ludy_kernel.outbox_held q WHERE q.org_id = p_org AND q.module = p_module ORDER BY q.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING h.id, h.org_id, h.event_id
  ), moved AS (
    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id, enqueued_at)
    SELECT t.org_id, t.event_id, pg_catalog.now() FROM taken t ORDER BY t.id
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_released FROM moved;
  RETURN v_released;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.outbox_release(uuid, text, integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.outbox_release(uuid, text, integer) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.outbox_lag_seconds()
RETURNS double precision LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_age double precision;
  v_held text[];
  v_stale text[];
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'OUTBOX_LAG_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  v_held := ludy_kernel.relay_held_types();
  IF pg_catalog.cardinality(v_held) = 0 THEN
    SELECT EXTRACT(EPOCH FROM pg_catalog.now() - p.enqueued_at)::double precision INTO v_age
    FROM ludy_kernel.outbox_pending p
    ORDER BY p.seq LIMIT 1;
    RETURN GREATEST(COALESCE(v_age, 0), 0);
  END IF;
  -- The oldest row the relay may claim: the first unmarked row of a type not held (unmarked held rows are only those
  -- emitted since the last claim), or the first row of a type marked and since released.
  v_stale := ARRAY(SELECT m FROM pg_catalog.unnest(ludy_kernel.outbox_marked_types()) m WHERE m <> ALL (v_held));
  SELECT EXTRACT(EPOCH FROM pg_catalog.now() - x.enqueued_at)::double precision INTO v_age
  FROM (
    (SELECT p.seq, p.enqueued_at
     FROM ludy_kernel.outbox_pending p
     JOIN ludy_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
     WHERE p.held_type IS NULL AND e.type <> ALL (v_held)
     ORDER BY p.held_type, p.seq LIMIT 1)
    UNION ALL
    (SELECT f.seq, f.enqueued_at
     FROM pg_catalog.unnest(v_stale) s (t)
     CROSS JOIN LATERAL (
       SELECT p.seq, p.enqueued_at FROM ludy_kernel.outbox_pending p
       WHERE p.held_type = s.t ORDER BY p.held_type, p.seq LIMIT 1
     ) f)
  ) x
  ORDER BY x.seq LIMIT 1;
  RETURN GREATEST(COALESCE(v_age, 0), 0);
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.outbox_lag_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ludy_kernel.outbox_lag_seconds() TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.health(p_dead_letter_window_seconds integer DEFAULT 3600)
 RETURNS TABLE(checked_at timestamp with time zone, outbox_pending integer, outbox_oldest_age_seconds double precision, inbound_pending integer, inbound_oldest_age_seconds double precision, jobs_schema_present boolean, jobs_queued integer, job_oldest_queued_age_seconds double precision, dead_letter_count integer, worker_heartbeat_age_seconds double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_window interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_dead_letter_window_seconds, 3600), 60), 604800));
  v_worked text[];
  v_expected text[] := pg_catalog.string_to_array(
    COALESCE(NULLIF(pg_catalog.current_setting('ludy.prober_modules', true), ''), pg_catalog.current_setting('crove.prober_modules', true), ''),
    ','
  );
BEGIN
  checked_at := pg_catalog.now();

  SELECT pg_catalog.count(*)::int INTO outbox_pending
  FROM (SELECT 1 FROM ludy_kernel.outbox_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - p.enqueued_at)::double precision INTO outbox_oldest_age_seconds
  FROM ludy_kernel.outbox_pending p
  ORDER BY p.seq LIMIT 1;

  SELECT pg_catalog.count(*)::int INTO inbound_pending
  FROM (SELECT 1 FROM ludy_kernel.inbound_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - i.received_at)::double precision INTO inbound_oldest_age_seconds
  FROM ludy_kernel.inbound_pending i ORDER BY i.seq LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM ludy_kernel.worker_heartbeat h WHERE h.beat_at > checked_at - interval '1 hour' AND h.modules IS NULL) THEN
    SELECT pg_catalog.array_agg(DISTINCT m) INTO v_worked
    FROM ludy_kernel.worker_heartbeat h, pg_catalog.unnest(h.modules) m
    WHERE h.beat_at > checked_at - interval '7 days';
  END IF;

  jobs_schema_present := pg_catalog.to_regclass('ludy_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM ludy_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'ads', 'crm', 'notes', 'meetings', 'sign', 'hr'])
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked)
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_expected))
      ORDER BY j.start_after LIMIT 10000
    ) q;
    SELECT pg_catalog.count(*)::int INTO dead_letter_count
    FROM (
      SELECT 1 FROM ludy_jobs.job j
      WHERE j.state = 'failed' AND COALESCE(j.completed_on, j.created_on) > checked_at - v_window
      LIMIT 10000
    ) d;
  END IF;

  SELECT EXTRACT(EPOCH FROM checked_at - pg_catalog.max(h.beat_at))::double precision INTO worker_heartbeat_age_seconds
  FROM ludy_kernel.worker_heartbeat h;

  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.health(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ludy_kernel.health(integer) TO ludy_prober;

-- migration-lint: cross-module #3409: restate ludy_ads.launch_requeue to skip orgs whose Ads app is off
CREATE OR REPLACE FUNCTION ludy_ads.launch_requeue(p_providers text[], p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row record;
  v_event uuid;
  v_n integer := 0;
BEGIN
  FOR v_row IN
    SELECT l.org_id, l.id AS launch_id, l.ad_account_id
    FROM ludy_ads.ad_launch l
    JOIN ludy_kernel.tenant t ON t.org_id = l.org_id AND t.status = 'active'
    JOIN ludy_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
    JOIN ludy_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.write_connection_id
    WHERE c.provider = ANY (COALESCE(p_providers, ARRAY[]::text[]))
      AND ludy_kernel.org_app_on(t.org_id, 'ads')
      AND (l.state = 'queued' OR (l.state = 'launching' AND l.step IS DISTINCT FROM 'paused'))
      AND l.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5)
    ORDER BY l.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.launch.queued', pg_catalog.jsonb_build_object('launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  END IF;
  RETURN v_n;
END $$;
-- migration-lint: cross-module #3409: keep worker-only execute grants on ludy_ads.launch_requeue
REVOKE ALL ON FUNCTION ludy_ads.launch_requeue(text[], integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
-- migration-lint: cross-module #3409: grant execute on ludy_ads.launch_requeue to ludy_worker
GRANT EXECUTE ON FUNCTION ludy_ads.launch_requeue(text[], integer) TO ludy_worker;

-- migration-lint: cross-module #3409: restate ludy_ads.activate_requeue to skip orgs whose Ads app is off
CREATE OR REPLACE FUNCTION ludy_ads.activate_requeue(p_providers text[], p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row record;
  v_event uuid;
  v_n integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  FOR v_row IN
    SELECT l.org_id, l.id AS launch_id, l.ad_account_id
    FROM ludy_ads.ad_launch l
    JOIN ludy_kernel.tenant t ON t.org_id = l.org_id AND t.status = 'active'
    JOIN ludy_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
    JOIN ludy_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.write_connection_id
    WHERE c.provider = ANY (COALESCE(p_providers, ARRAY[]::text[]))
      AND ludy_kernel.org_app_on(t.org_id, 'ads')
      AND l.state = 'launching' AND l.step IN ('paused', 'activate')
      AND ludy_ads.launch_today(a.time_zone) BETWEEN l.start_on AND l.end_on
      AND l.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5)
    ORDER BY l.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.activate.queued', pg_catalog.jsonb_build_object('launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  END IF;
  RETURN v_n;
END $$;
-- migration-lint: cross-module #3409: keep worker-only execute grants on ludy_ads.activate_requeue
REVOKE ALL ON FUNCTION ludy_ads.activate_requeue(text[], integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
-- migration-lint: cross-module #3409: grant execute on ludy_ads.activate_requeue to ludy_worker
GRANT EXECUTE ON FUNCTION ludy_ads.activate_requeue(text[], integer) TO ludy_worker;
