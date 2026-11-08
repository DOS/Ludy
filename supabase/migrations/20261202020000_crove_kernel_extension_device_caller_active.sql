-- SPDX-License-Identifier: AGPL-3.0-only
-- The owner and admin device routines refuse a caller of an org that is no longer active (issue #2868, follow-up of #2740).
-- Idempotent; applied files stay untouched. ext_device_caller_role (20261128080000) checked only the caller's membership and the user's
-- standing; the other extension definers also require tenant.status = 'active'. It is now the same here, so
-- list_extension_tokens_for_org and revoke_extension_token_as_admin raise EXTENSION_FORBIDDEN for a closed org, like issuing a code does.
-- Signature, owner, grants and the rest of the body are as they were; CREATE OR REPLACE keeps the grants (nobody holds EXECUTE on it).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.ext_device_caller_role()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END $$;
