-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings #4137 (point 2, from the shared-core review of the glossary table): the class of invisible characters that the minutes templates (name, section title and hint) and the chapter titles refuse
-- missed four ranges that a reader, a screen or a model can still act on: U+180B to U+180D (the Mongolian free variation selectors, beside the vowel separator U+180E already in it), U+2060 to U+206F
-- (the class stopped at U+2069 and so missed the deprecated format controls U+206A to U+206F), U+FFA0 (the halfwidth Hangul filler, beside U+115F, U+1160 and U+3164 already in it) and U+1D173 to
-- U+1D17A (the musical symbol beam and slur format controls). The contract's class is one constant (packages/kernel-contract/src/invisible-chars.ts); this file spells the same class in the database.
--
-- 1. crove_meetings.minutes_sections_ok is restated whole with the wider class (CREATE OR REPLACE; same signature, owner and grants). The CHECKs that call it (minutes_template.sections and the meeting's
--    copy) are not re-evaluated by a restatement, so the rows are cleaned first (below), and a later UPDATE of an old row cannot meet a refusal it never had.
-- 2. Rows are scrubbed before any CHECK is widened, as 20270117210000 did for the chapter titles (#3882): a title or name that holds a character of the class loses it (a title that would be empty
--    becomes a dash; a hint is trimmed); the meeting's own copy of a template (minutes_template_sections) is cleaned the same way and its hash is made again from the stored sections, which is what
--    the copy's CHECK compares; a template name that would then equal another active template's name in the org (the unique index is on the lower-cased name) takes the first eight characters of
--    its id after it.
-- 3. The name CHECK of minutes_template and the title CHECK of meeting_chapter are dropped and added again with the wider class, NOT VALID, then validated (the rows are already clean).
-- crove_meetings.glossary_term (step 2 of #4043, a table of another PR) gets its own forward migration after that PR merges.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The function the sections' CHECKs call, with the wider class
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.minutes_sections_ok(p_sections jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_key text;
  v_keys text[] := ARRAY[]::text[];
  v_bad constant text := '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]';
BEGIN
  IF p_sections IS NULL OR pg_catalog.jsonb_typeof(p_sections) <> 'array' OR pg_catalog.jsonb_array_length(p_sections) NOT BETWEEN 1 AND 8 THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT e FROM pg_catalog.jsonb_array_elements(p_sections) AS e LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
      IF v_key NOT IN ('key', 'title', 'hint') THEN
        RETURN false;
      END IF;
    END LOOP;
    IF NOT (v_item ?& ARRAY['key', 'title', 'hint'])
       OR pg_catalog.jsonb_typeof(v_item -> 'key') <> 'string' OR v_item ->> 'key' !~ '^[a-z][a-z0-9_]{0,31}$'
       OR pg_catalog.jsonb_typeof(v_item -> 'title') <> 'string' OR pg_catalog.char_length(v_item ->> 'title') NOT BETWEEN 1 AND 60
       OR v_item ->> 'title' <> pg_catalog.btrim(v_item ->> 'title') OR v_item ->> 'title' ~ v_bad
       OR pg_catalog.jsonb_typeof(v_item -> 'hint') <> 'string' OR pg_catalog.char_length(v_item ->> 'hint') > 200
       OR v_item ->> 'hint' <> pg_catalog.btrim(v_item ->> 'hint') OR v_item ->> 'hint' ~ v_bad THEN
      RETURN false;
    END IF;
    IF (v_item ->> 'key') = ANY (v_keys) THEN
      RETURN false;
    END IF;
    v_keys := pg_catalog.array_append(v_keys, v_item ->> 'key');
  END LOOP;
  RETURN true;
END $$;

-- A pure function the table's and the meeting's CHECKs call as the writing role: crove_tenant needs EXECUTE (functions of this database start with none).
REVOKE ALL ON FUNCTION crove_meetings.minutes_sections_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.minutes_sections_ok(jsonb) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Clean what is already stored (two helpers of this file, dropped at its end)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.scrub_invisible_text(p_text text, p_dash boolean)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_dash
    THEN COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(p_text, '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]', '', 'g')), ''), '-')
    ELSE pg_catalog.btrim(pg_catalog.regexp_replace(p_text, '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]', '', 'g'))
  END
