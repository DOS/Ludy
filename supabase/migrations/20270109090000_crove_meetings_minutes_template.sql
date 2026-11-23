-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings #3578 (plan docs/plan/meetings-integrations.md section 4.3, owner direction of 2026-11-17): minutes templates an organization writes. Idempotent; applied files stay
-- untouched. The org_purge restatement that deletes the new table is its own file (20270109100000_crove_kernel_org_purge_minutes_templates.sql).
--
-- crove_meetings.minutes_template   one template of an org: a name and 1 to 8 sections (key, title, hint). Every member reads the active ones (it is layout, not personal data);
--                                   an owner or admin writes them, in the command and in the database (a restrictive row policy). Archive only: nothing deletes a row but the org purge.
-- crove_meetings.meeting            minutes_template_name / _sections / _hash: the meeting's OWN copy of the template it was summarized with, taken in meetings.minutes.set_template. No
--                                   foreign key to the template, so an edit, an archive or a purge of the template changes no published result; the copy follows the meeting's retention and
--                                   deletion. summary_template gets a sixth code, 'custom', set exactly when a copy is present.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The shape of the sections, in the database: the same bounds as the contract (packages/kernel-contract/src/meeting-minutes-templates.ts).
-- A pure check: 1 to 8 objects with exactly the keys key, title and hint; the key is snake_case and unique; the title is 1 to 60 and the hint 0 to 200 characters; no control character,
-- line or paragraph separator, bidirectional control, zero-width character, tag character or invisible filler in either (the app strips them, the database refuses what is left).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.minutes_sections_ok(p_sections jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_key text;
  v_keys text[] := ARRAY[]::text[];
  v_bad constant text := '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]';
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
-- The org's templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.minutes_template (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 80 AND name = pg_catalog.btrim(name) AND name !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]'),
  sections jsonb NOT NULL CHECK (crove_meetings.minutes_sections_ok(sections)),
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);

-- One active template per name in an org, whatever the case; an archived one frees its name.
CREATE UNIQUE INDEX IF NOT EXISTS minutes_template_active_name_idx ON crove_meetings.minutes_template (org_id, pg_catalog.lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS minutes_template_org_idx ON crove_meetings.minutes_template (org_id, created_at, id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.minutes_template');
-- Archive only: no role deletes a row (the org purge is the table owner's).
REVOKE DELETE ON crove_meetings.minutes_template FROM crove_tenant;

-- Every member reads; only an owner or admin of the org, in a user context, writes. The system and agent contexts pass the row policy as they do for the eSign templates, and the agent write
-- guard below then refuses an agent (AGENT_FORBIDDEN); no command of the system context writes here. The command checks the role first and answers 403; this is the same rule in the
-- database, so a member's direct INSERT is refused (42501) and their UPDATE finds no row to change.
DO $$
DECLARE
  v_check constant text := '((SELECT crove_kernel.ctx_actor_type()) IN (''system'', ''agent'') OR ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = minutes_template.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))))';
BEGIN
  DROP POLICY IF EXISTS writer_insert ON crove_meetings.minutes_template;
  EXECUTE 'CREATE POLICY writer_insert ON crove_meetings.minutes_template AS RESTRICTIVE FOR INSERT TO crove_tenant WITH CHECK ' || v_check;
  DROP POLICY IF EXISTS writer_update ON crove_meetings.minutes_template;
  EXECUTE 'CREATE POLICY writer_update ON crove_meetings.minutes_template AS RESTRICTIVE FOR UPDATE TO crove_tenant USING ' || v_check || ' WITH CHECK ' || v_check;
END $$;

SELECT crove_kernel.agent_write_guard_install('crove_meetings.minutes_template');

-- ---------------------------------------------------------------------------
-- The meeting's own copy
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS minutes_template_name text;
ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS minutes_template_sections jsonb;
ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS minutes_template_hash text;

ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_summary_template_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_summary_template_check CHECK (summary_template IN ('general', 'briefing', 'customer', 'supplier', 'one_on_one', 'custom'));
-- The copy is all three columns or none, and it is there exactly when the template is 'custom'. The hash is the md5 of the sections as stored, so a run asked for one layout is told from a
-- run made for another (a template edited and picked again); a hash that does not match its sections is refused.
ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_minutes_template_copy_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_minutes_template_copy_check CHECK (
  (summary_template = 'custom') = (minutes_template_sections IS NOT NULL)
  AND (minutes_template_sections IS NULL) = (minutes_template_name IS NULL)
  AND (minutes_template_sections IS NULL) = (minutes_template_hash IS NULL)
  AND (minutes_template_sections IS NULL OR (
    crove_meetings.minutes_sections_ok(minutes_template_sections)
    AND pg_catalog.char_length(minutes_template_name) BETWEEN 1 AND 80
    AND minutes_template_hash = pg_catalog.md5(minutes_template_sections::text)
  ))
);

GRANT UPDATE (minutes_template_name, minutes_template_sections, minutes_template_hash) ON crove_meetings.meeting TO crove_tenant;
