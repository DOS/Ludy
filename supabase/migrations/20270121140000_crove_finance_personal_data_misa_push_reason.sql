-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4015, PDPL; part of #3902 / #3854): MISA's own refusal text on a pushed voucher is registered as personal data, and an erasure clears it. Idempotent; applied files stay untouched.
--
-- Why: crove_finance.misa_amis_push.reason holds, for a `refused` row, MISA's own words about why it refused the voucher (untrusted text, at most 500 characters). MISA may quote a party's name, tax code or an
-- invoice number in it, so a person's erasure request must be able to reach it before MISA_AMIS_PUSH is turned on (the Accounting PO's decision on #4015: clear the text, keep the state).
--
-- crove_finance.personal_data_clear_misa_amis_push_reason(kind, value)
--     For kernel.personal_data.erase (R3, owners): sets `reason` to NULL on every `refused` row of the context's org whose text mentions the value, and answers how many rows changed. kind is 'email' (the lowercased
--     address) or 'digits' (10 to 15 digits), as personalDataProbe gives them; the matching is crove_kernel.text_mentions, the same the finder uses. The whole text goes, not just the mention: MISA's text is not ours to
--     edit, and what it says about a person under another spelling cannot be told apart. A value of 8 or 9 digits changes nothing and answers 0 (it may as well be an amount or an invoice number in MISA's text, and a
--     clearing cannot be undone): those rows are listed for the owner instead, as the activity lines are. Only `reason` changes, and only on a `refused` row: the state, the attempt count, the times and the batch
--     columns stay, so the row still says that MISA refused it, and a person sends it again through a new confirmed push as before. The codes of our own (CONFIRMED_IN_AMIS, NOT_IN_AMIS, the failures of the worker)
--     hold nothing about a person and are never touched. Owner-only, checked here too, in the owner's own context. It takes the value, never a pattern.
--
-- The table's guard (misa_amis_push_guard) lets a tenant role move a row only along the graph, so a tenant UPDATE of `reason` is refused; this definer runs as the function owner, which the guard does not treat as
-- a tenant, and is the one path that clears the text. updated_at is left as it is: an erasure resets no timer.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.personal_data_clear_misa_amis_push_reason(p_kind text, p_value text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_rows integer;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- A kind or a value of the wrong shape is refused (22023) before any row is read, whether or not the org has pushed anything.
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  IF p_kind = 'digits' AND pg_catalog.length(p_value) < 10 THEN
    RETURN 0;
  END IF;
  UPDATE crove_finance.misa_amis_push p
     SET reason = NULL
   WHERE p.org_id = v_org AND p.state = 'refused' AND p.reason IS NOT NULL AND crove_kernel.text_mentions(p.reason, p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION crove_finance.personal_data_clear_misa_amis_push_reason(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.personal_data_clear_misa_amis_push_reason(text, text) TO crove_app;
