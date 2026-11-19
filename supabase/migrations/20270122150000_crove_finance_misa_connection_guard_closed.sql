-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4132, two LOW items of the security review of #4131). Idempotent; applied files stay untouched.
--
-- 1. The insert guard of a MISA connection failed open: it raised only when it could SEE a channel connection of the wrong provider. A foreign key ignores RLS, so a channel row the writer cannot see
--    (a restrictive policy added later, say) passed the guard. The row is now also refused unless a channel connection of the product's provider is FOUND for it. That check is an AFTER INSERT
--    constraint trigger, not a change of the BEFORE guard: it runs after the row-level security check of the insert, so a row for another org is still refused by RLS first, with RLS's own error.
-- 2. The guard was not ENABLE ALWAYS, so an insert under session_replication_role = replica (a superuser's) skipped it. It is now, and so is the new trigger, like the trigger that fixes the product.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.misa_amis_connection_provider_found() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.channel_connection c
    WHERE c.org_id = NEW.org_id AND c.id = NEW.channel_connection_id
      AND c.provider = CASE NEW.product WHEN 'asp' THEN 'accounting_misa_asp' ELSE 'accounting_misa_amis' END
  ) THEN
    RAISE EXCEPTION 'MISA_AMIS_CONNECTION_PROVIDER' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_connection_provider_found() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_connection_provider_found ON crove_finance.misa_amis_connection;
CREATE CONSTRAINT TRIGGER misa_amis_connection_provider_found AFTER INSERT ON crove_finance.misa_amis_connection
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_connection_provider_found();
ALTER TABLE crove_finance.misa_amis_connection ENABLE ALWAYS TRIGGER misa_amis_connection_provider_found;
ALTER TABLE crove_finance.misa_amis_connection ENABLE ALWAYS TRIGGER misa_amis_connection_guard;
