-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations CV5c (issue #2357, plan docs/plan/conversations.md section 10, ADR-0041): a customer's image, stored
-- as a file bound to its message. Idempotent; applied files stay untouched.
--
-- Why not a crove_kernel.file row. A file is deduplicated by content (UNIQUE (org_id, sha256), blob key org/<org>/<sha256>), so two
-- customers who send the same photo, or a member who uploads the same bytes, would share ONE row and ONE blob: no row can belong to
-- one message, and deleting a message's file would delete or keep another's bytes. The file row is also reached by the file list,
-- the file route, extraction, evidence holds and the export. So a message's image is its own table, never a kernel file:
--
-- crove_kernel.conversation_attachment  one image of one message (ON DELETE CASCADE: it goes with its message, so with erase_contact,
--                                       purge_expired, erase_connection and the org purge). Read only by those who read the message
--                                       (the same crove_kernel.conversation_access rule as the thread, a restrictive policy); written,
--                                       updated and deleted only by the system context. Its bytes are a blob of its own under
--                                       conversation/<org_id>/<random id>, never content addressed and never shared, so deleting the row
--                                       deletes exactly its bytes. state 'pending': the platform's address is known (source_url, personal
--                                       data) and the bytes are not stored yet; state 'stored': the bytes are stored and the address is
--                                       gone. The row is made first and the blob written after, so a row always names its blob and no
--                                       blob is ever written that no row names.
-- crove_kernel.conversation_blob_doomed The keys of the blobs whose row was deleted, written by a trigger in the same transaction as the
--                                       delete (so every path that deletes a row queues its blob) and emptied by the worker once the object
--                                       is deleted from the store. A key of a pending row waits an hour first: a fetch in flight when the row
--                                       went may still write its bytes, and must not leave an object nobody names. Not a tenant table.
-- conversation_attachment_due           the worker's list of pending images to fetch. It also drops the rows that will never be fetched: a
--                                       source address is cleared at six days (Zalo keeps media for seven [S]) and after five tries, by
--                                       deleting the row (the message keeps its placeholder text).
-- conversation_blob_claim / _done       the worker's claim of doomed keys under a lease, and the delete of the ones it removed.
SET LOCAL lock_timeout = '2s';

-- What the attachment's composite foreign key names: a message cannot carry another channel or kind than its thread.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_attachment_ref_uq ON crove_kernel.conversation_message (org_id, id, channel_connection_id, kind);

