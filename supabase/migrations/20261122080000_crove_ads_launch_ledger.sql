-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-2 (issue #2296, ADR-0043 point 2, plan docs/plan/ads-write.md sections 3.3, 3.4 and 9): the launch ledger, the row an approved plan leaves
-- behind, and the commitment it holds against the spend caps. Nothing here calls a platform, nothing launches and nothing spends: a ledger row is
-- queued by the execution of an approved ads.campaign.launch proposal and waits (W2-3 adds the writer that runs it, W2-4 the pause on switch-off).
-- Until a person cancels it or a stop command releases it, it only holds its plan's amount against the caps, so two launches approved together cannot
-- pass a cap between them. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_launch            one row per approved plan (one per draft): the plan's account, the proposal that approved it, the hash of exactly that
--                                plan, the daily budget, the days of the flight, the largest amount it can spend (always the budget times the days: a
--                                CHECK), the name tag every object it creates will carry (`ludy:` and ten characters of its id, generated), its state
--                                (queued, launching, live, needs_attention, then stopped, failed or cancelled), the step the writer is at, the attempt, and
--                                `commit_until`: the last day it still commits. A launch commits its budget on every day from `start_on` to
--                                `commit_until` (the end of the flight at the start); the date can only move earlier (a launch that is paused or
--                                stopped commits what ran up to then and nothing after) and is cleared when nothing is committed any more (cancelled
--                                before it started, failed before it was activated). Its legal entity is its account's (trigger b_legal_entity and the
--                                composite foreign key, as the draft) under the same RESTRICTIVE le_scope policy. Tenant roles read it and update the
--                                state columns (a column grant); none inserts out of an approved execution (the guard) and none deletes: the org's
--                                purge deletes it with the account (ON DELETE CASCADE), as it does the drafts.
--
-- crove_ads.launch_guard         holds the ledger whatever path reaches it (fired for every role, the table's owner included, for rows of the org in
--                                context; a raw statement outside any context is a definer's or the owner's, and row security refuses every login role
--                                another org's rows): a row is born queued, inside the execution of an approved ads.campaign.launch proposal that names
--                                this draft, this plan hash, this account and currency, and whose plan has this budget and these days and this largest
--                                amount, for an approved draft of that account and amount, while the org's write switch and the account's are on and
--                                launches are not blocked; the proposal, the commitment window and who and when are stamped here, whatever the writer
--                                sent. After that the plan never changes, the commitment only shortens, a state moves only along its graph (queued to
--                                launching or cancelled; launching to live, failed, needs_attention or stopped; needs_attention back to launching, or to
--                                failed or stopped; live to stopped), the steps of the writer are the system's alone, and stopping or cancelling is the
--                                owner's, an admin's or the system's. A cancelled launch commits nothing. A final state never changes.
--
-- crove_ads.launch_commitments   the commitments of every launch of the org in context that touch a window, whatever the caller's legal entity scope: an
--                                org cap counts every account of the org, and an approver limited to some entities must not miss the others' launches.
--                                Answers ids, a currency, a budget as text and two dates; owners, admins and the system only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_launch (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  -- The approved proposal that queued it, stamped by the guard. No foreign key: the org purge deletes proposals before the ads tables.
  proposal_id uuid NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- The name tag of every object the launch creates, so reconcile finds one that was created and never recorded (plan 3.4).
  tag text GENERATED ALWAYS AS ('ludy:' || pg_catalog.substr(pg_catalog.replace(id::text, '-', ''), 23, 10)) STORED,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'launching', 'live', 'needs_attention', 'stopped', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  -- Where the writer is (campaign, ad_set, creative, ad, activate): a code, set by the system alone.
  step text CHECK (step IS NULL OR step ~ '^[a-z_]{1,32}$'),
  -- The account's currency when the plan was approved, the daily budget in its units, the days of the flight (both included) and the largest amount.
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  daily_budget numeric NOT NULL CHECK (daily_budget > 0 AND daily_budget < 'Infinity'::numeric AND daily_budget <> 'NaN'::numeric),
  start_on date NOT NULL,
  end_on date NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0 AND amount < 'Infinity'::numeric AND amount <> 'NaN'::numeric),
  -- The last day the launch still commits its budget; null when it commits nothing any more.
  commit_until date,
  stop_reason text CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z_]{1,40}$'),
  created_by uuid NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_launch_draft_uq UNIQUE (org_id, draft_id),
  CONSTRAINT ad_launch_tag_uq UNIQUE (org_id, tag),
  CONSTRAINT ad_launch_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ad_launch_draft_fk FOREIGN KEY (org_id, draft_id) REFERENCES crove_ads.ad_campaign_draft (org_id, id) ON DELETE CASCADE,
  -- A flight is at most 90 days, and what it can spend is its budget times its days, whoever wrote the row.
  CONSTRAINT ad_launch_flight_ck CHECK (end_on >= start_on AND end_on - start_on <= 89 AND amount = daily_budget * (end_on - start_on + 1)),
  CONSTRAINT ad_launch_commit_ck CHECK (commit_until IS NULL OR (commit_until >= start_on AND commit_until <= end_on)),
  -- A launch that is not over commits its budget, and a launch that is over has a finish time, and no other has.
  CONSTRAINT ad_launch_final_ck CHECK ((state IN ('stopped', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT ad_launch_open_ck CHECK (state IN ('stopped', 'failed', 'cancelled') OR commit_until IS NOT NULL)
);
-- A list of an account's launches, newest first (the screens); the commitments of a window; the draft's and the entity's foreign keys are covered
-- by the unique key and the first index.
CREATE INDEX IF NOT EXISTS ad_launch_account_idx ON crove_ads.ad_launch (org_id, ad_account_id, legal_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_launch_commit_idx ON crove_ads.ad_launch (org_id, commit_until) WHERE commit_until IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_launch');
-- Tenant roles read and update the state columns; they never delete a launch (the purge does, with the account), and the plan's columns are never granted.
REVOKE UPDATE, DELETE ON crove_ads.ad_launch FROM crove_tenant;
GRANT UPDATE (state, attempt, step, commit_until, stop_reason, updated_by, updated_at, started_at, finished_at) ON crove_ads.ad_launch TO crove_tenant;

DROP POLICY IF EXISTS le_scope ON crove_ads.ad_launch;
CREATE POLICY le_scope ON crove_ads.ad_launch AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_launch;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_launch FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER b_legal_entity;

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
  -- else; tenant roles have no UPDATE grant on the column.
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id') THEN
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
    IF v_move IN ('queued>cancelled', 'launching>stopped', 'needs_attention>stopped', 'live>stopped')
       AND NOT (v_actor = 'system' OR v_role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'ADS_LAUNCH_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor IS DISTINCT FROM 'system' THEN
    -- Without a move, the step and the commitment are the writer's: the system's.
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

DROP TRIGGER IF EXISTS launch_guard ON crove_ads.ad_launch;
CREATE TRIGGER launch_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_launch FOR EACH ROW EXECUTE FUNCTION crove_ads.launch_guard();
ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard;

-- The commitments the launches of the org in context hold in a window (owners, admins and the system): what a plan checks the caps against. Read across the
-- org's entities on purpose, since an org cap counts every account and an approver limited to some entities must not miss the others'. A launch that
-- commits nothing any more (released) is not listed, nor one whose window lies wholly outside.
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
  SELECT l.ad_account_id, l.currency, l.daily_budget::text, l.start_on, l.commit_until
  FROM crove_ads.ad_launch l
  WHERE l.org_id = v_org AND l.currency = p_currency AND l.commit_until IS NOT NULL AND l.commit_until >= p_from AND l.start_on <= p_to
  ORDER BY l.created_at, l.id;
END $$;
REVOKE ALL ON FUNCTION crove_ads.launch_commitments(text, date, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.launch_commitments(text, date, date) TO crove_app, crove_worker;
