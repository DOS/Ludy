-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W4 (issue #3835, ADR-0043 points 1, 2, 5 and 9, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.4 and 3.6): manage a running launch. A person pauses, resumes
-- or archives a campaign, an ad set or an ad of a live launch, lowers or raises the daily budget, shortens or extends the schedule (the budget and the end date are the ad
-- set's). A change that can start or raise spend (a resume, a raise, an extend) is the execution of an approved R3 proposal, like a launch; one that only reduces it (a pause,
-- an archive, a lower, a shorten) is an owner's or an admin's own R2 command. The platform is called by a job (queue ads-manage) after the begin command re-checked the stop
-- conditions and the caps; this migration holds the database's side. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_manage_change   one row per requested change: the launch and the object (slot, level, the platform's id as recorded), the kind (pause, resume, archive,
--                              budget_lower, budget_raise, schedule_shorten, schedule_extend), the values it moves from and to, the approved proposal of a raise, an
--                              extend or a resume, and its state: queued (asked, platform not yet confirmed), applied (the platform confirmed it), failed (the platform
--                              refused it or it never reached it), cancelled (never begun) or unclear (the platform's answer could not be told in the time Ludy waits:
--                              it may have applied). At most one change of a family (the budget, the schedule, one object's status) is queued at a time. In the
--                              account's legal entity under the same RESTRICTIVE le_scope policy as the ledger. Tenant roles read it and update the state columns
--                              (a column grant); a row is inserted by an owner or an admin for a reducing change, or by the execution of the approved proposal of its
--                              own command for the others, and nothing else (crove_ads.manage_change_guard); none deletes (the org's purge deletes with the account).
--
-- crove_ads.launch_hold        what a launch may spend, as an upper bound: its confirmed budget and end date (the last applied change of the family, else the ledger's), or
--                              the raise or the extension still queued or unclear if that is higher. A lower or a shorten holds nothing back until the platform confirms
--                              it, so the commitment never drops before the money does. The one definition, read by the commitments below and by the guard.
--
-- crove_ads.launch_commitments the commitments of every launch (W2-4b), now through launch_hold: the budget and the last day a launch commits are its hold. An ad set or a
--                              campaign archived at the platform ends its commitment at the day it was applied (what ran counts). Same signature, same callers.
-- crove_ads.launch_commitments_except  the same list without one launch: the begin step and the approval of a raise judge the launch against the others.
-- crove_ads.manage_requeue     the safety net of the job: a queued change whose event or job was lost is queued again with the same event; worker only, ids only.
-- Queue ads-manage             the job's queue: ids only, retried by the policy.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_manage_change (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The order of the changes of a launch (the newest applied change of a family is the one that stands).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  launch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pause', 'resume', 'archive', 'budget_lower', 'budget_raise', 'schedule_shorten', 'schedule_extend')),
  -- The object: the campaign, the ad set or one ad of the launch. The budget and the schedule are the ad set's.
  slot text NOT NULL CHECK (slot ~ '^(campaign|ad_set|ad_[1-3])$'),
  level text NOT NULL CHECK (level IN ('campaign', 'ad_set', 'ad')),
  -- The platform's id of the object, as the launch recorded it.
  object_id text NOT NULL CHECK (pg_catalog.length(object_id) BETWEEN 1 AND 64),
  family text GENERATED ALWAYS AS (CASE WHEN kind IN ('budget_lower', 'budget_raise') THEN 'budget' WHEN kind IN ('schedule_shorten', 'schedule_extend') THEN 'schedule' ELSE 'status:' || slot END) STORED,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'applied', 'failed', 'cancelled', 'unclear')),
  -- A daily budget in the account currency's own units, and an end date (the last day of the flight, in the account's zone).
  from_budget numeric CHECK (from_budget IS NULL OR (from_budget > 0 AND from_budget < 'Infinity'::numeric AND from_budget <> 'NaN'::numeric)),
  to_budget numeric CHECK (to_budget IS NULL OR (to_budget > 0 AND to_budget < 'Infinity'::numeric AND to_budget <> 'NaN'::numeric)),
  from_end_on date,
  to_end_on date,
  -- The approved proposal of a raise, an extend or a resume, stamped by the guard.
  proposal_id uuid,
  code text CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_.]{1,64}$'),
  -- The day (the latest any zone can be on) the platform confirmed it: what ran up to it counts.
  settled_on date,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_manage_change_seq_uq UNIQUE (org_id, seq),
  CONSTRAINT ad_manage_change_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ad_manage_change_launch_fk FOREIGN KEY (org_id, launch_id) REFERENCES crove_ads.ad_launch (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ad_manage_change_level_ck CHECK ((level = 'campaign' AND slot = 'campaign') OR (level = 'ad_set' AND slot = 'ad_set') OR (level = 'ad' AND slot ~ '^ad_[1-3]$')),
  -- The shape of each kind: the direction of a budget or a schedule change is in the row, so a "lower" cannot raise.
  CONSTRAINT ad_manage_change_shape_ck CHECK (
    (kind IN ('pause', 'resume', 'archive') AND from_budget IS NULL AND to_budget IS NULL AND from_end_on IS NULL AND to_end_on IS NULL)
    OR (kind = 'budget_lower' AND slot = 'ad_set' AND from_budget IS NOT NULL AND to_budget < from_budget AND from_end_on IS NULL AND to_end_on IS NULL)
    OR (kind = 'budget_raise' AND slot = 'ad_set' AND from_budget IS NOT NULL AND to_budget > from_budget AND from_end_on IS NULL AND to_end_on IS NULL)
    OR (kind = 'schedule_shorten' AND slot = 'ad_set' AND from_budget IS NULL AND to_budget IS NULL AND from_end_on IS NOT NULL AND to_end_on < from_end_on)
    OR (kind = 'schedule_extend' AND slot = 'ad_set' AND from_budget IS NULL AND to_budget IS NULL AND from_end_on IS NOT NULL AND to_end_on > from_end_on)
  ),
  -- What can raise spend carries the approved proposal that allowed it; what cannot, none.
  CONSTRAINT ad_manage_change_proposal_ck CHECK ((kind IN ('resume', 'budget_raise', 'schedule_extend')) = (proposal_id IS NOT NULL)),
  CONSTRAINT ad_manage_change_settled_ck CHECK ((state = 'queued') = (settled_at IS NULL) AND (settled_on IS NULL OR state = 'applied'))
);
-- One change of a family at a time while it waits for the platform.
CREATE UNIQUE INDEX IF NOT EXISTS ad_manage_change_open_uq ON crove_ads.ad_manage_change (org_id, launch_id, family) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS ad_manage_change_launch_idx ON crove_ads.ad_manage_change (org_id, launch_id, seq DESC);
CREATE INDEX IF NOT EXISTS ad_manage_change_account_idx ON crove_ads.ad_manage_change (org_id, ad_account_id, legal_entity_id);

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_manage_change');
-- Tenant roles read and update the state columns only; the guard holds who moves what.
REVOKE UPDATE, DELETE ON crove_ads.ad_manage_change FROM crove_tenant;
GRANT UPDATE (state, code, settled_on, settled_at, updated_at) ON crove_ads.ad_manage_change TO crove_tenant;

