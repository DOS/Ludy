-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3293, plan docs/plan/crm.md section 5 "Derived facts"): realtime hints for the contacts of the CRM.
-- Idempotent; applied files stay untouched.
--
-- The party table is the kernel's (the CRM reads it), so its triggers are a kernel migration; the deals' are in
-- 20270105010000_crove_crm_stream_hints.sql, which has the story. crove_kernel.stream_notify sends
-- `<org_id> crm_party <party id>` on crove_stream: the id only, never a name, an email or a phone, to the streams of that
-- org alone. A stream of an org that has the crm app off drops it (apps/kernel/src/stream.ts, HINT_APPS).
--
-- INSERT, and an UPDATE that changes what the contact screens and deal cards show: the kind, name, tax code, address,
-- email, phone, company link or duplicate mark, or the version (a screen sends it back with an edit, so a stale one would
-- fail with a conflict). Finance writes the same table (a verified flag), which a contact screen does not show, so that
-- sends nothing. No DELETE trigger: a party is deleted only by the org purge.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.party;
CREATE TRIGGER stream_hint AFTER INSERT ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('crm_party', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON crove_kernel.party;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON crove_kernel.party
  FOR EACH ROW
  WHEN ((OLD.kind, OLD.name, OLD.tax_code, OLD.address, OLD.email, OLD.phone, OLD.company_id, OLD.duplicate_of, OLD.version)
        IS DISTINCT FROM (NEW.kind, NEW.name, NEW.tax_code, NEW.address, NEW.email, NEW.phone, NEW.company_id, NEW.duplicate_of, NEW.version))
  EXECUTE FUNCTION crove_kernel.stream_notify('crm_party', 'id');
