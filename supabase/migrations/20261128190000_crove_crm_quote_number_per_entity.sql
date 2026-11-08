-- SPDX-License-Identifier: AGPL-3.0-only
-- A quote number is unique within the legal entity that issued it, not within the org (#2832, found in the review of #2830, plan docs/plan/crm-quotes.md Q2).
--
-- crm.quote.send takes the number from the kernel's numbering series, which is per legal entity (and its reset policy can change), so two entities of one org, or two
-- periods of one entity, can each hand out BG-YYYY-NNNN. The old key (org_id, number, revision) then refused the second send and the quote could not be sent. The new key adds
-- the issuing entity, so the same number in another entity's series is allowed while a duplicate within one entity is still refused. Every row the old key accepted is
-- accepted by the new one (it only has one more column), so no data is touched. A draft has neither a number nor an issuer (both NULL), so it never takes part in the key.
-- crove_crm.quote is not a hot table, so a plain constraint is built.
ALTER TABLE crove_crm.quote DROP CONSTRAINT IF EXISTS quote_number_uq;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'quote_number_entity_uq' AND conrelid = 'crove_crm.quote'::pg_catalog.regclass) THEN
    ALTER TABLE crove_crm.quote ADD CONSTRAINT quote_number_entity_uq UNIQUE (org_id, issuer_entity_id, number, revision);
  END IF;
END
$$;
