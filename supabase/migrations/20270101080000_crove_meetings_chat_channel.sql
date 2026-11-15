-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings B4 (issue #3168, plan docs/plan/meetings-integrations.md section 5.2): post the minutes of a meeting to a Slack or Microsoft Teams channel, from the recorder's click. Idempotent; applied
-- files stay untouched.
--
-- crove_meetings.chat_channel          the org's channels for minutes: a Slack Incoming Webhook or a Teams Workflows webhook, its name, its kind and its host (the part of the address before the path, for the
--                                      screen and for the host check at the send). Tenant data like crove_social.chat_alert: every member reads it (so the recorder can pick one), owners and admins change it
--                                      through the commands. It holds no secret.
-- crove_meetings.chat_channel_target   the address itself, sealed by the deployment's credential broker for the binding (org, 'meeting-chat', the channel's id), as crove_social.chat_alert_target
--                                      holds a team chat's: the key never reaches the database and no Crove role holds a grant on the table. Two ways in and out, both definers:
--                                        chat_target_put       seals in (save): owners and admins of the org in context;
--                                        chat_target_for_post  reads out, for the API process only (login crove_app), in a signed-in member's context, and only for that member's own post that is still
--                                                              `started` (made under two minutes ago) on a meeting they record. It returns the key id and the sealed bytes, never text. The API opens the
--                                                              envelope with the broker and posts once; nothing else reads the table. A removed channel takes its target with it (ON DELETE CASCADE).
-- crove_meetings.chat_post             the log of what the recorder posted: one row per click, written `started` before the call and settled (sent, failed, ambiguous) after it. It holds ids, the state, the
--                                      HTTP status and a code, a hash of the facts the recorder read and a hash of the text sent; NEVER the text. The recorder alone reads and writes their own rows (the
--                                      rule of crove_meetings.meeting_note); a row goes with its meeting and with its channel.
-- No queue, no worker: the post is made in the recorder's own request, so no definer here returns meeting text.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.chat_channel (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('slack', 'teams')),
  -- The name the owner or admin gave it ("Kênh #hop-giao-ban"). Not a secret.
  label text NOT NULL CHECK (pg_catalog.char_length(label) BETWEEN 1 AND 200),
  -- The address's host as the adapter parsed it when it was saved, for the screen and the check at the send. Not a secret.
  host text NOT NULL CHECK (host ~ '^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$'),
  -- The member who saved the address; the post uses it only while they are an owner or admin of the org and not disabled (checked by meetings.chat.begin and again by chat_target_for_post, as the chat alert's worker does).
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_meetings.chat_channel');

CREATE TABLE IF NOT EXISTS crove_meetings.chat_channel_target (
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation.
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 4096),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, channel_id),
  CONSTRAINT chat_channel_target_channel_fk FOREIGN KEY (org_id, channel_id) REFERENCES crove_meetings.chat_channel (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_meetings.chat_channel_target ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_meetings.chat_channel_target FROM PUBLIC, crove_tenant, crove_app, crove_worker;
DO $$
DECLARE r name;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('supabase_etl_admin', 'supabase_read_only_user') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_meetings.chat_channel_target FROM %I', r);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard on tenant tables; an agent context never saves a channel.
SELECT crove_kernel.agent_write_guard_install('crove_meetings.chat_channel_target');

CREATE TABLE IF NOT EXISTS crove_meetings.chat_post (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  -- The recorder who clicked.
  user_id uuid NOT NULL,
  -- sha256 (hex) of the facts the recorder read (the published result at that moment) and of the exact text that was sent. Neither is reversible and neither is the text.
  facts_key text NOT NULL CHECK (facts_key ~ '^[0-9a-f]{64}$'),
  text_hash text NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  -- started: written before the call. sent: the channel took it (Slack 200, Teams 202 accepted). failed: nothing went out (refused address, a connection that did not open, a refusal with a status).
  -- ambiguous: the request left and no answer came back (a timeout or a drop), so it may be in the channel: never repeated without the recorder's tick.
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'sent', 'failed', 'ambiguous')),
  http_status smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT chat_post_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_post_channel_fk FOREIGN KEY (org_id, channel_id) REFERENCES crove_meetings.chat_channel (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_post_settled CHECK ((state = 'started') = (settled_at IS NULL))
);
CREATE INDEX IF NOT EXISTS chat_post_meeting_idx ON crove_meetings.chat_post (org_id, meeting_id, channel_id, created_at DESC);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.chat_post');
REVOKE UPDATE ON crove_meetings.chat_post FROM crove_tenant;
GRANT UPDATE (state, http_status, code, settled_at) ON crove_meetings.chat_post TO crove_tenant;

