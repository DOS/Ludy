-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, Notes v2 E4 (issue #3560, plan docs/plan/notes-v2.md section 5): add the `notes` scope to the Ludy
-- browser extension token, allowing standalone `notes` scope or combined `meetings`/`notes` scopes (`agenda` still rides
-- with `meetings`). Idempotent; applied files stay untouched.
--
-- crove_kernel.extension_token.scopes and extension_auth_code.scopes
--                              The CHECK that lists the scopes a token may hold accepts `notes` next to `meetings` and
--                              `agenda`. Existing tokens keep their scopes unchanged and keep working.
-- crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text)
--                              Same body as 20270101040000 with `notes` added to the allowed scope list (`notes` may be
--                              requested alone or combined with `meetings` / `agenda`; `agenda` still requires `meetings`).
--                              Grants are preserved by CREATE OR REPLACE.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  v_table text;
  v_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['extension_token', 'extension_auth_code'] LOOP
    -- Already widened for notes: nothing to do on re-run.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = ('crove_kernel.' || v_table)::pg_catalog.regclass AND contype = 'c' AND conname = v_table || '_scopes_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%notes%'
    ) THEN
      CONTINUE;
    END IF;
    FOR v_name IN
      SELECT conname FROM pg_catalog.pg_constraint
      WHERE conrelid = ('crove_kernel.' || v_table)::pg_catalog.regclass AND contype = 'c'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%scopes%<@%'
    LOOP
      EXECUTE pg_catalog.format('ALTER TABLE crove_kernel.%I DROP CONSTRAINT %I', v_table, v_name);
    END LOOP;
    EXECUTE pg_catalog.format(
      'ALTER TABLE crove_kernel.%I ADD CONSTRAINT %I CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY[''meetings'', ''agenda'', ''notes'']::text[])',
      v_table, v_table || '_scopes_check');
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.issue_extension_auth_code(
  p_code_hash bytea, p_code_challenge text, p_method text, p_scopes text[], p_device_name text, p_extension_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_scopes text[];
  v_device text := pg_catalog.btrim(p_device_name);
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_method IS DISTINCT FROM 'S256'
     OR p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 8
     OR NOT (p_scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[])
     OR ('agenda' = ANY (p_scopes) AND NOT ('meetings' = ANY (p_scopes)))
     OR v_device IS NULL OR pg_catalog.char_length(v_device) NOT BETWEEN 1 AND 80
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  DELETE FROM crove_kernel.extension_auth_code c WHERE c.org_id = v_org AND c.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT pg_catalog.count(*) FROM crove_kernel.extension_auth_code c
      WHERE c.org_id = v_org AND c.user_id = v_user AND c.consumed_at IS NULL AND c.expires_at > pg_catalog.now()) >= 10 THEN
    RAISE EXCEPTION 'EXTENSION_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
  VALUES (v_org, v_user, p_code_hash, p_code_challenge, 'S256', v_scopes, v_device, p_extension_id, pg_catalog.now(), pg_catalog.now() + interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
