-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4037, slice 2 of #3850; plan stock-and-marketplaces.md section 8.6 "Columns"): the mapping of a marketplace report's columns that a person confirmed, per org and platform.
-- Idempotent; applied files stay untouched.
--
-- marketplace_column_profile   one row per confirmation, append-only: the platform, the row of the file the header was read from, the mapped columns (the column's place, the header text as the file
--                              words it and the standard field a person confirmed it is) and a digest of the whole header row, the key a later file is compared by. A newer confirmation for the same org and
--                              platform is a new row and the latest wins; an earlier one is never edited or deleted.
--
-- What is NOT here, by design: a cell value, a sample (masked or not), or the header of a buyer column. The mapping lists only the columns that map to a standard field (the contract has no field
-- for buyer data), the header text is cut to 80 characters, and a check in the table bounds the shape (at most one entry per standard field and per column, no entry beyond the list). Org-level:
-- no legal entity. Written by finance.marketplace.columns_confirm only (a person), read by every member.
SET LOCAL lock_timeout = '2s';

-- The shape of the mapped columns, in the table itself: a list of 2 to 13 entries, each an object of exactly `index` (a whole number 0 to 999), `header` (text of 1 to 80 characters) and `field` (one
-- of the standard fields of an order line, the same list as packages/l10n-vn ORDER_FIELDS), with no field and no column twice.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_column_profile_columns_ok(p_columns jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_columns) IS DISTINCT FROM 'array' THEN false
    WHEN pg_catalog.jsonb_array_length(p_columns) NOT BETWEEN 2 AND 13 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_columns) AS e(v)
      WHERE CASE
        -- Evaluated in this order, so a scalar never reaches jsonb_object_keys (which refuses one).
        WHEN pg_catalog.jsonb_typeof(e.v) IS DISTINCT FROM 'object' THEN true
        WHEN (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(e.v) AS k) IS DISTINCT FROM ARRAY['field', 'header', 'index']::text[] THEN true
        WHEN pg_catalog.jsonb_typeof(e.v -> 'index') IS DISTINCT FROM 'number'
          OR pg_catalog.jsonb_typeof(e.v -> 'header') IS DISTINCT FROM 'string'
          OR pg_catalog.jsonb_typeof(e.v -> 'field') IS DISTINCT FROM 'string' THEN true
        ELSE (e.v ->> 'index') !~ '^[0-9]{1,3}$'
          OR pg_catalog.char_length(e.v ->> 'header') NOT BETWEEN 1 AND 80
          OR (e.v ->> 'field') NOT IN ('orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount')
      END
    )
    AND (SELECT pg_catalog.count(DISTINCT e.v ->> 'field') FROM pg_catalog.jsonb_array_elements(p_columns) AS e(v)) = pg_catalog.jsonb_array_length(p_columns)
    AND (SELECT pg_catalog.count(DISTINCT e.v ->> 'index') FROM pg_catalog.jsonb_array_elements(p_columns) AS e(v)) = pg_catalog.jsonb_array_length(p_columns)
  END
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_column_profile_columns_ok(jsonb) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_column_profile_columns_ok(jsonb) TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_column_profile (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  platform text NOT NULL CHECK (platform IN ('shopee', 'tiktok_shop', 'lazada')),
  -- The row of the file the header was read from (as the sheet reader numbers its rows).
  header_row integer NOT NULL CHECK (header_row >= 0),
  columns jsonb NOT NULL CHECK (crove_finance.marketplace_column_profile_columns_ok(columns)),
  -- A digest (hex, 64) of the whole header row's normalized texts: a later file whose header row has another digest does not use this profile.
  header_digest text NOT NULL CHECK (header_digest ~ '^[0-9a-f]{64}$'),
  confirmed_by uuid,
  -- The time of the insert itself (not the transaction's start): two confirmations at once run one after the other under the command's lock, and the later insert must carry the later time for "latest wins".
  confirmed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT marketplace_column_profile_member_fk FOREIGN KEY (org_id, confirmed_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (confirmed_by)
);
CREATE INDEX IF NOT EXISTS marketplace_column_profile_latest_idx ON crove_finance.marketplace_column_profile (org_id, platform, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_column_profile_confirmed_by_idx ON crove_finance.marketplace_column_profile (org_id, confirmed_by) WHERE confirmed_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_column_profile');
-- Append-only: no UPDATE and no DELETE for a tenant role (the org purge deletes them through its definer).
REVOKE UPDATE, DELETE ON crove_finance.marketplace_column_profile FROM crove_tenant;

-- Owners and admins confirm a mapping (and the system context for the org's own jobs, as the matrix's own-org control); every member of the org reads. Whether a caller is a person is the command's check:
-- it refuses an agent before anything is written.
DROP POLICY IF EXISTS marketplace_column_profile_insert ON crove_finance.marketplace_column_profile;
CREATE POLICY marketplace_column_profile_insert ON crove_finance.marketplace_column_profile AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_column_profile.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
