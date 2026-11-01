-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: the conversation core (issue #2303, plan docs/plan/conversations.md section 5, ADR-0041). Idempotent;
-- applied files stay untouched.
--
-- One store for what customers write to an org on a connected channel: a comment under the org's own post (kind
-- 'comment_thread', answered in Social) or a private message (kind 'direct', answered in Service). Either module can run
-- without the other, so the tables are the kernel's, next to channel_connection, party and task.
--
-- crove_kernel.conversation_identity  who wrote: the platform's own id for the person (a page-scoped or OA-scoped id) and
--                                     the name it gave, once per (org, provider, id). Every column that names a person is
--                                     personal data (manifest class pii). A party is never made from it by itself: a person
--                                     links it ("link to contact"), because a comment is not consent to be in a CRM.
-- crove_kernel.conversation           a thread on one connection: one per top-level comment, one per private chat. Status
--                                     new (the last message is the customer's), pending (a member answered) or resolved
--                                     (closed by a person); a new inbound message reopens it as new. last_seq counts its
--                                     messages in arrival order: a reply carries the last seq its sender saw, and a newer
--                                     one refuses it (CONVERSATION_MOVED), which is the guarantee against two people
--                                     answering one customer.
-- crove_kernel.conversation_message   one message of a thread, in or out. Unique per (org, connection, platform id), so a
--                                     replayed notice is a no-op. Inbound text is tainted external text, always. An outbound
--                                     message is written by the reply command (queued) and settled by the worker's record
--                                     command after the platform's answer (sending, sent, failed, unknown); no platform
--                                     send call has an idempotency key, so an unknown outcome is never sent again blindly.
--                                     hide_request/hide_attempt track a hide or unhide the platform has not confirmed yet.
-- crove_kernel.conversation_note      an internal note on a thread, never sent.
-- crove_kernel.conversation_read      the last seq a member has seen of a thread (unread dots).
-- crove_kernel.conversation_inbound_pending  the signed notices the public webhook accepted, waiting for the worker: not a
--                                     tenant table (the org comes from the stored connection, never from the notice, as in
--                                     ADR-0039). A notice is the record here because the platforms keep no history to pull,
--                                     so it is held until the worker has stored it and deleted the moment it has: bodies are
--                                     personal data, so there is no job history, no dead letter copy and no log of them.
--
-- Who reads what is the database's rule, not the screen's (plan section 8), through crove_kernel.conversation_access:
--   - the worker's system context reads and writes everything of its org (ingest, purge); an agent reads and writes none;
--   - owners and admins read every conversation and are never limited to some channels;
--   - a member or viewer reads a comment thread of a channel they may use (crove_kernel.channel_access: with rows they are
--     limited to those channels, without any they use every one) and writes it when they are not a viewer;
--   - a private message is read only by owners, admins and holders of the permission kernel.conversation.direct.read (none yet:
--     the role that holds it arrives with the Service inbox), and the channel limit applies to them too.
-- Rows are org-level: a connection belongs to no legal entity yet, so a conversation does not either.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Who may read or write a conversation of this kind on this channel
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.conversation_access(p_kind text, p_connection_id uuid, p_write boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE crove_kernel.ctx_actor_type()
    WHEN 'system' THEN true
    WHEN 'user' THEN COALESCE((
      SELECT CASE
        WHEN m.role IN ('owner', 'admin') THEN true
        WHEN p_write AND m.role = 'viewer' THEN false
        WHEN p_kind = 'direct' AND NOT crove_kernel.ctx_has_permission('kernel.conversation.direct.read') THEN false
        WHEN p_kind NOT IN ('direct', 'comment_thread') THEN false
        ELSE NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
          OR EXISTS (SELECT 1 FROM crove_kernel.channel_access a
                     WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.channel_connection_id = p_connection_id)
      END
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id()), false)
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_identity (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_user_id text NOT NULL CHECK (pg_catalog.length(external_user_id) BETWEEN 1 AND 200),
  -- What the platform gave; many give none (plan section 5.4), and the screen then says "Facebook user ·1234".
  display_name text CHECK (display_name IS NULL OR pg_catalog.length(display_name) BETWEEN 1 AND 200),
  -- Set only by a person (link_contact), never by the intake.
  party_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_identity_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (party_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_identity_external_uq ON crove_kernel.conversation_identity (org_id, provider, external_user_id);
CREATE INDEX IF NOT EXISTS conversation_identity_party_idx ON crove_kernel.conversation_identity (org_id, party_id) WHERE party_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_identity');
REVOKE UPDATE ON crove_kernel.conversation_identity FROM crove_tenant;
GRANT UPDATE (display_name, party_id, updated_at) ON crove_kernel.conversation_identity TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.conversation (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_thread', 'direct')),
  -- The platform's thread: the top-level comment's id, or the chat's own id.
  external_thread_id text NOT NULL CHECK (pg_catalog.length(external_thread_id) BETWEEN 1 AND 300),
  -- A comment thread: the post or media it is under. Social joins it to its own variants on (channel_connection_id,
  -- external_post_id), so there is no foreign key across schemas.
  external_post_id text CHECK (external_post_id IS NULL OR pg_catalog.length(external_post_id) BETWEEN 1 AND 300),
  -- A private reply points at the comment thread it continues.
  parent_conversation_id uuid,
  identity_id uuid,
  -- The contact, set only by a person.
  party_id uuid,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'pending', 'resolved')),
  assignee_user_id uuid,
  -- Messages so far, in arrival order (the seq of the newest).
  last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  -- When the platform's free-reply window closes (from the last inbound message); NULL: no window (a comment).
  reply_window_until timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_resolved CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT conversation_channel_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_parent_fk FOREIGN KEY (org_id, parent_conversation_id) REFERENCES crove_kernel.conversation (org_id, id) ON DELETE SET NULL (parent_conversation_id),
  CONSTRAINT conversation_identity_fk FOREIGN KEY (org_id, identity_id) REFERENCES crove_kernel.conversation_identity (org_id, id) ON DELETE SET NULL (identity_id),
  CONSTRAINT conversation_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (party_id),
  -- A removed member leaves the thread without an assignee.
  CONSTRAINT conversation_assignee_fk FOREIGN KEY (org_id, assignee_user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (assignee_user_id)
);
-- One thread per platform thread; it also backs the connection foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_thread_uq ON crove_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id);
-- What a message's own foreign key names, so a message cannot carry another kind or channel than its thread.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_ref_uq ON crove_kernel.conversation (org_id, id, channel_connection_id, kind);
CREATE INDEX IF NOT EXISTS conversation_list_idx ON crove_kernel.conversation (org_id, status, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS conversation_post_idx ON crove_kernel.conversation (org_id, channel_connection_id, external_post_id) WHERE external_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_identity_idx ON crove_kernel.conversation (org_id, identity_id) WHERE identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_party_idx ON crove_kernel.conversation (org_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_assignee_idx ON crove_kernel.conversation (org_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_parent_idx ON crove_kernel.conversation (org_id, parent_conversation_id) WHERE parent_conversation_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation');
REVOKE UPDATE ON crove_kernel.conversation FROM crove_tenant;
GRANT UPDATE (identity_id, party_id, status, assignee_user_id, last_seq, last_inbound_at, last_message_at, reply_window_until, resolved_at, resolved_by, updated_at)
  ON crove_kernel.conversation TO crove_tenant;
DROP POLICY IF EXISTS conversation_scope ON crove_kernel.conversation;
CREATE POLICY conversation_scope ON crove_kernel.conversation AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));

CREATE TABLE IF NOT EXISTS crove_kernel.conversation_message (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  conversation_id uuid NOT NULL,
  -- The thread's own channel and kind, so the database decides who reads a message by the same rule as its thread.
  channel_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_thread', 'direct')),
  seq integer NOT NULL CHECK (seq >= 1),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  -- The platform's id; NULL on an outbound message until the platform has accepted it.
  external_message_id text CHECK (external_message_id IS NULL OR pg_catalog.length(external_message_id) BETWEEN 1 AND 300),
  -- The platform's time (messages are shown in this order); received_at is when the worker stored it.
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  author_kind text NOT NULL CHECK (author_kind IN ('contact', 'member', 'system')),
  author_user_id uuid,
  body text NOT NULL CHECK (pg_catalog.length(body) <= 20000),
  -- Files of the message (images stored when it arrived); the files are the kernel's, so there is no foreign key from an array.
  attachments uuid[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(attachments) <= 20),
  send_state text CHECK (send_state IN ('queued', 'sending', 'sent', 'failed', 'unknown')),
  send_attempt integer NOT NULL DEFAULT 0 CHECK (send_attempt >= 0),
  send_error_code text CHECK (send_error_code IS NULL OR pg_catalog.length(send_error_code) <= 100),
  -- What the platform shows for a comment (hidden_*), and a hide or unhide the platform has not confirmed (hide_request).
  hidden_at timestamptz,
  hidden_by uuid,
  hide_request text CHECK (hide_request IN ('hide', 'unhide')),
  hide_attempt integer NOT NULL DEFAULT 0 CHECK (hide_attempt >= 0),
  hide_error_code text CHECK (hide_error_code IS NULL OR pg_catalog.length(hide_error_code) <= 100),
  -- The author or the platform removed it: the body is blanked (plan section 10).
  platform_removed_at timestamptz,
  tainted boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_message_thread_fk FOREIGN KEY (org_id, conversation_id, channel_connection_id, kind)
    REFERENCES crove_kernel.conversation (org_id, id, channel_connection_id, kind) ON DELETE CASCADE,
  CONSTRAINT conversation_message_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE RESTRICT,
  -- A customer's message is tainted external text, whatever else is true of it.
  CONSTRAINT conversation_message_inbound CHECK (direction <> 'in' OR (author_kind = 'contact' AND tainted AND send_state IS NULL)),
  CONSTRAINT conversation_message_outbound CHECK (direction <> 'out' OR (author_kind IN ('member', 'system') AND send_state IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_seq_uq ON crove_kernel.conversation_message (org_id, conversation_id, seq);
-- A replayed notice finds its message and does nothing.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_external_uq ON crove_kernel.conversation_message (org_id, channel_connection_id, external_message_id);
CREATE INDEX IF NOT EXISTS conversation_message_thread_idx ON crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind);
CREATE INDEX IF NOT EXISTS conversation_message_connection_idx ON crove_kernel.conversation_message (org_id, channel_connection_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_message');
REVOKE UPDATE ON crove_kernel.conversation_message FROM crove_tenant;
GRANT UPDATE (external_message_id, sent_at, body, attachments, send_state, send_attempt, send_error_code, hidden_at, hidden_by, hide_request, hide_attempt, hide_error_code, platform_removed_at)
  ON crove_kernel.conversation_message TO crove_tenant;
DROP POLICY IF EXISTS conversation_message_scope ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope ON crove_kernel.conversation_message AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));

CREATE TABLE IF NOT EXISTS crove_kernel.conversation_note (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  conversation_id uuid NOT NULL,
  -- Not a foreign key: a note outlives its author's membership.
  author_user_id uuid NOT NULL,
  body text NOT NULL CHECK (pg_catalog.length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_note_thread_fk FOREIGN KEY (org_id, conversation_id) REFERENCES crove_kernel.conversation (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_note_thread_idx ON crove_kernel.conversation_note (org_id, conversation_id, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_note');
-- A note is added and removed with its thread, never changed.
REVOKE UPDATE ON crove_kernel.conversation_note FROM crove_tenant;
-- A note is seen and added by those who read and write its thread: the thread's own policy decides, since the lookup runs
-- as the caller.
DROP POLICY IF EXISTS conversation_note_scope ON crove_kernel.conversation_note;
CREATE POLICY conversation_note_scope ON crove_kernel.conversation_note AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_note.org_id AND c.id = conversation_note.conversation_id))
  WITH CHECK (EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_note.org_id AND c.id = conversation_note.conversation_id
    AND crove_kernel.conversation_access(c.kind, c.channel_connection_id, true)));

CREATE TABLE IF NOT EXISTS crove_kernel.conversation_read (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_seq integer NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_read_thread_fk FOREIGN KEY (org_id, conversation_id) REFERENCES crove_kernel.conversation (org_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_read_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_read_member_uq ON crove_kernel.conversation_read (org_id, conversation_id, user_id);
CREATE INDEX IF NOT EXISTS conversation_read_user_idx ON crove_kernel.conversation_read (org_id, user_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_read');
REVOKE UPDATE ON crove_kernel.conversation_read FROM crove_tenant;
GRANT UPDATE (last_read_seq, updated_at) ON crove_kernel.conversation_read TO crove_tenant;
-- Read state is a member's own, on a thread they may read.
DROP POLICY IF EXISTS conversation_read_scope ON crove_kernel.conversation_read;
CREATE POLICY conversation_read_scope ON crove_kernel.conversation_read AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system')
    AND EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_read.org_id AND c.id = conversation_read.conversation_id))
  WITH CHECK ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system')
    AND EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_read.org_id AND c.id = conversation_read.conversation_id));

-- An identity is seen by those who may read a thread of it, and by owners and admins; the intake and a person linking a
-- contact write it.
DROP POLICY IF EXISTS conversation_identity_scope ON crove_kernel.conversation_identity;
CREATE POLICY conversation_identity_scope ON crove_kernel.conversation_identity AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_identity.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))
    OR EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_identity.org_id AND c.identity_id = conversation_identity.id))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = conversation_identity.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- Deleting a thread, a message, a note or an identity is the owner's, an admin's or the system's alone (the erasure of a customer and
