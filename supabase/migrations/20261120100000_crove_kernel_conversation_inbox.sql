-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2306, plan docs/plan/conversations.md CV3): the Inbox. Idempotent; applied files stay untouched.
--
-- 1. The permission to read private messages, kernel.conversation.direct.read, is seeded for desk.agent. conversation_access already asks for it
--    (kind direct), so owners, admins and desk.agent holders read and write private messages and a member without the role never does; the
--    per-channel limit still applies. A viewer cannot hold the role (role_assignment_grant refuses a role with permissions for a viewer).
-- 2. crove_kernel.member_availability  one row per member who set it: available or away, optionally until a time. No row means available. It decides
--                           whom a new conversation is told to. Every member reads it; a member writes their own row.
-- 3. crove_kernel.conversation_composing  the "you are replying" marker: who is typing a reply to a thread, for 60 seconds. One row per thread and
--                           member. Read by those who read the thread (conversation_access), written by a member who may write it, in their own
--                           name. The screens read it with their six-second poll; a sweep removes the expired rows.
-- 4. crove_kernel.conversation_readers(conversation)  the members a new conversation is told to: the members who read it by the same rule as
--                           conversation_access (owners and admins; members for a comment thread, or for a private message when they hold the
--                           permission; the channel limit applied; never a viewer), with whether each is available now. Worker login, in an org's
--                           system context. It answers user ids only.
-- 5. crove_kernel.conversation_composing_sweep()  drops markers that expired more than five minutes ago. Worker login only.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. desk.agent reads private messages
-- ---------------------------------------------------------------------------
INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES
  ('desk.agent', 'kernel.conversation.direct.read')
ON CONFLICT (role_key, permission) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Availability
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.member_availability (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'away')),
  -- While away: back at this time (null: until the member says so).
  until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT member_availability_user_uq UNIQUE (org_id, user_id),
  CONSTRAINT member_availability_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_availability');
REVOKE UPDATE ON crove_kernel.member_availability FROM crove_tenant;
GRANT UPDATE (status, until, updated_at) ON crove_kernel.member_availability TO crove_tenant;
-- A member writes their own row, nobody else's (the system context may write, as for conversation_read, but no command of it does).
DROP POLICY IF EXISTS member_availability_insert ON crove_kernel.member_availability;
CREATE POLICY member_availability_insert ON crove_kernel.member_availability AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system'));
DROP POLICY IF EXISTS member_availability_update ON crove_kernel.member_availability;
CREATE POLICY member_availability_update ON crove_kernel.member_availability AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system'))
  WITH CHECK ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system'));
DROP POLICY IF EXISTS member_availability_delete ON crove_kernel.member_availability;
CREATE POLICY member_availability_delete ON crove_kernel.member_availability AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system'));

-- ---------------------------------------------------------------------------
-- 3. The "you are replying" marker
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_composing (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  conversation_id uuid NOT NULL,
  -- The thread's own channel and kind, so the database decides who reads a marker by the same rule as its thread.
  channel_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_thread', 'direct')),
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_composing_member_uq UNIQUE (org_id, conversation_id, user_id),
  CONSTRAINT conversation_composing_thread_fk FOREIGN KEY (org_id, conversation_id, channel_connection_id, kind)
    REFERENCES crove_kernel.conversation (org_id, id, channel_connection_id, kind) ON DELETE CASCADE,
  CONSTRAINT conversation_composing_user_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);
