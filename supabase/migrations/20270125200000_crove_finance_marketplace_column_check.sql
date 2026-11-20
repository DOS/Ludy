-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4036, slice 1c of #3850; plan stock-and-marketplaces.md section 8.6 "Columns"): the check of a column mapping on a marketplace order report no platform profile fits. Idempotent;
-- applied files stay untouched.
--
-- marketplace_column_check   one row per file: the last check a person asked for (the platform they picked and at most 13 assignments of a column to a standard field), whether it is waiting for the worker,
--                            done or failed, and what it found: the masked sheet (header texts and the SHAPES of a few values, never a value, a buyer column an empty shell), the check's refusal code, and a
--                            preview of at most 20 parsed lines. The file is read by the worker through the extract sandbox (the API has no access to it), so a person's request is a row and a job, and the
--                            worker records the answer. Nothing is imported or saved from a mapping here: saving a confirmed mapping is slice 2 (#4037).
--
-- The preview lines can carry a buyer's text when a person maps an unflagged column to a text field (the limit stated in #4178), so `preview` is personal data in the registry (packages/kernel
-- personal-data.ts), erased with the file and the org (the file's foreign key cascades, and the org purge deletes the table), kept only for the latest check per file (one row per file) and deleted
-- by the nightly retention seven days after it finished. It is never sent to a model, never in a log, an error, an audit row or a job payload (the job carries ids only).
--
-- Importers (owners, admins and members, the same people who see a staged report) ask for a check and delete a row; the system context (the worker) records it. A tenant role writes only the request
-- columns of a row and clears a result when it asks again, and never types a result: the guard below.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_column_check (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  file_id uuid NOT NULL,
  -- What was asked: the platform the person picked (never the model's guess; null for a request of the sheet alone) and the mapping, one assignment of a column index to a standard field each.
  platform text CHECK (platform IS NULL OR platform IN ('shopee', 'tiktok_shop', 'lazada')),
  assignments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(assignments) = 'array' AND pg_catalog.jsonb_array_length(assignments) <= 13 AND pg_catalog.pg_column_size(assignments) <= 2048),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'done', 'failed')),
  -- Why the check could not run, a fixed code of ours: the file is no sheet, is over the size limit, the sandbox could not be reached, or could not read it.
  failure text CHECK (failure IS NULL OR failure IN ('not_a_sheet', 'too_large', 'unavailable', 'unreadable')),
  -- Why the mapping does not read the file, the reason of the deterministic check (packages/l10n-vn marketplace-columns.ts); null when it reads it, or when no mapping was asked.
  refusal text CHECK (refusal IS NULL OR refusal IN ('no_header', 'bad_column', 'buyer_column', 'field_twice', 'column_twice', 'no_order_no', 'no_line', 'nothing_read', 'row_stops_file', 'too_many_rows', 'rows_without_order', 'return_without_status', 'quantity_exceeds_amount', 'dates_swapped', 'buyer_text')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finished_at timestamptz,
  -- The masked sheet of the file: shapes only. Kept when the person asks again (the file's sheet does not change).
  sheet jsonb CHECK (sheet IS NULL OR (pg_catalog.jsonb_typeof(sheet) = 'object' AND pg_catalog.pg_column_size(sheet) <= 32768)),
  -- Personal data (registry): at most 20 parsed lines and their counts, only what the confirm screen shows. Cleared when the person asks again.
  preview jsonb CHECK (preview IS NULL OR (pg_catalog.jsonb_typeof(preview) = 'object' AND pg_catalog.pg_column_size(preview) <= 65536)),
  PRIMARY KEY (org_id, id),
  -- One row per file: a new request is the same row asked again, and the latest check is the only one kept.
  CONSTRAINT marketplace_column_check_file_uq UNIQUE (org_id, file_id),
  CONSTRAINT marketplace_column_check_state_ck CHECK (
    (state <> 'done' OR finished_at IS NOT NULL)
    AND (state = 'failed') = (failure IS NOT NULL)
    AND (refusal IS NULL OR state = 'done')
    AND (preview IS NULL OR state = 'done')
  ),
  -- The file is the org's own, and its erasure removes the check and the preview with it.
  CONSTRAINT marketplace_column_check_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE,
  CONSTRAINT marketplace_column_check_member_fk FOREIGN KEY (org_id, requested_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX IF NOT EXISTS marketplace_column_check_requested_by_idx ON crove_finance.marketplace_column_check (org_id, requested_by) WHERE requested_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_column_check');
REVOKE UPDATE ON crove_finance.marketplace_column_check FROM crove_tenant;
GRANT UPDATE (platform, assignments, state, failure, refusal, requested_by, requested_at, finished_at, sheet, preview) ON crove_finance.marketplace_column_check TO crove_tenant;
-- Importers ask for a check, move it and delete it; the system context writes too (the worker records, the matrix's own-org control), never another org's rows.
DROP POLICY IF EXISTS marketplace_column_check_insert ON crove_finance.marketplace_column_check;
CREATE POLICY marketplace_column_check_insert ON crove_finance.marketplace_column_check AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_column_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS marketplace_column_check_update ON crove_finance.marketplace_column_check;
CREATE POLICY marketplace_column_check_update ON crove_finance.marketplace_column_check AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_column_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_column_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS marketplace_column_check_delete ON crove_finance.marketplace_column_check;
CREATE POLICY marketplace_column_check_delete ON crove_finance.marketplace_column_check AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_column_check.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- The guard: a tenant role never types a result (a new row is `requested`, with no failure, refusal, sheet, preview or finish time) and moves a row only to `requested` again (a new request: the platform, the
-- assignments, who and when change together; the failure, the refusal and the preview are cleared, the sheet and the finish time are kept); the system context moves a `requested` row to `done` or `failed`
-- and never touches what was asked. An update that changes none of these (the matrix's probe) passes. A superuser (a restore) and the table's owner keep what they write.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_column_check_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant boolean := pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
    AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_system boolean := (SELECT crove_kernel.ctx_actor_type()) = 'system';
  v_result boolean;
  v_ask boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_tenant THEN
      NEW.state := 'requested';
      NEW.failure := NULL;
      NEW.refusal := NULL;
      NEW.finished_at := NULL;
      NEW.sheet := NULL;
      NEW.preview := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NOT v_tenant THEN
    RETURN NEW;
  END IF;
  v_result := (NEW.state, NEW.failure, NEW.refusal, NEW.finished_at, NEW.sheet, NEW.preview) IS DISTINCT FROM (OLD.state, OLD.failure, OLD.refusal, OLD.finished_at, OLD.sheet, OLD.preview);
  v_ask := (NEW.platform, NEW.assignments, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.platform, OLD.assignments, OLD.requested_by, OLD.requested_at);
  IF NOT v_result AND NOT v_ask THEN
    RETURN NEW;
  END IF;
  IF v_system THEN
    IF v_ask OR NOT (OLD.state = 'requested' AND NEW.state IN ('done', 'failed')) THEN
      RAISE EXCEPTION 'MARKETPLACE_COLUMN_CHECK_STATE' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.state = 'requested' AND NEW.failure IS NULL AND NEW.refusal IS NULL AND NEW.preview IS NULL
        AND NEW.sheet IS NOT DISTINCT FROM OLD.sheet AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'MARKETPLACE_COLUMN_CHECK_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_column_check_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS marketplace_column_check_guard ON crove_finance.marketplace_column_check;
CREATE TRIGGER marketplace_column_check_guard BEFORE INSERT OR UPDATE ON crove_finance.marketplace_column_check
  FOR EACH ROW EXECUTE FUNCTION crove_finance.marketplace_column_check_guard();
ALTER TABLE crove_finance.marketplace_column_check ENABLE ALWAYS TRIGGER marketplace_column_check_guard;

-- The worker's queue for a file's check: one job per file at a time (exclusive), dead-lettered like the others. finance.marketplace.columns_check queues a file the moment a member asks; nothing else queues it.
-- The check reads the file (through the extract sandbox): it changes nothing in the books.
SELECT crove_jobs.create_queue('finance-marketplace-column-check', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);

-- The nightly retention (the worker's, with the retention of decided reports' originals): a check whose last move is older than `days` days is deleted, its sheet and its preview with it. The preview is
-- personal data kept for seven days at most; a request that never finished (a lost job) goes the same way. Worker only; ids are never returned, only the count.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_column_check_prune(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_COLUMN_CHECK_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'MARKETPLACE_COLUMN_CHECK_RETENTION_DAYS' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_finance.marketplace_column_check c
   -- The row's last move: a new request keeps the earlier finish time, so the later of the two is the age, and a check asked again today is never pruned for an old finish.
   WHERE GREATEST(c.requested_at, COALESCE(c.finished_at, c.requested_at)) < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_column_check_prune(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_column_check_prune(integer) TO crove_worker;
