-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2381, plan docs/plan/crm.md §4.2 and the AI-first map 5.3): an open deal nobody touched for N days, or one past its
-- expected close, raises a next step for the member in charge. The rule is deterministic: no model, no text, no network. Idempotent; applied
-- files stay untouched.
--
-- crove_crm.deal_setting    the org's one row of deal settings: after how many days without a change an open deal is stale (7 to 60; with
--                           no row the product's 14 applies). Every member reads it; only an owner or admin (or the system) writes it.
-- crove_crm.deal_next_step  one next step for one deal: a reason code (no_activity or past_close), the day it is about, who it is for and
--                           how it ended. It holds no text of its own (the deal's title stays in the deal), so it carries no personal
--                           data. Read through the deal's own rule. At most one is open per deal. Only the system context inserts one (the
--                           daily rule, apps/kernel/src/crm-worker.ts); a member with a write role marks it done or snoozes it, and a guard
--                           trigger holds each actor to its transitions. A resolved step is final. It is deleted only with its deal (the
--                           foreign key) or by the org purge.
-- crove_crm.deal_stale_orgs(after, limit)  the orgs with an open deal that could be stale, org id order after `after`, at most `limit`
--                           (1 to 1000). It answers org ids only, never a row. Callable by the worker login alone, and not from inside an
--                           org's context. The rule itself runs per org in its system context, where the tenant policy shows that org alone.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The org's setting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.deal_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  stale_days smallint NOT NULL DEFAULT 14 CHECK (stale_days BETWEEN 7 AND 60),
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT deal_setting_org_uq UNIQUE (org_id),
  CONSTRAINT deal_setting_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS deal_setting_set_by_idx ON crove_crm.deal_setting (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.deal_setting');
REVOKE UPDATE ON crove_crm.deal_setting FROM crove_tenant;
GRANT UPDATE (stale_days, set_by, updated_at) ON crove_crm.deal_setting TO crove_tenant;
DROP POLICY IF EXISTS deal_setting_insert ON crove_crm.deal_setting;
CREATE POLICY deal_setting_insert ON crove_crm.deal_setting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS deal_setting_update ON crove_crm.deal_setting;
CREATE POLICY deal_setting_update ON crove_crm.deal_setting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS deal_setting_delete ON crove_crm.deal_setting;
CREATE POLICY deal_setting_delete ON crove_crm.deal_setting AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- ---------------------------------------------------------------------------
-- The next steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.deal_next_step (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  deal_id uuid NOT NULL,
  -- The sets are the product's (DEAL_NEXT_STEP_REASONS and the like in packages/db/src/schema.ts, compared with these constraints by check-unions.db.test.ts).
  reason text NOT NULL CHECK (reason IN ('no_activity', 'past_close')),
  -- The deal's owner when the step was raised; none for an unowned deal (the org's owners and admins read it as theirs) and once that member
  -- is removed (the foreign key's action).
  assignee_user_id uuid,
  -- The day the step is about: the day the deal was last changed (no_activity) or its expected close (past_close), in Vietnam's calendar.
  since_on date NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'closed')),
  -- While open: hidden from the lists until this time, then shown again.
  snoozed_until timestamptz,
  resolved_at timestamptz,
  -- The member who marked it done; none for a step the deal's own change closed, and once that member is removed.
  resolved_by uuid,
  -- Why a step closed by itself: the deal was edited, moved to another stage, or closed (won or lost).
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('deal_edited', 'deal_moved', 'deal_closed')),
  PRIMARY KEY (org_id, id),
  CONSTRAINT deal_next_step_deal_fk FOREIGN KEY (org_id, deal_id) REFERENCES crove_crm.deal (org_id, id) ON DELETE CASCADE,
  CONSTRAINT deal_next_step_assignee_fk FOREIGN KEY (org_id, assignee_user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (assignee_user_id),
  CONSTRAINT deal_next_step_resolver_fk FOREIGN KEY (org_id, resolved_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (resolved_by),
  CONSTRAINT deal_next_step_state CHECK (
    (status = 'open') = (resolved_at IS NULL)
    AND (status = 'closed') = (closed_reason IS NOT NULL)
    AND (status = 'done' OR resolved_by IS NULL)
    AND (status = 'open' OR snoozed_until IS NULL))
);
-- One next step open per deal: the rule's insert does nothing when one is.
CREATE UNIQUE INDEX IF NOT EXISTS deal_next_step_open_uq ON crove_crm.deal_next_step (org_id, deal_id) WHERE status = 'open';
-- Backs the deal's foreign key, and the rule's look at how long ago a deal's last step was resolved.
CREATE INDEX IF NOT EXISTS deal_next_step_deal_idx ON crove_crm.deal_next_step (org_id, deal_id, resolved_at);
-- Backs the assignee's foreign key, and the "mine" list.
CREATE INDEX IF NOT EXISTS deal_next_step_assignee_idx ON crove_crm.deal_next_step (org_id, assignee_user_id, status, raised_at);
CREATE INDEX IF NOT EXISTS deal_next_step_resolver_idx ON crove_crm.deal_next_step (org_id, resolved_by) WHERE resolved_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.deal_next_step');
REVOKE UPDATE ON crove_crm.deal_next_step FROM crove_tenant;
GRANT UPDATE (status, snoozed_until, resolved_at, resolved_by, closed_reason) ON crove_crm.deal_next_step TO crove_tenant;
-- Read by those who read the deal (a member sees the steps of the deals they see).
DROP POLICY IF EXISTS deal_next_step_scope ON crove_crm.deal_next_step;
CREATE POLICY deal_next_step_scope ON crove_crm.deal_next_step AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_crm.deal d WHERE d.org_id = deal_next_step.org_id AND d.id = deal_next_step.deal_id));
-- Raised by the system alone; a member never inserts one.
DROP POLICY IF EXISTS deal_next_step_insert ON crove_crm.deal_next_step;
CREATE POLICY deal_next_step_insert ON crove_crm.deal_next_step AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system');
-- Marked done or snoozed by a member with a write role (never a viewer), or closed by the system.
DROP POLICY IF EXISTS deal_next_step_update ON crove_crm.deal_next_step;
CREATE POLICY deal_next_step_update ON crove_crm.deal_next_step AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_next_step.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_next_step.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
-- No context deletes a step: it goes with its deal (the foreign key) or with the org (the purge).
DROP POLICY IF EXISTS deal_next_step_delete ON crove_crm.deal_next_step;
CREATE POLICY deal_next_step_delete ON crove_crm.deal_next_step AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (false);

