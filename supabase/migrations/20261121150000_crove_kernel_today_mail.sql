-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: the daily "Hôm nay cần bạn" brief by email, opt-in per member (issue #2406). Idempotent; applied files stay untouched.
--
-- crove_kernel.today_mail  a member who opted in to the daily brief by email in this org: no row means off, so it is off by default and
--                          turning it off deletes the row. The row also holds the day of the last mail, so a member gets at most one
--                          a day. A member sees, inserts and deletes only their own row. last_sent_day is the Asia/Ho_Chi_Minh
--                          calendar day of the last mail; only the system context writes it (the worker's send command claims the
--                          day with an UPDATE before it queues the mail), by the column grant and by a restrictive UPDATE policy that
--                          admits the system alone, and a member cannot insert a row with it set. A member's row goes with the
--                          membership (the foreign key cascades).
--
-- crove_kernel.today_mail_due  the orgs that have a member to mail today, in org_id order after the given one, so the worker's sweep
--                              pages through all of them: ids only, nothing of a member. Due: an active org with an opted-in member whose
--                              last mail was before today (Vietnam time) and whose local time is past 07:30. The command checks the day
--                              again in its own transaction before it claims it.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.today_mail (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The Asia/Ho_Chi_Minh calendar day of the last mail; NULL until the first one.
  last_sent_day date,
  PRIMARY KEY (org_id, id),
  CONSTRAINT today_mail_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);
-- One row per member; it also backs the member foreign key (G3).
CREATE UNIQUE INDEX IF NOT EXISTS today_mail_member_uq ON crove_kernel.today_mail (org_id, user_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.today_mail');
-- The owner of a row never changes in place, and only last_sent_day is ever updated.
REVOKE UPDATE ON crove_kernel.today_mail FROM crove_tenant;
GRANT UPDATE (last_sent_day) ON crove_kernel.today_mail TO crove_tenant;

-- Restrictive, so they narrow the tenant policy and never widen it. A member reads, inserts and deletes their own row; the worker's system
-- context reads and deletes them all (the sweep, the purge); an agent context reads none. Updates are the system's alone, and a row a member
-- inserts has no last_sent_day.
DROP POLICY IF EXISTS today_mail_own ON crove_kernel.today_mail;
CREATE POLICY today_mail_own ON crove_kernel.today_mail AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));
DROP POLICY IF EXISTS today_mail_update ON crove_kernel.today_mail;
CREATE POLICY today_mail_update ON crove_kernel.today_mail AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system')
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system');
DROP POLICY IF EXISTS today_mail_insert ON crove_kernel.today_mail;
CREATE POLICY today_mail_insert ON crove_kernel.today_mail AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (last_sent_day IS NULL OR (SELECT crove_kernel.ctx_actor_type()) = 'system');

-- The orgs whose members are due a brief, paged. Worker only: EXECUTE for crove_worker alone, plus the session_user check the other worker-only
-- definers carry, so a definer running as a more privileged owner cannot be used to reach it from the API.
CREATE OR REPLACE FUNCTION crove_kernel.today_mail_due(p_after_org uuid, p_limit integer)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_local timestamp := pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now());
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'TODAY_MAIL_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- Before 07:30 in Vietnam nobody is due.
  IF v_local::time < time '07:30' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT t.org_id
  FROM crove_kernel.tenant t
  WHERE t.status = 'active'
    AND t.org_id > pg_catalog.coalesce(p_after_org, '00000000-0000-0000-0000-000000000000'::uuid)
    AND EXISTS (
      SELECT 1 FROM crove_kernel.today_mail m
      WHERE m.org_id = t.org_id AND (m.last_sent_day IS NULL OR m.last_sent_day < v_local::date)
    )
  ORDER BY t.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.today_mail_due(uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.today_mail_due(uuid, integer) TO crove_worker;
