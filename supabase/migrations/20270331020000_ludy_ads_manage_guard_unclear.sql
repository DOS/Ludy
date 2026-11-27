-- SPDX-License-Identifier: AGPL-3.0-only
-- Ads W4 follow-ups of #3898 (issue #4076): the guard holds the unclear-family refusal as the commands do, and the unclear pick gets its own small index. Idempotent; the applied
-- manage migrations stay untouched.
--
-- ludy_ads.manage_change_guard   (replaced) the same guard as 20270121110000's, with one addition on INSERT: a lower budget or a shorter schedule is refused with
--                                 ADS_MANAGE_UNCLEAR while an unclear change of its family is newer than the newest applied one of the family (the commands' ADS_CHANGE_UNCLEAR rule,
--                                 now held by the database for every writer but the table's owner). Step one of the two-step route was #4064: the invariant suite's three setups that
--                                 build a hold with a lower budget behind an unclear raise accept both behaviors (requestBehindUnclear).
-- ad_manage_change_unclear_idx    a partial index on the unclear changes, for the settle sweep's pick and this refusal (the table is small, the index smaller).
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS ad_manage_change_unclear_idx ON ludy_ads.ad_manage_change (org_id, launch_id, family, seq) WHERE state = 'unclear';

CREATE OR REPLACE FUNCTION ludy_ads.manage_change_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := CASE WHEN ludy_kernel.ctx_actor_type() = 'user' THEN ludy_kernel.ctx_user_id() END;
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
    IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'queued' OR NEW.code IS NOT NULL OR NEW.settled_on IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role FROM ludy_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
    IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT l.state, l.ad_account_id, l.start_on, l.currency INTO v_launch FROM ludy_ads.ad_launch l WHERE l.org_id = NEW.org_id AND l.id = NEW.launch_id;
    IF NOT FOUND OR v_launch.ad_account_id <> NEW.ad_account_id OR v_launch.state NOT IN ('live', 'needs_attention') OR (v_launch.state = 'needs_attention' AND NEW.kind <> 'pause') THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- The object is one the launch recorded, with the platform's id as recorded.
    SELECT o.level, o.external_id INTO v_object FROM ludy_ads.ad_object o WHERE o.org_id = NEW.org_id AND o.launch_id = NEW.launch_id AND o.slot = NEW.slot;
    IF NOT FOUND OR v_object.level <> NEW.level OR v_object.external_id <> NEW.object_id THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT s.write_enabled, s.launches_blocked INTO v_setting FROM ludy_ads.ad_org_setting s WHERE s.org_id = NEW.org_id ORDER BY s.id LIMIT 1;
    SELECT a.write_enabled, a.time_zone INTO v_account FROM ludy_ads.ad_account a WHERE a.org_id = NEW.org_id AND a.id = NEW.ad_account_id;
    -- Anything but a pause needs running ads on for the org and the account; what can start or raise spend also needs launches not blocked.
    IF NEW.kind <> 'pause' AND (v_setting.write_enabled IS NOT TRUE OR v_account.write_enabled IS NOT TRUE) THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') AND v_setting.launches_blocked IS NOT FALSE THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- What can start or raise spend is refused for an ad set or a campaign that was archived: it no longer delivers.
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') AND EXISTS (
         SELECT 1 FROM ludy_ads.ad_manage_change x WHERE x.org_id = NEW.org_id AND x.launch_id = NEW.launch_id AND x.kind = 'archive' AND x.state = 'applied' AND x.slot IN ('campaign', 'ad_set')) THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT h.daily_budget, h.end_on INTO v_hold FROM ludy_ads.launch_hold(NEW.org_id, NEW.launch_id) h;
    v_today := ludy_ads.launch_today(v_account.time_zone);
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
    -- A lower budget or a shorter schedule (no approval) behind an unclear change of its family could really be a raise or an extension (the platform may already run the other
    -- value): refused until a read or a confirmed change settles it (#3898 step two; #4076). The same rule as the commands' (unclearOpen): an unclear change newer than the newest
    -- applied one of the family. The system's settle sweep (manage_unclear_pick) is the way out; a person's other changes (a pause, an archive, an approved raise) are not held back.
    IF NEW.kind IN ('budget_lower', 'schedule_shorten') AND EXISTS (
         SELECT 1 FROM ludy_ads.ad_manage_change u
         WHERE u.org_id = NEW.org_id AND u.launch_id = NEW.launch_id AND u.state = 'unclear'
           AND u.family = CASE NEW.kind WHEN 'budget_lower' THEN 'budget' ELSE 'schedule' END
           AND u.seq > COALESCE((SELECT pg_catalog.max(a.seq) FROM ludy_ads.ad_manage_change a WHERE a.org_id = u.org_id AND a.launch_id = u.launch_id AND a.family = u.family AND a.state = 'applied'), 0)) THEN
      RAISE EXCEPTION 'ADS_MANAGE_UNCLEAR' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind IN ('resume', 'budget_raise', 'schedule_extend') THEN
      v_command := CASE NEW.kind WHEN 'resume' THEN 'ads.object.resume' WHEN 'budget_raise' THEN 'ads.budget.raise' ELSE 'ads.schedule.extend' END;
      -- The largest amount the plan can spend with this change: the budget times the days of the flight, the one number the approver signed.
      v_amount := CASE NEW.kind
        WHEN 'budget_raise' THEN NEW.to_budget * (v_hold.end_on - v_launch.start_on + 1)
        WHEN 'schedule_extend' THEN v_hold.daily_budget * (NEW.to_end_on - v_launch.start_on + 1)
        ELSE v_hold.daily_budget * (v_hold.end_on - v_launch.start_on + 1) END;
      v_match := pg_catalog.jsonb_build_object('launchId', NEW.launch_id::text, 'adAccountId', NEW.ad_account_id::text, 'slot', NEW.slot);
      IF NOT ludy_ads.approved_execution(v_command, v_match, v_amount) THEN
        RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      SELECT p.id, p.payload INTO v_proposal, v_payload FROM ludy_kernel.proposal p
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
  IF OLD.state = 'unclear' THEN
    -- The one move out of a state that is not queued: the system settles an unclear change by what a read of the object showed (applied, or failed when the object is as it was),
    -- while nothing newer of its family is queued, applied or unclear (what a read shows is then not about this change). Anything else, anyone else, is frozen.
    IF v_actor IS DISTINCT FROM 'system' OR NEW.state NOT IN ('applied', 'failed') OR EXISTS (
         SELECT 1 FROM ludy_ads.ad_manage_change x
         WHERE x.org_id = OLD.org_id AND x.launch_id = OLD.launch_id AND x.family = OLD.family AND x.seq > OLD.seq AND x.state IN ('queued', 'applied', 'unclear')) THEN
      RAISE EXCEPTION 'ADS_MANAGE_FROZEN' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state <> 'queued' THEN
    RAISE EXCEPTION 'ADS_MANAGE_FROZEN' USING ERRCODE = '42501';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM ludy_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.user_id = v_user;
  END IF;
  IF NEW.state = 'cancelled' THEN
    -- An owner or an admin, or the system (a stop or a switch-off found it queued), for a change the job never begun: a call that was begun may have landed.
    IF v_actor IS DISTINCT FROM 'system' AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM ludy_kernel.external_call e WHERE e.org_id = OLD.org_id AND e.key LIKE 'ads.manage:' || OLD.id::text || ':%') THEN
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
    SELECT a.time_zone INTO v_account FROM ludy_ads.ad_account a WHERE a.org_id = OLD.org_id AND a.id = OLD.ad_account_id;
    NEW.settled_on := ludy_ads.launch_today(v_account.time_zone);
  ELSE
    NEW.settled_on := NULL;
  END IF;
  NEW.settled_at := pg_catalog.clock_timestamp();
  NEW.updated_at := NEW.settled_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_ads.manage_change_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DROP TRIGGER IF EXISTS manage_change_guard ON ludy_ads.ad_manage_change;
CREATE TRIGGER manage_change_guard BEFORE INSERT OR UPDATE ON ludy_ads.ad_manage_change FOR EACH ROW EXECUTE FUNCTION ludy_ads.manage_change_guard();
ALTER TABLE ludy_ads.ad_manage_change ENABLE ALWAYS TRIGGER manage_change_guard;
