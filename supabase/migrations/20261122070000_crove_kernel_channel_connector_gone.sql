-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2296, ads W2-1): whether the member who connected an open channel connection is still an owner or admin of the org, for the system
-- command that closes the ads write connection of a member who left (kernel.channel.close_orphan). The kernel's own door for a credential
-- (credential_get) already refuses a connection whose connector left, so such a connection can no longer be used; the revoke sweep closes it, so that the
-- token nobody can use is held, revoked at the platform and wiped instead of sitting in Ludy. The answer is a boolean and nothing is returned of the
-- connection or the member. The same test as credential_get's: still a member with the role owner or admin, and not disabled. Idempotent; applied files
-- stay untouched.
SET LOCAL lock_timeout = '2s';

-- True when the org in context has an active connection with this id whose connector is no longer an owner or admin (removed, demoted or disabled). False
-- for a connection that is not active, does not exist, or whose connector is still in charge. Raises NO_CONTEXT (42501) outside a system context.
CREATE OR REPLACE FUNCTION crove_kernel.channel_connector_gone(p_connection_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_by uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT c.connected_by, c.status INTO v_by, v_status FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id = p_connection_id;
  IF NOT FOUND OR v_status <> 'active' THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_by AND m.role IN ('owner', 'admin') AND u.disabled_at IS NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_kernel.channel_connector_gone(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.channel_connector_gone(uuid) TO crove_worker;
