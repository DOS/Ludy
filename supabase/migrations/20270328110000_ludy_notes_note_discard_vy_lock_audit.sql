-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Notes (issue #4725, PR #4700 review follow-up):
-- 1. Convert note_discard_vy_tr to an AFTER DELETE statement trigger using REFERENCING OLD TABLE AS
--    deleted_notes and a single O(1) per-org exclusive advisory lock ('ludy.note_vy:<org>') acquired
--    after all DELETE row locks and before any ai_run row locks. That avoids O(N) shared lock-table growth
--    during large trash_empty / purge batches and eliminates multi-note lock-order cycles with concurrent
--    member_vy.run.start (which takes the matching shared per-org lock before locking ai_run).
-- 2. Emit one 'notes.vy.run_cancelled' audit_event row per running Vy run cancelled by note deletion,
--    matching ludy_meetings.meeting_discard_transcribe() audit parity (20261220000000 / 20270327120000).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_notes.note_discard_vy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deleted_notes) THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'NOTE_DISCARD_VY_ISOLATION' USING ERRCODE = '25001';
  END IF;

  FOR v_org IN
    SELECT DISTINCT d.org_id
      FROM deleted_notes d
     ORDER BY d.org_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('ludy.note_vy:' || v_org::text, 0)
    );
  END LOOP;

  WITH locked_runs AS (
    SELECT ar.org_id,
           ar.id AS run_id,
           mvr.subject_id AS note_id,
           mvr.feature
      FROM deleted_notes dn
      JOIN ludy_kernel.member_vy_result mvr
        ON mvr.org_id = dn.org_id
       AND mvr.subject_type IN ('note', 'notes.note')
       AND mvr.subject_id = dn.id
      JOIN ludy_kernel.ai_run ar
        ON ar.org_id = mvr.org_id
       AND ar.id = mvr.run_id
     WHERE mvr.run_id IS NOT NULL
       AND ar.status = 'running'
     ORDER BY ar.org_id, ar.id
     FOR UPDATE OF ar
  ),
  cancelled AS (
    UPDATE ludy_kernel.ai_run ar
       SET status = 'cancelled',
           finished_at = COALESCE(ar.finished_at, pg_catalog.now()),
           error = COALESCE(ar.error, 'NOTE_REMOVED')
      FROM locked_runs lr
     WHERE ar.org_id = lr.org_id
       AND ar.id = lr.run_id
       AND ar.status = 'running'
     RETURNING lr.org_id, lr.run_id, lr.note_id, lr.feature
  )
  INSERT INTO ludy_kernel.audit_event (
    org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail
  )
  SELECT c.org_id,
         'system',
         NULL,
         'notes.vy.run_cancelled',
         ludy_kernel.uuid_v7(),
         'ok',
         'kernel.ai_run',
         c.run_id,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.run_id::text, 'UTF8')), 'hex'),
         pg_catalog.jsonb_build_object('runId', c.run_id, 'noteId', c.note_id, 'feature', c.feature, 'reason', 'NOTE_REMOVED')
    FROM cancelled c;

  DELETE FROM ludy_kernel.member_vy_result v
   USING deleted_notes d
   WHERE v.org_id = d.org_id
     AND v.subject_type IN ('note', 'notes.note')
     AND v.subject_id = d.id;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION ludy_notes.note_discard_vy()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_catalog.pg_roles
     WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
       AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.note_discard_vy() FROM %I', r.rolname);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS note_discard_vy_tr ON ludy_notes.note;
CREATE TRIGGER note_discard_vy_tr
  AFTER DELETE ON ludy_notes.note
  REFERENCING OLD TABLE AS deleted_notes
  FOR EACH STATEMENT
  EXECUTE FUNCTION ludy_notes.note_discard_vy();

-- Mixed-version rollout & rollback guard (#4725): an older kernel release that inserts a running note-bound
-- member_vy_result without calling acquireNoteVyLock() still acquires the shared ludy.note_vy lock and verifies
-- a live non-trashed readable note under caller session RLS AFTER RLS WITH CHECK (preserving 42501 precedence).
-- Body names ludy_notes.note and ludy_kernel.ctx_user_id() only (never member_vy_result or member_vy_memory).
-- migration-lint: cross-module checks ludy_kernel.ctx_user_id() so non-context admin test seeds stay unaffected while runtime user inserts are guarded (#4725).
CREATE OR REPLACE FUNCTION ludy_notes.note_member_vy_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ludy_kernel.ctx_user_id() IS NULL THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'NOTE_DISCARD_VY_ISOLATION' USING ERRCODE = '25001';
  END IF;
  -- Serialize mixed-version note-bound Vy starts behind concurrent hard-deletes instead of raising spurious 40001 RETRY (#4725);
  -- if an older kernel locked ai_run first, PostgreSQL's deadlock detector breaks the cycle as 40P01 RETRY with zero orphans.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('ludy.note_vy:' || NEW.org_id::text, 0)
  );
  IF NOT EXISTS (
    SELECT 1
      FROM ludy_notes.note n
     WHERE n.org_id = NEW.org_id
       AND n.id = NEW.subject_id
       AND n.deleted_at IS NULL
  ) THEN
    -- Rolled back atomically by DB; runtimes without the P0002 mapper temporarily surface 500 INTERNAL with zero orphans.
    RAISE EXCEPTION 'NOTE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION ludy_notes.note_member_vy_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_catalog.pg_roles
     WHERE rolname LIKE 'ludy\_%'
       AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.note_member_vy_guard() FROM %I', r.rolname);
  END LOOP;
END $$;

-- migration-lint: cross-module enforce shared ludy.note_vy lock and live note check at insert time on ludy_kernel.member_vy_result for note-bound Vy runs (#4725).
DROP TRIGGER IF EXISTS note_member_vy_guard ON ludy_kernel.member_vy_result;
-- migration-lint: cross-module see above.
CREATE TRIGGER note_member_vy_guard
  AFTER INSERT ON ludy_kernel.member_vy_result
  FOR EACH ROW
  WHEN (NEW.subject_type IN ('note', 'notes.note') AND NEW.status = 'running')
  EXECUTE FUNCTION ludy_notes.note_member_vy_guard();
