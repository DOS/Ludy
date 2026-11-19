-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4112, S3a of #4103; plan accounting-software-sync.md step 5): the check of the vouchers' parties and items against the firm's own catalogue in MISA, and what it found. Idempotent;
-- applied files stay untouched.
--
-- misa_amis_match_check   one row per connection: the last check a person asked for (the batch it was asked about: the kind, the period, the entity and the item codes the person chose), whether
--                         it is waiting for the worker, done or failed, and when. A check is a read of the catalogue (parties, items) through the sealed access code, which only the worker opens: the
--                         API never reads the catalogue, so a person's request is a row and a job, and the worker records what it found.
-- misa_amis_match         what the check found, one row per party (by tax code) or item (by code) of the batch: matched (exactly one active catalogue entry, with its code and id), unknown (none) or
--                         ambiguous (more than one active entry). The catalogue itself is read in the worker's memory and is never stored: no name, address or tax code of a catalogue entry is
--                         kept here, only the entry's code and id, which the voucher is written with. The worker replaces a connection's rows whole with each check; nothing else writes them.
--
-- Every member of the entity reads; owners and admins ask for a check (the command), the system context (the worker) records it. A tenant role writes only the request columns of the check row
-- through the guard, and no column of a result row.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.misa_amis_match_check (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  -- The batch the person asked about: the preview kind, the period, the entity and the codes chosen for service and sales lines. Ids, codes and dates; never a name or an amount.
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(params) = 'object' AND pg_catalog.pg_column_size(params) <= 2048),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'done', 'failed')),
  -- Why a check failed, a fixed code of ours (never MISA's text): credentials, unreachable, invalid_response, catalogue_too_large.
  failure text CHECK (failure IS NULL OR failure IN ('credentials', 'unreachable', 'invalid_response', 'catalogue_too_large')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finished_at timestamptz,
  PRIMARY KEY (org_id, id),
  -- One row per connection: a new request is the same row asked again.
  CONSTRAINT misa_amis_match_check_connection_uq UNIQUE (org_id, connection_id),
  CONSTRAINT misa_amis_match_check_state_ck CHECK ((state = 'requested') = (finished_at IS NULL) AND (state = 'failed') = (failure IS NOT NULL)),
  CONSTRAINT misa_amis_match_check_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- A disconnect deletes the connection and, with it, its check and results.
  CONSTRAINT misa_amis_match_check_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_finance.misa_amis_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT misa_amis_match_check_member_fk FOREIGN KEY (org_id, requested_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX IF NOT EXISTS misa_amis_match_check_entity_idx ON crove_finance.misa_amis_match_check (org_id, legal_entity_id);
CREATE INDEX IF NOT EXISTS misa_amis_match_check_requested_by_idx ON crove_finance.misa_amis_match_check (org_id, requested_by) WHERE requested_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.misa_amis_match_check');
REVOKE UPDATE, DELETE ON crove_finance.misa_amis_match_check FROM crove_tenant;
GRANT UPDATE (params, state, failure, requested_by, requested_at, finished_at) ON crove_finance.misa_amis_match_check TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.misa_amis_match_check;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.misa_amis_match_check
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.misa_amis_match_check ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.misa_amis_match_check;
CREATE POLICY le_scope ON crove_finance.misa_amis_match_check AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners and admins ask for a check (the same people who may connect AMIS); every member reads. The system context writes too (the worker records, the matrix's own-org control), never another org's rows.
DROP POLICY IF EXISTS misa_amis_match_check_insert ON crove_finance.misa_amis_match_check;
CREATE POLICY misa_amis_match_check_insert ON crove_finance.misa_amis_match_check AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_match_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS misa_amis_match_check_update ON crove_finance.misa_amis_match_check;
CREATE POLICY misa_amis_match_check_update ON crove_finance.misa_amis_match_check AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_match_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_match_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- The guard: the check is the connection's own entity; a tenant role never types a result (a new row is `requested`, with no failure and no finish time) and moves a row only to `requested` again (a new
-- request: the params, who and when change together, the failure and finish time are cleared); the system context moves a `requested` row to `done` or `failed` and never touches what was asked. An update
-- that changes none of these (the matrix's probe) passes. A superuser (a restore) and the table's owner keep what they write.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_match_check_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant boolean := pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
    AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_system boolean := (SELECT crove_kernel.ctx_actor_type()) = 'system';
  v_result boolean;
  v_ask boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM crove_finance.misa_amis_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.connection_id AND c.legal_entity_id <> NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'MISA_AMIS_MATCH_ENTITY' USING ERRCODE = '42501';
    END IF;
    IF v_tenant THEN
      NEW.state := 'requested';
      NEW.failure := NULL;
      NEW.finished_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NOT v_tenant THEN
    RETURN NEW;
  END IF;
  v_result := (NEW.state, NEW.failure, NEW.finished_at) IS DISTINCT FROM (OLD.state, OLD.failure, OLD.finished_at);
  v_ask := (NEW.params, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.params, OLD.requested_by, OLD.requested_at);
  IF NOT v_result AND NOT v_ask THEN
    RETURN NEW;
  END IF;
  IF v_system THEN
    IF v_ask OR NOT (OLD.state = 'requested' AND NEW.state IN ('done', 'failed')) THEN
      RAISE EXCEPTION 'MISA_AMIS_MATCH_STATE' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.state = 'requested' AND NEW.failure IS NULL AND NEW.finished_at IS NULL THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'MISA_AMIS_MATCH_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_match_check_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_match_check_guard ON crove_finance.misa_amis_match_check;
CREATE TRIGGER misa_amis_match_check_guard BEFORE INSERT OR UPDATE ON crove_finance.misa_amis_match_check
  FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_match_check_guard();
ALTER TABLE crove_finance.misa_amis_match_check ENABLE ALWAYS TRIGGER misa_amis_match_check_guard;

CREATE TABLE IF NOT EXISTS crove_finance.misa_amis_match (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('party', 'item')),
  -- A party is keyed by its tax code (digits only: 10, or 13 with the branch part), an item by the code the voucher is written with.
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 64 AND (kind <> 'party' OR ref ~ '^[0-9]{10}([0-9]{3})?$')),
  state text NOT NULL CHECK (state IN ('matched', 'unknown', 'ambiguous')),
  -- The one active catalogue entry's code and id, only for `matched`: what the voucher is written with. No name, address or tax code of the entry is kept.
  catalogue_code text CHECK (catalogue_code IS NULL OR char_length(catalogue_code) BETWEEN 1 AND 100),
  catalogue_id uuid,
  checked_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT misa_amis_match_ref_uq UNIQUE (org_id, connection_id, kind, ref),
  CONSTRAINT misa_amis_match_found_ck CHECK ((state = 'matched') = (catalogue_code IS NOT NULL) AND (catalogue_id IS NULL OR state = 'matched')),
  CONSTRAINT misa_amis_match_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT misa_amis_match_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_finance.misa_amis_connection (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS misa_amis_match_entity_idx ON crove_finance.misa_amis_match (org_id, legal_entity_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.misa_amis_match');
-- A result is replaced whole, never updated in place: no UPDATE grant. The worker (the system context, which runs as the tenant role) inserts and deletes, by the policies below.
REVOKE UPDATE ON crove_finance.misa_amis_match FROM crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.misa_amis_match;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.misa_amis_match
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.misa_amis_match ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.misa_amis_match;
CREATE POLICY le_scope ON crove_finance.misa_amis_match AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- The system context inserts and deletes (a check replaces a connection's rows whole), and owners and admins by the same pattern as the connection's other tables; no command of theirs writes a result, so a
-- user write exists only for a caller that bypasses the commands, and it can only add a row for a connection of the caller's own entities.
DROP POLICY IF EXISTS misa_amis_match_insert ON crove_finance.misa_amis_match;
CREATE POLICY misa_amis_match_insert ON crove_finance.misa_amis_match AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_match.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS misa_amis_match_delete ON crove_finance.misa_amis_match;
CREATE POLICY misa_amis_match_delete ON crove_finance.misa_amis_match AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_match.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- The result's entity is the connection's, whoever writes it.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_match_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_finance.misa_amis_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.connection_id AND c.legal_entity_id <> NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'MISA_AMIS_MATCH_ENTITY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_match_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_match_guard ON crove_finance.misa_amis_match;
CREATE TRIGGER misa_amis_match_guard BEFORE INSERT ON crove_finance.misa_amis_match
  FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_match_guard();
ALTER TABLE crove_finance.misa_amis_match ENABLE ALWAYS TRIGGER misa_amis_match_guard;

-- The worker's queue for a connection's check: one job per connection at a time (exclusive), dead-lettered like the others. finance.misa_amis_match.check_requested queues a connection the moment an owner
-- or admin asks; nothing else queues it. The check reads (catalogue pages): it changes nothing in MISA.
SELECT crove_jobs.create_queue('finance-misa-amis-match', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);
