-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4111, S2 of #4103; plan accounting-software-sync.md step 5): the MISA connection gets a product. Idempotent; applied files stay untouched.
--
-- misa_amis_connection.product   `amis` (the default, so every row already there stays an AMIS Kế toán connection) or `asp` (MISA ASP). The table already holds ONE connection per legal entity
--                                (misa_amis_connection_entity_uq), so a legal entity is on AMIS or on ASP, never both, with no new constraint. The product is fixed for the row's life: a tenant role
--                                may update only the last test's state and time (the column grant is unchanged), so switching product is a disconnect and a new connection.
-- The row's channel connection must be the one of its product: provider `accounting_misa_amis` for AMIS, `accounting_misa_asp` for ASP (ADR-0025; the access code of an ASP connection is sealed
-- under its own provider id, so the code of one product is never opened as the other's). The guard that already checked the AMIS provider now checks the provider of the row's product.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_connection ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT 'amis';
ALTER TABLE crove_finance.misa_amis_connection DROP CONSTRAINT IF EXISTS misa_amis_connection_product_ck;
ALTER TABLE crove_finance.misa_amis_connection ADD CONSTRAINT misa_amis_connection_product_ck CHECK (product IN ('amis', 'asp'));

CREATE OR REPLACE FUNCTION crove_finance.misa_amis_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    NEW.org_company_code := 'ludy-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    NEW.last_test_state := NULL;
    NEW.last_tested_at := NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.channel_connection c
    WHERE c.org_id = NEW.org_id AND c.id = NEW.channel_connection_id
      AND c.provider <> CASE NEW.product WHEN 'asp' THEN 'accounting_misa_asp' ELSE 'accounting_misa_amis' END
  ) THEN
    RAISE EXCEPTION 'MISA_AMIS_CONNECTION_PROVIDER' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- The product and the channel connection are fixed for the row's life. Today only the column grant keeps them so (a tenant role may update just the last test's state and time); this trigger keeps them
-- so for anyone, a later grant or a definer function included: a re-bound row could pair an AMIS access code with ASP's paths or the other way round. The restore of a dump inserts and never updates.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_connection_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.product IS DISTINCT FROM OLD.product OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id THEN
    RAISE EXCEPTION 'MISA_AMIS_CONNECTION_FIXED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_connection_fixed() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_connection_fixed ON crove_finance.misa_amis_connection;
CREATE TRIGGER misa_amis_connection_fixed BEFORE UPDATE OF product, channel_connection_id ON crove_finance.misa_amis_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_connection_fixed();
ALTER TABLE crove_finance.misa_amis_connection ENABLE ALWAYS TRIGGER misa_amis_connection_fixed;
