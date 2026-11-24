-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes review-followup (#4229, PR #4199 follow-up): require whole-org legal-entity scope
-- ('*' = ANY (ludy_kernel.ctx_le_scope())) when authors insert or update a shared ('org')
-- note template in ludy_notes.note_template, matching ludy_notes.notebook parity.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS note_template_insert ON ludy_notes.note_template;
CREATE POLICY note_template_insert ON ludy_notes.note_template AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_agent_id()) IS NULL
    AND author_user_id = (SELECT ludy_kernel.ctx_user_id())
    AND (visibility = 'private' OR '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = note_template.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- Keep USING open to the author so a member whose scope later narrows to a branch can still
-- demote their own shared ('org') template to 'private' (matching notebook_update), while
-- WITH CHECK refuses any insert/update leaving visibility = 'org' without whole-org scope.
DROP POLICY IF EXISTS note_template_update ON ludy_notes.note_template;
CREATE POLICY note_template_update ON ludy_notes.note_template AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT ludy_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT ludy_kernel.ctx_user_id())
        AND (visibility = 'private' OR '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  );
