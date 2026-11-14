-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings A6 (issue #3164, plan docs/plan/meetings-integrations.md section 4.5): a member's own webhook for the minutes they publish. Idempotent; applied files stay untouched.
--
-- Whose it is: a MEMBER's, not the org's. A meeting is readable only by its recorder and attendees, so an address an owner set would send an attendees-only meeting where its readers did not
-- choose. The member sets one https address, ticks the fields, and every time they publish a result (meetings.result.publish) one signed POST is sent there, at least once, through the
-- egress guard. It works only while the owner's org switch (crove_kernel.tenant.meeting_hooks, off by default) is on, it stops when the member leaves, and an unpublished result sends nothing.
--
-- crove_meetings.member_hook      one row per member: the address, the sealed secret (shown once), the fields to send. Definer-only, zero grants to login roles (MACHINERY).
-- crove_meetings.hook_delivery    one event to send. The body is built in the recorder's own transaction at publish (the system context cannot read meetings), kept only while the delivery is
--                                 queued and set to NULL the moment it settles: afterwards the row is ids, a status and times. Definer-only.
-- crove_meetings.hook_body_ok     the database's twin of packages/kernel-contract/src/meeting-hook-body.ts: the keys, the shapes and the limits of a body, a CHECK on the delivery table.
--                                 No transcript, audio, video or attendee contact detail has a key to ride in.
-- A queued delivery is dropped (status 'dropped', body wiped) in the same transaction when its hook is switched off, the org switch is turned off, or the text of its meeting changes (a
-- personal-data erasure redacts a summary, an action item or a title), and goes with its hook (member leaves, hook cleared) and with its meeting (ON DELETE CASCADE).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The owner's switch: crove_kernel.tenant.meeting_hooks (off by default), changed only by an owner in the org's own context.
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_hooks boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION crove_kernel.tenant_meeting_hooks_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_hooks IS NOT DISTINCT FROM OLD.meeting_hooks THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_user := crove_kernel.ctx_user_id();
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'MEETING_HOOKS_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.hooks.switch.set, run by an owner of the org in its own context, changes the org switch for members'' minutes webhooks';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_hooks_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_meeting_hooks_guard BEFORE UPDATE OF meeting_hooks ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_meeting_hooks_guard();
REVOKE ALL ON FUNCTION crove_kernel.tenant_meeting_hooks_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The body check: the same shapes and limits as meetingHookEvent (packages/kernel-contract/src/meeting-hook-body.ts).
-- ---------------------------------------------------------------------------
-- A body is queued (and then must be a well-formed event) or settled (and then must be NULL). Top-level keys are exactly id, type, created_at, org, data; id, org and type equal the row's.
-- 'ping' carries `data` = {} and no meeting. 'meeting.result_published' carries meeting_id (the row's), published_at, started_at, length_seconds (a whole number of seconds or null) and,
-- only if ticked, title, summary, decisions and action_items; an unknown key anywhere is refused.
CREATE OR REPLACE FUNCTION crove_meetings.hook_body_ok(p_body jsonb, p_id uuid, p_org uuid, p_type text, p_meeting uuid, p_status text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_instant constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$';
  c_date constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  v_key text;
  v_data jsonb;
  v_item jsonb;
  v_elem jsonb;
BEGIN
  IF p_status IS DISTINCT FROM 'queued' THEN
    RETURN p_body IS NULL;
  END IF;
  IF p_body IS NULL OR pg_catalog.jsonb_typeof(p_body) <> 'object' THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_body) LOOP
    IF v_key NOT IN ('id', 'type', 'created_at', 'org', 'data') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF NOT (p_body ?& ARRAY['id', 'type', 'created_at', 'org', 'data']) THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_body -> 'id') <> 'string' OR p_body ->> 'id' <> p_id::text
     OR pg_catalog.jsonb_typeof(p_body -> 'org') <> 'string' OR p_body ->> 'org' <> p_org::text
     OR pg_catalog.jsonb_typeof(p_body -> 'type') <> 'string' OR p_body ->> 'type' <> p_type
     OR pg_catalog.jsonb_typeof(p_body -> 'created_at') <> 'string' OR p_body ->> 'created_at' !~ c_instant
     OR pg_catalog.jsonb_typeof(p_body -> 'data') <> 'object' THEN
    RETURN false;
  END IF;
  v_data := p_body -> 'data';
  IF p_type = 'ping' THEN
    RETURN p_meeting IS NULL AND v_data = '{}'::jsonb;
  END IF;
  IF p_type <> 'meeting.result_published' OR p_meeting IS NULL THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_data) LOOP
    IF v_key NOT IN ('meeting_id', 'published_at', 'started_at', 'length_seconds', 'title', 'summary', 'decisions', 'action_items') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF NOT (v_data ?& ARRAY['meeting_id', 'published_at', 'started_at', 'length_seconds']) THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(v_data -> 'meeting_id') <> 'string' OR v_data ->> 'meeting_id' <> p_meeting::text
     OR pg_catalog.jsonb_typeof(v_data -> 'published_at') <> 'string' OR v_data ->> 'published_at' !~ c_instant
     OR pg_catalog.jsonb_typeof(v_data -> 'started_at') <> 'string' OR v_data ->> 'started_at' !~ c_instant THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(v_data -> 'length_seconds') = 'number' THEN
    IF (v_data ->> 'length_seconds')::numeric <> pg_catalog.trunc((v_data ->> 'length_seconds')::numeric) OR (v_data ->> 'length_seconds')::numeric NOT BETWEEN 0 AND 86400 THEN
      RETURN false;
    END IF;
  ELSIF pg_catalog.jsonb_typeof(v_data -> 'length_seconds') <> 'null' THEN
    RETURN false;
  END IF;
  IF v_data ? 'title' AND (pg_catalog.jsonb_typeof(v_data -> 'title') <> 'string' OR pg_catalog.char_length(v_data ->> 'title') NOT BETWEEN 1 AND 300) THEN
    RETURN false;
  END IF;
  IF v_data ? 'summary' AND (pg_catalog.jsonb_typeof(v_data -> 'summary') <> 'string' OR pg_catalog.char_length(v_data ->> 'summary') NOT BETWEEN 1 AND 8000) THEN
    RETURN false;
  END IF;
  IF v_data ? 'decisions' THEN
    IF pg_catalog.jsonb_typeof(v_data -> 'decisions') <> 'array' OR pg_catalog.jsonb_array_length(v_data -> 'decisions') > 50 THEN
      RETURN false;
    END IF;
    FOR v_elem IN SELECT e FROM pg_catalog.jsonb_array_elements(v_data -> 'decisions') AS e LOOP
      IF pg_catalog.jsonb_typeof(v_elem) <> 'string' OR pg_catalog.char_length(v_elem #>> '{}') NOT BETWEEN 1 AND 1000 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF v_data ? 'action_items' THEN
    IF pg_catalog.jsonb_typeof(v_data -> 'action_items') <> 'array' OR pg_catalog.jsonb_array_length(v_data -> 'action_items') > 100 THEN
      RETURN false;
    END IF;
    FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(v_data -> 'action_items') AS e LOOP
      IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
        RETURN false;
      END IF;
      FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
        IF v_key NOT IN ('text', 'owner', 'due') THEN
          RETURN false;
        END IF;
      END LOOP;
      IF NOT (v_item ?& ARRAY['text', 'owner', 'due'])
         OR pg_catalog.jsonb_typeof(v_item -> 'text') <> 'string' OR pg_catalog.char_length(v_item ->> 'text') NOT BETWEEN 1 AND 300
         OR NOT (pg_catalog.jsonb_typeof(v_item -> 'owner') = 'null' OR (pg_catalog.jsonb_typeof(v_item -> 'owner') = 'string' AND pg_catalog.char_length(v_item ->> 'owner') <= 200))
         OR NOT (pg_catalog.jsonb_typeof(v_item -> 'due') = 'null' OR (pg_catalog.jsonb_typeof(v_item -> 'due') = 'string' AND v_item ->> 'due' ~ c_date)) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- member_hook and hook_delivery
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.member_hook (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  url text NOT NULL CHECK (pg_catalog.char_length(url) BETWEEN 12 AND 2048 AND url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$' AND url !~ '^https://[0-9.]+(:|/|$)'),
  -- What the member ticked beyond the always-sent part: a subset of these four, nothing else.
  fields text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (fields <@ ARRAY['title', 'summary', 'decisions', 'action_items']::text[]),
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason = 'failing'),
  -- The secret as the credential broker sealed it ({keyId, envelope}), and the one it replaced while a rotation overlaps.
  secret_sealed jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(secret_sealed) = 'object' AND pg_catalog.pg_column_size(secret_sealed) <= 4096),
  previous_sealed jsonb CHECK (previous_sealed IS NULL OR (pg_catalog.jsonb_typeof(previous_sealed) = 'object' AND pg_catalog.pg_column_size(previous_sealed) <= 4096)),
  previous_until timestamptz,
  -- The public id the receiver can see beside the secret ("whk_" and eight hex digits): enough to tell which secret signed, never enough to sign.
  secret_hint text NOT NULL CHECK (secret_hint ~ '^whk_[0-9a-f]{8}$'),
  failing_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_delivery_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- At most one address per member; it goes when the member leaves the org.
  CONSTRAINT member_hook_user_uq UNIQUE (org_id, user_id),
  CONSTRAINT member_hook_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CHECK ((previous_sealed IS NULL) = (previous_until IS NULL))
);
ALTER TABLE crove_meetings.member_hook ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_meetings.hook_delivery (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  -- The event id the receiver sees; it never changes across retries. For a published result it is the result's id.
  id uuid NOT NULL,
  hook_id uuid NOT NULL,
  -- NULL for a test ping.
  meeting_id uuid,
  type text NOT NULL CHECK (type IN ('meeting.result_published', 'ping')),
  -- The event while queued, NULL once settled (hook_body_ok).
  body jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'dropped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The HTTP status of the last attempt, when the receiver answered.
  last_code smallint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- NULL until the sweep first hands the delivery to the queue; a delivery never taken up is handed over again after three minutes.
  handed_at timestamptz,
  sent_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT hook_delivery_hook_fk FOREIGN KEY (org_id, hook_id) REFERENCES crove_meetings.member_hook (org_id, id) ON DELETE CASCADE,
  CONSTRAINT hook_delivery_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CHECK ((type = 'ping') = (meeting_id IS NULL)),
  CHECK (crove_meetings.hook_body_ok(body, id, org_id, type, meeting_id, status))
);
CREATE INDEX IF NOT EXISTS hook_delivery_open_idx ON crove_meetings.hook_delivery (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS hook_delivery_hook_idx ON crove_meetings.hook_delivery (org_id, hook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hook_delivery_meeting_idx ON crove_meetings.hook_delivery (org_id, meeting_id) WHERE meeting_id IS NOT NULL;
ALTER TABLE crove_meetings.hook_delivery ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_meetings.member_hook, crove_meetings.hook_delivery FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_meetings.member_hook, crove_meetings.hook_delivery FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard on tenant tables; an agent context never sets up or sends a webhook.
SELECT crove_kernel.agent_write_guard_install('crove_meetings.member_hook');
SELECT crove_kernel.agent_write_guard_install('crove_meetings.hook_delivery');

-- ---------------------------------------------------------------------------
-- Standing: the webhook sends only while it is enabled, the org is active with the owner's switch on, and the member is still in the org and not disabled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.hook_standing(p_org uuid, p_hook uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_meetings.member_hook h
    JOIN crove_kernel.tenant t ON t.org_id = h.org_id AND t.status = 'active' AND t.meeting_hooks
    JOIN crove_kernel.tenant_member m ON m.org_id = h.org_id AND m.user_id = h.user_id
    JOIN crove_kernel.user_account u ON u.id = h.user_id AND u.disabled_at IS NULL
    WHERE h.org_id = p_org AND h.id = p_hook AND h.enabled)
$$;

-- The caller: a member of an active org in a user context. Raises NO_CONTEXT (42501) or MEETING_HOOK_FORBIDDEN (42501).
CREATE OR REPLACE FUNCTION crove_meetings.hook_caller()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'MEETING_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END $$;

-- Drops the queued deliveries of a hook, a meeting or the whole org (NULL for each): status 'dropped', body wiped. Only the triggers and the owner's switch below call it.
CREATE OR REPLACE FUNCTION crove_meetings.hook_drop_queued(p_org uuid, p_hook uuid, p_meeting uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE crove_meetings.hook_delivery d SET status = 'dropped', body = NULL
  WHERE d.org_id = p_org AND d.status = 'queued' AND (p_hook IS NULL OR d.hook_id = p_hook) AND (p_meeting IS NULL OR d.meeting_id = p_meeting);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Triggers that drop queued deliveries in the same transaction as the change: a hook switched off; the text of a meeting changing (a personal-data erasure redacts a result's summary or
-- decisions, an action item's title, owner or due text, or the meeting's title).
CREATE OR REPLACE FUNCTION crove_meetings.hook_drop_on_disable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_meetings.hook_drop_queued(NEW.org_id, NEW.id, NULL);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_hook_drop_on_disable ON crove_meetings.member_hook;
CREATE TRIGGER member_hook_drop_on_disable AFTER UPDATE OF enabled ON crove_meetings.member_hook
  FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled) EXECUTE FUNCTION crove_meetings.hook_drop_on_disable();

CREATE OR REPLACE FUNCTION crove_meetings.hook_drop_on_text_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The meeting's own key is id; its results and action items name it in meeting_id (two branches: a record field is resolved when its statement runs).
  IF TG_TABLE_NAME = 'meeting' THEN
    PERFORM crove_meetings.hook_drop_queued(NEW.org_id, NULL, NEW.id);
  ELSE
    PERFORM crove_meetings.hook_drop_queued(NEW.org_id, NULL, NEW.meeting_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_result_hook_drop ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_hook_drop AFTER UPDATE OF summary, decisions ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.summary IS DISTINCT FROM NEW.summary OR OLD.decisions IS DISTINCT FROM NEW.decisions) EXECUTE FUNCTION crove_meetings.hook_drop_on_text_change();
DROP TRIGGER IF EXISTS action_item_hook_drop ON crove_meetings.action_item;
CREATE TRIGGER action_item_hook_drop AFTER UPDATE OF title, who_drafted, when_drafted ON crove_meetings.action_item
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.who_drafted IS DISTINCT FROM NEW.who_drafted OR OLD.when_drafted IS DISTINCT FROM NEW.when_drafted)
  EXECUTE FUNCTION crove_meetings.hook_drop_on_text_change();
