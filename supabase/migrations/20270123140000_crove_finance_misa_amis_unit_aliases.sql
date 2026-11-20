-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4125, MISA ASP): the unit aliases of a MISA ASP connection. Idempotent; applied files stay untouched.
--
-- ASP names a line's unit by id, and a unit of Ludy is matched to the firm's unit catalogue by its exact name. When the catalogue spells a unit differently (or has it twice), a person types the unit's name as
-- MISA has it, once per unit of Ludy:
--   unit_aliases   one jsonb object on the connection: the unit of Ludy (folded the way the check folds it: composed, lower case, single spaces, 1 to 64 characters) to the unit name typed as the catalogue
--                  spells it (1 to 64 characters). At most 200 entries; '{}' for none. The next check matches the typed name exactly instead of the unit's own name (nothing looser).
-- No new table: the column sits on the connection row, written by finance.misa_amis_connection.set_unit_alias (owner or admin) through the column grant, and only an ASP connection may hold any.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_connection ADD COLUMN IF NOT EXISTS unit_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The bounds of the object, in the table itself: an object, at most 200 entries, every key and every value a text of 1 to 64 characters.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_unit_aliases_ok(p_aliases jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_aliases) IS DISTINCT FROM 'object' THEN false
    ELSE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_each(p_aliases)) <= 200
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_each(p_aliases) AS e
        WHERE pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'string'
          OR pg_catalog.char_length(e.key) NOT BETWEEN 1 AND 64
          OR pg_catalog.char_length(e.value #>> '{}') NOT BETWEEN 1 AND 64
      )
  END
$$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_unit_aliases_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.misa_amis_unit_aliases_ok(jsonb) TO crove_tenant;

ALTER TABLE crove_finance.misa_amis_connection DROP CONSTRAINT IF EXISTS misa_amis_connection_unit_aliases_ck;
ALTER TABLE crove_finance.misa_amis_connection ADD CONSTRAINT misa_amis_connection_unit_aliases_ck CHECK (
  crove_finance.misa_amis_unit_aliases_ok(unit_aliases) AND (unit_aliases = '{}'::jsonb OR product = 'asp')
);
GRANT UPDATE (unit_aliases) ON crove_finance.misa_amis_connection TO crove_tenant;
