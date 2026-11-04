-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-4a (issue #2296, ADR-0043 points 4 and 7a, plan docs/plan/ads-write.md sections 3.6 and 10): the stop and the pause. A started launch that is stopped (a
-- person's stop, the switch-off, the kill switch, an account switched off or disconnected) is wound down: what it made at the platform is paused. NOTHING IN THIS
-- SLICE UN-PAUSES AN OBJECT. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_launch gains   the wind-down of a stopped launch, kept on its row and written by the system alone (a worker-only definer, never a column grant, so the
--                             columns a tenant role may update stay the state columns): `wound_down_at` (every object it made is paused at the platform, or there was
--                             nothing to pause), `wind_down_tries` (the pause runs begun, a lease counted), `wind_down_next_at` (the lease of the run in flight, or when the
--                             next run is due) and `wind_down_code` (why Ludy gave up: the person is told to pause by hand at the platform). A stopped launch with none of
--                             `wound_down_at` and `wind_down_code` is an open obligation, and the sweep below queues it again.
--
-- crove_ads.launch_today      today in an account's time zone as a date, tomorrow in UTC (the latest day any zone can be on) when no zone is recorded or the database does not
--                             know the name. One definition for the guard's acceptance line of W2-3 (a person's stop keeps the commitment to at least the earlier of
--                             what it was and today) and for the commands that stop, so the two cannot disagree.
--
-- crove_ads.launch_guard      the W2-3 guard with three additions: the new columns are the system's and only for a stopped launch, are never set at insert, and an update
--                             that changes only them is not a "nothing changed" (which would have discarded it); the acceptance line calls launch_today. Everything else is as it was.
--
-- crove_ads.wind_down_take / wind_down_settle / wind_down_requeue
--                             the pause job's claim of a stopped launch (a lease, a try counted), its settlement (done, due again, or given up with a code) and the safety net
--                             that writes the event ads.pause.queued again for a stopped launch whose job was lost; worker only, ids and codes only.
--
-- Queue ads-pause             the pause job's queue: ids only, retried by the policy.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS wound_down_at timestamptz;
ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS wind_down_tries integer NOT NULL DEFAULT 0;
ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS wind_down_next_at timestamptz;
ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS wind_down_code text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_ads.ad_launch'::regclass AND conname = 'ad_launch_wind_down_ck') THEN
    ALTER TABLE crove_ads.ad_launch ADD CONSTRAINT ad_launch_wind_down_ck CHECK (
      wind_down_tries >= 0
      AND (wind_down_code IS NULL OR wind_down_code ~ '^[a-z_]{1,40}$')
      AND (wound_down_at IS NULL OR wind_down_code IS NULL)
    );
  END IF;
END $$;

