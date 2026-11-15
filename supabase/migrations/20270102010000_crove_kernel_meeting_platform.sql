-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3173, meetings integrations C1, plan docs/plan/meetings-integrations.md section 6.1): a member connects a meeting platform (Google Meet, Zoom, Microsoft Teams, or the
-- offline sandbox) and imports the recordings it finished. Nothing is downloaded before the member's own click. Idempotent; applied files stay untouched.
--
-- The state lives in crove_kernel, not crove_meetings, on purpose: the download job must read text (the platform's recording id, the provider, the staging key), and the rule of
-- meetings-readers.db.test.ts lets a crove_meetings definer return scalars only. None of it is meeting content: the job never reads a title.
--
-- meeting_platform_connection   one row per platform account a member connected. The member's own (a member reads only theirs). Tokens are not here.
-- meeting_platform_credential   the connection's tokens, sealed by the deployment's credential key (ADR-0025, packages/kernel-runtime/src/vault.ts), definer-only like calendar_credential:
--                                 meeting_platform_credential_put   seals in (connect, refresh): the member who owns the connection, or the system (the worker refreshing a token);
--                                 meeting_platform_credential_get   reads out: the worker only, in the system context of the org, only while the member is still an owner, admin or member
--                                                                   of the org and not disabled and the connection is active;
--                                 meeting_platform_credential_drop  forgets it (disconnect).
-- meeting_platform_oauth_begin / _consume   the single-use OAuth state of a connect, in the existing oauth_state table (the calendar's pair, for the recording providers).
-- meeting_platform_recording    what a platform has finished that the member could import: a SUGGESTION until the member presses "Nhập", then the state of the import. Only the member reads it;
--                               every change goes through a definer (the member's click, the worker's list and download). The staged bytes of an import wait under a staging key kept here (the
--                               staged-upload grants of crove_kernel.file_upload live 5 minutes, too short for a download) for at most 55 minutes; the member's own request then claims, seals and
--                               records them through the same route as an upload.
--                                 status: suggested -> importing (the click) -> staged (the worker's bytes are in staging) -> claimed (the member's request took them) -> imported
--                                         importing | staged | claimed -> failed (error_code says why); suggested | failed -> dismissed (the member's choice).
-- Definers: _sync_due (the sweep's page of active connections), _recording_replace (the sweep's one writer of suggestions), _recording_begin (the click), _recording_dismiss, _import_open (the
--           importing rows for the worker), _import_staged and _import_failed (the worker's outcomes), _recording_claim (the member's request takes the staged bytes), _recording_imported (called
--           when the media of a meeting is recorded), _recording_sweep (expiry).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.meeting_platform_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The member who owns the account. Not a foreign key, like calendar_connection.user_id: the worker checks that this user is still a member (meeting_platform_credential_get).
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sandbox', 'google_meet', 'zoom', 'microsoft_teams')),
  -- The account as the provider names it, lowercased.
  external_account text NOT NULL CHECK (pg_catalog.length(external_account) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(scopes) <= 20),
  -- expired: the provider refused the grant; the member reconnects. A list that failed for another reason leaves the connection active and says why in status_reason.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  status_reason text CHECK (status_reason IS NULL OR pg_catalog.length(status_reason) <= 500),
  expires_at timestamptz,
  last_synced_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_platform_connection_account_uq ON crove_kernel.meeting_platform_connection (org_id, user_id, provider, external_account);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.meeting_platform_connection');
REVOKE UPDATE ON crove_kernel.meeting_platform_connection FROM crove_tenant;
GRANT UPDATE (display_name, scopes, status, status_reason, expires_at, last_synced_at, updated_at) ON crove_kernel.meeting_platform_connection TO crove_tenant;
DROP POLICY IF EXISTS own_meeting_platform_connection ON crove_kernel.meeting_platform_connection;
CREATE POLICY own_meeting_platform_connection ON crove_kernel.meeting_platform_connection AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));

CREATE TABLE IF NOT EXISTS crove_kernel.meeting_platform_credential (
  org_id uuid NOT NULL,
  -- The id of the connection it seals: one credential per connection.
  id uuid NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_platform_credential_connection_fk FOREIGN KEY (org_id, id)
    REFERENCES crove_kernel.meeting_platform_connection (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_kernel.meeting_platform_credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.meeting_platform_credential FROM PUBLIC, crove_tenant, crove_app, crove_worker;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.meeting_platform_credential');

CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_credential_put(p_connection_id uuid, p_key_id text, p_envelope bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_owner uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT c.user_id INTO v_owner FROM crove_kernel.meeting_platform_connection c
  WHERE c.org_id = v_org AND c.id = p_connection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT (
    v_actor_type = 'user' AND v_user = v_owner AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    )
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.meeting_platform_credential AS k (org_id, id, key_id, envelope)
  VALUES (v_org, p_connection_id, p_key_id, p_envelope)
  ON CONFLICT (org_id, id) DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed credential of an active connection, for the worker in the system context of its org. Raises NO_CONTEXT (42501) outside a system context, MEETING_PLATFORM_NOT_FOUND (P0002) when the
-- org has no such connection or it has no credential, MEETING_PLATFORM_NOT_ACTIVE (55000) when the connection is expired, and MEETING_PLATFORM_OWNER_LEFT (42501) when the member who owns it has
-- left the org, no longer edits in it, or is disabled.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_credential_get(p_connection_id uuid)
RETURNS TABLE (key_id text, envelope bytea, provider text, external_account text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_connection crove_kernel.meeting_platform_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_connection FROM crove_kernel.meeting_platform_connection c WHERE c.org_id = v_org AND c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_connection.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  IF v_connection.status <> 'active' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    SELECT k.key_id, k.envelope, v_connection.provider, v_connection.external_account
    FROM crove_kernel.meeting_platform_credential k WHERE k.org_id = v_org AND k.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_credential_drop(p_connection_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT (
    v_actor_type = 'user' AND EXISTS (
      SELECT 1 FROM crove_kernel.meeting_platform_connection c
      WHERE c.org_id = v_org AND c.id = p_connection_id AND c.user_id = v_user
    )
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.meeting_platform_credential k WHERE k.org_id = v_org AND k.id = p_connection_id;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_credential_put(uuid, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_credential_get(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_credential_drop(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_credential_put(uuid, text, bytea) TO crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_credential_drop(uuid) TO crove_app, crove_worker;
-- Reading a credential out is the worker's alone: the API seals tokens in, it never reads them back (ADR-0025).
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_credential_get(uuid) TO crove_worker;

-- The single-use OAuth state of a connect (the calendar's pair, for these providers; the oauth_state table is shared).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_oauth_begin(p_provider text, p_state_hash text, p_code_verifier text, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('google_recordings', 'zoom_recordings', 'teams_recordings')
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_code_verifier IS NOT NULL AND p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'OAUTH_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.oauth_state s WHERE s.org_id = v_org AND s.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT count(*) FROM crove_kernel.oauth_state s
      WHERE s.org_id = v_org AND s.user_id = v_user AND s.consumed_at IS NULL AND s.expires_at > pg_catalog.now()
        AND s.created_at > pg_catalog.now() - interval '2 minutes') >= 20 THEN
    RAISE EXCEPTION 'OAUTH_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.oauth_state (org_id, user_id, provider, state_hash, code_verifier, expires_at)
  VALUES (v_org, v_user, p_provider, p_state_hash, p_code_verifier, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_oauth_consume(p_provider text, p_state_hash text)
RETURNS TABLE (code_verifier text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row crove_kernel.oauth_state%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('google_recordings', 'zoom_recordings', 'teams_recordings') THEN
    RAISE EXCEPTION 'OAUTH_STATE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_row FROM crove_kernel.oauth_state s
  WHERE s.state_hash = p_state_hash AND s.org_id = v_org AND s.user_id = v_user AND s.provider = p_provider
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAUTH_STATE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_STATE_USED' USING ERRCODE = '55000';
  END IF;
  IF v_row.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'OAUTH_STATE_EXPIRED' USING ERRCODE = '55000';
  END IF;
  UPDATE crove_kernel.oauth_state s SET consumed_at = pg_catalog.now(), code_verifier = NULL
  WHERE s.org_id = v_row.org_id AND s.id = v_row.id;
  RETURN QUERY SELECT v_row.code_verifier;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_oauth_begin(text, text, text, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_oauth_consume(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_oauth_begin(text, text, text, integer) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_oauth_consume(text, text) TO crove_app;

-- A page of the active connections of active orgs after a key that are due to be listed, for the worker's sweep. A connection of a member who left or is disabled is not due.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_sync_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider
  FROM crove_kernel.meeting_platform_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active'
    -- Listed at most every 10 minutes (MEETING_PLATFORM_SYNC_MINUTES); a member's refresh clears last_synced_at so the next pass lists it at once.
    AND (c.last_synced_at IS NULL OR c.last_synced_at < pg_catalog.now() - interval '10 minutes')
    AND (p_after_org IS NULL OR (c.org_id, c.id) > (p_after_org, p_after_id))
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
      WHERE m.org_id = c.org_id AND m.user_id = c.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL)
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_sync_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_sync_due(uuid, uuid, int) TO crove_worker;

-- ---------------------------------------------------------------------------
-- The recordings: suggestions, then the import
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.meeting_platform_recording (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  connection_id uuid NOT NULL,
  -- The member who owns the connection and so the row.
  user_id uuid NOT NULL,
  -- The platform's own id of the recording, for the download and the diff. Never shown.
  external_id text NOT NULL CHECK (pg_catalog.char_length(external_id) BETWEEN 1 AND 1024),
  -- What the member reads in the list; the platform's words and third parties' personal data. Cut at 200.
  title text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(title) <= 200),
  started_at timestamptz NOT NULL,
  length_seconds integer CHECK (length_seconds IS NULL OR length_seconds >= 0),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- Which formats the platform offers. The import takes the audio, else the video's audio; a transcript alone is not imported by C1.
  has_audio boolean NOT NULL DEFAULT false,
  has_video boolean NOT NULL DEFAULT false,
  has_transcript boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'importing', 'staged', 'claimed', 'imported', 'failed', 'dismissed')),
  -- The meeting created by the click, and where its bytes wait until the member's own request claims them (a random key under staging/, per import, never listed).
  meeting_id uuid,
  staging_key text CHECK (staging_key IS NULL OR staging_key ~ '^staging/[0-9a-f]{64}$'),
  staged_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_platform_recording_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_kernel.meeting_platform_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_platform_recording_uq UNIQUE (org_id, connection_id, external_id),
  CONSTRAINT meeting_platform_recording_state CHECK (
    (status IN ('suggested', 'dismissed')) OR meeting_id IS NOT NULL
  ),
  -- A key exists exactly while bytes may wait for the import: importing, staged and claimed.
  CONSTRAINT meeting_platform_recording_staging CHECK ((status IN ('importing', 'staged', 'claimed')) = (staging_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS meeting_platform_recording_user_idx ON crove_kernel.meeting_platform_recording (org_id, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS meeting_platform_recording_open_idx ON crove_kernel.meeting_platform_recording (status, updated_at) WHERE status IN ('importing', 'staged', 'claimed');

SELECT crove_kernel.apply_tenant_rls('crove_kernel.meeting_platform_recording');
-- Rows come from the definers below alone; a member reads their own and changes nothing directly.
REVOKE INSERT, UPDATE, DELETE ON crove_kernel.meeting_platform_recording FROM crove_tenant;
DROP POLICY IF EXISTS meeting_platform_recording_read ON crove_kernel.meeting_platform_recording;
CREATE POLICY meeting_platform_recording_read ON crove_kernel.meeting_platform_recording AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id());
DROP POLICY IF EXISTS meeting_platform_recording_insert ON crove_kernel.meeting_platform_recording;
CREATE POLICY meeting_platform_recording_insert ON crove_kernel.meeting_platform_recording AS RESTRICTIVE FOR INSERT TO crove_tenant WITH CHECK (false);
DROP POLICY IF EXISTS meeting_platform_recording_update ON crove_kernel.meeting_platform_recording;
CREATE POLICY meeting_platform_recording_update ON crove_kernel.meeting_platform_recording AS RESTRICTIVE FOR UPDATE TO crove_tenant USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS meeting_platform_recording_delete ON crove_kernel.meeting_platform_recording;
CREATE POLICY meeting_platform_recording_delete ON crove_kernel.meeting_platform_recording AS RESTRICTIVE FOR DELETE TO crove_tenant USING (false);

-- The worker's guard shared by the definers below that act for one org: the worker login, in the org's system context.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_system()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_system() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The member in context, who must still edit in the org; raises MEETING_PLATFORM_FORBIDDEN (42501) otherwise.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_member()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_member() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The sweep's one writer of suggestions. p_rows is a JSON array of at most 100 recordings: {id, title, startedAt, lengthSeconds, sizeBytes, hasAudio, hasVideo, hasTranscript}. A suggested row
-- the platform no longer lists is deleted; a listed one is inserted or has its facts updated; a row in any other state (dismissed, importing, staged, claimed, imported, failed) keeps its state
-- and is never listed again as a suggestion. Returns a count, never text. A connection that is gone or not active is left as it is (0).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_replace(p_connection uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.meeting_platform_system();
  v_user uuid;
  v_ids text[];
  v_n integer;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
             WHERE COALESCE(pg_catalog.jsonb_typeof(e.value -> 'id'), '') <> 'string' OR COALESCE(e.value ->> 'id', '') = '' OR pg_catalog.char_length(e.value ->> 'id') > 1024
                OR COALESCE(pg_catalog.jsonb_typeof(e.value -> 'startedAt'), '') <> 'string') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT c.user_id INTO v_user FROM crove_kernel.meeting_platform_connection c
  WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.array_agg(e.value ->> 'id') INTO v_ids FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value);
  DELETE FROM crove_kernel.meeting_platform_recording r
  WHERE r.org_id = v_org AND r.connection_id = p_connection AND r.status = 'suggested'
    AND r.external_id <> ALL (COALESCE(v_ids, ARRAY[]::text[]));
  INSERT INTO crove_kernel.meeting_platform_recording AS r (org_id, connection_id, user_id, external_id, title, started_at, length_seconds, size_bytes, has_audio, has_video, has_transcript)
  SELECT DISTINCT ON (e.value ->> 'id') v_org, p_connection, v_user, e.value ->> 'id',
         pg_catalog.left(COALESCE(e.value ->> 'title', ''), 200),
         (e.value ->> 'startedAt')::timestamptz,
         CASE WHEN COALESCE(e.value ->> 'lengthSeconds', '') ~ '^[0-9]{1,9}$' THEN (e.value ->> 'lengthSeconds')::integer END,
         CASE WHEN COALESCE(e.value ->> 'sizeBytes', '') ~ '^[0-9]{1,15}$' THEN (e.value ->> 'sizeBytes')::bigint END,
         COALESCE((e.value ->> 'hasAudio')::boolean, false), COALESCE((e.value ->> 'hasVideo')::boolean, false), COALESCE((e.value ->> 'hasTranscript')::boolean, false)
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
  ORDER BY e.value ->> 'id'
  ON CONFLICT ON CONSTRAINT meeting_platform_recording_uq DO UPDATE
    SET title = EXCLUDED.title, length_seconds = EXCLUDED.length_seconds, size_bytes = EXCLUDED.size_bytes,
        has_audio = EXCLUDED.has_audio, has_video = EXCLUDED.has_video, has_transcript = EXCLUDED.has_transcript, updated_at = pg_catalog.now()
    WHERE r.status = 'suggested';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE crove_kernel.meeting_platform_connection c SET last_synced_at = pg_catalog.now(), updated_at = pg_catalog.now() WHERE c.org_id = v_org AND c.id = p_connection;
  RETURN v_n;
END $$;

-- The member's click on "Nhập": links the recording to the meeting the command just created and queues the download. The member must own the row and the meeting is theirs to record (the
-- command created it in the same transaction). Raises MEETING_PLATFORM_NOT_FOUND (P0002), MEETING_PLATFORM_STATE (55000) unless the row is suggested or failed, and
-- MEETING_PLATFORM_NO_AUDIO (22023) when the platform offers neither an audio file nor a video file.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_begin(p_recording uuid, p_meeting uuid, p_staging_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.meeting_platform_member();
  v_row crove_kernel.meeting_platform_recording%ROWTYPE;
BEGIN
  IF p_staging_key IS NULL OR p_staging_key !~ '^staging/[0-9a-f]{64}$' OR p_meeting IS NULL THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM crove_kernel.meeting_platform_recording r WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('suggested', 'failed') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_STATE' USING ERRCODE = '55000';
  END IF;
  IF NOT (v_row.has_audio OR v_row.has_video) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NO_AUDIO' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r
  SET status = 'importing', meeting_id = p_meeting, staging_key = p_staging_key, staged_at = NULL, error_code = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording;
END $$;

-- The member's choice not to see a suggestion again (a suggested or failed row only).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_dismiss(p_recording uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.meeting_platform_member();
BEGIN
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'dismissed', error_code = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user AND r.status IN ('suggested', 'failed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- The importing rows, for the worker's sweep (all orgs, like crove_meetings.hook_open): ids, the provider and the platform's id, the staging key. No title.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_import_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, connection_id uuid, provider text, external_id text, has_audio boolean, has_video boolean, size_bytes bigint, staging_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.org_id, r.id, r.connection_id, c.provider, r.external_id, r.has_audio, r.has_video, r.size_bytes, r.staging_key
  FROM crove_kernel.meeting_platform_recording r
  JOIN crove_kernel.meeting_platform_connection c ON c.org_id = r.org_id AND c.id = r.connection_id
  WHERE r.status = 'importing'
  ORDER BY r.updated_at, r.id
  LIMIT GREATEST(1, LEAST(p_limit, 200))
$$;

-- The worker's outcomes, in the org's system context: the bytes are in staging, or the download failed (a short code, never the platform's message).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_import_staged(p_recording uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.meeting_platform_system();
BEGIN
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'staged', staged_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording AND r.status = 'importing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_STATE' USING ERRCODE = '55000';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_import_failed(p_recording uuid, p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.meeting_platform_system();
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'failed', error_code = p_code, staging_key = NULL, staged_at = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording AND r.status IN ('importing', 'staged', 'claimed');
END $$;

-- The member's request takes the staged bytes: the row must be theirs and staged. It becomes claimed; the staging key is returned for the sealing (the same route as an upload). Raises
-- MEETING_PLATFORM_NOT_FOUND (P0002) and MEETING_PLATFORM_STATE (55000) otherwise.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_claim(p_recording uuid)
RETURNS TABLE (staging_key text, meeting_id uuid, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.meeting_platform_member();
  v_row crove_kernel.meeting_platform_recording%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM crove_kernel.meeting_platform_recording r WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'staged' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_STATE' USING ERRCODE = '55000';
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'claimed', updated_at = pg_catalog.now() WHERE r.org_id = v_org AND r.id = p_recording;
  RETURN QUERY SELECT v_row.staging_key, v_row.meeting_id, v_row.size_bytes;
END $$;

-- The route's failure after a claim (a hostile or unreadable file, a refused size): the row fails with a short code and the staging key is forgotten (the route deletes the bytes).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_claim_failed(p_recording uuid, p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.meeting_platform_member();
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'failed', error_code = p_code, staging_key = NULL, staged_at = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user AND r.status = 'claimed';
END $$;

-- Called when the media of a meeting is recorded (modules/meetings recordSealedMedia): a claimed recording of this meeting and member becomes imported and forgets its staging key. A meeting
-- that is no import is a no-op.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_imported(p_meeting uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RETURN;
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r SET status = 'imported', staging_key = NULL, staged_at = NULL, error_code = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.meeting_id = p_meeting AND r.user_id = v_user AND r.status = 'claimed';
END $$;

-- The sweep: suggestions older than 14 days go; staged bytes the member did not claim within 55 minutes (the daily staging sweep deletes a staging/ object older than an hour: STAGING_MAX_AGE_MS), and a claim that never finished within 30 minutes, fail with `not_claimed` and
-- `claim_failed`; a download that has run for 2 hours fails with `timeout`. Returns the staging keys whose bytes the job must delete (a failed row forgets its key), never text of a meeting.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_sweep()
RETURNS TABLE (staging_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.meeting_platform_recording r WHERE r.status IN ('suggested', 'dismissed') AND r.started_at < pg_catalog.now() - interval '14 days';
  RETURN QUERY
    WITH due AS (
      SELECT r.org_id, r.id, r.staging_key AS key,
             CASE WHEN r.status = 'staged' THEN 'not_claimed' WHEN r.status = 'claimed' THEN 'claim_failed' ELSE 'timeout' END AS code
      FROM crove_kernel.meeting_platform_recording r
      WHERE (r.status = 'staged' AND r.staged_at < pg_catalog.now() - interval '55 minutes')
         OR (r.status = 'claimed' AND r.updated_at < pg_catalog.now() - interval '30 minutes')
         OR (r.status = 'importing' AND r.updated_at < pg_catalog.now() - interval '2 hours')
      FOR UPDATE
    ), upd AS (
      UPDATE crove_kernel.meeting_platform_recording r SET status = 'failed', error_code = due.code, staging_key = NULL, staged_at = NULL, updated_at = pg_catalog.now()
      FROM due WHERE r.org_id = due.org_id AND r.id = due.id
      RETURNING due.key
    )
    SELECT upd.key FROM upd WHERE upd.key IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_replace(uuid, jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_begin(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_dismiss(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_import_open(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_import_staged(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_import_failed(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_claim(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_claim_failed(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_imported(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_recording_sweep() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION
  crove_kernel.meeting_platform_recording_replace(uuid, jsonb),
  crove_kernel.meeting_platform_import_open(integer),
  crove_kernel.meeting_platform_import_staged(uuid),
  crove_kernel.meeting_platform_import_failed(uuid, text),
  crove_kernel.meeting_platform_recording_sweep()
TO crove_worker;
GRANT EXECUTE ON FUNCTION
  crove_kernel.meeting_platform_recording_begin(uuid, uuid, text),
  crove_kernel.meeting_platform_recording_dismiss(uuid),
  crove_kernel.meeting_platform_recording_claim(uuid),
  crove_kernel.meeting_platform_recording_claim_failed(uuid, text),
  crove_kernel.meeting_platform_recording_imported(uuid)
TO crove_app;

-- The worker's note that a connection could not be listed: a short code in status_reason (never the platform's message) and last_synced_at moved to now, so the next try waits 10 minutes
-- instead of every minute; with p_expired the provider refused the grant and the member must connect again (status expired).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_sync_failed(p_connection uuid, p_code text, p_expired boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.meeting_platform_system();
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.meeting_platform_connection c
  SET status_reason = p_code, last_synced_at = pg_catalog.now(), updated_at = pg_catalog.now(), status = CASE WHEN p_expired THEN 'expired' ELSE c.status END
  WHERE c.org_id = v_org AND c.id = p_connection;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_sync_failed(uuid, text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_sync_failed(uuid, text, boolean) TO crove_worker;

-- ---------------------------------------------------------------------------
-- Queues (QUEUES in apps/kernel/src/jobs-schema.ts; both send their dead letters to kernel-job.dlq):
--   kernel-meeting-import        one download of a recording to staging. 'stately': at most one queued and one active job per recording.
--   kernel-meeting-import-sweep  the worker's sweep, every minute: hands over the importing rows, lists the connections' recordings, expires what was not claimed.
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('kernel-meeting-import', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('kernel-meeting-import-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
