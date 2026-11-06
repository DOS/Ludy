-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2183, after #2142): the number of a bank account, recorded by an owner or admin, so a bank
-- statement that arrives as a file matches its bank account without a bank feed. Idempotent; applied files stay untouched.
--
-- bank_account_number   one row per (org, account number): the digits a statement file names (6 to 20, banks print them with
--                       spaces or dots; only the digits are kept) and the bank account of one legal entity it belongs to
--                       (a 112 account or an org sub-account under it, checked as a bank line's is). One number belongs to
--                       one bank account of an org (UNIQUE (org_id, account_number)); a bank account may have several
--                       numbers. A row is made and removed whole (finance.bank_account_number.set and .clear, owners and
--                       admins, audited), never updated: changing a number is a clear and a set, each in the audit trail.
--                       The row carries the entity and is under le_scope like the bank lines it routes: a member limited to
--                       another entity neither sees nor records it. The statement path (finance.bank.statement_stage) reads
--                       these numbers next to the numbers of bank feed accounts.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_account_number (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  bank_account text NOT NULL,
  account_number text NOT NULL CHECK (account_number ~ '^[0-9]{6,20}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_account_number_uq UNIQUE (org_id, account_number),
  CONSTRAINT bank_account_number_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
-- Entity first, as the finance tables' entity indexes are (20261102140000).
CREATE INDEX IF NOT EXISTS bank_account_number_entity_idx ON crove_finance.bank_account_number (legal_entity_id, org_id);

SELECT crove_kernel.apply_tenant_rls('crove_finance.bank_account_number');
-- Made and removed whole.
REVOKE UPDATE ON crove_finance.bank_account_number FROM crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.bank_account_number;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.bank_account_number
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.bank_account_number ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.bank_account_number;
CREATE POLICY le_scope ON crove_finance.bank_account_number AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

DROP TRIGGER IF EXISTS check_bank_account ON crove_finance.bank_account_number;
CREATE TRIGGER check_bank_account BEFORE INSERT OR UPDATE OF bank_account ON crove_finance.bank_account_number
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_bank_account();

