-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel health(): add the optional projects module (#5158 GitHub Slice 1) to the optional module list so
-- deployments without projects do not page on projects-github-* job age (Gate T6, jobs-schema.test.ts).
-- Preserves 20270327180000 outbox_oldest_age_seconds (p.enqueued_at), ludy.prober_modules (no crove.* fallback),
-- and ludy_prober execute grant.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

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
    COALESCE(pg_catalog.current_setting('ludy.prober_modules', true), ''),
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
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'ads', 'crm', 'notes', 'meetings', 'sign', 'hr', 'projects'])
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
