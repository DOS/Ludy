-- SPDX-License-Identifier: AGPL-3.0-only
-- The marker of a deleted original file (#2516 step C-2b3, ADR-0045 point 8): crove_kernel.file.original_deleted_at says the bytes of a file are gone while its row stays (its sha256,
-- name and size, so the same bytes are still recognised). It moves once, from NULL to a time, and only for the worker acting as the system, through the definer
-- crove_finance.marketplace_retention_apply (20261128100000_crove_finance_marketplace_retention.sql), which also checks the kind and the age. The same bytes uploaded again (the object is
-- content addressed, so it lands under the same key and the file is a duplicate) bring the original back: crove_kernel.file_original_restore clears the marker, and the nightly run
-- deletes that copy again, so a restored original is never kept past the next run. Every other change of the marker is refused here.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS original_deleted_at timestamptz;

-- original_deleted_at moves from NULL to a time only when the login role is a member of crove_worker and the sealed context is a system actor (in practice the retention definer; the
-- trigger cannot tell which function runs it), and back to NULL only inside a SECURITY DEFINER function (file_original_restore below: SESSION_USER differs from CURRENT_USER there;
-- another definer could do it too, so the trigger is a backstop, not an authorization: who may call a definer is the definer's own check). Every other change is refused. A separate trigger, so file_guard (the reference that never changes) stays as it is.
CREATE OR REPLACE FUNCTION crove_kernel.file_original_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.original_deleted_at IS DISTINCT FROM OLD.original_deleted_at THEN
    IF NEW.original_deleted_at IS NULL THEN
      IF SESSION_USER = CURRENT_USER THEN
        RAISE EXCEPTION 'FILE_ORIGINAL_DELETED_IMMUTABLE' USING ERRCODE = '42501';
      END IF;
    ELSIF OLD.original_deleted_at IS NOT NULL
       OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
       OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'FILE_ORIGINAL_DELETED_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS file_original_guard ON crove_kernel.file;
CREATE TRIGGER file_original_guard BEFORE UPDATE ON crove_kernel.file
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.file_original_guard();
REVOKE ALL ON FUNCTION crove_kernel.file_original_guard() FROM PUBLIC;

-- The original is back in the store (the same bytes were uploaded or mailed again): the marker is cleared, in the caller's own org only, so the file can be read again and the nightly
-- run deletes this copy once the decision is old enough. Called by kernel.file.ingest when it answers a duplicate. False when the file had no marker.
CREATE OR REPLACE FUNCTION crove_kernel.file_original_restore(p_file_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'FILE_ORIGINAL_RESTORE_NO_ORG' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.file f SET original_deleted_at = NULL
  WHERE f.org_id = v_org AND f.id = p_file_id AND f.original_deleted_at IS NOT NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_kernel.file_original_restore(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.file_original_restore(uuid) TO crove_app, crove_worker;
