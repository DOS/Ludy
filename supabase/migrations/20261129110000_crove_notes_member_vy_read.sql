-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove notes (issue #2756, ADR-0049 stage B): a member-scoped context reads its member's notes. Idempotent; applied files stay untouched.
--   crove_notes.note_read   reads ctx_acting_user_id() where it read ctx_user_id(): the member-scoped background context of Vy reads its
--                           member's notes and the shared ones the member may read, and writes none (note_insert and note_update are
--                           untouched). The catalog row of this opt-in is member_vy_table in 20261129100000.
SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS note_read ON crove_notes.note;
CREATE POLICY note_read ON crove_notes.note AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_acting_user_id())
    OR (visibility = 'org' AND (
      ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
      OR ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_acting_user_id()) AND m.role IN ('owner', 'admin', 'member'))))));

