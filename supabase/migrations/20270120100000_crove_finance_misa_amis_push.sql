-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3902, S3b of #3854; plan accounting-software-sync.md step 4): the vouchers pushed to MISA AMIS Kế toán as requests a person approved. Idempotent; applied files stay untouched.
--
-- misa_amis_push   one row per AMIS voucher part pushed: the connection, the Ludy source (a cash voucher, a purchase document or a sales document), the AMIS voucher type, the part (a voucher of
--                  more than 500 lines is several), the `org_refid` AMIS is told (a UUID, unique per org: MISA's own key for the request, so a replay, a double press or a retry never makes a second
--                  request), the voucher number AMIS shows (`org_refno`, at most the 20 characters MISA takes), the digest of what the person saw, the state and, for a refusal, what MISA said.
--                  No voucher body is stored (it holds party names): the worker rebuilds it from the source and checks the digest again before it sends.
--
-- State (a guard enforces the graph): queued -> sending -> sent -> accepted | refused. A call whose answer was lost leaves `ambiguous`: the worker asks MISA for the `org_refid` before anything is
-- sent again. An `ambiguous` row leaves only with MISA's own answer (accepted or refused); nothing sends it again. `failed` is a row that could not be sent (the source changed since the person looked, or a code the worker could not map). Only a person moves a `refused` or `failed` row back to `queued`
-- (a new confirmed push, one more attempt); nothing else moves a row out of `accepted` or `refused`, and no tenant role deletes a row, so nobody erases the record and pushes the same voucher again unseen.
--
-- Every member of the entity reads the rows; owners and admins push (the command), and the system context (the worker) records what came back. A tenant role updates only the state columns, through the guard.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.misa_amis_push (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('cash_voucher', 'purchase_document', 'sales_document')),
  source_id uuid NOT NULL,
  -- The AMIS voucher_type (a small number of the document's enum).
  voucher_type integer NOT NULL CHECK (voucher_type BETWEEN 1 AND 99),
  part integer NOT NULL DEFAULT 1 CHECK (part BETWEEN 1 AND 1000),
  org_refid uuid NOT NULL,
  org_refno text NOT NULL CHECK (char_length(org_refno) BETWEEN 1 AND 20),
  -- SHA-256 (hex) of the voucher part as the person saw it in the preview, without the AMIS branch (which only the worker reads from AMIS).
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  -- What rebuilds the voucher from its source: the preview kind, the period and the choices the person made for the batch. Ids, codes and dates; never a name or an amount.
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(params) = 'object' AND pg_catalog.pg_column_size(params) <= 2048),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent', 'accepted', 'refused', 'ambiguous', 'failed')),
  -- MISA's own text for a refusal (untrusted: shown escaped, never logged, never read as an instruction) or the code of a failure of ours.
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 100),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  answered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- The idempotency key: one request per voucher part in AMIS, whatever is pressed or replayed.
  CONSTRAINT misa_amis_push_refid_uq UNIQUE (org_id, org_refid),
  CONSTRAINT misa_amis_push_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- A disconnect deletes the connection and, with it, these rows (the audit trail and the external call ledger keep the history).
  CONSTRAINT misa_amis_push_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_finance.misa_amis_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT misa_amis_push_member_fk FOREIGN KEY (org_id, requested_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (requested_by)
);
-- What the worker takes next (the queued rows of a connection, oldest first) and what a person lists (a connection's rows by state).
CREATE INDEX IF NOT EXISTS misa_amis_push_connection_idx ON crove_finance.misa_amis_push (org_id, connection_id, state, requested_at);
CREATE INDEX IF NOT EXISTS misa_amis_push_source_idx ON crove_finance.misa_amis_push (org_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS misa_amis_push_requested_by_idx ON crove_finance.misa_amis_push (org_id, requested_by) WHERE requested_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.misa_amis_push');
REVOKE UPDATE, DELETE ON crove_finance.misa_amis_push FROM crove_tenant;
-- The state columns, and the batch columns a person's new confirmed push sets again on a `refused` or `failed` row (the digest of what was approved now, the choices, who and when); the guard below allows
-- the batch columns to change only together with that move back to `queued`.
GRANT UPDATE (state, reason, attempts, sent_at, answered_at, updated_at, payload_digest, params, requested_by, requested_at) ON crove_finance.misa_amis_push TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.misa_amis_push;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.misa_amis_push
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.misa_amis_push ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.misa_amis_push;
CREATE POLICY le_scope ON crove_finance.misa_amis_push AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners and admins write (they are the people who may connect AMIS); every member reads. The system context writes too (the worker, the matrix's own-org control), never another org's rows.
DROP POLICY IF EXISTS misa_amis_push_insert ON crove_finance.misa_amis_push;
CREATE POLICY misa_amis_push_insert ON crove_finance.misa_amis_push AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_push.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS misa_amis_push_update ON crove_finance.misa_amis_push;
CREATE POLICY misa_amis_push_update ON crove_finance.misa_amis_push AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_push.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_push.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- The insert guard: a tenant role never types the state, the reason, the attempt count or the times (a new row is `queued`, attempt 1, nothing answered), the entity is the connection's, and the
-- connection is the AMIS one. The update guard enforces the graph in the header: the system context moves a row along it; a person moves only `refused` or `failed` back to `queued`, with one more attempt
-- and the reason and times cleared; an update that changes none of the state columns (the matrix's probe) passes. The immutable columns have no UPDATE grant. A superuser (a restore) and the table's
-- owner keep what they write. Runs as the writer, which reads the connection through its own policies.
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
  ELSIF NOT (OLD.state IN ('refused', 'failed') AND NEW.state = 'queued' AND NEW.attempts = OLD.attempts + 1 AND NEW.reason IS NULL AND NEW.sent_at IS NULL AND NEW.answered_at IS NULL) THEN
    RAISE EXCEPTION 'MISA_AMIS_PUSH_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_push_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_push_guard ON crove_finance.misa_amis_push;
CREATE TRIGGER misa_amis_push_guard BEFORE INSERT OR UPDATE ON crove_finance.misa_amis_push
  FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_push_guard();
ALTER TABLE crove_finance.misa_amis_push ENABLE ALWAYS TRIGGER misa_amis_push_guard;

-- The worker's queue for a connection's push: one job per connection at a time (exclusive), dead-lettered like the others.
SELECT crove_jobs.create_queue('finance-misa-amis-push', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);
