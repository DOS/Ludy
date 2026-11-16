-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3188, review follow-up of #3154): a household profile is written only after its entity's period
-- lock row is held FOR SHARE, so a concurrent finance.period.lock (which takes the row FOR UPDATE) waits for the profile
-- to commit or is read after it, and the profile never lands inside a month that is locked by then. Idempotent; applied
-- files stay untouched.
--
-- The tenant role cannot write period_lock, and Postgres refuses SELECT ... FOR SHARE to a role without UPDATE on the
-- table, so the read is a SECURITY DEFINER function, like the posting guard's. It answers only for the org in context
-- and an entity the context may see, creates the entity's row (nothing locked) when no posting or lock has yet, and
-- returns locked_through while the row stays held to the end of the transaction.
CREATE OR REPLACE FUNCTION crove_finance.period_lock_share(p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entity uuid;
  v_through date;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  v_entity := crove_finance.period_lock_entity(v_org, p_legal_entity_id);
  INSERT INTO crove_finance.period_lock (org_id, legal_entity_id) VALUES (v_org, v_entity) ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR SHARE;
  RETURN v_through;
END $$;

REVOKE ALL ON FUNCTION crove_finance.period_lock_share(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.period_lock_share(uuid) TO crove_tenant;
