-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2402, part 2 of #2385): what a bank statement line's text says about its party, learned from the
-- vouchers people made by hand. Idempotent; applied files stay untouched.
--
-- bank_party_rule       one row per (org, legal entity, kind, key, party): when a person made the voucher of a bank line
--                       and chose its party themselves (never taking the matcher's suggestion), the voucher's approval
--                       remembers how the line's text pointed at that party, and the matcher of the next statement
--                       adds that party as a candidate with its own reason. A rule only raises a suggestion: a person
--                       still makes and approves every voucher.
--                       The key is not stored as text. It is the keyed hash (bank_party_rule_hash) of the line's
--                       distinctive words (kind 'text') or of a counterparty account number (kind 'account', a later
--                       slice), so the table holds no free text and no account number that an erasure of a person's data
--                       would have to reach. Several parties may hold one key: the matcher then lists them and chooses
--                       none. Rows are made by the voucher's approval and removed whole (owners and admins, audited),
--                       never updated. They carry the entity and are under le_scope like the bank lines they read: a member
--                       limited to another entity neither sees nor learns them.
--
-- bank_party_rule_hash  HMAC-SHA256 under a key derived from the deployment's keyed-hash key (crove_kernel.mail_hash_key, as
--                       the keyed input hash of #1732 and conversation_identity_hash do), over a domain label per kind, the
--                       org of the caller's sealed context and the key: org-bound, so the same words hash differently in two
--                       orgs. A definer with a pinned search_path, so no tenant role reads the key; the learner and the
--                       matcher both call it.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.bank_party_rule_hash(p_kind text, p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('text', 'account') OR p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'BANK_RULE_HASH_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN 'k1:' || pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'bank_party_rule:' || p_kind || ':' || pg_catalog.chr(31) || v_org::text || pg_catalog.chr(31) || p_key, 'UTF8'))),
    'hex');
END $$;
REVOKE ALL ON FUNCTION crove_finance.bank_party_rule_hash(text, text) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.bank_party_rule_hash(text, text) TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_finance.bank_party_rule (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- What the key is the key of: the line's distinctive words, or a counterparty account number.
  kind text NOT NULL CHECK (kind IN ('text', 'account')),
  -- bank_party_rule_hash of the key, 'k1:' and 64 hex digits.
  key_hash text NOT NULL CHECK (key_hash ~ '^k1:[0-9a-f]{64}$'),
  party_id uuid NOT NULL,
  -- The approver whose approval taught the rule (the user, never a system actor).
  confirmed_by uuid,
  confirmed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- The voucher whose approval taught it.
  source_voucher_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- One rule per entity, kind, key and party; it also backs the matcher's lookup by key.
  CONSTRAINT bank_party_rule_key_uq UNIQUE (org_id, legal_entity_id, kind, key_hash, party_id),
  CONSTRAINT bank_party_rule_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- A party removed from the books takes its rules with it.
  CONSTRAINT bank_party_rule_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT bank_party_rule_voucher_fk FOREIGN KEY (org_id, source_voucher_id) REFERENCES crove_finance.cash_voucher (org_id, id)
);
-- Entity first, as the finance tables' entity indexes are (20261102140000).
CREATE INDEX IF NOT EXISTS bank_party_rule_entity_idx ON crove_finance.bank_party_rule (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS bank_party_rule_party_idx ON crove_finance.bank_party_rule (org_id, party_id);
CREATE INDEX IF NOT EXISTS bank_party_rule_voucher_idx ON crove_finance.bank_party_rule (org_id, source_voucher_id);

SELECT crove_kernel.apply_tenant_rls('crove_finance.bank_party_rule');
-- Made and removed whole.
REVOKE UPDATE ON crove_finance.bank_party_rule FROM crove_tenant;

-- The entity: the one named, or the entity of the voucher whose approval taught the rule (crove_finance.legal_entity_fill with
-- its parent), never changed.
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.bank_party_rule;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, source_voucher_id ON crove_finance.bank_party_rule
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.cash_voucher', 'source_voucher_id');
ALTER TABLE crove_finance.bank_party_rule ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.bank_party_rule;
CREATE POLICY le_scope ON crove_finance.bank_party_rule AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
