-- SPDX-License-Identifier: AGPL-3.0-only
-- An error only in the non-core content of an issued sales e-invoice (#2504, plan einvoice-issue.md section 8 "Errors only in non-core content", the accountant's answers of section 3a row 7
-- and 3b): the buyer's name or address, or the amount in words. No new invoice is made and the invoice is not cancelled: the seller tells the buyer ("Gửi thông báo cho người mua") and, as
-- the working answer of #2506 question 1 (not confirmed by the accountant yet), files the form 04/SS-HĐĐT with the tax authority. Both are the seller's own steps outside Ludy, so this table
-- tracks them and nothing is sent from here:
--   einvoice_notice   one row per error found on an issued invoice: the field, the text that is right, and two steps, each `todo` until a person says it is done and then `sent` or `filed`
--                     with the time. The row belongs to the issued draft's legal entity.
-- Idempotent; applied files stay untouched. A tenant role inserts and ticks a step (the four step columns are the only ones it may update); no row is ever deleted by a tenant role (the org
-- purge deletes them with the draft they name).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.einvoice_notice (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The issued draft whose invoice has the error.
  draft_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('buyer_name', 'buyer_address', 'amount_in_words')),
  -- What the field should say: a name or an address of the buyer (personal data) or the amount in words.
  correct_text text NOT NULL CHECK (char_length(correct_text) BETWEEN 1 AND 500),
  buyer_notice_state text NOT NULL DEFAULT 'todo' CHECK (buyer_notice_state IN ('todo', 'sent')),
  buyer_notified_at timestamptz,
  form_state text NOT NULL DEFAULT 'todo' CHECK (form_state IN ('todo', 'filed')),
  form_filed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- A step is done exactly when it has its time.
  CONSTRAINT einvoice_notice_buyer_ck CHECK ((buyer_notice_state = 'sent') = (buyer_notified_at IS NOT NULL)),
  CONSTRAINT einvoice_notice_form_ck CHECK ((form_state = 'filed') = (form_filed_at IS NOT NULL)),
  CONSTRAINT einvoice_notice_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT einvoice_notice_draft_fk FOREIGN KEY (org_id, draft_id) REFERENCES crove_finance.einvoice_draft (org_id, id),
  CONSTRAINT einvoice_notice_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS einvoice_notice_entity_idx ON crove_finance.einvoice_notice (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS einvoice_notice_draft_idx ON crove_finance.einvoice_notice (org_id, draft_id);
CREATE INDEX IF NOT EXISTS einvoice_notice_created_by_idx ON crove_finance.einvoice_notice (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.einvoice_notice');
REVOKE UPDATE, DELETE ON crove_finance.einvoice_notice FROM crove_tenant;
GRANT UPDATE (buyer_notice_state, buyer_notified_at, form_state, form_filed_at) ON crove_finance.einvoice_notice TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.einvoice_notice;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.einvoice_notice
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.einvoice_notice ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.einvoice_notice;
CREATE POLICY le_scope ON crove_finance.einvoice_notice AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners, admins and members write (the roles that may issue and draft an invoice); a viewer only reads.
DROP POLICY IF EXISTS einvoice_notice_insert ON crove_finance.einvoice_notice;
CREATE POLICY einvoice_notice_insert ON crove_finance.einvoice_notice AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_notice.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS einvoice_notice_update ON crove_finance.einvoice_notice;
CREATE POLICY einvoice_notice_update ON crove_finance.einvoice_notice AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_notice.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_notice.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A step is ticked once and never taken back, and nothing but a step may change: a row's field, text, draft and entity are fixed. The notice names a draft of the same entity (the command requires it issued).
CREATE OR REPLACE FUNCTION crove_finance.einvoice_notice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.buyer_notice_state <> 'todo' OR NEW.form_state <> 'todo' THEN
      RAISE EXCEPTION 'EINVOICE_NOTICE_STATE' USING ERRCODE = '42501';
    END IF;
    -- A row for another org than the context's, or with no context, is the row-level policy's to refuse, not this guard's (it could not see that org's draft anyway).
    IF crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM crove_finance.einvoice_draft d WHERE d.org_id = NEW.org_id AND d.id = NEW.draft_id AND d.legal_entity_id = NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'EINVOICE_NOTICE_DRAFT' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.to_jsonb(NEW) - ARRAY['buyer_notice_state', 'buyer_notified_at', 'form_state', 'form_filed_at'] <> pg_catalog.to_jsonb(OLD) - ARRAY['buyer_notice_state', 'buyer_notified_at', 'form_state', 'form_filed_at']
     OR (OLD.buyer_notice_state = 'sent' AND NEW.buyer_notified_at IS DISTINCT FROM OLD.buyer_notified_at)
     OR (OLD.form_state = 'filed' AND NEW.form_filed_at IS DISTINCT FROM OLD.form_filed_at)
     OR (OLD.buyer_notice_state = 'sent' AND NEW.buyer_notice_state <> 'sent')
     OR (OLD.form_state = 'filed' AND NEW.form_state <> 'filed') THEN
    RAISE EXCEPTION 'EINVOICE_NOTICE_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_notice_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS einvoice_notice_guard ON crove_finance.einvoice_notice;
CREATE TRIGGER einvoice_notice_guard BEFORE INSERT OR UPDATE ON crove_finance.einvoice_notice
  FOR EACH ROW EXECUTE FUNCTION crove_finance.einvoice_notice_guard();
