-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3832): a cheap, necessary prefilter in front of the exact regex of crove_kernel.text_mentions, so a line that cannot hold the value never reaches the regex engine.
-- The finder and the erasure of personal data (#923, #1678, #1948) call text_mentions on every free-text column and, in Meetings, on every transcript line, twice in an owner's search and once in an admin's; the regex (a
-- lookbehind, an alternation and up to three separators between every digit, case-folded, tried at every character) costs about 37 microseconds a line of 200 characters, so a phone search over
-- 120 000 lines took about 20 s. This changes how fast the answer comes, never what it is: each check below is a NECESSARY condition of the pattern text_mention_pattern builds (a text that fails it
-- cannot match the pattern), and a text that passes it still goes through the same regex, so text_mentions returns exactly what it returned before.
--   - kind 'email': the pattern holds the address's '@' as a literal, which no letter folds into, so a text without an '@' cannot match.
--   - kind 'digits': the pattern is the digits of the number (its local form, or its +84 form for a phone) with up to three separators of the listed characters between any two digits, never a digit
--     between them. A match therefore holds every distinct digit of one of the two forms, so a text that lacks a digit that both forms need cannot match. The check is `strpos` on single characters,
--     no regex engine: a line of words with no digits fails at the first digit it lacks.
-- text_mention_pattern, text_redact, the signature, the grants and the validation stay as they are: the value and the kind are still checked first (a bad one raises even for a NULL text), a NULL text is
-- still false, and the forms are derived by the same rules as in text_mention_pattern (a value from 84 with 11 or 12 digits is found also from 0, a value from 0 with 10 or 11 digits also from 84; those
-- rules are the lengths of the value, which the pattern function has already checked to be 8 to 20 digits, as its latest definition, 20261122040000, does). The equivalence is pinned in apps/kernel/test/text-mentions-prefilter.db.test.ts against the
-- unchanged pattern. Idempotent: CREATE OR REPLACE.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.text_mentions(p_text text, p_kind text, p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- First, so that a bad kind or value raises whatever the text is, as before.
  v_pattern constant text := crove_kernel.text_mention_pattern(p_kind, p_value);
  v_local text;
  v_intl text;
  v_local_ok boolean := true;
  v_intl_ok boolean := true;
  v_digit text;
BEGIN
  IF p_text IS NULL THEN
    RETURN false;
  END IF;
  IF p_kind = 'email' THEN
    IF pg_catalog.strpos(p_text, '@') = 0 THEN
      RETURN false;
    END IF;
  ELSIF p_kind = 'digits' THEN
    v_local := CASE WHEN pg_catalog.left(p_value, 2) = '84' AND pg_catalog.length(p_value) IN (11, 12) THEN '0' || pg_catalog.substr(p_value, 3) ELSE p_value END;
    v_intl := CASE WHEN pg_catalog.left(v_local, 1) = '0' AND pg_catalog.length(v_local) IN (10, 11) THEN '84' || pg_catalog.substr(v_local, 2) ELSE v_local END;
    FOR i IN 0..9 LOOP
      v_digit := i::text;
      IF pg_catalog.strpos(p_text, v_digit) = 0 THEN
        IF pg_catalog.strpos(v_local, v_digit) > 0 THEN
          v_local_ok := false;
        END IF;
        IF pg_catalog.strpos(v_intl, v_digit) > 0 THEN
          v_intl_ok := false;
        END IF;
        IF NOT (v_local_ok OR v_intl_ok) THEN
          RETURN false;
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN p_text ~* v_pattern;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_mentions(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_mentions(text, text, text) TO crove_tenant;
