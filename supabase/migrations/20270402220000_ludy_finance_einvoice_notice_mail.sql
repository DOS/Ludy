-- SPDX-License-Identifier: AGPL-3.0-only
-- Finance (#3697, follow-up of #2504): link a queued Ludy mail message to an e-invoice buyer error notice so mail delivery settles the buyer step.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.einvoice_notice
  ADD COLUMN IF NOT EXISTS buyer_notice_mail_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_finance' AND t.relname = 'einvoice_notice' AND c.conname = 'einvoice_notice_mail_fk'
  ) THEN
    ALTER TABLE ludy_finance.einvoice_notice
      ADD CONSTRAINT einvoice_notice_mail_fk FOREIGN KEY (org_id, buyer_notice_mail_id) REFERENCES ludy_kernel.mail_message (org_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS einvoice_notice_mail_idx ON ludy_finance.einvoice_notice (org_id, buyer_notice_mail_id) WHERE buyer_notice_mail_id IS NOT NULL;

GRANT UPDATE (buyer_notice_mail_id) ON ludy_finance.einvoice_notice TO ludy_tenant;

-- Preserves 20270111100000 rules and adds buyer_notice_mail_id invariants: never non-null on insert, never cleared once set, and never changed once the buyer step is sent or while setting sent.
CREATE OR REPLACE FUNCTION ludy_finance.einvoice_notice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.buyer_notice_state <> 'todo' OR NEW.form_state <> 'todo' OR NEW.buyer_notice_mail_id IS NOT NULL THEN
      RAISE EXCEPTION 'EINVOICE_NOTICE_STATE' USING ERRCODE = '42501';
    END IF;
    -- A row for another org than the context's, or with no context, is the row-level policy's to refuse, not this guard's (it could not see that org's draft anyway).
    IF ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ludy_finance.einvoice_draft d WHERE d.org_id = NEW.org_id AND d.id = NEW.draft_id AND d.legal_entity_id = NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'EINVOICE_NOTICE_DRAFT' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The author's membership ending clears created_by (the foreign key's SET NULL); that is the only change of it allowed.
  IF pg_catalog.to_jsonb(NEW) - ARRAY['buyer_notice_state', 'buyer_notified_at', 'form_state', 'form_filed_at', 'created_by', 'buyer_notice_mail_id']
     <> pg_catalog.to_jsonb(OLD) - ARRAY['buyer_notice_state', 'buyer_notified_at', 'form_state', 'form_filed_at', 'created_by', 'buyer_notice_mail_id']
     OR (NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)
     OR (OLD.buyer_notice_state = 'sent' AND NEW.buyer_notified_at IS DISTINCT FROM OLD.buyer_notified_at)
     OR (OLD.form_state = 'filed' AND NEW.form_filed_at IS DISTINCT FROM OLD.form_filed_at)
     OR (OLD.buyer_notice_state = 'sent' AND NEW.buyer_notice_state <> 'sent')
     OR (OLD.form_state = 'filed' AND NEW.form_state <> 'filed')
     OR (OLD.buyer_notice_mail_id IS NOT NULL AND NEW.buyer_notice_mail_id IS NULL)
     OR (NEW.buyer_notice_mail_id IS DISTINCT FROM OLD.buyer_notice_mail_id AND (OLD.buyer_notice_state = 'sent' OR NEW.buyer_notice_state <> 'todo')) THEN
    RAISE EXCEPTION 'EINVOICE_NOTICE_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.einvoice_notice_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
