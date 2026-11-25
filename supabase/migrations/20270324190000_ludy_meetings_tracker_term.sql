-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings keyword trackers (#4818): the keywords and phrases an org keeps (competitor names, "giá", "hợp đồng") to see how often they come up in its meetings. Idempotent; applied files stay
-- untouched. The org_purge restatement that deletes the new table is its own file (20270324190100_ludy_kernel_org_purge_tracker_term.sql).
--
-- ludy_meetings.tracker_term  one keyword or phrase of an org: the same shape as a glossary term (ludy_meetings.glossary_term_ok: 1 to 40 characters of plain text, no address, no run of digits).
--                             Every member of the org reads the list (a meeting shows its hits to whoever reads it, and a viewer must know the words to read the count), an owner or admin adds and
--                             removes; nobody edits a term (a changed word is a removed one and a new one). Every policy admits a user context only: an agent context (a member Vy run included), the
--                             system context and the sealed company context read and write none. At most 20 terms an org (the command counts under a lock; the database keeps the shape).
--                             The table holds the words an owner chose, never a meeting's text: the hits are counted by code, in the viewer's own transaction, from the lines that viewer may read.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.tracker_term (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  term text NOT NULL CHECK (ludy_meetings.glossary_term_ok(term)),
  created_by uuid NOT NULL REFERENCES ludy_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);

-- One row per term in an org, whatever the case.
CREATE UNIQUE INDEX IF NOT EXISTS tracker_term_term_idx ON ludy_meetings.tracker_term (org_id, pg_catalog.lower(term));

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.tracker_term');
-- A term is added or removed, never edited.
REVOKE UPDATE ON ludy_meetings.tracker_term FROM ludy_tenant;

-- Every member of the org (owner, admin, member), in a user context, reads.
DROP POLICY IF EXISTS tracker_term_read ON ludy_meetings.tracker_term;
CREATE POLICY tracker_term_read ON ludy_meetings.tracker_term AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = tracker_term.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
  );
-- An owner or admin of the org, in a user context, adds a term in their own name.
DROP POLICY IF EXISTS tracker_term_insert ON ludy_meetings.tracker_term;
CREATE POLICY tracker_term_insert ON ludy_meetings.tracker_term AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = tracker_term.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))
  );
-- An owner or admin removes a term.
DROP POLICY IF EXISTS tracker_term_delete ON ludy_meetings.tracker_term;
CREATE POLICY tracker_term_delete ON ludy_meetings.tracker_term AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = tracker_term.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))
  );
