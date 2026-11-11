-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #2587, plan docs/plan/meetings.md section 15 step L1, ADR-0024, ADR-0047): a meeting links to a party, to a deal and to the calendar
-- event it came from. Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_link  one link of a meeting to exactly one target: a party, a deal or a calendar event. A meeting has at most one deal.
--   - The meetings module owns the write path (meetings.link.add and meetings.link.remove); the recorder sets and removes links.
--   - A link is read only by the readers of its meeting, through the same helper the meeting's other child tables use, so a deal page, a viewer and an agent
--     see no row (and so no title) of an attendees-only meeting they do not read.
--   - deal_id has no foreign key: a module names only its own schema and the kernel's (plan 5.4, ADR-0031), so the deal is checked through the CRM module's
--     query when a link is added, and a deployment without the CRM module cannot link a deal. party_id and calendar_event_id are the kernel's and have keys.
--   - Deleting the meeting, the party or the calendar event deletes its links; the org purge removes them with the meetings.
-- crove_kernel.meeting_link_export_rows() is what the org export carries of links: those of the meetings shared with the whole org.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.meeting_link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  party_id uuid,
  deal_id uuid,
  calendar_event_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_link_one_target CHECK (((party_id IS NOT NULL)::integer + (deal_id IS NOT NULL)::integer + (calendar_event_id IS NOT NULL)::integer) = 1),
  CONSTRAINT meeting_link_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_link_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_link_calendar_event_fk FOREIGN KEY (org_id, calendar_event_id) REFERENCES crove_kernel.calendar_event (org_id, id) ON DELETE CASCADE
);
-- One link per meeting and target, and at most one deal per meeting.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_link_party_uq ON crove_meetings.meeting_link (org_id, meeting_id, party_id) WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meeting_link_deal_uq ON crove_meetings.meeting_link (org_id, meeting_id) WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meeting_link_event_uq ON crove_meetings.meeting_link (org_id, meeting_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL;
-- The pages that list a target's meetings.
CREATE INDEX IF NOT EXISTS meeting_link_meeting_idx ON crove_meetings.meeting_link (org_id, meeting_id);
CREATE INDEX IF NOT EXISTS meeting_link_party_idx ON crove_meetings.meeting_link (org_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_link_deal_idx ON crove_meetings.meeting_link (org_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_link_event_idx ON crove_meetings.meeting_link (org_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_link');
REVOKE UPDATE ON crove_meetings.meeting_link FROM crove_tenant;

-- Readers of the meeting read its links; its recorder sets and removes them.
DROP POLICY IF EXISTS meeting_link_read ON crove_meetings.meeting_link;
CREATE POLICY meeting_link_read ON crove_meetings.meeting_link AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_reader(org_id, meeting_id));

DROP POLICY IF EXISTS meeting_link_insert ON crove_meetings.meeting_link;
CREATE POLICY meeting_link_insert ON crove_meetings.meeting_link AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND created_by = (SELECT crove_kernel.ctx_user_id())
  );

DROP POLICY IF EXISTS meeting_link_delete ON crove_meetings.meeting_link;
CREATE POLICY meeting_link_delete ON crove_meetings.meeting_link AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- What the org export carries of links: those of the meetings shared with the whole org (as meeting_export_rows). System context of the worker only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.meeting_link_export_rows()
RETURNS SETOF crove_meetings.meeting_link LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.* FROM crove_meetings.meeting_link l
    JOIN crove_meetings.meeting m ON m.org_id = l.org_id AND m.id = l.meeting_id
    WHERE l.org_id = v_org AND m.visibility = 'org'
    ORDER BY l.created_at, l.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_link_export_rows() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_link_export_rows() TO crove_tenant;
