-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2438, CRM-Q5 of docs/plan/crm.md): a person works at one company. A person is a party of kind 'person', a company a party of kind
-- 'organization'; the link is a nullable column on the person, `company_id`, pointing at a company of the same org. It follows the party convention of
-- `duplicate_of` (#887): a self-reference led by org_id, a CHECK against itself, a partial index, and a guard trigger that holds the rule for every writer.
-- Nothing is deleted or moved, and no table is added (so no new row-level policy). The org purge deletes the parties no voucher names and keeps the ones a voucher
-- names, so a kept person may point at a company that goes: the foreign key nulls the link (ON DELETE SET NULL (company_id), as conversation_party_fk does).
--
--   - only a person has a company (CHECK party_company_person);
--   - the company is an organization of the same org that is not merged into another (party_company_guard): link the party kept;
--   - an organization people point at stays an organization (party_company_kind_guard), and so does a person who has a company until the link is cleared;
--   - an organization people point at is merged only into another organization (party_company_merge_guard).
-- A company merged into another later (kernel.party.mark_duplicate) keeps its people pointing at it; the reads show them under the company kept.
-- Both guards read `party` as the writer, like the commands; the restrictive entity policy #1538 will put on `party` has to keep them sound (see the issue).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.party ADD COLUMN IF NOT EXISTS company_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_company_fk' AND conrelid = 'crove_kernel.party'::regclass) THEN
    ALTER TABLE crove_kernel.party
      ADD CONSTRAINT party_company_fk FOREIGN KEY (org_id, company_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (company_id),
      ADD CONSTRAINT party_company_not_self CHECK (company_id IS DISTINCT FROM id),
      ADD CONSTRAINT party_company_person CHECK (company_id IS NULL OR kind = 'person');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS party_company_idx ON crove_kernel.party (org_id, company_id) WHERE company_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_kernel.party_company_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- The company row is locked for share while it is read: a change of its kind, which locks the row to run its own guard, waits for this write and then sees the
  -- link, and the other way round, so a person is never left linked to a party that became a person under READ COMMITTED.
  PERFORM 1 FROM crove_kernel.party c
    WHERE c.org_id = NEW.org_id AND c.id = NEW.company_id AND c.kind = 'organization' AND c.duplicate_of IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARTY_COMPANY_INVALID: the company must be an organization of this org that is not merged into another' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crove_kernel.party_company_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS party_company_guard ON crove_kernel.party;
CREATE TRIGGER party_company_guard BEFORE INSERT OR UPDATE OF company_id ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.party_company_guard();

-- An organization that people point at cannot become a person. (A person who has a company cannot become an organization either: party_company_person.)
CREATE OR REPLACE FUNCTION crove_kernel.party_company_kind_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.kind = 'person' AND OLD.kind = 'organization'
     AND EXISTS (SELECT 1 FROM crove_kernel.party p WHERE p.org_id = NEW.org_id AND p.company_id = NEW.id) THEN
    RAISE EXCEPTION 'PARTY_COMPANY_HAS_PEOPLE: people work at this company; unlink them first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crove_kernel.party_company_kind_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS party_company_kind_guard ON crove_kernel.party;
CREATE TRIGGER party_company_kind_guard BEFORE UPDATE OF kind ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.party_company_kind_guard();

-- A company people work at is merged only into another company: their link reads through duplicate_of, so a merge into a person would make "the company" a
-- person, or the person their own company. (kernel.party.mark_duplicate refuses it first, with a typed error; this holds it for every writer.) The kept party is
-- locked for share, as the link guard locks its company, so a change of that party's kind and this merge do not cross.
CREATE OR REPLACE FUNCTION crove_kernel.party_company_merge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kept text;
BEGIN
  IF NEW.duplicate_of IS NULL OR NEW.duplicate_of IS NOT DISTINCT FROM OLD.duplicate_of OR OLD.kind <> 'organization' THEN
    RETURN NEW;
  END IF;
  SELECT k.kind INTO v_kept FROM crove_kernel.party k WHERE k.org_id = NEW.org_id AND k.id = NEW.duplicate_of FOR SHARE;
  IF v_kept = 'person' AND EXISTS (SELECT 1 FROM crove_kernel.party p WHERE p.org_id = NEW.org_id AND p.company_id = NEW.id) THEN
    RAISE EXCEPTION 'PARTY_COMPANY_HAS_PEOPLE: people work at this company; it can be merged only into another company' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crove_kernel.party_company_merge_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS party_company_merge_guard ON crove_kernel.party;
CREATE TRIGGER party_company_merge_guard BEFORE UPDATE OF duplicate_of ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.party_company_merge_guard();