-- the retention purge, CV6): the scope policies above are FOR ALL and so let anyone who may read a row delete it, with its cascades.
-- A restrictive policy per table, so a viewer, a member or a member limited to some channels deletes 0 rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation', 'conversation_message', 'conversation_note', 'conversation_identity'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS %I ON crove_kernel.%I', t || '_delete', t);
    EXECUTE pg_catalog.format($p$CREATE POLICY %I ON crove_kernel.%I AS RESTRICTIVE FOR DELETE TO crove_tenant
      USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
        OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %I.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))$p$,
      t || '_delete', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The webhook's pending notices (no tenant column: the org is found by the worker from the stored connection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_inbound_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  body bytea NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 262144),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- The worker's lease: a notice a crashed worker held is claimed again once it passes, up to 5 times, then dropped; one older than 7
  -- days is dropped whoever holds it.
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
REVOKE ALL ON crove_kernel.conversation_inbound_pending FROM PUBLIC;
ALTER TABLE crove_kernel.conversation_inbound_pending ENABLE ROW LEVEL SECURITY;
-- An agent context writes none of it (ADR-0029): the guard every table carries.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.conversation_inbound_pending');

-- Stores a notice the API verified, for the worker. Reads nothing and writes no tenant data. Past 10000 waiting notices it
-- raises 53400 (configuration_limit_exceeded), which the API answers with 503 so the platform retries later.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_inbound_enqueue(p_provider text, p_body bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_seq bigint;
BEGIN
  -- The count and the insert are one step: concurrent calls near the limit queue here, so the cap holds exactly.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove.conversation_inbound_enqueue', 0));
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_kernel.conversation_inbound_pending LIMIT 10001) s) > 10000 THEN
    RAISE EXCEPTION 'CONVERSATION_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) VALUES (p_provider, p_body) RETURNING seq INTO v_seq;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_seq;
