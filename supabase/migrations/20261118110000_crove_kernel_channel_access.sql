-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: the per-channel limit of a member, moved from Social to the kernel (conversation core, #2303, plan
-- docs/plan/conversations.md section 8). Idempotent; applied files stay untouched.
--
-- crove_kernel.channel_access  a channel connection a member or viewer may use. Exactly the table crove_social.channel_access
--                              was (#1081): a member with any row is limited to the channels of their rows, whatever the
--                              status of those connections; a member with none uses every channel; owners and admins are
--                              never limited, whatever rows exist. Owners and admins replace a member's list with the
--                              command social.channel_access.set (the command checks the role); a member's rows go with the
--                              member, and a connection's rows with the connection.
--
-- Why it moves: the conversation core is the kernel's, and the kernel cannot read a module's schema. The core's row-level
-- policies ask this table whether a limited member may read a conversation of a channel (plan section 8), so a freelancer
-- limited to one client's channels reads no other channel's comments or messages, in the database and not only on screen.
-- Social reads and writes the kernel's table from now on, with no change in behaviour; the rows are copied once and the
-- Social table is dropped.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.channel_access (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_access_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT channel_access_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_access_member_connection_uq ON crove_kernel.channel_access (org_id, user_id, channel_connection_id);
CREATE INDEX IF NOT EXISTS channel_access_connection_idx ON crove_kernel.channel_access (org_id, channel_connection_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.channel_access');
-- A row is added and removed, never changed.
REVOKE UPDATE ON crove_kernel.channel_access FROM crove_tenant;
-- The table is now the database's own channel limit (the conversation policies read it), so who may change it is held here too and
-- not only by the command: owners and admins and the system context add and remove rows; a member never changes a list.
DROP POLICY IF EXISTS channel_access_insert ON crove_kernel.channel_access;
CREATE POLICY channel_access_insert ON crove_kernel.channel_access AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_access.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS channel_access_delete ON crove_kernel.channel_access;
CREATE POLICY channel_access_delete ON crove_kernel.channel_access AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_access.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- One copy, then the Social table goes (a run after it is dropped finds nothing to copy).
DO $$
BEGIN
  IF pg_catalog.to_regclass('crove_social.channel_access') IS NOT NULL THEN
    INSERT INTO crove_kernel.channel_access (org_id, id, user_id, channel_connection_id, created_by, created_at)
    SELECT s.org_id, s.id, s.user_id, s.channel_connection_id, s.created_by, s.created_at FROM crove_social.channel_access s
    ON CONFLICT DO NOTHING;
    -- crove:contract adr=0041
    -- migration-lint: cross-module the per-channel limit moves from Social to the kernel (ADR-0041, #2303): its rows were copied just above and Social now reads the kernel's table
    DROP TABLE crove_social.channel_access;
  END IF;
END $$;