-- The recorder alone, in a user context: is_meeting_recorder answers false for every other member, and ctx_actor_type() is 'user' only for a signed-in member (an agent context, a member Vy run
-- included, and the system context are refused). A post is written by its own recorder, as the recorder, and never deleted by a person (a row goes with its meeting or channel).
DROP POLICY IF EXISTS chat_post_read ON crove_meetings.chat_post;
CREATE POLICY chat_post_read ON crove_meetings.chat_post AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS chat_post_insert ON crove_meetings.chat_post;
CREATE POLICY chat_post_insert ON crove_meetings.chat_post AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id) AND state = 'started');
DROP POLICY IF EXISTS chat_post_update ON crove_meetings.chat_post;
CREATE POLICY chat_post_update ON crove_meetings.chat_post AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS chat_post_delete ON crove_meetings.chat_post;
CREATE POLICY chat_post_delete ON crove_meetings.chat_post AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (false);

-- ---------------------------------------------------------------------------
-- The address, sealed
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
  ON CONFLICT (org_id, channel_id) DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed address of a channel, for the API process, to post once for a recorder's own click. Raises MEETINGS_API_ONLY (42501) for a login that is not the API's, NO_CONTEXT (42501) outside a signed-in
-- member's context, CHAT_CHANNEL_OWNER_LEFT (42501) when the member who saved the address is no longer an owner or admin or is disabled, and CHAT_POST_NOT_OPEN (P0002) unless the post is the caller's own, is still `started`, was made under two minutes ago and is on a meeting the caller records. It returns the key id
-- and the sealed bytes: the envelope opens only with the deployment's credential key, which the database never holds, and the API process alone uses it.
CREATE OR REPLACE FUNCTION crove_meetings.chat_target_for_post(p_post_id uuid)
RETURNS TABLE (key_id text, envelope bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_post crove_meetings.chat_post%ROWTYPE;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_API_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_post FROM crove_meetings.chat_post p
  WHERE p.org_id = v_org AND p.id = p_post_id AND p.user_id = v_user AND p.state = 'started' AND p.created_at > pg_catalog.clock_timestamp() - interval '2 minutes';
  IF NOT FOUND OR NOT crove_meetings.is_meeting_recorder(v_org, v_post.meeting_id) THEN
    RAISE EXCEPTION 'CHAT_POST_NOT_OPEN' USING ERRCODE = 'P0002';
  END IF;
  -- The address belongs to the member who saved it: once they are no longer an owner or admin of the org, or are disabled, it opens for nobody (an owner or admin pastes it again).
  IF NOT EXISTS (
    SELECT 1 FROM crove_meetings.chat_channel c
    JOIN crove_kernel.tenant_member m ON m.org_id = c.org_id AND m.user_id = c.created_by AND m.role IN ('owner', 'admin')
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE c.org_id = v_org AND c.id = v_post.channel_id
  ) THEN
    RAISE EXCEPTION 'CHAT_CHANNEL_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.key_id, t.envelope FROM crove_meetings.chat_channel_target t WHERE t.org_id = v_org AND t.channel_id = v_post.channel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHAT_POST_NOT_OPEN' USING ERRCODE = 'P0002';
  END IF;
END $$;

REVOKE ALL ON FUNCTION crove_meetings.chat_target_put(uuid, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_meetings.chat_target_for_post(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.chat_target_put(uuid, text, bytea) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_meetings.chat_target_for_post(uuid) TO crove_app;
