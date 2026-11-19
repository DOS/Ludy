-- SPDX-License-Identifier: AGPL-3.0-only
-- What a sealed MCP grant context may read of Hộp thư (#3858, slice b; ADR-0051 decisions 10 to 12, owner decision 2026-11-18/19). READ ONLY. Two more ways in, for the sealed contexts of an MCP grant and for
-- nothing else, on the two policies that decide who reads a conversation and its messages:
--   a company grant (kind `mcp_company`, an owner's or admin's; the whole-org scope '*', a little stricter than a person, whose conversation_access ignores the entity scope)
--                        reads every conversation of its org and their messages, of every kind (comment thread, private message, email): the rights of the owner or admin who made the grant;
--   a member-bound grant (kind `mcp_member`, ADR-0049 member mode)
--                        reads exactly what its member may read, worked out in the database from the sealed member: the base role (owner and admin everything; a member the comment threads of the
--                        channels they are limited to, or of all channels when no limit is set; private messages and email only with `kernel.conversation.direct.read`; a viewer the comment threads of their
--                        channels), by crove_kernel.conversation_access_mcp_member(kind, connection), which asks ctx_mcp_member_id() and so answers false to every other context.
-- The function is a definer because member_has_permission refuses a tenant login that asks about anyone but itself (PERMISSION_QUERY_FORBIDDEN), and a sealed member context has no user to ask for; it reads only through the
-- org of the context and the sealed member (ctx_org_id, ctx_mcp_member_id) and returns a boolean, never a row, so it cannot be steered to another org or member.
-- The sealed company context is also the one the wake worker enters for a signal sweep (enter_mcp_wake_company_context seals the same kind), so that entry gains this read as well; it is read only there too.
-- A member grant now reads private messages and email of its member without a row in mcp_member_table: that catalog is for tables private to one member (notes), and these are org tables read by member rights; the
-- owner decision of 2026-11-18/19 (a grant reads conversations and CRM within its role and member binding) is what lifts the 2026-11-13 hold for them. Both per-row calls are wrapped in a sub-select so the
-- sealed context is verified once per statement, not once per row.
-- Nothing else changes for anyone: the person branch (crove_kernel.conversation_access) is untouched. The notes of a thread and the identity of a contact are read through the thread's own row (their
-- policies ask for a readable thread), so they follow for free and their write checks still refuse an agent; attachments, drafts, composing markers and read marks ask conversation_access directly and stay
-- closed to a grant, as does every other table of the module. CRM rows (party, deal, quote, booking) carry only the org policy, so a sealed context already reads its own org's rows and no other, and
-- every write of an agent context is refused by crove_kernel.agent_write_guard; test/invariant/mcp-grant-read.db.test.ts pins both.
-- The two read policies of each table replace its one FOR ALL policy: the write checks are restated unchanged (insert and update with the same WITH CHECK, update and delete with the same USING), the
-- read branch is the only addition, and the kind is compared inline (`ctx_verified() ->> 'kind'`) because no function may name the company kind (mcp-company-context.db.test.ts). No policy of this migration
-- holds the string 'member' or reads ctx_acting_user_id, so the net of member-vy-background.db.test.ts does not flag them.
-- Idempotent (create or replace, drop and create).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.conversation_access_mcp_member(p_kind text, p_connection_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN m.role IN ('owner', 'admin') THEN true
      WHEN p_kind IN ('direct', 'email') AND NOT COALESCE(crove_kernel.member_has_permission(m.org_id, m.user_id, 'kernel.conversation.direct.read'), false) THEN false
      WHEN p_kind NOT IN ('direct', 'comment_thread', 'email') THEN false
      ELSE NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
        OR EXISTS (SELECT 1 FROM crove_kernel.channel_access a
                   WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.channel_connection_id = p_connection_id)
    END
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_mcp_member_id()), false)
$$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_access_mcp_member(text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_access_mcp_member(text, uuid) TO crove_tenant;

-- conversation
DROP POLICY IF EXISTS conversation_scope ON crove_kernel.conversation;
DROP POLICY IF EXISTS conversation_scope_read ON crove_kernel.conversation;
CREATE POLICY conversation_scope_read ON crove_kernel.conversation AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    crove_kernel.conversation_access(kind, channel_connection_id, false)
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_member_id()) IS NOT NULL
      AND crove_kernel.conversation_access_mcp_member(kind, channel_connection_id)
    )
  );
DROP POLICY IF EXISTS conversation_scope_insert ON crove_kernel.conversation;
CREATE POLICY conversation_scope_insert ON crove_kernel.conversation AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));
DROP POLICY IF EXISTS conversation_scope_update ON crove_kernel.conversation;
CREATE POLICY conversation_scope_update ON crove_kernel.conversation AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));
DROP POLICY IF EXISTS conversation_scope_delete ON crove_kernel.conversation;
CREATE POLICY conversation_scope_delete ON crove_kernel.conversation AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false));

-- conversation_message
DROP POLICY IF EXISTS conversation_message_scope ON crove_kernel.conversation_message;
DROP POLICY IF EXISTS conversation_message_scope_read ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope_read ON crove_kernel.conversation_message AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    crove_kernel.conversation_access(kind, channel_connection_id, false)
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_member_id()) IS NOT NULL
      AND crove_kernel.conversation_access_mcp_member(kind, channel_connection_id)
    )
  );
DROP POLICY IF EXISTS conversation_message_scope_insert ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope_insert ON crove_kernel.conversation_message AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));
DROP POLICY IF EXISTS conversation_message_scope_update ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope_update ON crove_kernel.conversation_message AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));
DROP POLICY IF EXISTS conversation_message_scope_delete ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope_delete ON crove_kernel.conversation_message AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false));
