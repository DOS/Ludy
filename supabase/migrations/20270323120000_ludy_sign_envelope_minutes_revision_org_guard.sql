-- SPDX-License-Identifier: AGPL-3.0-only
-- Guard ludy_sign.envelope_minutes_revision() against cross-org hash lookups on forged BEFORE INSERT statements (#4726).
-- PostgreSQL runs BEFORE INSERT row triggers before evaluating RLS WITH CHECK policies; short-circuiting when
-- ludy_kernel.ctx_org_id() is set and differs from NEW.org_id prevents reading the target org's minutes before
-- RLS aborts the statement, while preserving direct no-context (admin/system) inserts.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_sign.envelope_minutes_revision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'meeting_minutes' THEN
      IF v_ctx_org IS NOT NULL AND NEW.org_id IS DISTINCT FROM v_ctx_org THEN
        NEW.source_revision := 'legacy';
        RETURN NEW;
      END IF;
      NEW.source_revision := COALESCE(ludy_sign.meeting_minutes_revision_raw(NEW.org_id, NEW.source_id), 'legacy');
    ELSE
      NEW.source_revision := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_revision IS DISTINCT FROM OLD.source_revision THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'the minutes revision of an envelope is set when it is created and never changes';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.envelope_minutes_revision() FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_sign.envelope_minutes_revision() FROM %I', r.rolname);
  END LOOP;
END $$;
