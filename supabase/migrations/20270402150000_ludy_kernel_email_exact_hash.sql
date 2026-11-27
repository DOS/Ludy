-- SPDX-License-Identifier: AGPL-3.0-only
-- Exact case-folded keyed email hash for matching synced calendar attendees against party emails (#4991 PM1)
-- without stripping Gmail dots or +tags (unlike ludy_kernel.mail_address_hash / invite_cap_key).
-- Uses the deployment's ludy_kernel.mail_hash_key with an independent domain prefix; idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.email_exact_hash(p_address text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_norm text;
BEGIN
  IF p_address IS NULL OR pg_catalog.btrim(p_address) = '' THEN
    RETURN NULL;
  END IF;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM ludy_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  v_norm := pg_catalog.lower(pg_catalog.btrim(p_address));
  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to('ludy.email-exact.v1' || pg_catalog.chr(31) || v_norm, 'UTF8'))
    ),
    'hex'
  );
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.email_exact_hash(text) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.email_exact_hash(text) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.email_exact_hash(text) TO ludy_tenant;
