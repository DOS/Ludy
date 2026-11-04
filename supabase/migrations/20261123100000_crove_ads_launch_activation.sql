-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-4b (issue #2296, ADR-0043 points 4 and 5, plan docs/plan/ads-write.md sections 3.6 and 10): retry and activation. The activation is the last steps of the
-- approved launch (it continues the launch's own ads.campaign.launch approval: no second approval, the ruling of 2026-11-04); a resume of something stopped or paused is
-- W4's own R3. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_launch gains   the request to run a launch that needs attention again, kept on its row: `retry_requested_at` and `retry_requested_by`. They are the
--                             system's and the definer's below, never a column grant, so the columns a tenant role may update stay the state columns.
-- crove_ads.ad_object         `configured_status` accepts 'active' (set by the guard of the launch in the move to live, nothing else sets it).
--
-- crove_ads.launch_activation_problem
--                             why a launch may not be live yet, or null: the stamped proposal is the approved launch of this draft and plan hash, every object of the plan is
--                             recorded, every ad, the ad set and the campaign has its activation settled (an external_call row ads.launch:<launch>:<attempt>:activate_<slot>
--                             that succeeded), the org's switch and the account's are on and launches are not blocked, and today in the account's zone is inside the flight.
-- crove_ads.launch_guard      the W2-4a guard with additions marked W2-4b: the move launching to live raises ADS_LAUNCH_ACTIVATION (the reason in DETAIL) unless the function above
--                             says null, and sets the delivering objects active; the retry columns are held as above. Everything else is as it was.
-- crove_ads.launch_commitments
--                             L2 of the W2-4a review: a stopped launch that is not wound down keeps committing to the last day of its flight.
-- crove_ads.launch_request_retry
--                             the person's request (owner or admin, a launch that needs attention), a definer that stamps the two columns; ads.launch.begin takes it.
-- crove_ads.launch_take_retry the system's move of a launch with a request waiting to launching (attempt one more, request cleared); worker only.
-- crove_ads.activate_requeue  the safety net of the activation job: a launch whose objects are created and paused, whose flight has begun and whose event or job was lost,
--                             gets the event ads.activate.queued again; worker only, ids only.
--
-- Queue ads-activate          the activation job's queue: ids only, retried by the policy.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;
ALTER TABLE crove_ads.ad_launch ADD COLUMN IF NOT EXISTS retry_requested_by uuid;

DO $$
DECLARE
  v_name text;
BEGIN
  SELECT c.conname INTO v_name FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'crove_ads.ad_object'::regclass AND c.contype = 'c' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%configured_status%' AND c.conname <> 'ad_object_configured_status_ck';
  IF v_name IS NOT NULL THEN
    EXECUTE pg_catalog.format('ALTER TABLE crove_ads.ad_object DROP CONSTRAINT %I', v_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_ads.ad_object'::regclass AND conname = 'ad_object_configured_status_ck') THEN
    ALTER TABLE crove_ads.ad_object ADD CONSTRAINT ad_object_configured_status_ck CHECK (configured_status IN ('paused', 'active', 'archived'));
  END IF;
END $$;

-- Why a launch may not be live yet, or null. Read by the guard (which is the one place that matters) and by the tests; the commands check the same things before each call.
CREATE OR REPLACE FUNCTION crove_ads.launch_activation_problem(p_org uuid, p_launch uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_l record;
  v_d record;
  v_setting record;
  v_a record;
  v_slots text[];
  v_slot text;
  v_n integer;
BEGIN
  SELECT l.draft_id, l.proposal_id, l.plan_hash, l.ad_account_id, l.currency, l.start_on, l.end_on INTO v_l FROM crove_ads.ad_launch l WHERE l.org_id = p_org AND l.id = p_launch;
  IF NOT FOUND THEN
    RETURN 'launch';
  END IF;
  -- The proposal the row is stamped with is the approved (or executed) launch of this draft, hash, account and currency.
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.proposal p
    WHERE p.org_id = p_org AND p.id = v_l.proposal_id AND p.command = 'ads.campaign.launch' AND p.status IN ('approved', 'executed')
      AND p.payload @> pg_catalog.jsonb_build_object('draftId', v_l.draft_id::text, 'planHash', v_l.plan_hash, 'adAccountId', v_l.ad_account_id::text, 'currency', v_l.currency)
  ) THEN
    RETURN 'proposal';
  END IF;
  SELECT d.status, d.proposal_id, pg_catalog.jsonb_array_length(d.variants) AS variants INTO v_d FROM crove_ads.ad_campaign_draft d WHERE d.org_id = p_org AND d.id = v_l.draft_id;
  IF NOT FOUND OR v_d.status <> 'approved' OR v_d.proposal_id IS DISTINCT FROM v_l.proposal_id THEN
    RETURN 'proposal';
  END IF;
  -- Every object of the plan: a campaign, an ad set, and a creative and an ad for each text variant.
  v_slots := ARRAY['campaign', 'ad_set'];
  FOR v_n IN 1..v_d.variants LOOP
    v_slots := v_slots || ARRAY['creative_' || v_n::text, 'ad_' || v_n::text];
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM crove_ads.ad_object o WHERE o.org_id = p_org AND o.launch_id = p_launch AND o.slot = ANY (v_slots)) <> pg_catalog.array_length(v_slots, 1) THEN
    RETURN 'objects';
  END IF;
  -- The objects that deliver (a creative has no status of its own) have each had their activation settled.
  FOREACH v_slot IN ARRAY v_slots LOOP
    IF pg_catalog.left(v_slot, 9) = 'creative_' THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM crove_kernel.external_call c
      WHERE c.org_id = p_org AND c.state = 'succeeded' AND c.key ~ ('^ads\.launch:' || p_launch::text || ':[0-9]{1,2}:activate_' || v_slot || '$')
    ) THEN
      RETURN 'activation';
    END IF;
  END LOOP;
  -- The owner's switches as they stand now, and a flight that has begun and not ended in the account's own zone.
  SELECT s.write_enabled, s.launches_blocked INTO v_setting FROM crove_ads.ad_org_setting s WHERE s.org_id = p_org ORDER BY s.id LIMIT 1;
  SELECT a.write_enabled, a.time_zone INTO v_a FROM crove_ads.ad_account a WHERE a.org_id = p_org AND a.id = v_l.ad_account_id;
  IF v_setting.write_enabled IS NOT TRUE OR v_setting.launches_blocked IS NOT FALSE OR v_a.write_enabled IS NOT TRUE THEN
    RETURN 'switches';
  END IF;
  IF crove_ads.launch_today(v_a.time_zone) NOT BETWEEN v_l.start_on AND v_l.end_on THEN
    RETURN 'flight';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_activation_problem(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The W2-4a guard with the additions of this slice (marked W2-4b): everything else is as it was.
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
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row of another org, or made outside any context (a raw statement of the table's owner, a definer), is left to row security, which refuses a
    -- login role's insert of another org's row; a row of the org in context is the writer's and is held here.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'queued' OR NEW.attempt <> 1 OR NEW.step IS NOT NULL OR NEW.stop_reason IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
       -- W2-4a: a launch is born with nothing wound down.
       OR NEW.wound_down_at IS NOT NULL OR NEW.wind_down_tries <> 0 OR NEW.wind_down_next_at IS NOT NULL OR NEW.wind_down_code IS NOT NULL
       -- W2-4b: nor with a request to run again.
       OR NEW.retry_requested_at IS NOT NULL OR NEW.retry_requested_by IS NOT NULL THEN
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
  -- W2-4b: the request to run a launch that needs attention again. It is made by an owner or an admin through crove_ads.launch_request_retry and touches nothing else; the
  -- system takes it with the move to launching (the attempt one more, by the rule below) and clears it in the same statement, and nothing else sets or clears it.
  IF NEW.retry_requested_at IS DISTINCT FROM OLD.retry_requested_at OR NEW.retry_requested_by IS DISTINCT FROM OLD.retry_requested_by THEN
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
      IF v_actor IS DISTINCT FROM 'user' OR OLD.state <> 'needs_attention' OR OLD.retry_requested_at IS NOT NULL OR NEW.retry_requested_at IS NULL OR NEW.retry_requested_by IS DISTINCT FROM v_user
         OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.step IS DISTINCT FROM OLD.step OR NEW.commit_until IS DISTINCT FROM OLD.commit_until
         OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
        RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.user_id = v_user;
      IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      NEW.updated_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END IF;
    IF v_actor IS DISTINCT FROM 'system' OR OLD.state <> 'needs_attention' OR NEW.state <> 'launching' OR NEW.retry_requested_at IS NOT NULL OR NEW.retry_requested_by IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
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
    -- W2-4b: the move that starts spend. Only the system makes it, and only when the launch's own approval, its objects, the switches and the flight all hold now: the
    -- activation job meets them, and nothing else can (the graph above is judged first, so a queued launch is still a bad move). The objects of the launch that deliver are
    -- set to active in the same statement, so what Ludy recorded for them is what it set.
    IF v_move = 'launching>live' THEN
      v_problem := crove_ads.launch_activation_problem(OLD.org_id, OLD.id);
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'ADS_LAUNCH_ACTIVATION' USING ERRCODE = '42501', DETAIL = v_problem;
      END IF;
      UPDATE crove_ads.ad_object o SET configured_status = 'active'
      WHERE o.org_id = OLD.org_id AND o.launch_id = OLD.id AND o.level IN ('campaign', 'ad_set', 'ad');
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

-- The request of a person to run a launch that needs attention again (owner or admin; the app login, in the person's context): stamps the two columns of a launch that
-- needs attention and has no request waiting, and nothing else. The move itself is the system's (ads.launch.begin takes the request). True when it stamped.
CREATE OR REPLACE FUNCTION crove_ads.launch_request_retry(p_org uuid, p_launch uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_role text;
BEGIN
  -- The org is the one the command runs in: a definer that trusted its parameter would let a context of one org ask for the launch of another.
  IF v_user IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND m.user_id = v_user;
  IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_launch l SET retry_requested_at = pg_catalog.clock_timestamp(), retry_requested_by = v_user
  WHERE l.org_id = p_org AND l.id = p_launch AND l.state = 'needs_attention' AND l.retry_requested_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_request_retry(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_request_retry(uuid, uuid) TO crove_app;

-- The retry taken (worker login only, in the org's system context): the move of a launch that needs attention and has a request waiting to launching, the attempt one more and
-- the request cleared in the same statement, which the guard holds to the system. Answers the new attempt, or null when there was nothing to take.
CREATE OR REPLACE FUNCTION crove_ads.launch_take_retry(p_org uuid, p_launch uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_attempt integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- The org is the one the command runs in: a definer that trusted its parameter would let a context of one org take the retry of another.
  IF p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_launch l
  SET state = 'launching', attempt = l.attempt + 1, retry_requested_at = NULL, retry_requested_by = NULL
  WHERE l.org_id = p_org AND l.id = p_launch AND l.state = 'needs_attention' AND l.retry_requested_at IS NOT NULL
  RETURNING l.attempt INTO v_attempt;
  RETURN v_attempt;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_take_retry(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_take_retry(uuid, uuid) TO crove_worker;

-- The safety net of the activation job. A launch whose objects were created (the step paused) gets the event ads.activate.queued from its begin; a lost job, or a flight that
-- begins later, leaves it waiting. Those whose flight has begun (today in the account's zone) and that have waited five minutes get the same event again, for a provider this
-- worker has an activator for (p_providers); the job's begin decides what is due, so a repeat is harmless. Only orgs that are active. Worker only, ids only.
CREATE OR REPLACE FUNCTION crove_ads.activate_requeue(p_providers text[], p_limit integer) RETURNS integer
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
    JOIN crove_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
    JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.write_connection_id
    WHERE c.provider = ANY (COALESCE(p_providers, ARRAY[]::text[]))
      AND l.state = 'launching' AND l.step IN ('paused', 'activate')
      AND crove_ads.launch_today(a.time_zone) BETWEEN l.start_on AND l.end_on
      AND l.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5)
    ORDER BY l.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.activate.queued', pg_catalog.jsonb_build_object('launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_ads.activate_requeue(text[], integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.activate_requeue(text[], integer) TO crove_worker;

-- The commitments the launches hold (W2-4b, L2 of the W2-4a review): a stop shortens a launch's commitment to today, but its objects stay on at the platform until they are
-- paused, which can take days or end as given up, and an object that is on spends past that day with no cap room held. A launch that was stopped and is not wound down (its
-- objects are not confirmed paused: the pause is pending, or Ludy gave up and the person was told to pause by hand) keeps committing to the last day of its flight, until
-- the day its wind-down is done; a launch that is wound down commits what its row says. The rule is here, in the one function the caps read, so the stop commands, the pause job
-- and the guard are as they were. Everything else of the function is as it was.
CREATE OR REPLACE FUNCTION crove_ads.launch_commitments(p_currency text, p_from date, p_to date)
RETURNS TABLE (ad_account_id uuid, currency text, daily_budget text, start_on date, commit_until date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id();
  END IF;
  IF v_actor IS DISTINCT FROM 'system' AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.ad_account_id, l.currency, l.daily_budget::text, l.start_on, c.until
  FROM crove_ads.ad_launch l
  CROSS JOIN LATERAL (
    SELECT CASE WHEN l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL THEN GREATEST(l.commit_until, l.end_on) ELSE l.commit_until END AS until
  ) c
  WHERE l.org_id = v_org AND l.currency = p_currency AND l.commit_until IS NOT NULL AND c.until >= p_from AND l.start_on <= p_to
  ORDER BY l.created_at, l.id;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments(text, date, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_commitments(text, date, date) TO crove_app, crove_worker;

-- The job's queue: ids only (the org and the launch), retried by the policy.
SELECT crove_jobs.create_queue('ads-activate', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
