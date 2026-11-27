-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Notes (#5127, split from #5122):
--   1) Partial composite index supporting keyset spring-forward sibling scans on recurring todos (modules/notes/src/todos.ts).
--   2) Owner-only count helper for private note attachments whose text extraction failed (extract_status = 'failed'),
--      matching private_pending_attachment_count() without disclosing filenames, text, note ids, or authors.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS todo_series_tz_created_idx
  ON ludy_notes.todo (org_id, owner_user_id, series_id, time_zone, created_at DESC, id DESC)
  WHERE series_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ludy_notes.private_failed_attachment_count()
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT pg_catalog.count(*)::bigint
      FROM ludy_notes.attachment a
      JOIN ludy_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org
       AND n.visibility = 'private'
       AND a.extract_status = 'failed'
  );
END $$;

REVOKE ALL ON FUNCTION ludy_notes.private_failed_attachment_count() FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_catalog.pg_roles
     WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%' OR rolname IN ('anon', 'authenticated', 'service_role'))
       AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.private_failed_attachment_count() FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_notes.private_failed_attachment_count() TO ludy_tenant;
