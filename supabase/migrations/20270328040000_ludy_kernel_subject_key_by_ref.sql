-- SPDX-License-Identifier: AGPL-3.0-only
-- Look up one subject's wrapped key by its reference (#3751), without creating a key when missing or shredded.
-- Same context and access rules as ludy_kernel.subject_key_wrapped(uuid[]): signed-in user of the org in context, API login only.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.subject_key_by_ref(p_ref text)
RETURNS TABLE (id uuid, key_id text, wrapped_key bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id()
  ) THEN
    RAISE EXCEPTION 'SUBJECT_KEY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT k.id, k.key_id, k.wrapped_key FROM ludy_kernel.subject_key k WHERE k.org_id = v_org AND k.ref = p_ref;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.subject_key_by_ref(text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.subject_key_by_ref(text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.subject_key_by_ref(text) TO ludy_app;