CREATE TABLE IF NOT EXISTS crove_kernel.conversation_attachment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  message_id uuid NOT NULL,
  -- The message's own channel and kind, so the database decides who reads an image by the same rule as its message.
  channel_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_thread', 'direct')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'stored')),
  -- The platform's address of the image: personal data, kept only while pending and cleared the moment the bytes are stored.
  source_url text CHECK (source_url IS NULL OR pg_catalog.length(source_url) BETWEEN 1 AND 2000),
  -- Reserved when the row is made (a random id, so no two rows share bytes).
  storage_key text NOT NULL CHECK (storage_key ~ '^conversation/[0-9a-f-]{36}/[0-9a-f]{64}$'),
  -- An S3 or GCS version id (printable ASCII, at most 1024 characters: PostgreSQL's regex repeats at most 255 times, so the length is its own test), or a content address.
  generation text CHECK (generation IS NULL OR (pg_catalog.length(generation) <= 1030 AND generation ~ '^(?:s3|gcs):[!-~]+$') OR generation ~ '^content:[0-9a-f]{64}$'),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- Read from the bytes (their first bytes decide, never what the platform said).
  content_type text CHECK (content_type IS NULL OR content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 20971520),
  width integer CHECK (width IS NULL OR width BETWEEN 1 AND 100000),
  height integer CHECK (height IS NULL OR height BETWEEN 1 AND 100000),
  -- When the relay last handed it to the worker, and how many times.
  requested_at timestamptz,
  fetch_attempts integer NOT NULL DEFAULT 0 CHECK (fetch_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_attachment_message_fk FOREIGN KEY (org_id, message_id, channel_connection_id, kind)
    REFERENCES crove_kernel.conversation_message (org_id, id, channel_connection_id, kind) ON DELETE CASCADE,
  CONSTRAINT conversation_attachment_key_org CHECK (storage_key LIKE 'conversation/' || org_id::text || '/%'),
  CONSTRAINT conversation_attachment_state CHECK (
    (state = 'pending' AND source_url IS NOT NULL AND stored_at IS NULL AND generation IS NULL AND sha256 IS NULL AND content_type IS NULL AND size_bytes IS NULL)
    OR (state = 'stored' AND source_url IS NULL AND stored_at IS NOT NULL AND generation IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_attachment_key_uq ON crove_kernel.conversation_attachment (org_id, storage_key);
CREATE INDEX IF NOT EXISTS conversation_attachment_message_idx ON crove_kernel.conversation_attachment (org_id, message_id, channel_connection_id, kind);
CREATE INDEX IF NOT EXISTS conversation_attachment_pending_idx ON crove_kernel.conversation_attachment (created_at) WHERE state = 'pending';
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_attachment');
REVOKE UPDATE ON crove_kernel.conversation_attachment FROM crove_tenant;
GRANT UPDATE (state, source_url, generation, sha256, content_type, size_bytes, width, height, requested_at, fetch_attempts, stored_at) ON crove_kernel.conversation_attachment TO crove_tenant;

-- Read by those who read the message (the thread's own rule, channel limit and direct-message permission included): a member limited to
-- other channels, a member without kernel.conversation.direct.read and an agent see no row, whatever route they read by. Written, updated and
-- deleted only by the system context (the intake and the worker), never by a member: an owner's erasure deletes the row through its message.
DROP POLICY IF EXISTS conversation_attachment_scope ON crove_kernel.conversation_attachment;
CREATE POLICY conversation_attachment_scope ON crove_kernel.conversation_attachment AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system');
DROP POLICY IF EXISTS conversation_attachment_delete ON crove_kernel.conversation_attachment;
CREATE POLICY conversation_attachment_delete ON crove_kernel.conversation_attachment AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system');

-- What never changes, and a stored image is final: pending becomes stored once, with its bytes recorded, and nothing changes after.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_attachment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.org_id, NEW.id, NEW.message_id, NEW.channel_connection_id, NEW.kind, NEW.storage_key, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.message_id, OLD.channel_connection_id, OLD.kind, OLD.storage_key, OLD.created_at) THEN
    RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'an attachment keeps its message and its blob key';
  END IF;
  IF OLD.state = 'stored' THEN
    RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a stored attachment never changes';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_attachment_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS conversation_attachment_guard ON crove_kernel.conversation_attachment;
CREATE TRIGGER conversation_attachment_guard BEFORE UPDATE ON crove_kernel.conversation_attachment
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.conversation_attachment_guard();

-- ---------------------------------------------------------------------------
-- The blobs whose row is gone
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_blob_doomed (
  storage_key text PRIMARY KEY CHECK (storage_key ~ '^conversation/[0-9a-f-]{36}/[0-9a-f]{64}$'),
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- A stored image's blob goes at once; a pending image's waits an hour for a fetch that may still be writing it.
  not_before timestamptz NOT NULL DEFAULT pg_catalog.now(),
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS conversation_blob_doomed_due_idx ON crove_kernel.conversation_blob_doomed (not_before, queued_at);
REVOKE ALL ON crove_kernel.conversation_blob_doomed FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.conversation_blob_doomed ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.conversation_blob_doomed');

-- Queues the blob of every deleted row, in the transaction that deletes it, by whatever path: the cascade of a message, a thread, a
-- customer, a connection, the org purge, a platform removal or the expiry below.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_attachment_doom() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO crove_kernel.conversation_blob_doomed (storage_key, not_before)
  VALUES (OLD.storage_key, CASE WHEN OLD.state = 'stored' THEN pg_catalog.now() ELSE pg_catalog.now() + pg_catalog.make_interval(hours => 1) END)
  ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_attachment_doom() FROM PUBLIC;
DROP TRIGGER IF EXISTS conversation_attachment_doom ON crove_kernel.conversation_attachment;
CREATE TRIGGER conversation_attachment_doom AFTER DELETE ON crove_kernel.conversation_attachment
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.conversation_attachment_doom();

-- The worker's claim of doomed keys, under a five minute lease (a worker that dies lets the next claim take them).
CREATE OR REPLACE FUNCTION crove_kernel.conversation_blob_claim(p_limit integer)
RETURNS TABLE (blob_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT d.storage_key FROM crove_kernel.conversation_blob_doomed d
    WHERE d.not_before <= pg_catalog.now() AND (d.claimed_until IS NULL OR d.claimed_until < pg_catalog.now())
    ORDER BY d.queued_at, d.storage_key LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
  )
  UPDATE crove_kernel.conversation_blob_doomed d
  SET claimed_until = pg_catalog.now() + pg_catalog.make_interval(mins => 5), attempts = d.attempts + 1
  FROM due WHERE d.storage_key = due.storage_key
  RETURNING d.storage_key;
END $$;

-- The keys the worker has deleted from the store.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_blob_done(p_keys text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.conversation_blob_doomed d WHERE d.storage_key = ANY (p_keys);
END $$;

-- ---------------------------------------------------------------------------
-- The pending images to fetch (worker login only)
-- ---------------------------------------------------------------------------
-- First the rows that will never be fetched go: older than six days (a source address is cleared then, and Zalo keeps media for seven [S]),
-- or tried five times with the last try p_retry_seconds ago. Deleting the row clears the address and queues its blob key (the trigger);
-- the message keeps the placeholder text it was stored with. Then the active orgs' pending rows on an active connection that were never
-- handed out, or not for p_retry_seconds, oldest first.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_attachment_due(p_limit integer, p_retry_seconds integer)
RETURNS TABLE (org_id uuid, attachment_id uuid, connection_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.conversation_attachment a
  WHERE a.state = 'pending'
    AND (a.created_at < pg_catalog.now() - pg_catalog.make_interval(days => 6)
         OR (a.fetch_attempts >= 5 AND a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1))));
  RETURN QUERY
  SELECT a.org_id, a.id, a.channel_connection_id
  FROM crove_kernel.conversation_attachment a
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id AND c.status = 'active'
  WHERE a.state = 'pending'
    AND (a.requested_at IS NULL OR a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1)))
  ORDER BY a.created_at, a.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_blob_claim(integer), crove_kernel.conversation_blob_done(text[]), crove_kernel.conversation_attachment_due(integer, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_blob_claim(integer), crove_kernel.conversation_blob_done(text[]), crove_kernel.conversation_attachment_due(integer, integer) TO crove_worker;

-- The reply job's queue already exists (kernel-conversation-reply): an attachment fetch is a job on it, with ids only in its data.
