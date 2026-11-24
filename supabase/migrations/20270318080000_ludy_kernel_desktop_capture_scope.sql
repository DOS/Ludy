-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Desktop capture scopes (ADR-0055 slice 3, issue #4516). Idempotent; applied files stay untouched.
--
-- Slice 2 (#4515) limited desktop tokens and auth codes (`client = 'desktop'`, reserved id `abababababababababababababababab`)
-- to an empty scope list. Slice 3 lets a deployment with MEETINGS_DESKTOP_CAPTURE=on grant Ludy Desktop the meetings and
-- agenda scopes so it can open a call capture, create a meeting, stream live pieces and upload the recording. `notes` stays
-- forbidden for desktop tokens. Off by default in the HTTP edge until #2585 legal answers land; this migration updates the
-- schema checks and issue_extension_auth_code validator cleanly forward.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'ludy_kernel.extension_token'::pg_catalog.regclass
    AND conname = 'extension_token_scopes_check';
  IF v_def IS NULL OR v_def LIKE '%cardinality(scopes) = 0%' THEN
    ALTER TABLE ludy_kernel.extension_token DROP CONSTRAINT IF EXISTS extension_token_scopes_check;
    ALTER TABLE ludy_kernel.extension_token ADD CONSTRAINT extension_token_scopes_check
      CHECK (
        pg_catalog.cardinality(scopes) <= 8
        AND scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[]
        AND (
          (client = 'extension' AND pg_catalog.cardinality(scopes) >= 1)
          OR (client = 'desktop' AND scopes <@ ARRAY['meetings', 'agenda']::text[])
        )
      );
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'ludy_kernel.extension_auth_code'::pg_catalog.regclass
    AND conname = 'extension_auth_code_scopes_check';
  IF v_def IS NULL OR v_def LIKE '%cardinality(scopes) = 0%' THEN
    ALTER TABLE ludy_kernel.extension_auth_code DROP CONSTRAINT IF EXISTS extension_auth_code_scopes_check;
    ALTER TABLE ludy_kernel.extension_auth_code ADD CONSTRAINT extension_auth_code_scopes_check
      CHECK (
        pg_catalog.cardinality(scopes) <= 8
        AND scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[]
        AND (
          (extension_id = 'abababababababababababababababab' AND scopes <@ ARRAY['meetings', 'agenda']::text[])
          OR (extension_id IS DISTINCT FROM 'abababababababababababababababab' AND pg_catalog.cardinality(scopes) >= 1)
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- issue_extension_auth_code: desktop may hold no scopes or meetings/agenda
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_kernel.issue_extension_auth_code(
  p_code_hash bytea, p_code_challenge text, p_method text, p_scopes text[], p_device_name text, p_extension_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_scopes text[];
  v_device text := pg_catalog.btrim(p_device_name);
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_method IS DISTINCT FROM 'S256'
     OR p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 0 AND 8
     OR (pg_catalog.cardinality(p_scopes) = 0 AND p_extension_id IS DISTINCT FROM 'abababababababababababababababab')
     OR (p_extension_id IS NOT DISTINCT FROM 'abababababababababababababababab' AND NOT (p_scopes <@ ARRAY['meetings', 'agenda']::text[]))
     OR NOT (p_scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[])
     OR ('agenda' = ANY (p_scopes) AND NOT ('meetings' = ANY (p_scopes)))
     OR v_device IS NULL OR pg_catalog.char_length(v_device) NOT BETWEEN 1 AND 80
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s ORDER BY s), ARRAY[]::text[]) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  DELETE FROM ludy_kernel.extension_auth_code c WHERE c.org_id = v_org AND c.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT pg_catalog.count(*) FROM ludy_kernel.extension_auth_code c
      WHERE c.org_id = v_org AND c.user_id = v_user AND c.consumed_at IS NULL AND c.expires_at > pg_catalog.now()) >= 10 THEN
    RAISE EXCEPTION 'EXTENSION_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO ludy_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
  VALUES (v_org, v_user, p_code_hash, p_code_challenge, 'S256', v_scopes, v_device, p_extension_id, pg_catalog.now(), pg_catalog.now() + interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user AND rolname <> 'ludy_app' LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text) TO ludy_app;
