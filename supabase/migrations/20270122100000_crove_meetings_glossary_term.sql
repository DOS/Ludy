-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings #4043 (step 2 of 4): the glossary an organization keeps, the terms (a product, an acronym, jargon) that Vy should spell the way the org does. Idempotent; applied files stay
-- untouched. The org_purge restatement that deletes the new table is its own file (20270122110000_crove_kernel_org_purge_glossary_term.sql).
--
-- crove_meetings.glossary_term   one term of an org: 1 to 40 characters of plain text. Only an owner or admin of the org, in a user context, reads or writes it (a restrictive policy for every
--                                command): a member has no glossary screen, the system context and an agent context read none of it. The recorder's own run reads it through a definer in step 3.
--                                At most 60 terms an org (the command counts; the database keeps the shape). Rows are deleted by the command; the org purge deletes the rest.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The shape of a term, in the database: the same rules as the contract (packages/kernel-contract/src/meeting-glossary.ts). A pure check: 1 to 40 characters, no space at either end, no
-- control, line or paragraph separator, bidirectional control, zero-width character, tag character or invisible filler, at least one character that is neither a digit, a space nor
-- punctuation (a name has a letter; "[^[:digit:][:space:][:punct:]]" holds for Vietnamese letters whatever the database locale), at most 4 digits, no "@" and no "://" or "www." (an address is
-- not a term). The app is stricter on digits (every Unicode decimal digit counts there).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.glossary_term_ok(p_term text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_term IS NOT NULL
    AND pg_catalog.char_length(p_term) BETWEEN 1 AND 40
    AND p_term = pg_catalog.btrim(p_term)
    AND p_term !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]'
    AND p_term ~ '[^[:digit:][:space:][:punct:]]'
    AND pg_catalog.char_length(p_term) - pg_catalog.char_length(pg_catalog.regexp_replace(p_term, '[[:digit:]]', '', 'g')) <= 4
    AND pg_catalog.strpos(p_term, '@') = 0
    AND p_term !~* '(://|www[.])'
$$;

-- A pure function the table's CHECK calls as the writing role: crove_tenant needs EXECUTE (functions of this database start with none).
REVOKE ALL ON FUNCTION crove_meetings.glossary_term_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.glossary_term_ok(text) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- The org's terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.glossary_term (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  term text NOT NULL CHECK (crove_meetings.glossary_term_ok(term)),
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);

-- One row per term in an org, whatever the case.
CREATE UNIQUE INDEX IF NOT EXISTS glossary_term_term_idx ON crove_meetings.glossary_term (org_id, pg_catalog.lower(term));
CREATE INDEX IF NOT EXISTS glossary_term_org_idx ON crove_meetings.glossary_term (org_id, created_at, id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.glossary_term');
-- Only the term and the stamp change; the org, the author and the identity never do.
REVOKE UPDATE ON crove_meetings.glossary_term FROM crove_tenant;
GRANT UPDATE (term, updated_at) ON crove_meetings.glossary_term TO crove_tenant;

-- An owner or admin of the org, in a user context, reads and writes; nobody else does: the system context and an agent context pass no row, so the recorder's run reads the terms only through a
-- definer (step 3). The commands check the role first and answer 403; this is the same rule in the database.
DO $$
DECLARE
  v_check constant text := '((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = glossary_term.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';
BEGIN
  DROP POLICY IF EXISTS owner_admin ON crove_meetings.glossary_term;
  EXECUTE 'CREATE POLICY owner_admin ON crove_meetings.glossary_term AS RESTRICTIVE FOR ALL TO crove_tenant USING ' || v_check || ' WITH CHECK ' || v_check;
END $$;

SELECT crove_kernel.agent_write_guard_install('crove_meetings.glossary_term');
