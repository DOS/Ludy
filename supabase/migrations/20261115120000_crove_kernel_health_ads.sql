-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2217): the prober's job age counts the queue ads-sync of the ads module only while a worker records
-- the module or the deployment runs it, like the other optional modules' queues. Idempotent; applied files stay untouched.
--
-- crove_kernel.health(int)   as in 20261106030000, with ads in the list of optional modules whose queues alone can drop
--                            out of the job age (the queue name's first word, ads-sync, is the module id).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.health(p_dead_letter_window_seconds int DEFAULT 3600)
RETURNS TABLE (
  checked_at timestamptz,
  outbox_pending int,
  outbox_oldest_age_seconds double precision,
  inbound_pending int,
  inbound_oldest_age_seconds double precision,
  jobs_schema_present boolean,
  jobs_queued int,
  job_oldest_queued_age_seconds double precision,
  dead_letter_count int,
  worker_heartbeat_age_seconds double precision
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_window interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_dead_letter_window_seconds, 3600), 60), 604800));
  -- The modules the workers of the last 7 days recorded, a worker that stopped cleanly recording none; NULL (every
  -- queue counts) when none recorded any, or while a worker that beat in the last hour recorded none (an older release).
  v_worked text[];
  -- The modules the deployment runs, as the prober's session names them (#1894); empty when it names none.
  v_expected text[] := pg_catalog.string_to_array(COALESCE(pg_catalog.current_setting('crove.prober_modules', true), ''), ',');
BEGIN
  checked_at := pg_catalog.now();

  SELECT pg_catalog.count(*)::int INTO outbox_pending
  FROM (SELECT 1 FROM crove_kernel.outbox_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - e.created_at)::double precision INTO outbox_oldest_age_seconds
  FROM crove_kernel.outbox_pending p
  JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
  ORDER BY p.seq LIMIT 1;

  SELECT pg_catalog.count(*)::int INTO inbound_pending
  FROM (SELECT 1 FROM crove_kernel.inbound_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - i.received_at)::double precision INTO inbound_oldest_age_seconds
  FROM crove_kernel.inbound_pending i ORDER BY i.seq LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM crove_kernel.worker_heartbeat h WHERE h.beat_at > checked_at - interval '1 hour' AND h.modules IS NULL) THEN
    SELECT pg_catalog.array_agg(DISTINCT m) INTO v_worked
    FROM crove_kernel.worker_heartbeat h, pg_catalog.unnest(h.modules) m
    WHERE h.beat_at > checked_at - interval '7 days';
  END IF;

  jobs_schema_present := pg_catalog.to_regclass('crove_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    -- Queued: waiting to run and already due (a retry waiting out its backoff is not late yet), in a queue a worker of
    -- the last 7 days works or of a module the deployment runs (#1877, #1887, #1894).
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM crove_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        -- Only the queues of the optional modules can drop out; any other name counts, the kernel's and pg-boss's
        -- own (__pgboss__send-it, its cron) among them.
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'ads', 'crm', 'notes'])
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked)
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_expected))
      ORDER BY j.start_after LIMIT 10000
    ) q;
    SELECT pg_catalog.count(*)::int INTO dead_letter_count
    FROM (
      SELECT 1 FROM crove_jobs.job j
      WHERE j.state = 'failed' AND COALESCE(j.completed_on, j.created_on) > checked_at - v_window
      LIMIT 10000
    ) d;
  END IF;

  SELECT EXTRACT(EPOCH FROM checked_at - pg_catalog.max(h.beat_at))::double precision INTO worker_heartbeat_age_seconds
  FROM crove_kernel.worker_heartbeat h;

  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.health(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.health(int) TO crove_prober;