DROP POLICY IF EXISTS le_scope ON crove_ads.ad_manage_change;
CREATE POLICY le_scope ON crove_ads.ad_manage_change AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_manage_change;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_manage_change FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_manage_change ENABLE ALWAYS TRIGGER b_legal_entity;

-- What a launch may spend, as an upper bound (see the header). Internal: the definers below and the guard call it; no login role does.
CREATE OR REPLACE FUNCTION crove_ads.launch_hold(p_org uuid, p_launch uuid) RETURNS TABLE (daily_budget numeric, end_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH l AS (SELECT x.daily_budget, x.end_on FROM crove_ads.ad_launch x WHERE x.org_id = p_org AND x.id = p_launch),
  b AS (SELECT c.to_budget, c.seq FROM crove_ads.ad_manage_change c WHERE c.org_id = p_org AND c.launch_id = p_launch AND c.family = 'budget' AND c.state = 'applied' ORDER BY c.seq DESC LIMIT 1),
  e AS (SELECT c.to_end_on, c.seq FROM crove_ads.ad_manage_change c WHERE c.org_id = p_org AND c.launch_id = p_launch AND c.family = 'schedule' AND c.state = 'applied' ORDER BY c.seq DESC LIMIT 1)
  SELECT GREATEST(COALESCE((SELECT b.to_budget FROM b), l.daily_budget),
                  (SELECT pg_catalog.max(c.to_budget) FROM crove_ads.ad_manage_change c
                   WHERE c.org_id = p_org AND c.launch_id = p_launch AND c.kind = 'budget_raise' AND c.state IN ('queued', 'unclear') AND c.seq > COALESCE((SELECT b.seq FROM b), 0))),
         GREATEST(COALESCE((SELECT e.to_end_on FROM e), l.end_on),
                  (SELECT pg_catalog.max(c.to_end_on) FROM crove_ads.ad_manage_change c
                   WHERE c.org_id = p_org AND c.launch_id = p_launch AND c.kind = 'schedule_extend' AND c.state IN ('queued', 'unclear') AND c.seq > COALESCE((SELECT e.seq FROM e), 0)))
  FROM l
$$;
REVOKE ALL ON FUNCTION crove_ads.launch_hold(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The guard of the changes, in the database as well as in the commands, whatever path reaches the table (fired for every role, the table's owner included, for rows of the
-- org in context; a raw statement outside any context is a definer's or the owner's, and row security refuses a login role another org's rows).
-- INSERT: a signed-in owner or admin makes a change that cannot raise spend (a pause, an archive, a lower budget, a shorter schedule) for a live launch (a pause also for one
-- that needs attention), while running ads is on for the org and the account (a pause needs neither switch); a resume, a raise or an extension is the execution of the
-- approved proposal of its own command that names this launch, this object and these values and this largest amount, with the switches on and launches not blocked. The
-- object is one the launch recorded, the values it moves from are what the launch holds now, a lower goes below it, a raise above it, a shorter schedule ends no earlier than
-- the day it ran to, a longer one keeps the flight within 90 days. UPDATE: the system settles a queued change (applied, failed, unclear), an owner or an admin cancels one that
-- was never begun; a settled change never changes; the stamps are the database's.
CREATE OR REPLACE FUNCTION crove_ads.manage_change_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_role text;
  v_launch record;
  v_hold record;
  v_setting record;
  v_account record;
  v_object record;
  v_command text;
  v_match jsonb;
  v_amount numeric;
  v_proposal uuid;
  v_payload jsonb;
  v_today date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'queued' OR NEW.code IS NOT NULL OR NEW.settled_on IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
    IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT l.state, l.ad_account_id, l.start_on, l.currency INTO v_launch FROM crove_ads.ad_launch l WHERE l.org_id = NEW.org_id AND l.id = NEW.launch_id;
    IF NOT FOUND OR v_launch.ad_account_id <> NEW.ad_account_id OR v_launch.state NOT IN ('live', 'needs_attention') OR (v_launch.state = 'needs_attention' AND NEW.kind <> 'pause') THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- The object is one the launch recorded, with the platform's id as recorded.
    SELECT o.level, o.external_id INTO v_object FROM crove_ads.ad_object o WHERE o.org_id = NEW.org_id AND o.launch_id = NEW.launch_id AND o.slot = NEW.slot;
    IF NOT FOUND OR v_object.level <> NEW.level OR v_object.external_id <> NEW.object_id THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT s.write_enabled, s.launches_blocked INTO v_setting FROM crove_ads.ad_org_setting s WHERE s.org_id = NEW.org_id ORDER BY s.id LIMIT 1;
    SELECT a.write_enabled, a.time_zone INTO v_account FROM crove_ads.ad_account a WHERE a.org_id = NEW.org_id AND a.id = NEW.ad_account_id;
    -- Anything but a pause needs running ads on for the org and the account; what can start or raise spend also needs launches not blocked.
    IF NEW.kind <> 'pause' AND (v_setting.write_enabled IS NOT TRUE OR v_account.write_enabled IS NOT TRUE) THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') AND v_setting.launches_blocked IS NOT FALSE THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- What can start or raise spend is refused for an ad set or a campaign that was archived: it no longer delivers.
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') AND EXISTS (
         SELECT 1 FROM crove_ads.ad_manage_change x WHERE x.org_id = NEW.org_id AND x.launch_id = NEW.launch_id AND x.kind = 'archive' AND x.state = 'applied' AND x.slot IN ('campaign', 'ad_set')) THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT h.daily_budget, h.end_on INTO v_hold FROM crove_ads.launch_hold(NEW.org_id, NEW.launch_id) h;
    v_today := crove_ads.launch_today(v_account.time_zone);
    IF NEW.kind IN ('budget_lower', 'budget_raise') THEN
      IF NEW.from_budget IS DISTINCT FROM v_hold.daily_budget THEN
        RAISE EXCEPTION 'ADS_MANAGE_STALE' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.kind IN ('schedule_shorten', 'schedule_extend') THEN
      IF NEW.from_end_on IS DISTINCT FROM v_hold.end_on THEN
        RAISE EXCEPTION 'ADS_MANAGE_STALE' USING ERRCODE = '42501';
      END IF;
      -- A flight is at most 90 days, and a shorter schedule ends no earlier than the day it ran to (what ran counts).
      IF NEW.kind = 'schedule_extend' AND NEW.to_end_on - v_launch.start_on > 89 THEN
        RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      IF NEW.kind = 'schedule_shorten' AND (NEW.to_end_on < v_launch.start_on OR NEW.to_end_on < v_today) THEN
        RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') THEN
      v_command := CASE NEW.kind WHEN 'resume' THEN 'ads.object.resume' WHEN 'budget_raise' THEN 'ads.budget.raise' ELSE 'ads.schedule.extend' END;
      -- The largest amount the plan can spend with this change: the budget times the days of the flight, the one number the approver signed.
      v_amount := CASE NEW.kind
        WHEN 'budget_raise' THEN NEW.to_budget * (v_hold.end_on - v_launch.start_on + 1)
        WHEN 'schedule_extend' THEN v_hold.daily_budget * (NEW.to_end_on - v_launch.start_on + 1)
        ELSE v_hold.daily_budget * (v_hold.end_on - v_launch.start_on + 1) END;
      v_match := pg_catalog.jsonb_build_object('launchId', NEW.launch_id::text, 'adAccountId', NEW.ad_account_id::text, 'slot', NEW.slot);
      IF NOT crove_ads.approved_execution(v_command, v_match, v_amount) THEN
        RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      SELECT p.id, p.payload INTO v_proposal, v_payload FROM crove_kernel.proposal p
      WHERE p.org_id = NEW.org_id AND p.command = v_command AND p.status = 'approved' AND p.payload @> v_match AND p.decided_by = v_user AND p.decided_at = pg_catalog.now()
      ORDER BY p.id DESC LIMIT 1;
      -- The values inside the proposal are the values the row holds: what the approver was shown.
      IF v_proposal IS NULL
         OR (NEW.kind = 'budget_raise' AND (v_payload ->> 'toBudget')::numeric IS DISTINCT FROM NEW.to_budget)
         OR (NEW.kind = 'schedule_extend' AND (v_payload ->> 'toEndOn')::date IS DISTINCT FROM NEW.to_end_on) THEN
        RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      NEW.proposal_id := v_proposal;
    ELSIF NEW.proposal_id IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.requested_by := v_user;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  -- UPDATE. The one change that is not a writer's comes first: the cascade of the account's legal entity (when the account moves to another entity), which alters nothing
  -- else; tenant roles have no UPDATE grant on the column. (The generated family is left out of the comparison: a BEFORE trigger sees it before it is computed.)
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id' - 'family') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id' - 'family') THEN
    RETURN NEW;
  END IF;
  -- Nothing but the state columns changes, and a settled change never does.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.ad_account_id IS DISTINCT FROM OLD.ad_account_id OR NEW.launch_id IS DISTINCT FROM OLD.launch_id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.level IS DISTINCT FROM OLD.level OR NEW.object_id IS DISTINCT FROM OLD.object_id
     OR NEW.from_budget IS DISTINCT FROM OLD.from_budget OR NEW.to_budget IS DISTINCT FROM OLD.to_budget OR NEW.from_end_on IS DISTINCT FROM OLD.from_end_on
     OR NEW.to_end_on IS DISTINCT FROM OLD.to_end_on OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.code IS NOT DISTINCT FROM OLD.code AND NEW.settled_on IS NOT DISTINCT FROM OLD.settled_on AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at THEN
    RETURN OLD;
  END IF;
  IF OLD.state <> 'queued' THEN
    RAISE EXCEPTION 'ADS_MANAGE_FROZEN' USING ERRCODE = '42501';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.user_id = v_user;
  END IF;
  IF NEW.state = 'cancelled' THEN
    -- An owner or an admin, or the system (a stop or a switch-off found it queued), for a change the job never begun: a call that was begun may have landed.
    IF v_actor IS DISTINCT FROM 'system' AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM crove_kernel.external_call e WHERE e.org_id = OLD.org_id AND e.key LIKE 'ads.manage:' || OLD.id::text || ':%') THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.state IN ('applied', 'failed', 'unclear') THEN
    IF v_actor IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'ADS_MANAGE_STATE' USING ERRCODE = '42501';
  END IF;
  -- Applied is the day (the latest any zone can be on) the platform confirmed it: the database's, never the writer's.
  IF NEW.state = 'applied' THEN
    SELECT a.time_zone INTO v_account FROM crove_ads.ad_account a WHERE a.org_id = OLD.org_id AND a.id = OLD.ad_account_id;
    NEW.settled_on := crove_ads.launch_today(v_account.time_zone);
  ELSE
    NEW.settled_on := NULL;
  END IF;
  NEW.settled_at := pg_catalog.clock_timestamp();
  NEW.updated_at := NEW.settled_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.manage_change_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS manage_change_guard ON crove_ads.ad_manage_change;