DROP TRIGGER IF EXISTS meeting_hook_drop ON crove_meetings.meeting;
CREATE TRIGGER meeting_hook_drop AFTER UPDATE OF title ON crove_meetings.meeting
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION crove_meetings.hook_drop_on_text_change();

-- The owner's switch turned off: every queued delivery of the org is dropped in the same transaction (meetings.hooks.switch.set calls this after the change). Owner only, in a user context.
CREATE OR REPLACE FUNCTION crove_meetings.hooks_drop_all()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETING_HOOKS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN crove_meetings.hook_drop_queued(v_org, NULL, NULL);
END $$;

-- ---------------------------------------------------------------------------
-- The member's own setup (a user context; every member sets only their own)
-- ---------------------------------------------------------------------------
-- Sets or changes the member's address and fields. A new hook keeps the sealed secret it is given; an existing one keeps its own (a rotation is its own call). Returns whether the row is new.
-- Raises MEETING_HOOKS_OFF (22023) while the owner's switch is off, MEETING_HOOK_INVALID (22023) for an address, fields or secret that do not fit.
CREATE OR REPLACE FUNCTION crove_meetings.hook_put(p_url text, p_sealed jsonb, p_hint text, p_fields text[], p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_new boolean;
BEGIN
  v_user := crove_meetings.hook_caller();
  IF NOT (SELECT t.meeting_hooks FROM crove_kernel.tenant t WHERE t.org_id = v_org) THEN
    RAISE EXCEPTION 'MEETING_HOOKS_OFF' USING ERRCODE = '22023';
  END IF;
  IF p_url IS NULL OR p_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$' OR p_url ~ '^https://[0-9.]+(:|/|$)'
     OR pg_catalog.char_length(p_url) NOT BETWEEN 12 AND 2048
     OR p_sealed IS NULL OR pg_catalog.jsonb_typeof(p_sealed) <> 'object'
     OR p_hint IS NULL OR p_hint !~ '^whk_[0-9a-f]{8}$'
     OR p_fields IS NULL OR NOT (p_fields <@ ARRAY['title', 'summary', 'decisions', 'action_items']::text[])
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'MEETING_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_meetings.member_hook AS h (org_id, user_id, url, fields, enabled, secret_sealed, secret_hint)
  VALUES (v_org, v_user, p_url, p_fields, p_enabled, p_sealed, p_hint)
  ON CONFLICT ON CONSTRAINT member_hook_user_uq DO UPDATE SET
    url = EXCLUDED.url,
    fields = EXCLUDED.fields,
    enabled = EXCLUDED.enabled,
    paused_reason = CASE WHEN EXCLUDED.enabled THEN NULL ELSE h.paused_reason END,
    failing_since = CASE WHEN EXCLUDED.enabled AND NOT h.enabled THEN NULL ELSE h.failing_since END,
    consecutive_failures = CASE WHEN EXCLUDED.enabled AND NOT h.enabled THEN 0 ELSE h.consecutive_failures END,
    updated_at = pg_catalog.clock_timestamp()
  RETURNING (xmax = 0) INTO v_new;
  RETURN v_new;
END $$;

-- Replaces the secret; the old one still verifies for 24 hours so a receiver can switch over.
CREATE OR REPLACE FUNCTION crove_meetings.hook_rotate(p_sealed jsonb, p_hint text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_count integer;
BEGIN
  v_user := crove_meetings.hook_caller();
  IF p_sealed IS NULL OR pg_catalog.jsonb_typeof(p_sealed) <> 'object' OR p_hint IS NULL OR p_hint !~ '^whk_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'MEETING_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_meetings.member_hook h SET
    previous_sealed = h.secret_sealed, previous_until = pg_catalog.clock_timestamp() + interval '24 hours',
    secret_sealed = p_sealed, secret_hint = p_hint, updated_at = pg_catalog.clock_timestamp()
  WHERE h.org_id = v_org AND h.user_id = v_user;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- Removes the member's webhook (and with it every delivery row of it).
CREATE OR REPLACE FUNCTION crove_meetings.hook_clear()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_count integer;
BEGIN
  v_user := crove_meetings.hook_caller();
  DELETE FROM crove_meetings.member_hook h WHERE h.org_id = v_org AND h.user_id = v_user;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- The member's own webhook, everything but the secrets (the address is the member's own to read back).
CREATE OR REPLACE FUNCTION crove_meetings.hook_get()
RETURNS TABLE (id uuid, url text, fields text[], enabled boolean, paused_reason text, secret_hint text, previous_until timestamptz, failing_since timestamptz,
               consecutive_failures integer, last_delivery_at timestamptz, last_status text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
BEGIN
  v_user := crove_meetings.hook_caller();
  RETURN QUERY
  SELECT h.id, h.url, h.fields, h.enabled, h.paused_reason, h.secret_hint, CASE WHEN h.previous_until > pg_catalog.clock_timestamp() THEN h.previous_until END,
         h.failing_since, h.consecutive_failures, h.last_delivery_at, h.last_status, h.created_at
  FROM crove_meetings.member_hook h WHERE h.org_id = v_org AND h.user_id = v_user;
END $$;

-- "Gửi thử": stores a `ping` for the caller's own hook (the sweep hands it to the queue within a minute). It carries no meeting data. At most one a minute and ten an hour.
-- Returns the event id; MEETING_HOOK_TOO_SOON (22023) when sent too often, MEETING_HOOK_NOT_FOUND (22023) when there is no standing hook.
CREATE OR REPLACE FUNCTION crove_meetings.hook_test()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_hook uuid;
  v_id uuid := crove_kernel.uuid_v7();
BEGIN
  v_user := crove_meetings.hook_caller();
  SELECT h.id INTO v_hook FROM crove_meetings.member_hook h WHERE h.org_id = v_org AND h.user_id = v_user FOR UPDATE;
  IF NOT FOUND OR NOT crove_meetings.hook_standing(v_org, v_hook) THEN
    RAISE EXCEPTION 'MEETING_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM crove_meetings.hook_delivery d WHERE d.org_id = v_org AND d.hook_id = v_hook AND d.type = 'ping' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 minute')
     OR (SELECT pg_catalog.count(*) FROM crove_meetings.hook_delivery d WHERE d.org_id = v_org AND d.hook_id = v_hook AND d.type = 'ping' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'MEETING_HOOK_TOO_SOON' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_meetings.hook_delivery (org_id, id, hook_id, type, body)
  VALUES (v_org, v_id, v_hook, 'ping', pg_catalog.jsonb_build_object(
    'id', v_id, 'type', 'ping', 'created_at', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'org', v_org, 'data', '{}'::jsonb));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- At publish, in the recorder's own transaction (the command meetings.result.publish)
-- ---------------------------------------------------------------------------
-- The hook to send for a meeting the caller records, with the fields the member ticked; no row when there is none to send to (no hook, switched off, org switch off).
CREATE OR REPLACE FUNCTION crove_meetings.hook_for_publish(p_meeting uuid)
RETURNS TABLE (hook_id uuid, fields text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
BEGIN
  v_user := crove_meetings.hook_caller();
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT h.id, h.fields FROM crove_meetings.member_hook h
  WHERE h.org_id = v_org AND h.user_id = v_user AND crove_meetings.hook_standing(v_org, h.id);
END $$;

-- Stores the event for a published result: the caller must be the recorder of the meeting and the owner of a hook that stands. A replay of the event id stores nothing (false). The body's
-- CHECK (23514) refuses one that does not fit.
CREATE OR REPLACE FUNCTION crove_meetings.hook_enqueue_publish(p_id uuid, p_hook uuid, p_meeting uuid, p_body jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_count integer;
BEGIN
  v_user := crove_meetings.hook_caller();
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting)
     OR NOT EXISTS (SELECT 1 FROM crove_meetings.member_hook h WHERE h.org_id = v_org AND h.id = p_hook AND h.user_id = v_user)
     OR NOT crove_meetings.hook_standing(v_org, p_hook) THEN
    RAISE EXCEPTION 'MEETING_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_meetings.hook_delivery (org_id, id, hook_id, meeting_id, type, body)
  VALUES (v_org, p_id, p_hook, p_meeting, 'meeting.result_published', p_body)
  ON CONFLICT (org_id, id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- The worker's side (the system context in an org, or no context for the list)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.hook_system()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;

-- The deliveries that need the queue: never handed over ('send'), handed over but not taken up for three minutes ('send'), or still waiting after eight hours, longer than the retries
-- last ('expire'). Ids only: never an address, a secret or a body.
CREATE OR REPLACE FUNCTION crove_meetings.hook_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.org_id, d.id,
         CASE WHEN d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM crove_meetings.hook_delivery d
  WHERE d.status = 'queued'
    AND (d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
         OR d.handed_at IS NULL
         OR (d.attempts = 0 AND d.handed_at <= pg_catalog.clock_timestamp() - interval '3 minutes'))
  ORDER BY d.created_at, d.id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- One delivery, for the job that sends it: its body is what the receiver gets.
CREATE OR REPLACE FUNCTION crove_meetings.hook_delivery_get(p_org_id uuid, p_id uuid)
RETURNS TABLE (id uuid, hook_id uuid, type text, body jsonb, status text, attempts integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_meetings.hook_system();
  RETURN QUERY
  SELECT d.id, d.hook_id, d.type, d.body, d.status, d.attempts
  FROM crove_meetings.hook_delivery d WHERE d.org_id = p_org_id AND d.id = p_id AND p_org_id = crove_kernel.ctx_org_id();
END $$;

-- The delivery worker's one read of an address, its sealed secrets (bound to the member's user id) and that id: only while the webhook stands (enabled, org active with the owner's switch on, member still in the org and not
-- disabled), so a member who left, an owner who turned the feature off or a stopped org ends the very next attempt.
CREATE OR REPLACE FUNCTION crove_meetings.hook_target(p_hook uuid)
RETURNS TABLE (url text, secret_sealed jsonb, previous_sealed jsonb, user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_meetings.hook_system();
BEGIN
  RETURN QUERY
  SELECT h.url, h.secret_sealed, CASE WHEN h.previous_until > pg_catalog.clock_timestamp() THEN h.previous_sealed END, h.user_id
  FROM crove_meetings.member_hook h
  WHERE h.org_id = v_org AND h.id = p_hook AND crove_meetings.hook_standing(v_org, h.id);
END $$;

-- Notes that a queued delivery was handed to the queue now.
CREATE OR REPLACE FUNCTION crove_meetings.hook_touch(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_meetings.hook_system();
  v_count integer;
BEGIN
  UPDATE crove_meetings.hook_delivery d SET handed_at = pg_catalog.clock_timestamp() WHERE d.org_id = v_org AND d.id = p_id AND d.status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- The outcome of one attempt. 'sent': delivered. 'retry': the attempt failed and the queue tries again (the body stays). 'failed': the last attempt failed. 'dropped': the webhook no longer
-- stands, so nothing is sent. 'expired': the delivery waited too long with no attempt made (the worker was down), failed without counting against the receiver. Every outcome but 'retry'
-- settles the delivery and wipes its body. A failed attempt counts on the hook; after seven days of failing it is paused with the reason. A delivery already settled is left as it is (false).
CREATE OR REPLACE FUNCTION crove_meetings.hook_record(p_id uuid, p_outcome text, p_code integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_meetings.hook_system();
  v_hook uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'failed', 'dropped', 'expired') OR (p_code IS NOT NULL AND p_code NOT BETWEEN 100 AND 599) THEN
    RAISE EXCEPTION 'MEETING_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_meetings.hook_delivery d SET
    status = CASE p_outcome WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'expired' THEN 'failed' WHEN 'dropped' THEN 'dropped' ELSE d.status END,
    body = CASE WHEN p_outcome = 'retry' THEN d.body ELSE NULL END,
    attempts = d.attempts + CASE WHEN p_outcome IN ('dropped', 'expired') THEN 0 ELSE 1 END,
    last_code = p_code,
    sent_at = CASE WHEN p_outcome = 'sent' THEN pg_catalog.clock_timestamp() ELSE d.sent_at END
  WHERE d.org_id = v_org AND d.id = p_id AND d.status = 'queued'
  RETURNING d.hook_id INTO v_hook;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_outcome = 'sent' THEN
    UPDATE crove_meetings.member_hook h SET last_delivery_at = pg_catalog.clock_timestamp(), last_status = 'sent', consecutive_failures = 0, failing_since = NULL
    WHERE h.org_id = v_org AND h.id = v_hook;
  ELSIF p_outcome IN ('retry', 'failed') THEN
    UPDATE crove_meetings.member_hook h SET
      last_status = 'failed',
      consecutive_failures = h.consecutive_failures + 1,
      failing_since = COALESCE(h.failing_since, pg_catalog.clock_timestamp())
    WHERE h.org_id = v_org AND h.id = v_hook;
    UPDATE crove_meetings.member_hook h SET enabled = false, paused_reason = 'failing'
    WHERE h.org_id = v_org AND h.id = v_hook AND h.enabled AND h.failing_since <= pg_catalog.clock_timestamp() - interval '7 days';
  END IF;
  -- The log of a hook's deliveries (ids, status, times) is kept for 30 days once settled.
  DELETE FROM crove_meetings.hook_delivery d
  WHERE d.org_id = v_org AND d.hook_id = v_hook AND d.status <> 'queued' AND d.created_at < pg_catalog.clock_timestamp() - interval '30 days';
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_meetings.hook_body_ok(jsonb, uuid, uuid, text, uuid, text),
  crove_meetings.hook_standing(uuid, uuid),
  crove_meetings.hook_caller(),
  crove_meetings.hook_drop_queued(uuid, uuid, uuid),
  crove_meetings.hook_drop_on_disable(),
  crove_meetings.hook_drop_on_text_change(),
  crove_meetings.hooks_drop_all(),
  crove_meetings.hook_put(text, jsonb, text, text[], boolean),
  crove_meetings.hook_rotate(jsonb, text),
  crove_meetings.hook_clear(),
  crove_meetings.hook_get(),
  crove_meetings.hook_test(),
  crove_meetings.hook_for_publish(uuid),
  crove_meetings.hook_enqueue_publish(uuid, uuid, uuid, jsonb),
  crove_meetings.hook_system(),
  crove_meetings.hook_open(integer),
  crove_meetings.hook_delivery_get(uuid, uuid),
  crove_meetings.hook_target(uuid),
  crove_meetings.hook_touch(uuid),
  crove_meetings.hook_record(uuid, text, integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
-- Every other login role (the migration owner aside) loses them too, so a later role starts with none.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_meetings.hook_body_ok(jsonb, uuid, uuid, text, uuid, text), crove_meetings.hook_standing(uuid, uuid), crove_meetings.hook_caller(), '
      'crove_meetings.hook_drop_queued(uuid, uuid, uuid), crove_meetings.hook_drop_on_disable(), crove_meetings.hook_drop_on_text_change(), crove_meetings.hooks_drop_all(), '
      'crove_meetings.hook_put(text, jsonb, text, text[], boolean), crove_meetings.hook_rotate(jsonb, text), crove_meetings.hook_clear(), crove_meetings.hook_get(), crove_meetings.hook_test(), '
      'crove_meetings.hook_for_publish(uuid), crove_meetings.hook_enqueue_publish(uuid, uuid, uuid, jsonb), crove_meetings.hook_system(), crove_meetings.hook_open(integer), '
      'crove_meetings.hook_delivery_get(uuid, uuid), crove_meetings.hook_target(uuid), crove_meetings.hook_touch(uuid), crove_meetings.hook_record(uuid, text, integer) FROM %I',
      r.rolname);
  END LOOP;
END $$;
-- The API's own login: the member's setup, the switch's drop and the publish.
GRANT EXECUTE ON FUNCTION
  crove_meetings.hooks_drop_all(),
  crove_meetings.hook_put(text, jsonb, text, text[], boolean),
  crove_meetings.hook_rotate(jsonb, text),
  crove_meetings.hook_clear(),
  crove_meetings.hook_get(),
  crove_meetings.hook_test(),
  crove_meetings.hook_for_publish(uuid),
  crove_meetings.hook_enqueue_publish(uuid, uuid, uuid, jsonb)
TO crove_app;
-- The delivery worker's login alone.
GRANT EXECUTE ON FUNCTION
  crove_meetings.hook_open(integer),
  crove_meetings.hook_delivery_get(uuid, uuid),
  crove_meetings.hook_target(uuid),
  crove_meetings.hook_touch(uuid),
  crove_meetings.hook_record(uuid, text, integer)
TO crove_worker;

-- ---------------------------------------------------------------------------
-- Queues (QUEUES in apps/kernel/src/jobs-schema.ts; create_queue skips existing ones, and both send their dead letters to kernel-job.dlq):
--   kernel-meeting-hook        one delivery to a member's receiver. 'stately': at most one queued and one active job per delivery, so a handed-over-again delivery is one job.
--   kernel-meeting-hook-sweep  the worker's sweep, every minute: hands over the deliveries that are waiting (apps/kernel/src/meeting-hook-sweep.ts).
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('kernel-meeting-hook', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('kernel-meeting-hook-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