$$;
REVOKE ALL ON FUNCTION crove_meetings.scrub_invisible_text(text, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION crove_meetings.scrub_invisible_sections(p_sections jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'key', t.e -> 'key',
             'title', pg_catalog.to_jsonb(crove_meetings.scrub_invisible_text(t.e ->> 'title', true)),
             'hint', pg_catalog.to_jsonb(crove_meetings.scrub_invisible_text(t.e ->> 'hint', false))
           ) ORDER BY t.o)
  FROM pg_catalog.jsonb_array_elements(p_sections) WITH ORDINALITY AS t(e, o)
$$;
REVOKE ALL ON FUNCTION crove_meetings.scrub_invisible_sections(jsonb) FROM PUBLIC;

-- The templates: the sections and the name. A name that equals another active template's name once cleaned (the unique index is on the lower-cased name of the active ones) keeps the first eight
-- characters of its id after it; every row of such a pair gets the suffix, so no two collide.
UPDATE crove_meetings.minutes_template AS t
   SET sections = crove_meetings.scrub_invisible_sections(t.sections),
       name = CASE
         WHEN t.archived_at IS NULL AND EXISTS (
           SELECT 1 FROM crove_meetings.minutes_template AS o
            WHERE o.org_id = t.org_id AND o.id <> t.id AND o.archived_at IS NULL
              AND pg_catalog.lower(crove_meetings.scrub_invisible_text(o.name, true)) = pg_catalog.lower(crove_meetings.scrub_invisible_text(t.name, true)))
         THEN pg_catalog.left(crove_meetings.scrub_invisible_text(t.name, true), 71) || ' ' || pg_catalog.left(t.id::text, 8)
         ELSE crove_meetings.scrub_invisible_text(t.name, true)
       END,
       updated_at = pg_catalog.now()
 WHERE NOT crove_meetings.minutes_sections_ok(t.sections) OR t.name OPERATOR(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]';

-- The meeting's own copy of a template: the sections, and the hash the copy's CHECK compares with the sections as stored.
UPDATE crove_meetings.meeting AS m
   SET minutes_template_sections = crove_meetings.scrub_invisible_sections(m.minutes_template_sections),
       minutes_template_hash = pg_catalog.md5(crove_meetings.scrub_invisible_sections(m.minutes_template_sections)::text)
 WHERE m.minutes_template_sections IS NOT NULL AND NOT crove_meetings.minutes_sections_ok(m.minutes_template_sections);

-- The chapter titles.
UPDATE crove_meetings.meeting_chapter
   SET title = crove_meetings.scrub_invisible_text(title, true)
 WHERE title OPERATOR(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]';

-- ---------------------------------------------------------------------------
-- The CHECKs with the wider class (the rows are clean, so the validation cannot fail)
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.minutes_template DROP CONSTRAINT IF EXISTS minutes_template_name_check;
ALTER TABLE crove_meetings.minutes_template ADD CONSTRAINT minutes_template_name_check
  CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 80 AND name = pg_catalog.btrim(name) AND name OPERATOR(pg_catalog.!~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]') NOT VALID;
ALTER TABLE crove_meetings.minutes_template VALIDATE CONSTRAINT minutes_template_name_check;

ALTER TABLE crove_meetings.meeting_chapter DROP CONSTRAINT IF EXISTS meeting_chapter_title_check;
ALTER TABLE crove_meetings.meeting_chapter ADD CONSTRAINT meeting_chapter_title_check
  CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 80 AND title OPERATOR(pg_catalog.!~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\U0001d173-\U0001d17a\U000e0000-\U000e007f]') NOT VALID;
ALTER TABLE crove_meetings.meeting_chapter VALIDATE CONSTRAINT meeting_chapter_title_check;

DROP FUNCTION IF EXISTS crove_meetings.scrub_invisible_sections(jsonb);
DROP FUNCTION IF EXISTS crove_meetings.scrub_invisible_text(text, boolean);
