-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4124, S3b part 2 of #4103; plan accounting-software-sync.md step 5): a party of Ludy that has NO tax code cannot be looked up in the firm's MISA catalogue by it, so the check looks it up
-- by name and keeps the answer on the match table (#4112) for a person to confirm. Idempotent; applied files stay untouched.
--
-- kind 'party_name'   a party with no tax code, keyed by its id in Ludy (a uuid, never its name).
-- state 'name_proposal'  the one active catalogue entry of the same name: its code, its id and its NAME (candidate_name, up to 200 characters; it can be a person's name, so it lives on this row alone, is
--                     a registered personal datum and is erased with the person's data). Until a person confirms it, the party is blocked like one the catalogue does not have.
-- state 'confirmed'   a person (an owner or admin) confirmed the proposal: the code and the entry's id stay, the candidate's name is gone (the row is replaced by the command, never updated), and who and when
--                     are kept. A later check does not replace it; it checks the code is still in the catalogue and active, and the row goes when it is not.
-- state 'ambiguous'   several active entries carry the name: nothing is proposed.
-- A rejected proposal is deleted. No UPDATE is granted: the commands delete and insert, as the worker does.
-- Only a person confirms: a tenant role may insert a `confirmed` row only as a user, in its own name (confirmed_by is the caller) and with the time; the system context (the worker) never inserts one, and a check
-- cannot make one. A superuser (a restore) and the table's owner keep what they write.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_match ADD COLUMN IF NOT EXISTS candidate_name text;
ALTER TABLE crove_finance.misa_amis_match ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE crove_finance.misa_amis_match ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- The checks of the first migration that name the kind, the state or the key are replaced by named ones (found by what they say, not by the name Postgres gave them).
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'crove_finance.misa_amis_match'::pg_catalog.regclass
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ~ '(^|[^a-z_])(kind|state|match_key)([^a-z_]|$)'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE crove_finance.misa_amis_match DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
ALTER TABLE crove_finance.misa_amis_match DROP CONSTRAINT IF EXISTS misa_amis_match_name_ck;
ALTER TABLE crove_finance.misa_amis_match DROP CONSTRAINT IF EXISTS misa_amis_match_confirmed_by_fk;

ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_kind_ck CHECK (kind IN ('party', 'item', 'party_name'));
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_state_ck CHECK (state IN ('matched', 'unknown', 'ambiguous', 'name_proposal', 'confirmed'));
-- A party is keyed by its tax code (digits only: 10, or 13 with the branch part), a name match by the party's id, an item by the code the voucher is written with.
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_key_ck CHECK (
  char_length(match_key) BETWEEN 1 AND 64
  AND (kind <> 'party' OR match_key ~ '^[0-9]{10}([0-9]{3})?$')
  AND (kind <> 'party_name' OR match_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_found_ck CHECK (
  -- An entry's code is kept for a match, a proposal and a confirmation, and for nothing else; its id only with a code.
  (state IN ('matched', 'name_proposal', 'confirmed')) = (catalogue_code IS NOT NULL)
  AND (catalogue_id IS NULL OR state IN ('matched', 'name_proposal', 'confirmed'))
  -- The candidate's name is on a proposal and nowhere else; who confirmed and when, on a confirmation and nowhere else.
  AND (state = 'name_proposal') = (candidate_name IS NOT NULL)
  AND (state = 'confirmed' OR (confirmed_by IS NULL AND confirmed_at IS NULL))
  AND (state <> 'confirmed' OR confirmed_at IS NOT NULL)
  -- A tax code or an item code finds a match, nothing is none, several are ambiguous; a name finds a proposal, several or none, and a person confirms.
  AND (kind = 'party_name' OR state IN ('matched', 'unknown', 'ambiguous'))
  AND (kind <> 'party_name' OR state IN ('name_proposal', 'confirmed', 'ambiguous', 'unknown'))
);
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_name_ck CHECK (candidate_name IS NULL OR char_length(candidate_name) BETWEEN 1 AND 200);
-- A member who leaves keeps the decision: only the link to them goes.
ALTER TABLE crove_finance.misa_amis_match ADD CONSTRAINT misa_amis_match_confirmed_by_fk
  FOREIGN KEY (org_id, confirmed_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (confirmed_by);
CREATE INDEX IF NOT EXISTS misa_amis_match_confirmed_by_idx ON crove_finance.misa_amis_match (org_id, confirmed_by) WHERE confirmed_by IS NOT NULL;

-- The result's entity is the connection's, whoever writes it (as before); and a `confirmed` row is a person's: the only insert of one by a tenant role is a user's, in their own name and with a time.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_match_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant boolean := pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
    AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
BEGIN
  IF EXISTS (SELECT 1 FROM crove_finance.misa_amis_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.connection_id AND c.legal_entity_id <> NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'MISA_AMIS_MATCH_ENTITY' USING ERRCODE = '42501';
  END IF;
  IF v_tenant AND NEW.state = 'confirmed' THEN
    IF (SELECT crove_kernel.ctx_actor_type()) = 'system'
       OR NEW.confirmed_by IS DISTINCT FROM (SELECT crove_kernel.ctx_user_id())
       OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION 'MISA_AMIS_MATCH_CONFIRMED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_match_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
