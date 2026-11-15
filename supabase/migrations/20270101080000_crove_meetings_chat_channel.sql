-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings B4 (issue #3168, plan docs/plan/meetings-integrations.md section 5.2): post the minutes of a meeting to a Slack or Microsoft Teams channel, from the recorder's click, by a worker
-- job like the minutes webhook's (A6). Idempotent; applied files stay untouched.
--
-- Owner decision of 2026-11-15 (Meetings PO's chat): a worker job, and the post body added to the owner's text exception of the readers invariant. ADR-0025 stands: the API seals the address and
-- never opens it; only the worker does.
--
-- crove_meetings.chat_channel          the org's channels for minutes: a Slack Incoming Webhook or a Teams Workflows webhook, its name, its kind and its host (for the screen). Tenant data like
--                                      crove_social.chat_alert: every member reads it (so the recorder can pick one), owners and admins change it through the commands. It holds no secret.
-- crove_meetings.chat_channel_target   the address, sealed by the deployment's credential broker for the binding (org, 'meeting-chat', the channel's id). Definer-only, no grant to any Crove role.
--                                        chat_target_put   seals in (an owner or admin in a user context: the API);
--                                        chat_target_get   reads out (the worker, in the org's system context, only while the channel stands);
--                                        chat_target_reseal_due, chat_target_key_counts, chat_target_reseal   the worker's pass after a credential key rotation, as for a team chat alert.
-- crove_meetings.chat_post             one click of the recorder: ids, a state (queued, sent, failed, ambiguous, dropped), the HTTP status of the last answer, a code, the number of attempts and
--                                      hashes of the facts and of the message. NEVER the text. The recorder alone reads their own rows (the rule of crove_meetings.meeting_note); the worker's one writer is chat_record.
-- crove_meetings.chat_post_body        the message while the post is queued, built in the recorder's own transaction from what they read (the system context cannot read meetings), and DELETED the moment
--                                      the post settles. Definer-only. chat_body_ok pins its keys and limits in the database: the title, the day, the summary, the decisions, the action items
--                                      (title, owner as said, date) and the link back; no transcript, audio or contact detail has a key to ride in.
--                                        chat_post_enqueue  stores it (the recorder's own click, the API login);
--                                        chat_post_get      the worker's one read of it: kind, status and body (the owner's narrow exception of 2026-11-15 to the readers invariant: this function and
--                                                           hook_delivery_get are the only two that return a `body`).
-- A queued post is dropped (state 'dropped', body deleted) in the same transaction when the published text of its meeting changes (a personal-data erasure redacts a summary, an action item or a
-- title), and goes with its channel (removed) and its meeting (ON DELETE CASCADE).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The body check: the same shapes and limits as ChatMessage (packages/kernel-contract/src/meeting-chat.ts) plus the link back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.chat_body_ok(p_body jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_item jsonb;
  v_elem jsonb;
BEGIN
  IF p_body IS NULL OR pg_catalog.jsonb_typeof(p_body) <> 'object' THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_body) LOOP
    IF v_key NOT IN ('v', 'lang', 'title', 'day', 'summary', 'decisions', 'items', 'link') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF NOT (p_body ?& ARRAY['v', 'lang', 'title', 'day', 'summary', 'decisions', 'items', 'link']) THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_body -> 'v') <> 'number' OR p_body ->> 'v' <> '1'
     OR pg_catalog.jsonb_typeof(p_body -> 'lang') <> 'string' OR p_body ->> 'lang' NOT IN ('vi', 'en')
     OR pg_catalog.jsonb_typeof(p_body -> 'title') <> 'string' OR pg_catalog.char_length(p_body ->> 'title') NOT BETWEEN 1 AND 200
     OR pg_catalog.jsonb_typeof(p_body -> 'day') <> 'string' OR p_body ->> 'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR pg_catalog.jsonb_typeof(p_body -> 'summary') <> 'string' OR pg_catalog.char_length(p_body ->> 'summary') > 8000
     OR pg_catalog.jsonb_typeof(p_body -> 'decisions') <> 'array' OR pg_catalog.jsonb_array_length(p_body -> 'decisions') > 50
     OR pg_catalog.jsonb_typeof(p_body -> 'items') <> 'array' OR pg_catalog.jsonb_array_length(p_body -> 'items') > 100 THEN
    RETURN false;
  END IF;
  IF NOT (pg_catalog.jsonb_typeof(p_body -> 'link') = 'null'
          OR (pg_catalog.jsonb_typeof(p_body -> 'link') = 'string' AND pg_catalog.char_length(p_body ->> 'link') <= 500 AND p_body ->> 'link' ~ '^https://[^[:space:]]+$')) THEN
    RETURN false;
  END IF;
  FOR v_elem IN SELECT e FROM pg_catalog.jsonb_array_elements(p_body -> 'decisions') AS e LOOP
    IF pg_catalog.jsonb_typeof(v_elem) <> 'string' OR pg_catalog.char_length(v_elem #>> '{}') NOT BETWEEN 1 AND 500 THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_body -> 'items') AS e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
      IF v_key NOT IN ('title', 'who', 'when') THEN
        RETURN false;
      END IF;
    END LOOP;
    IF NOT (v_item ?& ARRAY['title', 'who', 'when'])
       OR pg_catalog.jsonb_typeof(v_item -> 'title') <> 'string' OR pg_catalog.char_length(v_item ->> 'title') NOT BETWEEN 1 AND 300
       OR pg_catalog.jsonb_typeof(v_item -> 'who') <> 'string' OR pg_catalog.char_length(v_item ->> 'who') > 200
       OR pg_catalog.jsonb_typeof(v_item -> 'when') <> 'string' OR pg_catalog.char_length(v_item ->> 'when') > 100 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.chat_channel (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('slack', 'teams')),
  -- The name the owner or admin gave it ("Kênh #hop-giao-ban"). Not a secret.
  label text NOT NULL CHECK (pg_catalog.char_length(label) BETWEEN 1 AND 200),
  -- The address's host as the adapter parsed it when it was saved, for the screen. Not a secret.
  host text NOT NULL CHECK (host ~ '^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$'),
  -- The member who saved the address; a post uses it only while they are an owner or admin of the org and not disabled (chat_standing).
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_meetings.chat_channel');

CREATE TABLE IF NOT EXISTS crove_meetings.chat_channel_target (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation.
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 4096),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT chat_channel_target_channel_uq UNIQUE (org_id, channel_id),
  CONSTRAINT chat_channel_target_channel_fk FOREIGN KEY (org_id, channel_id) REFERENCES crove_meetings.chat_channel (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_meetings.chat_channel_target ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_meetings.chat_post (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  -- The recorder who clicked.
  user_id uuid NOT NULL,
  -- sha256 (hex) of the facts the recorder read (the published result at that moment) and of the message that was queued. Neither is reversible and neither is the text.
  facts_key text NOT NULL CHECK (facts_key ~ '^[0-9a-f]{64}$'),
  text_hash text NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  -- queued: waiting for the worker (the body is kept). sent: the channel took it (Slack 200, Teams 202 accepted). failed: nothing went out (an address refused before any request, or a refusal answered).
  -- ambiguous: the request left and no usable answer came back (a timeout, a dropped connection, a server error), so it may be in the channel: never repeated without the recorder's tick.
  -- dropped: the post no longer stands (the channel or its saver, the org, the published text), so nothing is sent.
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed', 'ambiguous', 'dropped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  http_status smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- NULL until the sweep first hands the post to the queue; a post never taken up is handed over again after three minutes.
  handed_at timestamptz,
  -- Set, durably and before the request leaves, by the job that begins an attempt (chat_record 'begin'); cleared only by a 'retry' (nothing arrived). While it is set no other job begins, and a post
  -- whose attempt never concluded (the worker died after the request left) is settled `ambiguous` by the sweep, never sent again.
  sending_at timestamptz,
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT chat_post_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_post_channel_fk FOREIGN KEY (org_id, channel_id) REFERENCES crove_meetings.chat_channel (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_post_settled CHECK ((state = 'queued') = (settled_at IS NULL))
);
CREATE INDEX IF NOT EXISTS chat_post_channel_idx ON crove_meetings.chat_post (org_id, channel_id);
CREATE INDEX IF NOT EXISTS chat_post_meeting_idx ON crove_meetings.chat_post (org_id, meeting_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_post_open_idx ON crove_meetings.chat_post (created_at) WHERE state = 'queued';

CREATE TABLE IF NOT EXISTS crove_meetings.chat_post_body (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  body jsonb NOT NULL CHECK (crove_meetings.chat_body_ok(body)),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT chat_post_body_post_uq UNIQUE (org_id, post_id),
  CONSTRAINT chat_post_body_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_meetings.chat_post (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_meetings.chat_post_body ENABLE ROW LEVEL SECURITY;

-- The sealed address and the message are definer-only: no grant to any Crove role, and a later role starts with none.
DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_meetings.chat_channel_target, crove_meetings.chat_post_body FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_meetings.chat_channel_target, crove_meetings.chat_post_body FROM %I', r.rolname);
  END LOOP;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('supabase_etl_admin', 'supabase_read_only_user') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_meetings.chat_channel_target, crove_meetings.chat_post_body FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard on tenant tables; an agent context never saves a channel or posts.
SELECT crove_kernel.agent_write_guard_install('crove_meetings.chat_channel_target');
SELECT crove_kernel.agent_write_guard_install('crove_meetings.chat_post_body');

SELECT crove_kernel.apply_tenant_rls('crove_meetings.chat_post');
-- The recorder writes the row of their own click; nobody updates it but the worker's definer, and nobody deletes it but a cascade.
REVOKE UPDATE ON crove_meetings.chat_post FROM crove_tenant;

-- The recorder alone, in a user context: is_meeting_recorder answers false for every other member, and ctx_actor_type() is 'user' only for a signed-in member (an agent context, a member Vy run
-- included, and the system context are refused).
DROP POLICY IF EXISTS chat_post_read ON crove_meetings.chat_post;
CREATE POLICY chat_post_read ON crove_meetings.chat_post AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS chat_post_insert ON crove_meetings.chat_post;
CREATE POLICY chat_post_insert ON crove_meetings.chat_post AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id) AND state = 'queued' AND attempts = 0 AND settled_at IS NULL);
DROP POLICY IF EXISTS chat_post_update ON crove_meetings.chat_post;
CREATE POLICY chat_post_update ON crove_meetings.chat_post AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS chat_post_delete ON crove_meetings.chat_post;
CREATE POLICY chat_post_delete ON crove_meetings.chat_post AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (false);

-- ---------------------------------------------------------------------------
-- Standing and context
-- ---------------------------------------------------------------------------
-- Whether a channel may be used now: it exists, its org is active, and the member who saved its address is still an owner or admin of the org and not disabled (a Teams address sits on a
-- multi-tenant Microsoft host and the screen shows only the host, so the address must not outlive the person who vouched for it).
CREATE OR REPLACE FUNCTION crove_meetings.chat_standing(p_org uuid, p_channel uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_meetings.chat_channel c
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = c.org_id AND m.user_id = c.created_by AND m.role IN ('owner', 'admin')
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE c.org_id = p_org AND c.id = p_channel)
$$;

-- The worker's context: the system actor of an org. Raises NO_CONTEXT (42501) otherwise.
CREATE OR REPLACE FUNCTION crove_meetings.chat_system()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;

-- Drops the queued posts of a meeting (or of the whole org when NULL): state 'dropped', body deleted. Only the triggers below call it. A post whose attempt has begun (sending_at) is left to
-- conclude: its request may already be out, and the outcome must be recorded as it is.
CREATE OR REPLACE FUNCTION crove_meetings.chat_drop_queued(p_org uuid, p_meeting uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM crove_meetings.chat_post_body b
  USING crove_meetings.chat_post p
  WHERE p.org_id = b.org_id AND p.id = b.post_id AND p.org_id = p_org AND p.state = 'queued' AND p.sending_at IS NULL AND (p_meeting IS NULL OR p.meeting_id = p_meeting);
  UPDATE crove_meetings.chat_post p SET state = 'dropped', settled_at = pg_catalog.clock_timestamp(), code = 'POST_DROPPED'
  WHERE p.org_id = p_org AND p.state = 'queued' AND p.sending_at IS NULL AND (p_meeting IS NULL OR p.meeting_id = p_meeting);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- A change to the published text of a meeting (a personal-data erasure redacts a result's summary or decisions, an action item's title, owner or due text, or the meeting's title) drops
-- the queued posts of that meeting in the same transaction: the body is a copy of that text and must not outlive it.
CREATE OR REPLACE FUNCTION crove_meetings.chat_drop_on_text_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'meeting' THEN
    PERFORM crove_meetings.chat_drop_queued(NEW.org_id, NEW.id);
  ELSE
    PERFORM crove_meetings.chat_drop_queued(NEW.org_id, NEW.meeting_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_result_chat_drop ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_chat_drop AFTER UPDATE OF summary, decisions ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage = 'published' AND (OLD.summary IS DISTINCT FROM NEW.summary OR OLD.decisions IS DISTINCT FROM NEW.decisions)) EXECUTE FUNCTION crove_meetings.chat_drop_on_text_change();
DROP TRIGGER IF EXISTS action_item_chat_drop ON crove_meetings.action_item;
CREATE TRIGGER action_item_chat_drop AFTER UPDATE OF title, who_drafted, when_drafted ON crove_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage = 'published' AND (OLD.title IS DISTINCT FROM NEW.title OR OLD.who_drafted IS DISTINCT FROM NEW.who_drafted OR OLD.when_drafted IS DISTINCT FROM NEW.when_drafted))
  EXECUTE FUNCTION crove_meetings.chat_drop_on_text_change();
-- Sharing the minutes again deletes the published result and action items and publishes the drafts (meetings.result.publish), and an unshare deletes them: no text is updated, but a queued
-- message is a copy of what was published, so it is dropped too (the recorder reads the new version and posts again).
CREATE OR REPLACE FUNCTION crove_meetings.chat_drop_on_result_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM crove_meetings.chat_drop_queued(OLD.org_id, OLD.meeting_id);
    RETURN OLD;
  END IF;
  PERFORM crove_meetings.chat_drop_queued(NEW.org_id, NEW.meeting_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_result_chat_drop_delete ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_chat_drop_delete AFTER DELETE ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage = 'published') EXECUTE FUNCTION crove_meetings.chat_drop_on_result_change();
DROP TRIGGER IF EXISTS meeting_result_chat_drop_stage ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_chat_drop_stage AFTER UPDATE OF stage ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (NEW.stage = 'published' AND OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.chat_drop_on_result_change();
DROP TRIGGER IF EXISTS action_item_chat_drop_delete ON crove_meetings.action_item;
CREATE TRIGGER action_item_chat_drop_delete AFTER DELETE ON crove_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage = 'published') EXECUTE FUNCTION crove_meetings.chat_drop_on_result_change();
DROP TRIGGER IF EXISTS action_item_chat_drop_stage ON crove_meetings.action_item;
CREATE TRIGGER action_item_chat_drop_stage AFTER UPDATE OF stage ON crove_meetings.action_item
  FOR EACH ROW WHEN (NEW.stage = 'published' AND OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.chat_drop_on_result_change();
DROP TRIGGER IF EXISTS meeting_chat_drop ON crove_meetings.meeting;
CREATE TRIGGER meeting_chat_drop AFTER UPDATE OF title ON crove_meetings.meeting
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION crove_meetings.chat_drop_on_text_change();

-- ---------------------------------------------------------------------------
-- The address, sealed in (the API) and read out (the worker)
-- ---------------------------------------------------------------------------
-- Seals in, or replaces, the address of the org's channel with this id. Raises NO_CONTEXT (42501) without a context, CREDENTIAL_FORBIDDEN (42501) for an actor that is not an owner or admin of the org
-- (a user context only: the system and an agent are refused) and CHAT_CHANNEL_NOT_SET (P0002) when the org has no channel with that id.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_put(p_channel_id uuid, p_key_id text, p_envelope bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_meetings.chat_channel c WHERE c.org_id = v_org AND c.id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_CHANNEL_NOT_SET' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO crove_meetings.chat_channel_target AS t (org_id, channel_id, key_id, envelope)
  VALUES (v_org, p_channel_id, p_key_id, p_envelope)
  ON CONFLICT ON CONSTRAINT chat_channel_target_channel_uq DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed address of a channel, for the worker in the system context of its org, only while the channel stands (chat_standing): so a saver who left or was demoted, a stopped org or a
-- removed channel ends the very next attempt. No row otherwise. Key id and sealed bytes only: the envelope opens only with the deployment's credential key, which the database never holds.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_get(p_channel_id uuid)
RETURNS TABLE (key_id text, envelope bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_meetings.chat_system();
BEGIN
  IF NOT crove_meetings.chat_standing(v_org, p_channel_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT t.key_id, t.envelope FROM crove_meetings.chat_channel_target t WHERE t.org_id = v_org AND t.channel_id = p_channel_id;
END $$;

-- Whether the worker may use the address of this channel (the rule of chat_target_get), for the rotation pass.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_usable(p_org_id uuid, p_channel_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_meetings.chat_standing(p_org_id, p_channel_id)
$$;

-- The worker's scan, across active orgs, of usable addresses sealed with a key other than the given (current) one: ids and key ids only, in pages after a (sealed_at, channel_id) cursor, so an
-- address that cannot be resealed never holds back the ones after it.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_reseal_due(p_key_id text, p_limit int, p_after_sealed timestamptz, p_after_id uuid)
RETURNS TABLE (org_id uuid, channel_id uuid, key_id text, sealed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.channel_id, k.key_id, k.sealed_at
  FROM crove_meetings.chat_channel_target k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status = 'active'
  WHERE k.key_id <> p_key_id
    AND crove_meetings.chat_target_usable(k.org_id, k.channel_id)
    AND (p_after_sealed IS NULL OR (k.sealed_at, k.channel_id) > (p_after_sealed, p_after_id))
  ORDER BY k.sealed_at, k.channel_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- How many addresses each key id still seals: usable ones (resealed by the worker) and the others.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_key_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.key_id,
    count(*) FILTER (WHERE crove_meetings.chat_target_usable(k.org_id, k.channel_id)),
    count(*) FILTER (WHERE NOT crove_meetings.chat_target_usable(k.org_id, k.channel_id))
  FROM crove_meetings.chat_channel_target k
  GROUP BY k.key_id
$$;

-- Stores a resealed address, for the worker in the system context of its org, only if the stored envelope is still the one it read (its key id and the hex SHA-256 of its bytes), the key changes,
-- and the address is still usable. Returns whether it stored it.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_reseal(p_channel_id uuid, p_from_key_id text, p_from_sha256 text, p_key_id text, p_envelope bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_meetings.chat_system();
  v_target crove_meetings.chat_channel_target%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM crove_meetings.chat_channel_target t WHERE t.org_id = v_org AND t.channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND OR v_target.key_id IS DISTINCT FROM p_from_key_id OR p_from_key_id = p_key_id
     OR pg_catalog.encode(pg_catalog.sha256(v_target.envelope), 'hex') IS DISTINCT FROM p_from_sha256
     OR NOT crove_meetings.chat_standing(v_org, p_channel_id) THEN
    RETURN false;
  END IF;
  UPDATE crove_meetings.chat_channel_target t SET key_id = p_key_id, envelope = p_envelope, sealed_at = pg_catalog.now()
  WHERE t.org_id = v_org AND t.channel_id = p_channel_id;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- The recorder's click (the API login, a user context)
-- ---------------------------------------------------------------------------
-- Stores the message of a post the caller just made: the caller must be the recorder of its meeting and the author of the post, the post must be queued with no body yet, and its channel must
-- stand. A body that does not fit is refused by its CHECK (23514). Returns whether it stored one. Raises NO_CONTEXT (42501) outside a signed-in member's context and CHAT_POST_NOT_FOUND (22023).
CREATE OR REPLACE FUNCTION crove_meetings.chat_post_enqueue(p_post uuid, p_body jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_post crove_meetings.chat_post%ROWTYPE;
  v_count integer;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_post FROM crove_meetings.chat_post p WHERE p.org_id = v_org AND p.id = p_post AND p.user_id = v_user AND p.state = 'queued';
  IF NOT FOUND OR NOT crove_meetings.is_meeting_recorder(v_org, v_post.meeting_id) OR NOT crove_meetings.chat_standing(v_org, v_post.channel_id) THEN
    RAISE EXCEPTION 'CHAT_POST_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_meetings.chat_post_body (org_id, post_id, body) VALUES (v_org, p_post, p_body) ON CONFLICT ON CONSTRAINT chat_post_body_post_uq DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- The worker's side (the system context in an org, or no context for the list)
-- ---------------------------------------------------------------------------
-- The posts that need the queue: never handed over ('send'), handed over but not taken up for three minutes ('send'), still waiting after eight hours, longer than the retries last ('expire'), or
-- whose attempt began and never concluded for three minutes ('lost': the worker died, the request may be out, so it is settled ambiguous and never sent again). A post whose attempt has begun is
-- never handed over or expired. Ids only: never an address or a body. For the sweep, with no context, across orgs.
CREATE OR REPLACE FUNCTION crove_meetings.chat_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id,
         CASE WHEN p.sending_at IS NOT NULL THEN 'lost' WHEN p.created_at <= pg_catalog.clock_timestamp() - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM crove_meetings.chat_post p
  WHERE p.state = 'queued'
    AND ((p.sending_at IS NOT NULL AND p.sending_at <= pg_catalog.clock_timestamp() - interval '3 minutes')
         OR (p.sending_at IS NULL
             AND (p.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
                  OR p.handed_at IS NULL
                  OR (p.attempts = 0 AND p.handed_at <= pg_catalog.clock_timestamp() - interval '3 minutes'))))
  ORDER BY p.created_at, p.id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- One post, for the job that sends it: the kind of its channel, its state and its body (the message the channel gets). The owner's exception of 2026-11-15 names this function: with
-- hook_delivery_get it is the only one of crove_meetings that returns a `body`.
CREATE OR REPLACE FUNCTION crove_meetings.chat_post_get(p_org_id uuid, p_id uuid)
RETURNS TABLE (id uuid, channel_id uuid, kind text, status text, body jsonb, attempts integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_meetings.chat_system();
  RETURN QUERY
  SELECT p.id, p.channel_id, c.kind, p.state, b.body, p.attempts
  FROM crove_meetings.chat_post p
  JOIN crove_meetings.chat_channel c ON c.org_id = p.org_id AND c.id = p.channel_id
  LEFT JOIN crove_meetings.chat_post_body b ON b.org_id = p.org_id AND b.post_id = p.id
  WHERE p.org_id = p_org_id AND p.id = p_id AND p_org_id = crove_kernel.ctx_org_id();
END $$;

-- Notes that a queued post was handed to the queue now.
CREATE OR REPLACE FUNCTION crove_meetings.chat_touch(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_meetings.chat_system();
  v_count integer;
BEGIN
  UPDATE crove_meetings.chat_post p SET handed_at = pg_catalog.clock_timestamp() WHERE p.org_id = v_org AND p.id = p_id AND p.state = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- The outcome of one attempt. 'begin' comes first, before the request leaves: it marks the attempt as begun (sending_at) and answers whether this job may go on (false when an attempt already
-- began, or the post is older than eight hours: nobody else begins, so a post is never sent twice and a stale one is only expired). 'sent', 'failed' and 'ambiguous' settle the post as they say; 'retry': nothing went out, sending_at is cleared and the queue tries again (the body stays); 'dropped': the post no longer stands,
-- so nothing is sent; 'expired': the post waited too long with no attempt made (the worker was down), failed. Every outcome but 'retry' settles the post and DELETES its body. A post already
-- settled is left as it is (false). The code is a fixed word, never the service's own; the status is the HTTP status of the answer, when there was one.
CREATE OR REPLACE FUNCTION crove_meetings.chat_record(p_id uuid, p_outcome text, p_http integer, p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_meetings.chat_system();
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('begin', 'sent', 'retry', 'failed', 'ambiguous', 'dropped', 'expired')
     OR (p_http IS NOT NULL AND p_http NOT BETWEEN 100 AND 599) OR (p_code IS NOT NULL AND p_code !~ '^[A-Z0-9_]{1,64}$') THEN
    RAISE EXCEPTION 'CHAT_POST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'begin' THEN
    UPDATE crove_meetings.chat_post p SET sending_at = pg_catalog.clock_timestamp() WHERE p.org_id = v_org AND p.id = p_id AND p.state = 'queued' AND p.sending_at IS NULL
      AND p.created_at > pg_catalog.clock_timestamp() - interval '8 hours';
    RETURN FOUND;
  END IF;
  UPDATE crove_meetings.chat_post p SET
    sending_at = CASE WHEN p_outcome = 'retry' THEN NULL ELSE p.sending_at END,
    state = CASE p_outcome WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'expired' THEN 'failed' WHEN 'ambiguous' THEN 'ambiguous' WHEN 'dropped' THEN 'dropped' ELSE p.state END,
    attempts = p.attempts + CASE WHEN p_outcome IN ('dropped', 'expired') THEN 0 ELSE 1 END,
    http_status = p_http,
    code = CASE WHEN p_outcome = 'sent' THEN NULL WHEN p_outcome = 'expired' THEN 'POST_EXPIRED' ELSE p_code END,
    settled_at = CASE WHEN p_outcome = 'retry' THEN NULL ELSE pg_catalog.clock_timestamp() END
  WHERE p.org_id = v_org AND p.id = p_id AND p.state = 'queued'
    -- 'dropped' and 'expired' never settle a post whose attempt has begun: its request may be out, and only the attempt's own outcome (or the sweep's 'lost') settles it.
    AND (p.sending_at IS NULL OR p_outcome NOT IN ('dropped', 'expired'));
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_outcome <> 'retry' THEN
    DELETE FROM crove_meetings.chat_post_body b WHERE b.org_id = v_org AND b.post_id = p_id;
  END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_meetings.chat_body_ok(jsonb),
  crove_meetings.chat_standing(uuid, uuid),
  crove_meetings.chat_system(),
  crove_meetings.chat_drop_queued(uuid, uuid),
  crove_meetings.chat_drop_on_text_change(),
  crove_meetings.chat_drop_on_result_change(),
  crove_meetings.chat_target_put(uuid, text, bytea),
  crove_meetings.chat_target_get(uuid),
  crove_meetings.chat_target_usable(uuid, uuid),
  crove_meetings.chat_target_reseal_due(text, int, timestamptz, uuid),
  crove_meetings.chat_target_key_counts(),
  crove_meetings.chat_target_reseal(uuid, text, text, text, bytea),
  crove_meetings.chat_post_enqueue(uuid, jsonb),
  crove_meetings.chat_open(integer),
  crove_meetings.chat_post_get(uuid, uuid),
  crove_meetings.chat_touch(uuid),
  crove_meetings.chat_record(uuid, text, integer, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
-- Every other login role (the migration owner aside) loses them too, so a later role starts with none.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_meetings.chat_body_ok(jsonb), crove_meetings.chat_standing(uuid, uuid), crove_meetings.chat_system(), crove_meetings.chat_drop_queued(uuid, uuid), '
      'crove_meetings.chat_drop_on_text_change(), crove_meetings.chat_drop_on_result_change(), crove_meetings.chat_target_put(uuid, text, bytea), crove_meetings.chat_target_get(uuid), crove_meetings.chat_target_usable(uuid, uuid), '
      'crove_meetings.chat_target_reseal_due(text, int, timestamptz, uuid), crove_meetings.chat_target_key_counts(), crove_meetings.chat_target_reseal(uuid, text, text, text, bytea), '
      'crove_meetings.chat_post_enqueue(uuid, jsonb), crove_meetings.chat_open(integer), crove_meetings.chat_post_get(uuid, uuid), crove_meetings.chat_touch(uuid), '
      'crove_meetings.chat_record(uuid, text, integer, text) FROM %I',
      r.rolname);
  END LOOP;
END $$;
-- The API's own login: sealing an address in and storing the message of the recorder's own click. It never reads an address back.
GRANT EXECUTE ON FUNCTION
  crove_meetings.chat_target_put(uuid, text, bytea),
  crove_meetings.chat_post_enqueue(uuid, jsonb)
TO crove_app;
-- The worker's login alone: the sweep, the delivery job and the rotation pass.
GRANT EXECUTE ON FUNCTION
  crove_meetings.chat_target_get(uuid),
  crove_meetings.chat_target_reseal_due(text, int, timestamptz, uuid),
  crove_meetings.chat_target_key_counts(),
  crove_meetings.chat_target_reseal(uuid, text, text, text, bytea),
  crove_meetings.chat_open(integer),
  crove_meetings.chat_post_get(uuid, uuid),
  crove_meetings.chat_touch(uuid),
  crove_meetings.chat_record(uuid, text, integer, text)
TO crove_worker;

-- ---------------------------------------------------------------------------
-- Queues (QUEUES in apps/kernel/src/jobs-schema.ts; create_queue skips existing ones, and both send their dead letters to kernel-job.dlq):
--   kernel-meeting-chat        one post to a channel. 'stately': at most one queued and one active job per post, so a handed-over-again post is one job.
--   kernel-meeting-chat-sweep  the worker's sweep, every minute: hands over the posts that are waiting (apps/kernel/src/meeting-chat-sweep.ts).
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('kernel-meeting-chat', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('kernel-meeting-chat-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