-- Back the thread's and the member's foreign keys (led by the same columns).
CREATE INDEX IF NOT EXISTS conversation_composing_thread_idx ON crove_kernel.conversation_composing (org_id, conversation_id, channel_connection_id, kind);
CREATE INDEX IF NOT EXISTS conversation_composing_user_idx ON crove_kernel.conversation_composing (org_id, user_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_composing');
REVOKE UPDATE ON crove_kernel.conversation_composing FROM crove_tenant;
GRANT UPDATE (expires_at, updated_at) ON crove_kernel.conversation_composing TO crove_tenant;
-- Read by those who read the thread (its channel limit and the direct-message permission included); written by those who may write it, in their own
-- name (the system context may write, as for conversation_read, but no command of it does).
DROP POLICY IF EXISTS conversation_composing_scope ON crove_kernel.conversation_composing;
CREATE POLICY conversation_composing_scope ON crove_kernel.conversation_composing AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false));
DROP POLICY IF EXISTS conversation_composing_insert ON crove_kernel.conversation_composing;
CREATE POLICY conversation_composing_insert ON crove_kernel.conversation_composing AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system') AND crove_kernel.conversation_access(kind, channel_connection_id, true));
DROP POLICY IF EXISTS conversation_composing_update ON crove_kernel.conversation_composing;
CREATE POLICY conversation_composing_update ON crove_kernel.conversation_composing AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system') AND crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system') AND crove_kernel.conversation_access(kind, channel_connection_id, true));
-- A member removes their own marker (when they send or leave the box); every other removal is the sweep's or the thread's cascade.
DROP POLICY IF EXISTS conversation_composing_delete ON crove_kernel.conversation_composing;
CREATE POLICY conversation_composing_delete ON crove_kernel.conversation_composing AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((user_id = (SELECT crove_kernel.ctx_user_id()) OR (SELECT crove_kernel.ctx_actor_type()) = 'system'));

-- ---------------------------------------------------------------------------
-- 4. Whom a new conversation is told to (worker login only)
-- ---------------------------------------------------------------------------
-- The same rule as conversation_access for reading, for every member of the org in the system context: owners and admins; a member for a comment
-- thread, or for a private message when an org-wide assignment gives them kernel.conversation.direct.read; the channel limit (no rows of
-- channel_access for the member means every channel, else only the listed ones). Never a viewer: a viewer cannot reply. `available` is the member's
-- switch (no row: available; away until a time that has not passed: not available).
CREATE OR REPLACE FUNCTION crove_kernel.conversation_readers(p_conversation uuid)
RETURNS TABLE (user_id uuid, available boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR crove_kernel.ctx_org_id() IS NULL THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id,
         (COALESCE(a.status, 'available') = 'available' AND (a.until IS NULL OR a.until > pg_catalog.now()))
  FROM crove_kernel.conversation c
  JOIN crove_kernel.tenant_member m ON m.org_id = c.org_id
  LEFT JOIN crove_kernel.member_availability a ON a.org_id = m.org_id AND a.user_id = m.user_id
  WHERE c.org_id = crove_kernel.ctx_org_id() AND c.id = p_conversation
    AND (m.role IN ('owner', 'admin')
         OR (m.role = 'member'
             AND (c.kind = 'comment_thread'
                  OR EXISTS (SELECT 1 FROM crove_kernel.role_assignment ra
                             JOIN crove_kernel.role_permission rp ON rp.role_key = ra.role_key
                             WHERE ra.org_id = m.org_id AND ra.user_id = m.user_id AND ra.legal_entity_id IS NULL
                               AND rp.permission = 'kernel.conversation.direct.read'))
             AND (NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access x WHERE x.org_id = m.org_id AND x.user_id = m.user_id)
                  OR EXISTS (SELECT 1 FROM crove_kernel.channel_access x
                             WHERE x.org_id = m.org_id AND x.user_id = m.user_id AND x.channel_connection_id = c.channel_connection_id))))
  ORDER BY m.user_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_readers(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_readers(uuid) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 5. The sweep of expired markers (worker login only)
-- ---------------------------------------------------------------------------
-- A marker lives 60 seconds and readers ignore it after; the sweep drops the rows five minutes after they expired.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_composing_sweep() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.conversation_composing c WHERE c.expires_at < pg_catalog.now() - pg_catalog.make_interval(mins => 5);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_composing_sweep() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_composing_sweep() TO crove_worker;
