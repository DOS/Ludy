-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4125, MISA ASP): a voucher line written for MISA ASP names its unit and its stock by id, so the
-- catalogue check (#4112) also matches Ludy's unit names (catalogue 4) and stock codes (catalogue 3). Idempotent; applied
-- files stay untouched.
--
-- kind 'unit'   a unit name of Ludy, keyed by the name folded to NFC, trimmed, lower case, single spaces (up to 64 characters).
--               matched: the one active unit of that name (catalogue_code = the catalogue's unit name, catalogue_id = its id).
-- kind 'stock'  a stock code of Ludy (the warehouse code of a goods line, or the connection's default), keyed by the code.
--               matched: the one active stock of that code (catalogue_code = the stock code, catalogue_id = its id).
-- Both use the states of an item: matched, unknown (none) or ambiguous (several); a name is never matched loosely.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_match DROP CONSTRAINT IF EXISTS misa_amis_match_kind_ck;
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_kind_ck CHECK (kind IN ('party', 'item', 'party_name', 'unit', 'stock'));