END $$;

-- The worker takes the oldest waiting notices under a lease. Two kinds of notice never come back as a body, because a body is
-- personal data of a third party and must not outlive its use: one claimed 5 times without being finished (a poison notice
-- must not block the rest), and one waiting longer than 7 days (a worker that was down that long would otherwise hold the
-- bodies indefinitely). Both are deleted here and returned with dropped and the reason, so the worker logs and alerts with the
-- ids only.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_inbound_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (seq bigint, provider text, body bytea, attempts integer, dropped boolean, reason text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH expired AS (
    DELETE FROM crove_kernel.conversation_inbound_pending p WHERE p.received_at < pg_catalog.now() - pg_catalog.make_interval(days => 7)
    RETURNING p.seq, p.provider, p.attempts
  ), due AS (
    SELECT p.seq FROM crove_kernel.conversation_inbound_pending p
    WHERE (p.claimed_until IS NULL OR p.claimed_until < pg_catalog.now()) AND p.received_at >= pg_catalog.now() - pg_catalog.make_interval(days => 7)
    ORDER BY p.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), poison AS (
    DELETE FROM crove_kernel.conversation_inbound_pending p USING due WHERE p.seq = due.seq AND p.attempts >= 5
    RETURNING p.seq, p.provider, p.attempts
  ), taken AS (
    UPDATE crove_kernel.conversation_inbound_pending p
    SET claimed_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), attempts = p.attempts + 1
    FROM due WHERE p.seq = due.seq AND p.attempts < 5
    RETURNING p.seq, p.provider, p.body, p.attempts
  )
  SELECT t.seq, t.provider, t.body, t.attempts, false, NULL::text FROM taken t
  UNION ALL
  SELECT d.seq, d.provider, NULL::bytea, d.attempts, true, 'poison'::text FROM poison d
  UNION ALL
  SELECT e.seq, e.provider, NULL::bytea, e.attempts, true, 'expired'::text FROM expired e
  ORDER BY 1
