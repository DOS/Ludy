-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings #4137 (points 2b and 3, follow-up of #4070 and #4138):
-- 1. Widen crove_meetings.glossary_term_ok to the invisible-character class from 20270122120000 (adding U+180B to U+180D, U+206A to U+206F, U+FFA0 and U+1D173 to U+1D17A) so a glossary term
--    never holds hidden or format characters when sent to Vy. The contract's class is one constant (packages/kernel-contract/src/invisible-chars.ts); this file spells the same class in SQL.
-- 2. Point 3: enforce NFKC compatibility folding via pg_catalog.normalize(p_term, 'NFKC') in glossary_term_ok before checking '@', '://' and 'www.', so full-width '@' ('＠', U+FF20), small '@'
--    ('﹫', U+FE6B) and dotted or wide URL look-alikes ('．', '․', '﹒', '：', '／', 'ｗ') are rejected in the database just as in packages/kernel-contract/src/meeting-glossary.ts.
--    pg_catalog.normalize is built-in, IMMUTABLE and runs cleanly under search_path = pg_catalog, pg_temp (precedent: crove_kernel.search_fold in 20261023060000). The contract remains stricter
--    only on non-ASCII decimal digits (\p{Nd} vs [[:digit:]]).
-- 3. Scrub existing rows before re-adding and validating glossary_term_term_check (NOT VALID then VALIDATE CONSTRAINT, idempotent): drop any row that cannot satisfy glossary_term_ok once
--    invisible characters are stripped (for example a lone U+FFA0, which matched [^[:digit:][:space:][:punct:]] under the old CHECK, digits-only after scrub, or an NFKC address), then scrub
--    invisible characters from surviving rows (resolving lower-case collisions within the org with an 8-letter suffix from the random UUID tail so no digits are added against the 4-digit cap),
--    and finally re-add and validate the CHECK constraint.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.glossary_term_ok(p_term text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_term IS NOT NULL
    AND pg_catalog.char_length(p_term) BETWEEN 1 AND 40
    AND p_term = pg_catalog.btrim(p_term)
    AND p_term OPERATOR(pg_catalog.!~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]'
    AND p_term OPERATOR(pg_catalog.~) '[^[:digit:][:space:][:punct:]]'
    AND pg_catalog.char_length(p_term) - pg_catalog.char_length(pg_catalog.regexp_replace(p_term, '[[:digit:]]', '', 'g')) <= 4
    AND pg_catalog.strpos(pg_catalog.normalize(p_term, 'NFKC'), '@') = 0
    AND pg_catalog.normalize(p_term, 'NFKC') OPERATOR(pg_catalog.!~*) '(://|www[.])'
$$;

-- A pure function the table's CHECK calls as the writing role: crove_tenant needs EXECUTE (functions of this database start with none).
REVOKE ALL ON FUNCTION crove_meetings.glossary_term_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.glossary_term_ok(text) TO crove_tenant;

-- Clean what is already stored (helper of this file, dropped at its end).
CREATE OR REPLACE FUNCTION crove_meetings.scrub_glossary_term(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
    p_text,
    '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]',
    '',
    'g'
  ))
$$;
REVOKE ALL ON FUNCTION crove_meetings.scrub_glossary_term(text) FROM PUBLIC;

-- Remove rows that cannot satisfy the restated CHECK even after stripping invisible characters (such as a lone U+FFA0, digits-only after scrub, or an NFKC email/web address).
DELETE FROM crove_meetings.glossary_term
 WHERE NOT crove_meetings.glossary_term_ok(crove_meetings.scrub_glossary_term(term));

-- Scrub invisible characters from surviving rows. If cleaning makes a term equal another row's lower-cased cleaned term in the org, keep the last eight characters of its UUID (random tail;
-- digits 0-9 mapped to g-p so no digits are added) after a 31-character prefix so the total stays within 40 characters and keeps at most 4 digits.
UPDATE crove_meetings.glossary_term AS t
   SET term = CASE
         WHEN EXISTS (
           SELECT 1 FROM crove_meetings.glossary_term AS o
            WHERE o.org_id = t.org_id AND o.id <> t.id
              AND pg_catalog.lower(crove_meetings.scrub_glossary_term(o.term)) = pg_catalog.lower(crove_meetings.scrub_glossary_term(t.term))
         )
         THEN pg_catalog.btrim(pg_catalog.left(crove_meetings.scrub_glossary_term(t.term), 31)) || ' ' || pg_catalog.translate(pg_catalog.right(t.id::text, 8), '0123456789', 'ghijklmnop')
         ELSE crove_meetings.scrub_glossary_term(t.term)
       END,
       updated_at = pg_catalog.now()
 WHERE t.term OPERATOR(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]';

-- Re-add and validate the table CHECK constraint so PostgreSQL verifies all existing rows against the updated glossary_term_ok.
ALTER TABLE crove_meetings.glossary_term DROP CONSTRAINT IF EXISTS glossary_term_term_check;
ALTER TABLE crove_meetings.glossary_term ADD CONSTRAINT glossary_term_term_check
  CHECK (crove_meetings.glossary_term_ok(term)) NOT VALID;
ALTER TABLE crove_meetings.glossary_term VALIDATE CONSTRAINT glossary_term_term_check;

DROP FUNCTION IF EXISTS crove_meetings.scrub_glossary_term(text);
