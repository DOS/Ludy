-- SPDX-License-Identifier: AGPL-3.0-only
-- Defer ludy_kernel.ctx_org_id() HMAC verification until needed and gate contextless bypass in
-- ludy_sign.envelope_minutes_revision() (#4755, follow-up of #4726).
--   - On UPDATE OF source_revision or non-meeting_minutes INSERTs, skip ludy_kernel.ctx_org_id() so
--     ludy_kernel.ctx_verified() does not run unnecessary HMAC verification.
--   - On meeting_minutes INSERTs with no context (v_ctx_org IS NULL), only superuser, BYPASSRLS,
--     or table-owner roles may compute the real minutes revision; unprivileged callers short-circuit
--     NEW.source_revision to 'legacy' before RLS rejects the statement.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_sign.envelope_minutes_revision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid;
  v_privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'meeting_minutes' THEN
      v_ctx_org := ludy_kernel.ctx_org_id();
      IF v_ctx_org IS NOT NULL AND NEW.org_id IS DISTINCT FROM v_ctx_org THEN
        NEW.source_revision := 'legacy';
        RETURN NEW;
      END IF;
      IF v_ctx_org IS NULL THEN
        SELECT r.rolsuper
               OR r.rolbypassrls
               OR pg_catalog.pg_has_role(
                 r.oid,
                 (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID),
                 'USAGE'
               )
          INTO v_privileged
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = SESSION_USER;
        IF NOT COALESCE(v_privileged, false) THEN
          NEW.source_revision := 'legacy';
          RETURN NEW;
        END IF;
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
