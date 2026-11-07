-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2643, ADR-0017 section 7): the reseal pass for subject keys. After a credential key rotation the worker wraps every subject key again under the current
-- key, so CREDENTIAL_KEY_PREVIOUS can be retired. Only wrapped data keys move: no sealed value is read or changed, and SQL never sees a data key. Idempotent; applied files stay untouched.
--
--   subject_key_reseal_due(key, openable, limit, after_org, after_id)
--                                                          the rows (org, id, key id, wrapped key) wrapped under another key than the current one but under one of the key ids the
--                                                          worker opens (a row under a lost key never crowds the others out of a page), of orgs that are active or offboarding, in keyset
--                                                          order. Cross-org, like crove_kernel.credential_reseal_due. The worker login only.
--   subject_key_key_counts()                               how many rows sit under each key id, for the pass's log line and its report of a key the worker cannot open. The worker login only.
--   subject_key_reseal(id, from key, from wrapped, key, wrapped)
--                                                          replaces the wrapped key of one subject of the org in the sealed system context, if it is still the one the worker read (compare and
--                                                          swap on the key id and the bytes), and answers whether a row changed. A subject shredded in between changes no row. The worker login
--                                                          only, in the system context of the org (kernel.subject_key.reseal); never the user definers of 20261123120000, which are unchanged.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.subject_key_reseal_due(p_key_id text, p_openable text[], p_limit int, p_after_org uuid, p_after_id uuid)
RETURNS TABLE (org_id uuid, id uuid, key_id text, wrapped_key bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.id, k.key_id, k.wrapped_key
  FROM crove_kernel.subject_key k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status IN ('active', 'offboarding')
  WHERE k.key_id <> p_key_id
    AND k.key_id = ANY (p_openable)
    AND (p_after_org IS NULL OR (k.org_id, k.id) > (p_after_org, p_after_id))
  ORDER BY k.org_id, k.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.subject_key_key_counts()
RETURNS TABLE (key_id text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.key_id, count(*) FROM crove_kernel.subject_key k GROUP BY k.key_id
$$;

CREATE OR REPLACE FUNCTION crove_kernel.subject_key_reseal(p_id uuid, p_from_key_id text, p_from_wrapped bytea, p_key_id text, p_wrapped bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SUBJECT_KEY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'SUBJECT_KEY_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_key_id IS NULL OR p_from_key_id IS NULL OR p_key_id = p_from_key_id OR pg_catalog.length(p_key_id) NOT BETWEEN 1 AND 64
     OR p_wrapped IS NULL OR pg_catalog.length(p_wrapped) <> 60 OR p_from_wrapped IS NULL THEN
    RAISE EXCEPTION 'SUBJECT_KEY_RESEAL_INPUT' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.subject_key k
     SET key_id = p_key_id, wrapped_key = p_wrapped
   WHERE k.org_id = v_org AND k.id = p_id AND k.key_id = p_from_key_id AND k.wrapped_key = p_from_wrapped;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.subject_key_reseal_due(text, text[], int, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.subject_key_key_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.subject_key_reseal(uuid, text, bytea, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_reseal_due(text, text[], int, uuid, uuid) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_key_counts() TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.subject_key_reseal(uuid, text, bytea, text, bytea) TO crove_worker;
