-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: the phone key of a party (CRM slice 1, step K4, issue #2228). Idempotent; applied files stay untouched.
--
-- crove_kernel.phone_key(text)   the one form of a phone number to match on: `0912 345 678`, `+84 912 345 678`,
--                                `84912345678` and `0084 912 345 678` all give `0912345678`. It is the SQL twin of
--                                phoneKey() in @crove/kernel-contract (packages/kernel-contract/src/phone.ts), and one
--                                table of cases (packages/kernel-contract/test/phone-cases.ts) runs against both.
--                                IMMUTABLE and pure, so it can back an index; no digit gives NULL.
-- party_phone_key_idx            (org_id, phone_key(phone)) where a phone is recorded, for the contact search and the
--                                duplicate check of the contact import (K5). Stored party.phone is never rewritten.
--
-- The rules, in order: every character but the digits is dropped and only a leading `+` is remembered; a leading `00` is
-- the international call prefix, as a `+`; international `84`, or a bare `84` in front of 9 or 10 more digits, is
-- Vietnam's country code and becomes `0` (a trunk `0` written after it is not doubled); anything else keeps its digits.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.phone_key(p_phone text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN k.d = '' THEN NULL
    WHEN k.d LIKE '84%' AND (k.intl OR pg_catalog.length(k.d) IN (11, 12))
      THEN '0' || pg_catalog.regexp_replace(pg_catalog.substr(k.d, 3), '^0', '')
    ELSE k.d
  END
  FROM (
    SELECT
      (p_phone ~ '^\s*\+' OR r.digits LIKE '00%') AS intl,
      CASE WHEN r.digits LIKE '00%' THEN pg_catalog.substr(r.digits, 3) ELSE r.digits END AS d
    FROM (SELECT pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g') AS digits) r
  ) k
$$;

-- A pure function over its argument, like crove_kernel.search_fold: tenant roles may call it (a search folds the typed
-- phone the way the index folds the stored one); nothing else needs to.
REVOKE ALL ON FUNCTION crove_kernel.phone_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.phone_key(text) TO crove_tenant;

CREATE INDEX IF NOT EXISTS party_phone_key_idx ON crove_kernel.party (org_id, crove_kernel.phone_key(phone)) WHERE phone IS NOT NULL;