-- What each actor may do to a step. A step is raised open and unsnoozed. A person marks it done in their own name or snoozes it (it stays open, with a
-- time); either the person's command or the system closes it with a reason (the deal changed, moved or closed). Nothing else changes, and a resolved
-- step is final. The foreign keys' own SET NULL of the assignee and of the member who marked it done pass whatever the state. A database owner's own
-- statement has no context and is not held to it.
CREATE OR REPLACE FUNCTION crove_crm.deal_next_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_same crove_crm.deal_next_step;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row for another org is the tenant policy's to refuse (its own message), not this guard's.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'open' OR NEW.snoozed_until IS NOT NULL THEN
      RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a next step is raised open and unsnoozed';
    END IF;
    RETURN NEW;
  END IF;
  v_same := NEW;
  IF OLD.assignee_user_id IS NOT NULL AND NEW.assignee_user_id IS NULL THEN
    v_same.assignee_user_id := OLD.assignee_user_id;
  END IF;
  IF OLD.resolved_by IS NOT NULL AND NEW.resolved_by IS NULL THEN
    v_same.resolved_by := OLD.resolved_by;
  END IF;
  -- The foreign key's own action runs nested inside the referential trigger (depth 2 or more); a login's own statement is at depth 1 and never
  -- gets this exemption (a member could otherwise wipe who marked a step done).
  IF pg_catalog.pg_trigger_depth() > 1 AND v_same IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- A statement that changes nothing changes nothing, whoever runs it and whatever the step's state.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- The foreign key's own change was settled above (it alone changes nothing else), so here the assignee is as immutable as the rest.
  IF (NEW.org_id, NEW.id, NEW.deal_id, NEW.reason, NEW.since_on, NEW.raised_at, NEW.assignee_user_id)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.deal_id, OLD.reason, OLD.since_on, OLD.raised_at, OLD.assignee_user_id) THEN
    RAISE EXCEPTION 'NEXT_STEP_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a next step keeps its deal, its reason, its day and its assignee';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'NEXT_STEP_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a resolved next step never changes';
  END IF;
  IF v_actor IS NOT DISTINCT FROM 'user' THEN
    IF NEW.status = 'done' THEN
      IF NEW.resolved_by IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
        RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member marks a next step done in their own name';
      END IF;
    ELSIF NEW.status = 'open' THEN
      -- A snooze: only the time changes, and it is a time between now and the longest snooze (14 days) with a day of slack for the application's
      -- clock against the database's: never the past (an unsnooze) and never the far future (a step buried).
      IF NEW.snoozed_until IS NULL OR NEW.resolved_by IS NOT NULL OR NEW.closed_reason IS NOT NULL
         OR NEW.snoozed_until <= pg_catalog.now() OR NEW.snoozed_until > pg_catalog.now() + pg_catalog.make_interval(days => 15) THEN
        RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member snoozes a next step to a time within the next 14 days';
      END IF;
    END IF;
  ELSIF v_actor IS NOT DISTINCT FROM 'system' THEN
    IF NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'the system only closes a next step';
    END IF;
  ELSIF v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'no actor but a member or the system writes a next step';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_crm.deal_next_step_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS deal_next_step_guard ON crove_crm.deal_next_step;
CREATE TRIGGER deal_next_step_guard BEFORE INSERT OR UPDATE ON crove_crm.deal_next_step
  FOR EACH ROW EXECUTE FUNCTION crove_crm.deal_next_step_guard();

-- ---------------------------------------------------------------------------
-- The orgs the daily rule looks at (worker login only)
-- ---------------------------------------------------------------------------
-- An org of the active status with an open deal not changed for 7 days (the least N can be) or past its expected close (the day in Vietnam's
-- calendar) that has no open step and no step resolved in the last 7 days. A superset: the command applies the org's own N and everything else.
-- Keyset order, so the worker walks every org in batches.
CREATE OR REPLACE FUNCTION crove_crm.deal_stale_orgs(p_after uuid, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT d.org_id
  FROM crove_crm.deal d
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
  WHERE d.closed_at IS NULL
    AND (p_after IS NULL OR d.org_id > p_after)
    AND (d.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => 7)
         OR d.expected_close < (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
    -- Not a deal the command would pass over: one with an open step, or one whose step was resolved within the least N can be (7 days), so an org
    -- whose stale deals all have steps drops out of the list and the nightly pass does not walk it (or write its audit row) again.
    AND NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n
                    WHERE n.org_id = d.org_id AND n.deal_id = d.id
                      AND (n.status = 'open' OR n.resolved_at > pg_catalog.now() - pg_catalog.make_interval(days => 7)))
  ORDER BY 1
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_crm.deal_stale_orgs(uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.deal_stale_orgs(uuid, integer) TO crove_worker;

-- The worker's queue (apps/kernel/src/crm-worker.ts): the daily rule, scheduled when the crm module is installed.
SELECT crove_jobs.create_queue('crm-deal-stale', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
