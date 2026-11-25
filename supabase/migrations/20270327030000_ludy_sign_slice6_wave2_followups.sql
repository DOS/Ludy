-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 6 Wave 2 follow-ups (#4837, from #4722 & #4723):
--   1. Item 7: ludy_sign.work_recovery_candidates(...) picks up draft envelopes whose parent inspect_status
--      is 'failed' while newly-added packet document(s) remain 'pending' (e.g. Sign toggled off during add).
--   2. Item 10: ludy_sign.deposit_guard_file_error(...) and ludy_sign.deposit_profile_guard() narrow
--      new/changed VietQR profile images strictly to source = 'sign_deposit_qr' (matching resolveProfileQrFile
--      in TypeScript) while preserving pre-migration upload/social profiles and frozen snapshots.

-- 1. Item 7: Recover draft envelopes with any pending packet document even when parent inspect_status is 'failed'.
CREATE OR REPLACE FUNCTION ludy_sign.work_recovery_candidates(
  p_older_than timestamptz,
  p_limit integer DEFAULT 100,
  p_org_id uuid DEFAULT NULL,
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_org_id uuid DEFAULT NULL,
  p_after_envelope_id uuid DEFAULT NULL
)
RETURNS TABLE(work_kind text, org_id uuid, envelope_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_has_cursor boolean := p_after_updated_at IS NOT NULL
    AND p_after_org_id IS NOT NULL
    AND p_after_envelope_id IS NOT NULL;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF (p_after_updated_at IS NULL) <> (p_after_org_id IS NULL)
     OR (p_after_updated_at IS NULL) <> (p_after_envelope_id IS NULL) THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_INVALID_CURSOR' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT q.work_kind, q.org_id, q.envelope_id, q.updated_at
  FROM (
    SELECT 'inspect'::text AS work_kind, u.org_id, u.envelope_id, u.updated_at
    FROM (
      SELECT DISTINCT ON (s.org_id, s.envelope_id)
        s.org_id, s.envelope_id, s.updated_at
      FROM (
        SELECT e.org_id, e.id AS envelope_id, e.updated_at
        FROM ludy_sign.envelope e
        JOIN ludy_kernel.tenant t ON t.org_id = e.org_id
        WHERE t.status = 'active'
          AND (p_org_id IS NULL OR e.org_id = p_org_id)
          AND ludy_kernel.org_app_on(e.org_id, 'sign')
          AND e.status = 'draft'
          AND e.inspect_status = 'pending'
          AND e.updated_at <= p_older_than
          AND (NOT v_has_cursor OR (e.updated_at, e.org_id, e.id) > (p_after_updated_at, p_after_org_id, p_after_envelope_id))
        UNION ALL
        SELECT e.org_id, e.id AS envelope_id, e.updated_at
        FROM ludy_sign.envelope_document ed
        JOIN ludy_sign.envelope e
          ON e.org_id = ed.org_id AND e.id = ed.envelope_id
        JOIN ludy_kernel.tenant t ON t.org_id = e.org_id
        WHERE ed.inspect_status = 'pending'
          AND e.status = 'draft'
          AND t.status = 'active'
          AND (p_org_id IS NULL OR e.org_id = p_org_id)
          AND ludy_kernel.org_app_on(e.org_id, 'sign')
          AND e.updated_at <= p_older_than
          AND (NOT v_has_cursor OR (e.updated_at, e.org_id, e.id) > (p_after_updated_at, p_after_org_id, p_after_envelope_id))
      ) s
      ORDER BY s.org_id, s.envelope_id
    ) u
    UNION ALL
    SELECT 'seal'::text AS work_kind, e.org_id, e.id AS envelope_id, e.updated_at
    FROM ludy_sign.envelope e
    JOIN ludy_kernel.tenant t ON t.org_id = e.org_id
    WHERE t.status = 'active'
      AND (p_org_id IS NULL OR e.org_id = p_org_id)
      AND ludy_kernel.org_app_on(e.org_id, 'sign')
      AND e.status = 'completed'
      AND e.seal_status IS NULL
      AND e.updated_at <= p_older_than
      AND (NOT v_has_cursor OR (e.updated_at, e.org_id, e.id) > (p_after_updated_at, p_after_org_id, p_after_envelope_id))
  ) q
  ORDER BY q.updated_at ASC, q.org_id ASC, q.envelope_id ASC
  LIMIT v_limit;
END $$;

-- 2. Item 10: Require dedicated 'sign_deposit_qr' source for VietQR profile files.
CREATE OR REPLACE FUNCTION ludy_sign.deposit_guard_file_error(
  p_org_id uuid,
  p_file_id uuid,
  p_storage_key text,
  p_generation text,
  p_sha256 text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_file record;
BEGIN
  IF p_file_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT f.storage_key, f.generation, f.sha256, f.content_type, f.size_bytes, f.source
  INTO v_file
  FROM ludy_kernel.file f
  WHERE f.org_id = p_org_id
    AND f.id = p_file_id;

  IF NOT FOUND
     OR p_storage_key IS DISTINCT FROM v_file.storage_key
     OR p_generation IS DISTINCT FROM v_file.generation
     OR p_sha256 IS DISTINCT FROM v_file.sha256
     OR NOT (
       v_file.source = 'sign_deposit_qr'
       OR (
         v_file.source IN ('upload', 'social')
         AND (
           EXISTS (
             SELECT 1
             FROM ludy_sign.envelope_deposit ed
             WHERE ed.org_id = p_org_id
               AND ed.snapshot_vietqr_file_id = p_file_id
           )
           OR EXISTS (
             SELECT 1
             FROM ludy_sign.deposit_profile dp
             WHERE dp.org_id = p_org_id
               AND dp.vietqr_file_id = p_file_id
           )
         )
       )
     ) THEN
    RETURN 'SIGN_DEPOSIT_QR_FILE_INVALID';
  END IF;

  IF v_file.content_type IS DISTINCT FROM 'image/png'
     OR v_file.size_bytes < 45
     OR v_file.size_bytes > 262144 THEN
    RETURN 'SIGN_INVALID_SIGNATURE_PNG';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ludy_sign.envelope e
    WHERE e.org_id = p_org_id
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND (
        e.source_file_id = p_file_id
        OR e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document doc
          WHERE doc.org_id = e.org_id
            AND doc.envelope_id = e.id
            AND doc.file_id = p_file_id
        )
      )
  ) THEN
    RETURN 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN';
  END IF;

  RETURN NULL;
END $$;

-- 2b. Require dedicated 'sign_deposit_qr' source for all new or changed deposit_profile QR attachments.
CREATE OR REPLACE FUNCTION ludy_sign.deposit_profile_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_file_err text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := pg_catalog.now();
  END IF;

  IF v_actor IS NULL OR v_actor = 'system' THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;

  IF NEW.vietqr_file_id IS NOT NULL THEN
    v_file_err := ludy_sign.deposit_guard_file_error(
      NEW.org_id,
      NEW.vietqr_file_id,
      NEW.vietqr_storage_key,
      NEW.vietqr_generation,
      NEW.vietqr_sha256
    );
    IF v_file_err IS NOT NULL THEN
      RAISE EXCEPTION '%', v_file_err
        USING ERRCODE = '42501',
              DETAIL = 'vietqr file failed deposit QR integrity or confidentiality check';
    END IF;
    IF TG_OP = 'INSERT' OR NEW.vietqr_file_id IS DISTINCT FROM OLD.vietqr_file_id THEN
      IF NOT EXISTS (
        SELECT 1
        FROM ludy_kernel.file f
        WHERE f.org_id = NEW.org_id
          AND f.id = NEW.vietqr_file_id
          AND f.source = 'sign_deposit_qr'
      ) THEN
        RAISE EXCEPTION 'SIGN_DEPOSIT_QR_FILE_INVALID'
          USING ERRCODE = '42501',
                DETAIL = 'vietqr file failed deposit QR integrity or confidentiality check';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION
  ludy_sign.work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid),
  ludy_sign.deposit_guard_file_error(uuid, uuid, text, text, text),
  ludy_sign.deposit_profile_guard()
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
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION '
      || 'ludy_sign.work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid), '
      || 'ludy_sign.deposit_guard_file_error(uuid, uuid, text, text, text), '
      || 'ludy_sign.deposit_profile_guard() '
      || 'FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid)
TO ludy_worker;
