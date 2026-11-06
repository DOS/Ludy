-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-3 (issue #2296, ADR-0043 points 2 to 5, plan docs/plan/ads-write.md sections 3.4, 3.6, 7 and 9): the writer's tables and guards. A queued launch is
-- run by the launch job (queue ads-launch), which creates the plan's campaign, ad set, creatives and ads at the platform, every object PAUSED, and records each
-- platform id. NOTHING IN THIS SLICE UN-PAUSES AN OBJECT: a launch ends as objects created and paused (state launching, step 'paused', its commitment kept), and
-- the activation, the pause on switch-off and the screens are W2-4's. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_object           one row per object a launch created at the platform: which object of the launch it is (`slot`: campaign, ad_set, creative_1..3,
--                               ad_1..3), its level, the platform's id and the name sent (which must carry the launch's tag, so reconcile can find it), what Ludy
--                               set it to (paused, or archived) and what the platform last said about it (W2-4's sync). In the account's legal entity under the
--                               same RESTRICTIVE le_scope policy as the ledger. Tenant roles read it and update the status columns (a column grant); a row is
--                               inserted by the system's record step of a launch that was started and nothing else (crove_ads.object_guard, fired for every role
--                               in a context of the org): the launch is launching, or was stopped, failed or sent to a person while the call was in flight (an
--                               object the platform made is tracked all the same), it is of that account, the name carries the launch's tag, and the object
--                               is paused. A row of another org is refused by row security, as the ledger's. Nothing deletes one (the org's purge deletes it
--                               with the account, ON DELETE CASCADE).
--
-- crove_ads.launch_guard        the W2-2 guard, replaced with one addition that is this slice's acceptance line: a person's stop must not release spend that ran
--                               or is in flight. A launch that is launching, needs attention or live may be stopped by anyone but the system only with its
--                               commitment still held to at least the earlier of what it was and today in the account's time zone (tomorrow in UTC, the latest
--                               day any zone can be on, when no zone is recorded or the database does not know it), and never cleared: only the system, which
--                               knows what the writer did, clears a commitment of a launch that was started.
--
-- crove_ads.launch_requeue      the safety net of the launch job: a queued launch, or one that is launching and stopped half way, whose event or job was lost is
--                               queued again with the same event (ads.launch.queued) the approval writes; worker only, ids only, called by the agent sweep.
--
-- Queue ads-launch              the job's queue: ids only, retried by the policy.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_object (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  launch_id uuid NOT NULL,
  -- Which object of the launch this is: the campaign, the ad set, and a creative and an ad for each text variant (at most three).
  slot text NOT NULL CHECK (slot ~ '^[a-z][a-z0-9_]{0,31}$'),
  level text NOT NULL CHECK (level IN ('campaign', 'ad_set', 'creative', 'ad')),
  -- The platform's id of the object, and the name sent (it carries the launch's tag).
  external_id text NOT NULL CHECK (pg_catalog.length(external_id) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 400),
  -- What Ludy set it to. W2-3 creates every object paused; a later slice widens the list.
  configured_status text NOT NULL DEFAULT 'paused' CHECK (configured_status IN ('paused', 'archived')),
  -- What the platform last reported (W2-4's read of object states): its status and, for a rejected ad, the reason as a code or short text.
  effective_status text CHECK (effective_status IS NULL OR effective_status ~ '^[A-Z_]{1,40}$'),
  review_reason text CHECK (review_reason IS NULL OR pg_catalog.length(review_reason) <= 200),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_object_slot_uq UNIQUE (org_id, launch_id, slot),
  CONSTRAINT ad_object_external_uq UNIQUE (org_id, ad_account_id, level, external_id),
  CONSTRAINT ad_object_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ad_object_launch_fk FOREIGN KEY (org_id, launch_id) REFERENCES crove_ads.ad_launch (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ad_object_slot_ck CHECK (
    (level = 'campaign' AND slot = 'campaign') OR (level = 'ad_set' AND slot = 'ad_set') OR (level = 'creative' AND slot ~ '^creative_[1-3]$') OR (level = 'ad' AND slot ~ '^ad_[1-3]$')
  )
);
-- The launch's own objects are covered by the unique slot key; the account's foreign key (with its legal entity) by the first index below.
CREATE INDEX IF NOT EXISTS ad_object_account_idx ON crove_ads.ad_object (org_id, ad_account_id, legal_entity_id);

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_object');
-- Tenant roles read and update the status columns; they never delete an object (the purge does, with the account) and the identity columns are never granted.
REVOKE UPDATE, DELETE ON crove_ads.ad_object FROM crove_tenant;
GRANT UPDATE (configured_status, effective_status, review_reason, last_seen_at, updated_at) ON crove_ads.ad_object TO crove_tenant;

DROP POLICY IF EXISTS le_scope ON crove_ads.ad_object;
CREATE POLICY le_scope ON crove_ads.ad_object AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_object;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_object FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_object ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_ads.object_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_org uuid := crove_kernel.ctx_org_id();
  v_launch record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row of another org, or made outside any context (a raw statement of the table's owner, a definer), is left to row security, which refuses a login role's
    -- insert of another org's row; a row of the org in context is held here: the system's alone.
    IF NEW.org_id IS DISTINCT FROM v_org THEN
      RETURN NEW;
    END IF;
    IF v_actor IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'ADS_OBJECT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Only for a launch that was started, of this account, and an object whose name carries that launch's tag and that is paused: the record step of the job. A
    -- launch that is stopped, failed or waiting for a person since the call began is included on purpose: an object the platform made is tracked all the same.
    SELECT l.state, l.ad_account_id, l.tag INTO v_launch FROM crove_ads.ad_launch l WHERE l.org_id = NEW.org_id AND l.id = NEW.launch_id;
    IF NOT FOUND OR v_launch.state NOT IN ('launching', 'needs_attention', 'stopped', 'failed') OR v_launch.ad_account_id <> NEW.ad_account_id OR pg_catalog.strpos(NEW.name, v_launch.tag) = 0 THEN
      RAISE EXCEPTION 'ADS_OBJECT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.configured_status <> 'paused' OR NEW.effective_status IS NOT NULL OR NEW.review_reason IS NOT NULL OR NEW.last_seen_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_OBJECT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  -- The one change that is not the system's: the cascade of the account's legal entity, which alters nothing else.
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id') THEN
    RETURN NEW;
  END IF;
  -- What identifies the object and what was sent never changes, whoever writes.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.ad_account_id IS DISTINCT FROM OLD.ad_account_id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.launch_id IS DISTINCT FROM OLD.launch_id OR NEW.slot IS DISTINCT FROM OLD.slot
     OR NEW.level IS DISTINCT FROM OLD.level OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADS_OBJECT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.configured_status IS NOT DISTINCT FROM OLD.configured_status AND NEW.effective_status IS NOT DISTINCT FROM OLD.effective_status
     AND NEW.review_reason IS NOT DISTINCT FROM OLD.review_reason AND NEW.last_seen_at IS NOT DISTINCT FROM OLD.last_seen_at THEN
    RETURN OLD;
  END IF;
  -- What the platform reported and what Ludy set are the system's.
  IF v_actor IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'ADS_OBJECT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.object_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS object_guard ON crove_ads.ad_object;
CREATE TRIGGER object_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_object FOR EACH ROW EXECUTE FUNCTION crove_ads.object_guard();
ALTER TABLE crove_ads.ad_object ENABLE ALWAYS TRIGGER object_guard;

-- The W2-2 guard with the acceptance line of W2-3 added (see the header): everything else is as it was.
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
    IF NEW.state <> 'queued' OR NEW.attempt <> 1 OR NEW.step IS NOT NULL OR NEW.stop_reason IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
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
      -- earliest would let a person release a day that ran in a zone ahead of UTC.)
      v_today := (pg_catalog.now() AT TIME ZONE 'UTC')::date + 1;
      IF v_zone IS NOT NULL THEN
        BEGIN
          v_today := (pg_catalog.now() AT TIME ZONE v_zone)::date;
        EXCEPTION WHEN OTHERS THEN
          v_today := (pg_catalog.now() AT TIME ZONE 'UTC')::date + 1;
        END;
      END IF;
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

-- The safety net of the launch job. The approval writes the event ads.launch.queued in its own transaction, and the relay turns it into a job; a lost job (a
-- restart, a queue that expired) leaves a queued launch, or one that stopped half way (launching, and not yet at the end of the creates), waiting. Those that
-- have waited five minutes, for a provider this worker has a writer for (p_providers), get the same event again; the job's begin step decides what is due, so a
-- repeat is harmless. Only orgs that are active. Worker only, ids only. Returns how many were queued.
CREATE OR REPLACE FUNCTION crove_ads.launch_requeue(p_providers text[], p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row record;
  v_event uuid;
  v_n integer := 0;
BEGIN
  FOR v_row IN
    SELECT l.org_id, l.id AS launch_id, l.ad_account_id
    FROM crove_ads.ad_launch l
    JOIN crove_kernel.tenant t ON t.org_id = l.org_id AND t.status = 'active'
    JOIN crove_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
    JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.write_connection_id
    WHERE c.provider = ANY (COALESCE(p_providers, ARRAY[]::text[]))
      AND (l.state = 'queued' OR (l.state = 'launching' AND l.step IS DISTINCT FROM 'paused'))
      AND l.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5)
    ORDER BY l.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.launch.queued', pg_catalog.jsonb_build_object('launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_requeue(text[], integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_requeue(text[], integer) TO crove_worker;

-- The job's queue: ids only (the org and the launch), retried by the policy.
SELECT crove_jobs.create_queue('ads-launch', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
