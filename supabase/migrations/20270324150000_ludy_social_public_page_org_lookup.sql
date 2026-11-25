-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Social (issue #3393, ADR-0053 section 2 follow-up of #3310 C2a): read-only org resolution for Social public
-- pages so the API edge checks both org_app_on and the org's billing entitlement (Runtime.appOn) before any read or
-- visitor write runs. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_social.public_page_org(p_kind text, p_key text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_kind = 'review_link' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_social.review_link l
    JOIN ludy_kernel.tenant t
      ON t.org_id = l.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'social')
    WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8')), 'hex')
      AND l.revoked_at IS NULL
      AND l.expires_at > pg_catalog.now();
    RETURN v_org;
  ELSIF p_kind = 'report_link' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_social.report_link l
    JOIN ludy_kernel.tenant t
      ON t.org_id = l.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'social')
    WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8')), 'hex')
      AND l.revoked_at IS NULL
      AND l.expires_at > pg_catalog.now();
    RETURN v_org;
  ELSIF p_kind = 'short_link' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9]{10,16}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_social.short_link l
    JOIN ludy_kernel.tenant t
      ON t.org_id = l.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'social')
    WHERE l.code = p_key;
    RETURN v_org;
  ELSIF p_kind = 'bio' THEN
    IF p_key IS NULL OR p_key !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_social.bio_page b
    JOIN ludy_kernel.tenant t
      ON t.org_id = b.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'social')
    WHERE b.slug = p_key
      AND b.published;
    RETURN v_org;
  ELSIF p_kind = 'calendar_feed' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_social.calendar_feed f
    JOIN ludy_kernel.tenant t
      ON t.org_id = f.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'social')
    WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8')), 'hex')
      AND f.revoked_at IS NULL;
    RETURN v_org;
  ELSE
    RAISE EXCEPTION 'unknown social public page kind' USING ERRCODE = '22023';
  END IF;
END $$;

REVOKE ALL ON FUNCTION ludy_social.public_page_org(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE ANY (ARRAY['ludy\_%', 'crove\_%']) AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_social.public_page_org(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_social.public_page_org(text, text) TO ludy_app;
