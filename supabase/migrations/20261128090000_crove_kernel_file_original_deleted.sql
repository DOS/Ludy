-- SPDX-License-Identifier: AGPL-3.0-only
-- The marker of a deleted original file (#2516 step C-2b3, ADR-0045 point 8): crove_kernel.file.original_deleted_at says the bytes of a file are gone while its row stays (its sha256,
-- name and size, so the same bytes are still recognised). It moves once, from NULL to a time, and only for the worker acting as the system, through the definer
-- crove_finance.marketplace_retention_apply (20261128100000_crove_finance_marketplace_retention.sql), which also checks the kind and the age. Every other change of it is refused here.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS original_deleted_at timestamptz;

-- original_deleted_at moves once, from NULL to a time, and only for the worker acting as the system (the definer below). Every other change to it, and any attempt to set it
-- back, is refused. A separate trigger, so file_guard (the reference that never changes) stays as it is.
CREATE OR REPLACE FUNCTION crove_kernel.file_original_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.original_deleted_at IS DISTINCT FROM OLD.original_deleted_at THEN
    IF OLD.original_deleted_at IS NOT NULL
       OR NEW.original_deleted_at IS NULL
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
