-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2640, ADR-0017 sections 2 to 4): the per-subject keys that let a personal value sit in a row that cannot change and still be erased, by deleting the key.
-- Idempotent; applied files stay untouched.
--
-- subject_key  one row per subject (one person as the org knows them), named by `ref` (`employee:<id>`, `member:<user_id>`, `contact:<hmac>`). It holds the subject's data key,
--              WRAPPED by the runtime under a key derived from the deployment's credential key (the key never reaches the database): `key_id` names the credential key that
--              wrapped it and `wrapped_key` is the AES-256-GCM envelope (nonce 12 | tag 16 | wrapped 32 bytes). The values sealed under it live in other tables, as text.
--              Deleting a row is the shredding: the sealed values stay as they were and can no longer be opened. No login role reads or writes the table (as
--              crove_kernel.credential): only the three definers below reach it, each only for the org in the sealed context.
--
--   subject_key_ensure(id, ref, key_id, wrapped)  the subject's row, created from this id and wrapped key when missing; two concurrent calls converge on the first row. Owners, admins and
--                                              members (a user context; never an agent, never the system, never a viewer).
--   subject_key_wrapped(ids)                   the wrapped keys of these subjects in the org. Any member of the org (a user context), for the queries that show sealed values.
--   subject_key_shred(refs)                    deletes these subjects' keys and answers how many. Owners only; called by the erase commands (R3, fresh second factor).
--
-- The worker has no definer: payroll seals and opens only in a user's command or query (ADR-0017 section 4). The org purge deletes an org's keys with the org (the next migration).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.subject_key (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ref text NOT NULL CHECK (ref ~ '^[a-z_]+:[A-Za-z0-9._-]{1,128}$'),
  -- Which credential key wrapped the data key, for rotation: the same id the vault gives the key (crove_kernel.credential.key_id).
  key_id text NOT NULL CHECK (pg_catalog.length(key_id) BETWEEN 1 AND 64),
  -- nonce 12 | tag 16 | wrapped data key 32.
  wrapped_key bytea NOT NULL CHECK (pg_catalog.length(wrapped_key) = 60),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT subject_key_ref_uq UNIQUE (org_id, ref)
);
ALTER TABLE crove_kernel.subject_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.subject_key FROM PUBLIC, crove_tenant, crove_app, crove_worker;
-- An agent context writes only the tables on the allowlist (the table has no grant, so the definers are what reach it; the guard stays on as for every crove table).
SELECT crove_kernel.agent_write_guard_install('crove_kernel.subject_key');

-- Creates the subject's key from p_id and p_wrapped (the runtime draws the id, because the wrap binds it) when it has none, and answers the stored row either way, so the caller opens the key that is stored whichever call won.
CREATE OR REPLACE FUNCTION crove_kernel.subject_key_ensure(p_id uuid, p_ref text, p_key_id text, p_wrapped bytea)
RETURNS TABLE (id uuid, key_id text, wrapped_key bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'SUBJECT_KEY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.subject_key AS k (org_id, id, ref, key_id, wrapped_key)
  VALUES (v_org, p_id, p_ref, p_key_id, p_wrapped)
  ON CONFLICT (org_id, ref) DO NOTHING;
  RETURN QUERY SELECT k.id, k.key_id, k.wrapped_key FROM crove_kernel.subject_key k WHERE k.org_id = v_org AND k.ref = p_ref;
END $$;

-- The wrapped keys (and refs, so a caller checks a sealed value sits with its own subject) of the org's subjects with these ids. A subject whose key was shredded is absent from the answer: that is how a value reads as erased.
CREATE OR REPLACE FUNCTION crove_kernel.subject_key_wrapped(p_ids uuid[])
RETURNS TABLE (id uuid, key_id text, wrapped_key bytea, ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id()
  ) THEN
    RAISE EXCEPTION 'SUBJECT_KEY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT k.id, k.key_id, k.wrapped_key, k.ref FROM crove_kernel.subject_key k WHERE k.org_id = v_org AND k.id = ANY (p_ids);
END $$;

-- Deletes the keys of these subjects of the org in context (the shredding) and answers how many were deleted. The caller is an owner (the same assertion as the role commands).
CREATE OR REPLACE FUNCTION crove_kernel.subject_key_shred(p_refs text[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'SUBJECT_KEY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.subject_key k WHERE k.org_id = v_org AND k.ref = ANY (p_refs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.subject_key_ensure(uuid, text, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.subject_key_wrapped(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.subject_key_shred(text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_ensure(uuid, text, text, bytea) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_wrapped(uuid[]) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_shred(text[]) TO crove_app;
