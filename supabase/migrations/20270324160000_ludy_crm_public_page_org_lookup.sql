-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy CRM (issue #3393, ADR-0053 section 2 follow-up of #3310 C2a): read-only org resolution for CRM public pages
-- so the API edge checks both org_app_on and the org's billing entitlement (Runtime.appOn) before any read or visitor
-- write runs. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_crm.public_page_org(p_kind text, p_key text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_org_slug text;
  v_type_slug text;
  v_token text;
BEGIN
  IF p_kind = 'booking_page' THEN
    IF p_key IS NULL OR p_key !~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$' THEN
      RETURN NULL;
    END IF;
    v_org_slug := pg_catalog.split_part(p_key, '/', 1);
    v_type_slug := pg_catalog.split_part(p_key, '/', 2);
    IF pg_catalog.length(v_org_slug) > 60 OR pg_catalog.length(v_type_slug) > 60 THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_kernel.tenant t
    JOIN ludy_crm.event_type e
      ON e.org_id = t.org_id
     AND e.slug = v_type_slug
     AND e.active
    WHERE t.slug = v_org_slug
      AND t.status = 'active'
      AND ludy_kernel.org_app_on(t.org_id, 'crm');
    RETURN v_org;
  ELSIF p_kind = 'booking_manage' THEN
    IF p_key IS NULL OR p_key !~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*/[0-9a-f]{32}\.[0-9]{1,9}\.[0-9a-f]{32}$' THEN
      RETURN NULL;
    END IF;
    v_org_slug := pg_catalog.split_part(p_key, '/', 1);
    v_type_slug := pg_catalog.split_part(p_key, '/', 2);
    v_token := pg_catalog.split_part(p_key, '/', 3);
    IF pg_catalog.length(v_org_slug) > 60 OR pg_catalog.length(v_type_slug) > 60 THEN
      RETURN NULL;
    END IF;
    SELECT f.org_id INTO v_org
    FROM ludy_crm.booking_manage_find(v_org_slug, v_type_slug, v_token) f
    JOIN ludy_kernel.tenant t
      ON t.org_id = f.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'crm');
    RETURN v_org;
  ELSIF p_kind = 'booking_feed' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_crm.booking_feed f
    JOIN ludy_kernel.tenant t
      ON t.org_id = f.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'crm')
    WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8')), 'hex')
      AND f.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM ludy_kernel.tenant_member m
        JOIN ludy_kernel.user_account u ON u.id = m.user_id
        WHERE m.org_id = f.org_id
          AND m.user_id = f.user_id
          AND m.role IN ('owner', 'admin', 'member')
          AND u.disabled_at IS NULL
      );
    RETURN v_org;
  ELSIF p_kind = 'quote_link' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' THEN
      RETURN NULL;
    END IF;
    SELECT t.org_id INTO v_org
    FROM ludy_crm.quote_link l
    JOIN ludy_kernel.tenant t
      ON t.org_id = l.org_id
     AND t.status = 'active'
     AND ludy_kernel.org_app_on(t.org_id, 'crm')
    JOIN ludy_crm.quote q
      ON q.org_id = l.org_id
     AND q.id = l.quote_id
    WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8')), 'hex')
      AND l.revoked_at IS NULL
      AND l.expires_at > pg_catalog.now()
      AND q.status IN ('sent', 'accepted', 'declined');
    RETURN v_org;
  ELSE
    RAISE EXCEPTION 'unknown crm public page kind' USING ERRCODE = '22023';
  END IF;
END $$;

REVOKE ALL ON FUNCTION ludy_crm.public_page_org(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE ANY (ARRAY['ludy\_%', 'crove\_%']) AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_crm.public_page_org(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_crm.public_page_org(text, text) TO ludy_app;
