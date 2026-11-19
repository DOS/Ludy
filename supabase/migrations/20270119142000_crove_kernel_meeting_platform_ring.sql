-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #3175, integrations C3, plan docs/plan/meetings-integrations.md section 6.3): the doorbell of Zoom's webhook. Idempotent (CREATE OR REPLACE); applied files stay untouched.
--
-- crove_kernel.meeting_platform_ring(p_provider, p_account): called by the API login, with no org and no user in the context, when Zoom's signed notice says a recording of the Zoom user p_account
-- finished. It clears the last listing time of that user's ACTIVE connections, so the worker's sweep (meeting_platform_sync_due) lists them again at its next pass instead of up to 10 minutes later.
-- It writes nothing else, takes nothing from the notice but the provider and the account, and returns only how many connections it cleared (a count, never an id or a name), so the route can answer
-- the same whether or not one matched. Ringing twice is harmless: the second finds the column already empty and clears nothing.
--
-- A connection is rung only where the org is active and its Meetings app is on (ADR-0053: a notice of an org whose app is off is dropped like one that matches nothing), and only while its member is
-- still an owner, admin or member of the org and not disabled, the same test the sweep applies. Only 'zoom' is a provider here; any other text, or an account that is not the shape of a Zoom user id, clears nothing.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_ring(p_provider text, p_account text)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH rung AS (
    UPDATE crove_kernel.meeting_platform_connection c
    SET last_synced_at = NULL
    FROM crove_kernel.tenant t
    WHERE p_provider = 'zoom'
      AND p_account ~ '^[A-Za-z0-9_-]{1,200}$'
      AND c.provider = 'zoom'
      -- Accounts are stored lower case (the connect command lowercases them), whatever case Zoom writes the id in.
      AND c.external_account = pg_catalog.lower(p_account)
      AND c.status = 'active'
      AND c.last_synced_at IS NOT NULL
      AND t.org_id = c.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'meetings')
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
        WHERE m.org_id = c.org_id AND m.user_id = c.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL)
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer FROM rung
$$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_platform_ring(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_platform_ring(text, text) TO crove_app;
