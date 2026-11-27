-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #5182): the person's mark that one hit of the monthly review of unusual posted entries was looked at. A hit is an entry and the rule that found it (duplicate_invoice, control_manual,
-- amount_outlier, new_account, off_day; modules/finance/src/unusual-entries.ts). The review itself is a read of the books; this table is the only thing it ever writes, and it holds no money and no text.
--
-- ludy_finance.entry_review_mark   one row per (org, entry, rule): the entity of the entry, who marked it and when. UNIQUE (org_id, entry_id, rule) is the idempotency key: marking a hit again inserts
--                                  nothing (ON CONFLICT DO NOTHING in the command) and says so. There is no unmark in this slice, so tenant roles read and insert and nothing updates or deletes a row
--                                  (insert-only grant, no UPDATE or DELETE grant). finance.unusual_entries.review (R1, audited, user actors only) is the only writer. The mark is not purged with the org's
--                                  tenant data by ludy_kernel.org_purge: it follows the ledger entry it points at, which org_purge reads and never deletes, as input_vat_check does.
-- The entity of a row is the entity of its entry (trigger b_legal_entity with legal_entity_fill, a writer naming another entity is refused) and le_scope narrows reads and writes to the entities the
-- caller may see, as on every finance table (#1280). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_finance.entry_review_mark (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  rule text NOT NULL CHECK (rule IN ('duplicate_invoice', 'control_manual', 'amount_outlier', 'new_account', 'off_day')),
  marked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT entry_review_mark_entry_rule_uq UNIQUE (org_id, entry_id, rule),
  CONSTRAINT entry_review_mark_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT entry_review_mark_entry_fk FOREIGN KEY (org_id, entry_id) REFERENCES ludy_finance.journal_entry (org_id, id)
);
-- The foreign key to the legal entity (G3 fk-index); the key to the entry and the review's per-hit lookup are served by the unique key above (org_id, entry_id, rule).
CREATE INDEX IF NOT EXISTS entry_review_mark_entity_idx ON ludy_finance.entry_review_mark (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_finance.entry_review_mark', true);
REVOKE ALL ON TABLE ludy_finance.entry_review_mark FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON TABLE ludy_finance.entry_review_mark TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_finance.entry_review_mark;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, entry_id ON ludy_finance.entry_review_mark
  FOR EACH ROW EXECUTE FUNCTION ludy_finance.legal_entity_fill('ludy_finance.journal_entry', 'entry_id');
ALTER TABLE ludy_finance.entry_review_mark ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON ludy_finance.entry_review_mark;
CREATE POLICY le_scope ON ludy_finance.entry_review_mark AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));