-- Today in a time zone as a date: the zone's own date, or tomorrow in UTC (the latest day any zone can be on) when there is none or the database does not know it.
CREATE OR REPLACE FUNCTION crove_ads.launch_today(p_zone text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date + 1;
BEGIN
  IF p_zone IS NOT NULL THEN
    BEGIN
      v_today := (pg_catalog.now() AT TIME ZONE p_zone)::date;
    EXCEPTION WHEN OTHERS THEN
      v_today := (pg_catalog.now() AT TIME ZONE 'UTC')::date + 1;
    END;
  END IF;
  RETURN v_today;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_today(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_ads.launch_today(text) TO crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The W2-3 guard with the additions of this slice (marked W2-4a): everything else is as it was.
CREATE OR REPLACE FUNCTION crove_ads.launch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_role text;
  v_match jsonb;
  v_proposal uuid;
  v_payload jsonb;
  v_setting record;
  v_account record;
  v_draft record;
  v_move text;
  v_zone text;
  v_today date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row of another org, or made outside any context (a raw statement of the table's owner, a definer), is left to row security, which refuses a
    -- login role's insert of another org's row; a row of the org in context is the writer's and is held here.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'queued' OR NEW.attempt <> 1 OR NEW.step IS NOT NULL OR NEW.stop_reason IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
       -- W2-4a: a launch is born with nothing wound down.
       OR NEW.wound_down_at IS NOT NULL OR NEW.wind_down_tries <> 0 OR NEW.wind_down_next_at IS NOT NULL OR NEW.wind_down_code IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Only the execution of the approved proposal of this very plan: its draft, its hash, its account, its currency and its largest amount.
    v_match := pg_catalog.jsonb_build_object('draftId', NEW.draft_id::text, 'planHash', NEW.plan_hash, 'adAccountId', NEW.ad_account_id::text, 'currency', NEW.currency);
    IF NOT crove_ads.approved_execution('ads.campaign.launch', v_match, NEW.amount) THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT p.id, p.payload INTO v_proposal, v_payload FROM crove_kernel.proposal p
    WHERE p.org_id = NEW.org_id AND p.command = 'ads.campaign.launch' AND p.status = 'approved' AND p.payload @> v_match
    ORDER BY p.id DESC LIMIT 1;
    -- The plan inside the proposal is the plan the ledger holds: the budget and the days the approver was shown.
    IF v_proposal IS NULL
       OR (v_payload #>> '{plan,dailyBudget}')::numeric IS DISTINCT FROM NEW.daily_budget
       OR (v_payload #>> '{plan,startOn}')::date IS DISTINCT FROM NEW.start_on
       OR (v_payload #>> '{plan,endOn}')::date IS DISTINCT FROM NEW.end_on THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- The draft is the approved one of this account, approved by this proposal, for this amount.
    SELECT d.status, d.ad_account_id, d.proposal_id, d.max_spend INTO v_draft FROM crove_ads.ad_campaign_draft d WHERE d.org_id = NEW.org_id AND d.id = NEW.draft_id;
    IF NOT FOUND OR v_draft.status <> 'approved' OR v_draft.ad_account_id <> NEW.ad_account_id OR v_draft.proposal_id IS DISTINCT FROM v_proposal OR v_draft.max_spend IS DISTINCT FROM NEW.amount THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Running ads is on for the org and for the account and launches are not blocked, as the owner's switches stand now.
    SELECT s.write_enabled, s.launches_blocked INTO v_setting FROM crove_ads.ad_org_setting s WHERE s.org_id = NEW.org_id ORDER BY s.id LIMIT 1;
    SELECT a.write_enabled, a.currency INTO v_account FROM crove_ads.ad_account a WHERE a.org_id = NEW.org_id AND a.id = NEW.ad_account_id;
    IF v_setting.write_enabled IS NOT TRUE OR v_setting.launches_blocked IS NOT FALSE OR v_account.write_enabled IS NOT TRUE OR v_account.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.proposal_id := v_proposal;
    NEW.commit_until := NEW.end_on;
    NEW.created_by := COALESCE(v_user, NEW.created_by);
    NEW.updated_by := NULL;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  -- The one change that is not a writer's: the cascade of the account's legal entity (when the account moves to another entity), which alters nothing
  -- else; tenant roles have no UPDATE grant on the column. (The generated tag is left out of the comparison: a BEFORE trigger sees it before it is computed.)
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id' - 'tag') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id' - 'tag') THEN
    RETURN NEW;
  END IF;
  -- The plan and who wrote it never change, whoever writes.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.ad_account_id IS DISTINCT FROM OLD.ad_account_id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.daily_budget IS DISTINCT FROM OLD.daily_budget
     OR NEW.start_on IS DISTINCT FROM OLD.start_on OR NEW.end_on IS DISTINCT FROM OLD.end_on OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A final state never changes.
  IF OLD.state IN ('stopped', 'failed', 'cancelled') AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.step IS DISTINCT FROM OLD.step
     OR NEW.commit_until IS DISTINCT FROM OLD.commit_until OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FROZEN' USING ERRCODE = '42501';
  END IF;
  -- W2-4a: the wind-down of a stopped launch is the system's alone (the pause job, through the worker-only definers), and an update that touches it touches nothing else.
  IF NEW.wound_down_at IS DISTINCT FROM OLD.wound_down_at OR NEW.wind_down_tries IS DISTINCT FROM OLD.wind_down_tries
     OR NEW.wind_down_next_at IS DISTINCT FROM OLD.wind_down_next_at OR NEW.wind_down_code IS DISTINCT FROM OLD.wind_down_code THEN
    IF v_actor IS DISTINCT FROM 'system' OR OLD.state <> 'stopped' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.attempt IS DISTINCT FROM OLD.attempt
       OR NEW.step IS DISTINCT FROM OLD.step OR NEW.commit_until IS DISTINCT FROM OLD.commit_until OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason
       OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- A wound-down launch is never wound down again, and one that was given up on is not reopened by a run.
    IF OLD.wound_down_at IS NOT NULL OR OLD.wind_down_code IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FROZEN' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;
  -- An update that changes nothing the guard cares about (the stamps aside) passes, for any context.
  IF NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.attempt IS NOT DISTINCT FROM OLD.attempt AND NEW.step IS NOT DISTINCT FROM OLD.step
     AND NEW.commit_until IS NOT DISTINCT FROM OLD.commit_until AND NEW.stop_reason IS NOT DISTINCT FROM OLD.stop_reason
     AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN
    RETURN OLD;
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.user_id = v_user;
  END IF;
  -- The stamps are the database's: who and when, whatever the writer sent; the times of a start and a finish are set by the move, not by the writer.
  IF NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_move := OLD.state || '>' || NEW.state;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF v_move NOT IN ('queued>launching', 'queued>cancelled', 'launching>live', 'launching>failed', 'launching>needs_attention', 'launching>stopped',
                      'needs_attention>launching', 'needs_attention>failed', 'needs_attention>stopped', 'live>stopped') THEN
      RAISE EXCEPTION 'ADS_LAUNCH_STATE' USING ERRCODE = '42501';
    END IF;
    -- The writer's moves are the system's; stopping or cancelling is the system's, an owner's or an admin's.
    IF v_move IN ('queued>launching', 'launching>live', 'launching>failed', 'launching>needs_attention', 'needs_attention>launching', 'needs_attention>failed')
       AND v_actor IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- (Written with IS DISTINCT FROM so a context with no role, an agent's or none at all, is refused: a plain NOT (... OR ...) would be NULL, not true.)
    IF v_move IN ('queued>cancelled', 'launching>stopped', 'needs_attention>stopped', 'live>stopped')
       AND v_actor IS DISTINCT FROM 'system' AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- A launch the writer has activated cannot be stopped with its whole commitment cleared: what ran counts (the commitment is shortened to the last day it
    -- ran, never cleared), whoever stops it.
    IF v_move = 'live>stopped' AND NEW.commit_until IS NULL THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- W2-3, the acceptance line: a person's stop must not release spend that ran or is in flight. A launch that was started (launching, needs attention or
    -- live) may have created objects and be midway through the writer's calls, so only the system, which knows what the writer did, clears its commitment or
    -- ends it earlier than today in the account's own time zone; anyone else keeps it held to at least the earlier of what it was and today. (A queued launch has
    -- started nothing, so cancelling it releases its commitment entirely.)
    IF v_move IN ('launching>stopped', 'needs_attention>stopped', 'live>stopped') AND v_actor IS DISTINCT FROM 'system' THEN
      SELECT a.time_zone INTO v_zone FROM crove_ads.ad_account a WHERE a.org_id = OLD.org_id AND a.id = OLD.ad_account_id;
      -- No zone recorded, or one this database does not know: the LATEST day any zone can be on right now (tomorrow in UTC), so a person can release the least. (The
      -- earliest would let a person release a day that ran in a zone ahead of UTC.) W2-4a: one definition, crove_ads.launch_today, shared with the commands that stop.
      v_today := crove_ads.launch_today(v_zone);
      IF NEW.commit_until IS NULL OR NEW.commit_until < LEAST(OLD.commit_until, v_today) THEN
        RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF v_actor IS DISTINCT FROM 'system' THEN
    -- Without a move, the step and the commitment are the writer's: the system's.
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The step is where the writer is: only the writer's (the system's) to set, even on a stop a person makes.
  IF v_actor IS DISTINCT FROM 'system' AND NEW.step IS DISTINCT FROM OLD.step THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The attempt counts the writer's runs: one more each time a launch that needed attention runs again, and nothing else moves it.
  IF NEW.attempt IS DISTINCT FROM (OLD.attempt + CASE WHEN v_move = 'needs_attention>launching' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A commitment only shortens, or is released: never back after it was released, never later than it was, and a cancelled launch commits nothing.
  IF NEW.state = 'cancelled' THEN
    NEW.commit_until := NULL;
  ELSIF NEW.commit_until IS DISTINCT FROM OLD.commit_until AND (OLD.commit_until IS NULL OR (NEW.commit_until IS NOT NULL AND NEW.commit_until > OLD.commit_until)) THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The time of the start and of the end, and who and when.
  IF v_move = 'queued>launching' THEN
    NEW.started_at := pg_catalog.clock_timestamp();
  END IF;
  IF NEW.state IN ('stopped', 'failed', 'cancelled') THEN
    NEW.finished_at := pg_catalog.clock_timestamp();
    NEW.stop_reason := COALESCE(NEW.stop_reason, CASE NEW.state WHEN 'cancelled' THEN 'cancelled' WHEN 'stopped' THEN 'stopped' ELSE 'failed' END);
  END IF;
  NEW.updated_by := v_user;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The pause job's claim of a stopped launch (worker login only, in the org's system context): a launch that is stopped, not wound down, not given up on and not leased
-- is leased for p_lease_seconds and the try is counted; answers the new count, or null when there is nothing to do now (another run holds it, or it is over). The
-- claim is what keeps two runs from pausing one launch at the same moment.
CREATE OR REPLACE FUNCTION crove_ads.wind_down_take(p_org uuid, p_launch uuid, p_lease_seconds integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tries integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_launch l
  SET wind_down_tries = l.wind_down_tries + 1,
      wind_down_next_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 600), 60), 3600))
  WHERE l.org_id = p_org AND l.id = p_launch AND l.state = 'stopped' AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL
    AND (l.wind_down_next_at IS NULL OR l.wind_down_next_at <= pg_catalog.clock_timestamp())
  RETURNING l.wind_down_tries INTO v_tries;
  RETURN v_tries;
