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
-- The table's guard (misa_amis_push_guard) lets a tenant role move a row only along the graph, so a tenant UPDATE of `reason` is refused. On an owned database the definer's owner is a superuser or no member of
-- crove_tenant, which the guard does not treat as a tenant; on a shared database the migration login that owns it IS a member of crove_tenant (non-superuser, ADMIN OPTION) and would be refused (the finding B1 of
-- the security review). So the guard is restated whole from 20270121100000 with one narrow branch: `refused` to `refused`, `reason` not null to null, every other column unchanged, updated_at kept, no batch
-- column moved, in the owner's own sealed context. Nothing else about the guard changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.misa_amis_push_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant boolean := pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
    AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_system boolean := (SELECT crove_kernel.ctx_actor_type()) = 'system';
  v_state boolean;
  v_batch boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM crove_finance.misa_amis_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.connection_id AND c.legal_entity_id <> NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'MISA_AMIS_PUSH_ENTITY' USING ERRCODE = '42501';
    END IF;
    IF v_tenant THEN
      NEW.state := 'queued';
      NEW.reason := NULL;
      NEW.attempts := 1;
      NEW.sent_at := NULL;
      NEW.answered_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NOT v_tenant THEN
    RETURN NEW;
  END IF;
  v_state := (NEW.state, NEW.reason, NEW.attempts, NEW.sent_at, NEW.answered_at) IS DISTINCT FROM (OLD.state, OLD.reason, OLD.attempts, OLD.sent_at, OLD.answered_at);
  v_batch := (NEW.payload_digest, NEW.params, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.payload_digest, OLD.params, OLD.requested_by, OLD.requested_at);
  IF NOT v_state AND NOT v_batch THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;
  IF v_system THEN
    -- The worker moves a row along the graph and never touches what was approved or how many attempts a person has made. `ambiguous` leaves only with MISA's own answer: nothing sends it again.
    IF v_batch OR NEW.attempts <> OLD.attempts OR NOT (
      (OLD.state = 'queued' AND NEW.state IN ('sending', 'failed'))
      OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'ambiguous', 'failed', 'refused', 'queued'))
      OR (OLD.state = 'sent' AND NEW.state IN ('accepted', 'refused'))
      OR (OLD.state = 'ambiguous' AND NEW.state IN ('accepted', 'refused'))
    ) THEN
      RAISE EXCEPTION 'MISA_AMIS_PUSH_STATE' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state IN ('refused', 'failed') AND NEW.state = 'queued' AND NEW.attempts = OLD.attempts + 1 AND NEW.reason IS NULL AND NEW.sent_at IS NULL AND NEW.answered_at IS NULL THEN
    -- A person's move is stamped with the database clock, whatever the statement wrote: no row can be backdated into a window it has not reached (an `ambiguous` row put back to `sent` then settled at once).
    NEW.updated_at := pg_catalog.now();
  ELSIF OLD.state = 'ambiguous' AND OLD.updated_at < pg_catalog.now() - interval '3 days' AND NOT v_batch AND NEW.attempts = OLD.attempts AND NEW.answered_at IS NOT DISTINCT FROM OLD.answered_at
        AND ((NEW.state = 'sent' AND NEW.reason = 'CONFIRMED_IN_AMIS') OR (NEW.state = 'failed' AND NEW.reason = 'NOT_IN_AMIS')) THEN
    -- A person looked in AMIS after three days without MISA's answer: "it is in AMIS" (the row is `sent`, no call is made) or "it is not in AMIS" (`failed`; it goes back to `queued` only through a new confirmed push).
    NEW.updated_at := pg_catalog.now();
  ELSIF OLD.state = 'sent' AND OLD.updated_at < pg_catalog.now() - interval '24 hours' AND NOT v_batch AND NEW.attempts = OLD.attempts AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at
        AND ((NEW.state = 'accepted' AND NEW.reason = 'CONFIRMED_IN_AMIS' AND NEW.answered_at IS NOT NULL) OR (NEW.state = 'failed' AND NEW.reason = 'NOT_IN_AMIS' AND NEW.answered_at IS NOT DISTINCT FROM OLD.answered_at)) THEN
    -- A row MISA took and never answered for in the 24 hours the worker asks (the polling window): a person looked in AMIS. "It is in AMIS": the row is `accepted` (MISA's result is no longer awaited; nothing is sent);
    -- "it is not in AMIS": `failed` (it goes back to `queued` only through a new confirmed push).
    NEW.updated_at := pg_catalog.now();
  ELSIF OLD.state = 'refused' AND NEW.state = 'refused' AND OLD.reason IS NOT NULL AND NEW.reason IS NULL AND NOT v_batch AND NEW.attempts = OLD.attempts
        AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at AND NEW.answered_at IS NOT DISTINCT FROM OLD.answered_at
        AND (SELECT crove_kernel.ctx_verified() ->> 'role') = 'owner' THEN
    -- An owner's erasure (kernel.personal_data.erase, through personal_data_clear_misa_amis_push_reason): MISA's refusal text goes and nothing else about the row moves. The state stays `refused`, the attempt count, the
    -- times and the batch columns stay, and updated_at is kept, so an erasure resets no timer. Needed on a shared database, where the migration login that owns the definer is a MEMBER of crove_tenant (ADMIN OPTION,
    -- docs/runbooks/shared-database.md) and so is treated as a tenant here, unlike a superuser.
    NEW.updated_at := OLD.updated_at;
  ELSE
    RAISE EXCEPTION 'MISA_AMIS_PUSH_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_push_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