CREATE TRIGGER manage_change_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_manage_change FOR EACH ROW EXECUTE FUNCTION crove_ads.manage_change_guard();
ALTER TABLE crove_ads.ad_manage_change ENABLE ALWAYS TRIGGER manage_change_guard;

-- The commitments the launches hold (W2-4b's function, W4's hold): the budget and the last day a launch commits are what launch_hold says, an ad set or a campaign archived at
-- the platform ends the commitment at the day it was applied, and one launch can be left out (the begin step and the approval of a raise judge it against the others).
-- Everything else is as W2-4b had it: a stop shortens a launch's commitment to today but a launch that was stopped and is not wound down keeps committing to the last day of
-- its flight, and the callers are unchanged (the three-argument function is a wrapper).
CREATE OR REPLACE FUNCTION crove_ads.launch_commitments_pick(p_currency text, p_from date, p_to date, p_except uuid, p_only uuid)
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
  -- A launch commits its budget on every day of its window. With no change of the budget that is one row (the budget, the first day, the last). Once a raise was asked for (in any
  -- state but failed or cancelled) or a change of the budget was confirmed, each day is its own row at the HIGHEST budget that may have been running on it: the ledger's budget until
  -- a confirmed change took over, a raise from the day before it was asked for (the latest any zone can be on, minus one: the call could not be earlier) until a later confirmed
  -- change took over, a confirmed lower budget from the day after it was confirmed. A raise that is queued or unclear therefore counts for every day it may have run (and, while it
  -- waits, to the end), however long ago it was asked and whatever became of it later; a lower budget releases nothing before the platform confirmed it, and never the days that ran
  -- before. Days that overlap two budgets count the higher one once.
  RETURN QUERY
  WITH launches AS (
    SELECT l.id, l.ad_account_id, l.currency, l.start_on, l.daily_budget AS ledger_budget, h.daily_budget AS hold_budget,
           LEAST(c.until, a.ended) AS until
    FROM crove_ads.ad_launch l
    CROSS JOIN LATERAL crove_ads.launch_hold(l.org_id, l.id) h
    CROSS JOIN LATERAL (
      SELECT CASE WHEN l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL THEN GREATEST(l.commit_until, h.end_on)
                  -- A stopped launch whose schedule was extended: the days it ran past its first end still count (up to the day it stopped, the latest any zone can be on).
                  WHEN l.state = 'stopped' AND EXISTS (SELECT 1 FROM crove_ads.ad_manage_change x WHERE x.org_id = l.org_id AND x.launch_id = l.id AND x.kind = 'schedule_extend' AND x.state IN ('applied', 'unclear', 'queued'))
                    THEN GREATEST(l.commit_until, LEAST(h.end_on, (l.finished_at AT TIME ZONE 'UTC')::date + 1))
                  WHEN l.state IN ('stopped', 'failed', 'cancelled') THEN l.commit_until
                  ELSE h.end_on END AS until
    ) c
    -- An ad set or a campaign archived at the platform no longer delivers: it commits up to the day the archive was applied.
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT pg_catalog.max(x.settled_on) FROM crove_ads.ad_manage_change x
                       WHERE x.org_id = l.org_id AND x.launch_id = l.id AND x.kind = 'archive' AND x.state = 'applied' AND x.slot IN ('campaign', 'ad_set')), 'infinity'::date) AS ended
    ) a
    WHERE l.org_id = v_org AND l.currency = p_currency AND l.commit_until IS NOT NULL AND LEAST(c.until, a.ended) >= p_from AND l.start_on <= p_to
      AND (p_except IS NULL OR l.id <> p_except) AND (p_only IS NULL OR l.id = p_only)
  ), ch AS (
    SELECT c.launch_id, c.seq, c.kind, c.state, c.to_budget, c.settled_on,
           (c.created_at AT TIME ZONE 'UTC')::date - 1 AS asked_from
    FROM crove_ads.ad_manage_change c
    WHERE c.org_id = v_org AND c.family = 'budget' AND c.state IN ('applied', 'unclear', 'queued')
      AND c.launch_id IN (SELECT x.id FROM launches x)
  ), moving AS (
    SELECT DISTINCT launch_id FROM ch WHERE kind = 'budget_raise' OR state = 'applied'
  ), days AS (
    SELECT x.id AS launch_id, d::date AS day
    FROM launches x
    JOIN moving m ON m.launch_id = x.id
    CROSS JOIN LATERAL pg_catalog.generate_series(GREATEST(x.start_on, p_from)::timestamp, LEAST(x.until, p_to)::timestamp, interval '1 day') d
  ), cand AS (
    -- The ledger's budget, until a confirmed change took over (the day after it was confirmed: the old budget may have run on the day itself).
    SELECT d.launch_id, d.day, x.ledger_budget AS budget
    FROM days d JOIN launches x ON x.id = d.launch_id
    WHERE NOT EXISTS (SELECT 1 FROM ch j WHERE j.launch_id = d.launch_id AND j.state = 'applied' AND j.settled_on + 1 <= d.day)
    UNION ALL
    -- A raise from the day before it was asked for, and a confirmed lower budget from the day after it was confirmed, each until a LATER confirmed change took over.
    SELECT d.launch_id, d.day, i.to_budget
    FROM days d JOIN ch i ON i.launch_id = d.launch_id
    WHERE ((i.kind = 'budget_raise' AND d.day >= i.asked_from) OR (i.kind = 'budget_lower' AND i.state = 'applied' AND d.day >= i.settled_on + 1))
      AND NOT EXISTS (SELECT 1 FROM ch j WHERE j.launch_id = d.launch_id AND j.state = 'applied' AND j.seq > i.seq AND j.settled_on + 1 <= d.day)
  )
  SELECT x.ad_account_id, x.currency, p.budget::text, p.day, p.day
  FROM (SELECT c.launch_id, c.day, pg_catalog.max(c.budget) AS budget FROM cand c GROUP BY c.launch_id, c.day) p
  JOIN launches x ON x.id = p.launch_id
  UNION ALL
  SELECT x.ad_account_id, x.currency, x.hold_budget::text, x.start_on, x.until
  FROM launches x
  WHERE NOT EXISTS (SELECT 1 FROM moving m WHERE m.launch_id = x.id)
  ORDER BY 1, 4, 5;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments_pick(text, date, date, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Every launch but one (the begin step and the approval of a raise judge a launch against the others), and one launch alone (its own segments, of which the last is replaced by the
-- values being judged): both through the one body above, which holds the role check.
CREATE OR REPLACE FUNCTION crove_ads.launch_commitments_except(p_currency text, p_from date, p_to date, p_except uuid)
RETURNS TABLE (ad_account_id uuid, currency text, daily_budget text, start_on date, commit_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM crove_ads.launch_commitments_pick(p_currency, p_from, p_to, p_except, NULL::uuid)
$$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments_except(text, date, date, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_commitments_except(text, date, date, uuid) TO crove_app, crove_worker;

CREATE OR REPLACE FUNCTION crove_ads.launch_commitments_of(p_currency text, p_from date, p_to date, p_only uuid)
RETURNS TABLE (ad_account_id uuid, currency text, daily_budget text, start_on date, commit_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM crove_ads.launch_commitments_pick(p_currency, p_from, p_to, NULL::uuid, p_only)
$$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments_of(text, date, date, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_commitments_of(text, date, date, uuid) TO crove_app, crove_worker;

CREATE OR REPLACE FUNCTION crove_ads.launch_commitments(p_currency text, p_from date, p_to date)
RETURNS TABLE (ad_account_id uuid, currency text, daily_budget text, start_on date, commit_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM crove_ads.launch_commitments_pick(p_currency, p_from, p_to, NULL::uuid, NULL::uuid)
$$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments(text, date, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_commitments(text, date, date) TO crove_app, crove_worker;

-- The safety net of the manage job. A change is queued with the event ads.manage.queued by the command that makes it; a lost event or job leaves it waiting. Those that have
-- waited five minutes get the same event again, for a provider this worker has a manager for (p_providers); the job's begin decides what is due, so a repeat is harmless. Only
-- orgs that are active. Worker only, ids only.
CREATE OR REPLACE FUNCTION crove_ads.manage_requeue(p_providers text[], p_limit integer) RETURNS integer
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
    SELECT c.org_id, c.id AS change_id, c.launch_id, c.ad_account_id
    FROM crove_ads.ad_manage_change c
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
    JOIN crove_ads.ad_account a ON a.org_id = c.org_id AND a.id = c.ad_account_id
    JOIN crove_kernel.channel_connection k ON k.org_id = a.org_id AND k.id = a.write_connection_id
    WHERE k.provider = ANY (COALESCE(p_providers, ARRAY[]::text[]))
      AND c.state = 'queued'
      AND c.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5)
    ORDER BY c.updated_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
  LOOP
    INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (v_row.org_id, 'ads.manage.queued', pg_catalog.jsonb_build_object('changeId', v_row.change_id, 'launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id), 'system')
    RETURNING id INTO v_event;
    INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_row.org_id, v_event);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_ads.manage_requeue(text[], integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.manage_requeue(text[], integer) TO crove_worker;

-- The job's queue: ids only (the org and the change), retried by the policy.
SELECT crove_jobs.create_queue('ads-manage', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
