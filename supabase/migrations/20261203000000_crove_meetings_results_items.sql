-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2580, ADR-0047 points 2 and 8, ADR-0049 decision 8, meetings plan M6, part A): what a recorder keeps of a meeting beyond the
-- transcript, the summary with its decisions and the action items, and how it reaches the meeting's readers. Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_result  the summary and the decisions of one meeting (at most one draft and one published row per meeting). Typed by the
--                                recorder ('manual') or copied by the recorder from the result of their own Vy ('meetings.summary', part B).
-- crove_meetings.action_item     one thing somebody said they would do: what, who as said and as matched to an attendee, when as said and as parsed by
--                                code, the second of the transcript it rests on, flags code computed, and whether a task was made from it.
-- crove_meetings.action_item_accept(org, item, task)
--                                marks an item accepted when its task was made, in the caller's own context only.
-- Both tables follow the transcript's rule: a row is born 'draft', which only the recorder reads, writes and deletes (an attendee, an owner, an admin,
-- another member, an agent and the system context read none); 'published' is the recorder's one click (meetings.result.publish), after which a reader of
-- the meeting reads it. No row is inserted published. A row goes with its meeting (ON DELETE CASCADE: the recorder's delete, the retention shred, the org
-- purge). `tainted` is true while the text is the model's, unedited; the recorder's own edit clears it. Nothing here is written by an agent context: the
-- model's output lands in member_vy_result and the recorder's own command copies it (ADR-0049 decision 8).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.meeting_result (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  summary text NOT NULL CHECK (pg_catalog.char_length(summary) BETWEEN 1 AND 8000),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(decisions) = 'array' AND pg_catalog.jsonb_array_length(decisions) <= 50),
  feature text NOT NULL CHECK (feature IN ('manual', 'meetings.summary')),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published')),
  tainted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_result_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_result_stage_uq UNIQUE (org_id, meeting_id, stage)
);

CREATE TABLE IF NOT EXISTS crove_meetings.action_item (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  title text NOT NULL CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 300),
  -- Who and when as said (free text), and as code matched them: an attendee's user id, a date against the meeting's date.
  who_drafted text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(who_drafted) <= 200),
  who_parsed uuid,
  when_drafted text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(when_drafted) <= 200),
  when_parsed date,
  transcript_seconds integer CHECK (transcript_seconds IS NULL OR transcript_seconds BETWEEN 0 AND 86400),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published')),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted')),
  -- What code found wrong with the item's text, fixed words ('contact_in_title'); a flagged item is never "clean".
  flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(flags) = 'array' AND pg_catalog.jsonb_array_length(flags) <= 10),
  tainted boolean NOT NULL DEFAULT false,
  -- The task made from it, the member who made it and when (set only by action_item_accept).
  task_id uuid,
  accepted_by uuid,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT action_item_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT action_item_accepted_ck CHECK (task_id IS NULL OR status = 'accepted')
);
CREATE INDEX IF NOT EXISTS action_item_meeting_idx ON crove_meetings.action_item (org_id, meeting_id, transcript_seconds, id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_result');
SELECT crove_kernel.apply_tenant_rls('crove_meetings.action_item');
REVOKE UPDATE ON crove_meetings.meeting_result, crove_meetings.action_item FROM crove_tenant;
GRANT UPDATE (summary, decisions, feature, stage, tainted, updated_at) ON crove_meetings.meeting_result TO crove_tenant;
-- status, task_id, accepted_by and accepted_at are written only by action_item_accept below.
GRANT UPDATE (title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, flags, tainted, stage, updated_at) ON crove_meetings.action_item TO crove_tenant;

-- The recorder reads every stage; a reader of the meeting reads published rows only.
DROP POLICY IF EXISTS meeting_result_read ON crove_meetings.meeting_result;
CREATE POLICY meeting_result_read ON crove_meetings.meeting_result AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id) OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id)));
DROP POLICY IF EXISTS action_item_read ON crove_meetings.action_item;
CREATE POLICY action_item_read ON crove_meetings.action_item AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id) OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id)));

-- Only the recorder inserts, and only drafts (a row is born a draft, never published).
DROP POLICY IF EXISTS meeting_result_insert ON crove_meetings.meeting_result;
CREATE POLICY meeting_result_insert ON crove_meetings.meeting_result AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS action_item_insert ON crove_meetings.action_item;
CREATE POLICY action_item_insert ON crove_meetings.action_item AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (stage = 'draft' AND status = 'suggested' AND task_id IS NULL AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The recorder edits a draft and publishes it (draft to published, the one change of stage); a published row is not edited here.
DROP POLICY IF EXISTS meeting_result_update ON crove_meetings.meeting_result;
CREATE POLICY meeting_result_update ON crove_meetings.meeting_result AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (stage IN ('draft', 'published') AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS action_item_update ON crove_meetings.action_item;
CREATE POLICY action_item_update ON crove_meetings.action_item AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (stage = 'draft' AND status = 'suggested' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (stage IN ('draft', 'published') AND status = 'suggested' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The recorder deletes a draft of either kind, and replaces the published summary when they publish another (a published item is never deleted by hand: a
-- task may rest on it).
DROP POLICY IF EXISTS meeting_result_delete ON crove_meetings.meeting_result;
CREATE POLICY meeting_result_delete ON crove_meetings.meeting_result AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS action_item_delete ON crove_meetings.action_item;
CREATE POLICY action_item_delete ON crove_meetings.action_item AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (stage = 'draft' AND status = 'suggested' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- An item is accepted when its task was made: by the recorder from a draft, or by any reader once it is published. The caller's own context only (a user),
-- the item still suggested (a second accept is refused, never a second task); the task is the one the accepting command just made.
CREATE OR REPLACE FUNCTION crove_meetings.action_item_accept(p_org_id uuid, p_item_id uuid, p_task_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_meeting uuid;
  v_stage text;
  v_status text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_ITEM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT i.meeting_id, i.stage, i.status INTO v_meeting, v_stage, v_status
  FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETINGS_ITEM_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  IF NOT ((v_stage = 'draft' AND crove_meetings.is_meeting_recorder(v_org, v_meeting))
          OR (v_stage = 'published' AND crove_meetings.is_meeting_reader(v_org, v_meeting))) THEN
    RAISE EXCEPTION 'MEETINGS_ITEM_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'suggested' THEN
    RAISE EXCEPTION 'MEETINGS_ITEM_ACCEPTED' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_meetings.action_item
  SET status = 'accepted', task_id = p_task_id, accepted_by = v_user, accepted_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_item_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.action_item_accept(uuid, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.action_item_accept(uuid, uuid, uuid) TO crove_app;
