-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3902, S3b-2a of #3854): a way out for a `sent` row MISA never answered for (finding F6 of the security review of #4013). The worker asks MISA for the result of a `sent` row for 24 hours
-- after its last change; after that nothing asks, and until now nothing let a person settle it, so it stayed pending for ever (and kept its connection from being removed). The guard of misa_amis_push is
-- restated whole from 20270120100000 with one more person branch: a row `sent` whose last change is more than 24 hours old goes to `accepted` (reason CONFIRMED_IN_AMIS: the person looked in AMIS and it is
-- there) or to `failed` (reason NOT_IN_AMIS: it is sent again only through a new confirmed push). The same rules as the `ambiguous` branch: no batch column moves, the attempt count stays, and a person never
-- moves a row anywhere else. Nothing is sent by this. Idempotent (create or replace); applied files untouched.
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
  ELSE
    RAISE EXCEPTION 'MISA_AMIS_PUSH_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_push_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
