-- SPDX-License-Identifier: AGPL-3.0-only
-- Wave A1 P3 follow-up (#5024): worker-only definer checking whether an org has an undrained
-- kernel.org.apps_changed (module='sign', enabled='true') outbox event so periodic KYC timeout
-- sweeps do not time out long-paused checks before the relay's apps_changed renewal runs.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_sign.kyc_has_pending_sign_enable(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_org_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM ludy_kernel.outbox_pending p
    JOIN ludy_kernel.outbox_event e
      ON e.org_id = p.org_id
     AND e.id = p.event_id
    WHERE p.org_id = p_org_id
      AND e.type = 'kernel.org.apps_changed'
      AND e.payload ->> 'module' = 'sign'
      AND e.payload ->> 'enabled' = 'true'
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.kyc_has_pending_sign_enable(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

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
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_sign.kyc_has_pending_sign_enable(uuid) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION ludy_sign.kyc_has_pending_sign_enable(uuid) TO ludy_worker;