END $$;

-- The settlement of a run (worker login only): the launch is wound down (p_done), or due again at p_next, or given up on with a code (the person is told to pause by
-- hand at the platform). Touches a stopped launch that is still open and nothing else; true when it did.
CREATE OR REPLACE FUNCTION crove_ads.wind_down_settle(p_org uuid, p_launch uuid, p_done boolean, p_next timestamptz, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_done AND p_code IS NOT NULL THEN
    RAISE EXCEPTION 'ADS_WIND_DOWN_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_ads.ad_launch l
  SET wound_down_at = CASE WHEN p_done THEN pg_catalog.clock_timestamp() END,
      wind_down_next_at = CASE WHEN p_done OR p_code IS NOT NULL THEN NULL ELSE p_next END,
      wind_down_code = p_code
  WHERE l.org_id = p_org AND l.id = p_launch AND l.state = 'stopped' AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL;
  RETURN FOUND;
END $$;

-- The safety net of the pause job. A stop writes the event ads.pause.queued in its own transaction and the relay turns it into a job; a lost job (a restart, a queue
-- that expired, a run that died) leaves a stopped launch open. Those that are due (never run, or past their lease or their wait) get the same event again; the job's
-- begin step decides what is to be done, so a repeat is harmless. Only orgs that are active. Worker only, ids only. Returns how many were queued.
CREATE OR REPLACE FUNCTION crove_ads.wind_down_requeue(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row record;
  v_event uuid;
  v_n integer := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  FOR v_row IN
    SELECT l.org_id, l.id AS launch_id, l.ad_account_id
    FROM crove_ads.ad_launch l
    JOIN crove_kernel.tenant t ON t.org_id = l.org_id AND t.status = 'active'
    WHERE l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL
      AND (l.wind_down_next_at IS NULL OR l.wind_down_next_at <= pg_catalog.clock_timestamp())
      AND l.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => 60)
    ORDER BY l.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.pause.queued', pg_catalog.jsonb_build_object('launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION crove_ads.wind_down_take(uuid, uuid, integer), crove_ads.wind_down_settle(uuid, uuid, boolean, timestamptz, text), crove_ads.wind_down_requeue(integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.wind_down_take(uuid, uuid, integer), crove_ads.wind_down_settle(uuid, uuid, boolean, timestamptz, text), crove_ads.wind_down_requeue(integer) TO crove_worker;

-- The job's queue: ids only (the org and the launch), retried by the policy.
SELECT crove_jobs.create_queue('ads-pause', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