$$;

-- The worker has stored a notice: it goes at once.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_inbound_done(p_seq bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM crove_kernel.conversation_inbound_pending WHERE seq = p_seq
$$;

-- The active connections of active orgs that a platform's own account id names: where a notice goes. The org comes from
-- here, never from the notice (ADR-0039).
CREATE OR REPLACE FUNCTION crove_kernel.conversation_connections_for(p_provider text, p_account text)
RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.provider = p_provider AND c.external_account_id = p_account AND c.status = 'active'
  ORDER BY c.org_id, c.id
$$;

-- Outbound messages a worker began sending and never finished: the call was started more than 10 minutes ago, so the worker is gone
-- or the answer was lost. The worker's sweep settles each as unclear for a person (kernel.conversation.reply_begin does it).
CREATE INDEX IF NOT EXISTS conversation_message_sending_idx ON crove_kernel.conversation_message (sent_at) WHERE send_state = 'sending';
CREATE OR REPLACE FUNCTION crove_kernel.conversation_stale_sends(p_limit integer)
RETURNS TABLE (org_id uuid, message_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, m.id FROM crove_kernel.conversation_message m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  WHERE m.direction = 'out' AND m.send_state = 'sending'
    AND EXISTS (SELECT 1 FROM crove_kernel.external_call c
                WHERE c.org_id = m.org_id AND c.key = 'conversation.reply:' || m.id::text || ':' || m.send_attempt::text
                  AND c.state = 'started' AND c.started_at < pg_catalog.now() - pg_catalog.make_interval(mins => 10))
  ORDER BY m.sent_at LIMIT p_limit
$$;

-- The API login's alone enqueues; the worker login's alone claims, finishes and finds connections.
REVOKE ALL ON FUNCTION crove_kernel.conversation_inbound_enqueue(text, bytea), crove_kernel.conversation_inbound_claim(integer, integer),
  crove_kernel.conversation_inbound_done(bigint), crove_kernel.conversation_connections_for(text, text), crove_kernel.conversation_stale_sends(integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_inbound_enqueue(text, bytea) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_inbound_claim(integer, integer), crove_kernel.conversation_inbound_done(bigint),
  crove_kernel.conversation_connections_for(text, text), crove_kernel.conversation_stale_sends(integer) TO crove_worker;

-- The reply job: one queue, ids only in its data (a reply's text is read from the message row, not carried).
SELECT crove_jobs.create_queue('kernel-conversation-reply', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
