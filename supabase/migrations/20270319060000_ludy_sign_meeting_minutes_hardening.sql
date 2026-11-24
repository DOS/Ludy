-- SPDX-License-Identifier: AGPL-3.0-only
-- Review follow-ups for eSign meeting_minutes lifecycle & offboarding export (#4641, Refs #4639):
--   1. Make ludy_sign.is_exportable_envelope_id(uuid, uuid) and ludy_sign.is_exportable_sign_file(uuid, uuid, text)
--      status-aware so completed org-visible meeting_minutes legal records remain exportable after meeting
--      text_retention_date expiry or meeting deletion/purge (retained_org_visible = true), while preserving the
--      3-arg ludy_sign.is_exportable_envelope(uuid, text, uuid) contract and keeping attendees-only / erased
--      unsigned envelopes strictly excluded.
--   2. Align ludy_sign.cleanup_meeting_minutes_envelopes child lock order (signing_token before field) with
--      public_submit and personal_erase_unsealed_signers, and scrub pre-existing free-text void_reason on
--      already-closed unsigned envelopes.
--   3. Tighten ludy_sign.envelope_guard() cleanup checks (OLD.retained_org_visible/retained_reader_ids IS NULL
--      before snapshotting completed records, and strict status/voided_at/void_reason rules on unsigned erasure).

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Status-aware offboarding export helpers (preserving 3-arg signature)
-- ---------------------------------------------------------------------------

-- migration-lint: cross-module reads ludy_meetings.meeting for completed org-visible meeting_minutes export eligibility (#4641).
CREATE OR REPLACE FUNCTION ludy_sign.is_exportable_envelope_id(
  p_org_id uuid,
  p_envelope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_source_kind text;
  v_source_id uuid;
  v_status text;
  v_retained_org_visible boolean;
  v_vis text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_envelope_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
    ) THEN
      RETURN false;
    END IF;
  END IF;

  SELECT e.source_kind, e.source_id, e.status, e.retained_org_visible
  INTO v_source_kind, v_source_id, v_status, v_retained_org_visible
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_source_kind IS DISTINCT FROM 'meeting_minutes' THEN
    RETURN true;
  END IF;

  IF v_status = 'completed' THEN
    IF v_source_id IS NOT NULL THEN
      SELECT mtg.visibility
      INTO v_vis
      FROM ludy_meetings.meeting mtg
      WHERE mtg.org_id = v_org
        AND mtg.id = v_source_id;

      IF FOUND THEN
        RETURN (v_vis = 'org');
      END IF;
    END IF;

    RETURN (v_retained_org_visible IS TRUE);
  END IF;

  RETURN ludy_sign.is_exportable_envelope(v_org, v_source_kind, v_source_id);
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.is_exportable_sign_file(
  p_org_id uuid,
  p_file_id uuid,
  p_source text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
    ) THEN
      RETURN false;
    END IF;
  END IF;

  IF p_source IS DISTINCT FROM 'sign_document'
     AND p_source IS DISTINCT FROM 'sign_sealed'
     AND p_source IS DISTINCT FROM 'sign_certificate'
     AND p_source IS DISTINCT FROM 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.envelope e
       WHERE e.org_id = v_org
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
         )
     ) THEN
    RETURN true;
  END IF;

  -- Superseded or PDPL-erased sign_attachment files (no longer referenced by any field row) stay out of org exports.
  IF p_source = 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.field fld
       WHERE fld.org_id = v_org
         AND fld.attachment_file_id = p_file_id
     ) THEN
    RETURN false;
  END IF;

  -- 1. Deny sealed PDFs, PAdES PDFs, completion certificates, and supporting attachments of non-exportable envelopes first.
  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
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
      )
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
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
      )
  ) THEN
    RETURN true;
  END IF;

  -- 2. Blank organization-wide template PDFs stay exportable even after instantiating a
  --    confidential envelope from that template, provided the template existed at or before
  --    the confidential envelope was created.
  IF EXISTS (
    SELECT 1 FROM ludy_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  -- 3. Deny dedicated source PDFs attached to any non-exportable confidential envelope,
  --    unless an exportable retained envelope for the same source references the file.
  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.envelope e2
        WHERE e2.org_id = v_org
          AND e2.source_file_id = p_file_id
          AND e2.source_kind = e.source_kind
          AND e2.source_id IS NOT DISTINCT FROM e.source_id
          AND ludy_sign.is_exportable_envelope_id(v_org, e2.id)
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
  ) THEN
    RETURN true;
  END IF;

  -- Unattached sign_document files uploaded by non-owners stay private until attached.
  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    JOIN ludy_kernel.tenant_member m
      ON m.org_id = f.org_id AND m.user_id = f.created_by
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND m.role = 'owner'
  );
END $$;

-- ---------------------------------------------------------------------------
-- 2. Meeting-deletion cleanup definer: canonical lock order & void_reason scrub
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.cleanup_meeting_minutes_envelopes(
  p_org_id uuid,
  p_meeting_id uuid,
  p_org_visible boolean,
  p_reader_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_occurred_iso text := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_completed_ids uuid[] := '{}'::uuid[];
  v_unsigned_ids uuid[] := '{}'::uuid[];
  v_env record;
  v_next_seq integer;
  v_prev_hash text;
  v_prev_json text;
  v_canonical text;
  v_event_hash text;
BEGIN
  IF p_org_id IS NULL OR p_meeting_id IS NULL THEN
    RETURN;
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('ludy.org_purge', true) = p_org_id::text THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = p_org_id
      AND e.source_kind = 'meeting_minutes'
      AND e.source_id = p_meeting_id
  ) THEN
    RETURN;
  END IF;

  FOR v_env IN
    SELECT e.id, e.status, e.source_sha256, e.retained_reader_ids
    FROM ludy_sign.envelope e
    WHERE e.org_id = p_org_id
      AND e.source_kind = 'meeting_minutes'
      AND e.source_id = p_meeting_id
    ORDER BY e.id
    FOR UPDATE OF e
  LOOP
    IF v_env.status = 'completed' THEN
      v_completed_ids := pg_catalog.array_append(v_completed_ids, v_env.id);
    ELSE
      v_unsigned_ids := pg_catalog.array_append(v_unsigned_ids, v_env.id);
    END IF;
  END LOOP;

  IF pg_catalog.array_length(v_completed_ids, 1) IS NULL
     AND pg_catalog.array_length(v_unsigned_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', p_org_id::text, true);
  BEGIN
    IF COALESCE(pg_catalog.array_length(v_completed_ids, 1), 0) > 0 THEN
      UPDATE ludy_sign.envelope e
      SET retained_org_visible = COALESCE(e.retained_org_visible, COALESCE(p_org_visible, false)),
          retained_reader_ids = COALESCE(e.retained_reader_ids, COALESCE(p_reader_ids, ARRAY[]::uuid[])),
          updated_at = v_now
      WHERE e.org_id = p_org_id
        AND e.id = ANY (v_completed_ids)
        AND e.status = 'completed'
        AND e.retained_reader_ids IS NULL;
    END IF;

    IF COALESCE(pg_catalog.array_length(v_unsigned_ids, 1), 0) > 0 THEN
      -- Canonical lock order: envelope -> signer -> signing_token -> field -> signing_otp -> remaining children.
      PERFORM 1 FROM ludy_sign.signer s WHERE s.org_id = p_org_id AND s.envelope_id = ANY (v_unsigned_ids) ORDER BY s.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.signing_token t WHERE t.org_id = p_org_id AND t.envelope_id = ANY (v_unsigned_ids) ORDER BY t.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.field f WHERE f.org_id = p_org_id AND f.envelope_id = ANY (v_unsigned_ids) ORDER BY f.id FOR UPDATE;
      PERFORM 1
      FROM ludy_sign.signing_otp o
      JOIN ludy_sign.signer s ON s.org_id = o.org_id AND s.id = o.signer_id
      WHERE o.org_id = p_org_id AND s.envelope_id = ANY (v_unsigned_ids)
      ORDER BY o.id
      FOR UPDATE OF o;
      PERFORM 1 FROM ludy_sign.ai_analysis a WHERE a.org_id = p_org_id AND a.envelope_id = ANY (v_unsigned_ids) ORDER BY a.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.playbook_check p WHERE p.org_id = p_org_id AND p.envelope_id = ANY (v_unsigned_ids) ORDER BY p.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.kyc_check k WHERE k.org_id = p_org_id AND k.envelope_id = ANY (v_unsigned_ids) ORDER BY k.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.ca_signing_request c WHERE c.org_id = p_org_id AND c.envelope_id = ANY (v_unsigned_ids) ORDER BY c.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.envelope_obligation eo WHERE eo.org_id = p_org_id AND eo.envelope_id = ANY (v_unsigned_ids) ORDER BY eo.id FOR UPDATE;

      -- Append hash-chained envelope_voided event for active/in-flight envelopes before voiding.
      FOR v_env IN
        SELECT e.id, e.status, e.source_sha256
        FROM ludy_sign.envelope e
        WHERE e.org_id = p_org_id
          AND e.id = ANY (v_unsigned_ids)
          AND e.status IN ('draft', 'sent', 'in_progress')
        ORDER BY e.id
      LOOP
        SELECT COALESCE(se.seq, 0) + 1, se.event_hash
        INTO v_next_seq, v_prev_hash
        FROM ludy_sign.signing_event se
        WHERE se.org_id = p_org_id
          AND se.envelope_id = v_env.id
        ORDER BY se.seq DESC
        LIMIT 1;
        IF NOT FOUND THEN
          v_next_seq := 1;
          v_prev_hash := NULL;
        END IF;

        v_prev_json := CASE WHEN v_prev_hash IS NULL THEN 'null' ELSE '"' || v_prev_hash || '"' END;
        v_canonical :=
          '{"actorId":null,"actorLabel":"system:meetings_cleanup","actorType":"system"'
          || ',"documentSha256":"' || v_env.source_sha256 || '"'
          || ',"envelopeId":"' || v_env.id::text || '"'
          || ',"eventType":"envelope_voided"'
          || ',"ipHash":null'
          || ',"occurredAt":"' || v_occurred_iso || '"'
          || ',"orgId":"' || p_org_id::text || '"'
          || ',"payloadJson":{"reason":"meeting_deleted"}'
          || ',"prevEventHash":' || v_prev_json
          || ',"seq":' || v_next_seq::text
          || ',"signerId":null,"userAgent":null}';
        v_event_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_canonical, 'UTF8')), 'hex');

        INSERT INTO ludy_sign.signing_event (
          org_id, envelope_id, signer_id, host_user_id, seq, event_type,
          actor_type, actor_id, actor_label, document_sha256,
          prev_event_hash, event_hash, payload_json, ip_hash, user_agent, occurred_at
        )
        VALUES (
          p_org_id, v_env.id, NULL, NULL, v_next_seq, 'envelope_voided',
          'system', NULL, 'system:meetings_cleanup', v_env.source_sha256,
          v_prev_hash, v_event_hash, '{"reason":"meeting_deleted"}'::jsonb, NULL, NULL, v_now
        );
      END LOOP;

      DELETE FROM ludy_sign.signing_otp o
      USING ludy_sign.signer s
      WHERE o.org_id = p_org_id
        AND s.org_id = o.org_id
        AND s.id = o.signer_id
        AND s.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.signing_token t
      WHERE t.org_id = p_org_id
        AND t.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.kyc_check k
      WHERE k.org_id = p_org_id
        AND k.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.ca_signing_request c
      WHERE c.org_id = p_org_id
        AND c.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.playbook_check p
      WHERE p.org_id = p_org_id
        AND p.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.ai_analysis a
      WHERE a.org_id = p_org_id
        AND a.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.envelope_obligation eo
      WHERE eo.org_id = p_org_id
        AND eo.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.field f
      WHERE f.org_id = p_org_id
        AND f.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.signer s
      WHERE s.org_id = p_org_id
        AND s.envelope_id = ANY (v_unsigned_ids);

      UPDATE ludy_sign.envelope e
      SET status = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN 'voided' ELSE e.status END,
          voided_at = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN COALESCE(e.voided_at, v_now) ELSE e.voided_at END,
          void_reason = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN 'meeting_deleted' ELSE NULL END,
          title = '[Erased meeting minutes]',
          subject = NULL,
          message = NULL,
          inspect_error = NULL,
          detected_tags_json = NULL,
          share_summary_with_signers = false,
          shared_summary_json = NULL,
          version = e.version + 1,
          updated_at = v_now
      WHERE e.org_id = p_org_id
        AND e.id = ANY (v_unsigned_ids)
        AND e.status <> 'completed';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', '', true);
    RAISE;
  END;

  PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Tightened envelope_guard(): enforce initial NULL snapshot and strict transitions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.envelope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
  v_inherit_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.template_inherit_inspect(uuid,uuid)'::pg_catalog.regprocedure);
  v_correct_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.correct_signer_recipient(uuid,uuid,text,text,text,text,boolean,timestamptz)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only a draft envelope can be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'draft' OR NEW.inspect_status <> 'pending' OR NEW.inspect_error IS NOT NULL
       OR NEW.direct_link_id IS NOT NULL
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL
       OR NEW.seal_status IS NOT NULL
       OR NEW.sealed_file_id IS NOT NULL OR NEW.sealed_storage_key IS NOT NULL
       OR NEW.sealed_generation IS NOT NULL OR NEW.sealed_sha256 IS NOT NULL
       OR NEW.certificate_file_id IS NOT NULL OR NEW.certificate_storage_key IS NOT NULL
       OR NEW.certificate_generation IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL
       OR NEW.certificate_code IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_acknowledged_at IS NOT NULL OR NEW.decline_acknowledged_by IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
       OR NEW.void_reason IS NOT NULL OR NEW.expired_at IS NOT NULL
       OR NEW.retained_org_visible IS NOT NULL OR NEW.retained_reader_ids IS NOT NULL THEN
      RAISE EXCEPTION 'ENVELOPE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an envelope starts as an uninspected draft without sealing or completion data';
    END IF;
    IF NEW.share_summary_with_signers IS TRUE OR NEW.shared_summary_json IS NOT NULL THEN
      IF v_actor <> 'user'
         OR ludy_kernel.ctx_agent_id() IS NOT NULL
         OR ludy_kernel.ctx_user_id() IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = NEW.org_id
             AND m.user_id = ludy_kernel.ctx_user_id()
             AND m.role IN ('owner', 'admin', 'member')
             AND (m.role IN ('owner', 'admin') OR m.user_id = NEW.created_by)
         ) THEN
        RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'counterparty summary requires human review by the envelope creator, owner, or admin';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.created_by, NEW.created_at,
      NEW.source_kind, NEW.source_id, NEW.direct_link_id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_by, OLD.created_at,
      OLD.source_kind, OLD.source_id, OLD.direct_link_id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256) THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'envelope identity and source document columns are immutable';
  END IF;
  IF v_inherit_owner IS NOT NULL
     AND v_cur_role = v_inherit_owner
     AND pg_catalog.current_setting('crove.sign_template_inherit', true) IS NOT DISTINCT FROM NEW.id::text
     AND OLD.status = 'draft'
     AND NEW.status = 'draft'
     AND OLD.inspect_status = 'pending'
     AND NEW.inspect_status = 'passed'
     AND NEW.page_count IS NOT NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF v_cleanup_owner IS NOT NULL
     AND v_cur_role = v_cleanup_owner
     AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = NEW.org_id::text
     AND OLD.source_kind = 'meeting_minutes' THEN
    IF OLD.status = 'completed'
       AND NEW.status = 'completed'
       AND OLD.retained_org_visible IS NULL
       AND OLD.retained_reader_ids IS NULL
       AND NEW.retained_org_visible IS NOT NULL
       AND NEW.retained_reader_ids IS NOT NULL
       AND (pg_catalog.to_jsonb(OLD) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at'])
           IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    IF OLD.status <> 'completed'
       AND OLD.sealed_file_id IS NULL
       AND (
         (OLD.status IN ('draft', 'sent', 'in_progress')
          AND NEW.status = 'voided'
          AND NEW.voided_at IS NOT NULL
          AND NEW.void_reason = 'meeting_deleted')
         OR (OLD.status IN ('voided', 'expired', 'declined')
             AND NEW.status = OLD.status
             AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
             AND NEW.void_reason IS NULL)
       )
       AND NEW.title = '[Erased meeting minutes]'
       AND NEW.subject IS NULL
       AND NEW.message IS NULL
       AND NEW.inspect_error IS NULL
       AND NEW.detected_tags_json IS NULL
       AND NEW.share_summary_with_signers IS FALSE
       AND NEW.shared_summary_json IS NULL
       AND NEW.retained_org_visible IS NULL
       AND NEW.retained_reader_ids IS NULL
       AND (pg_catalog.to_jsonb(OLD) - ARRAY[
             'status', 'voided_at', 'void_reason', 'title', 'subject', 'message',
             'inspect_error', 'detected_tags_json', 'share_summary_with_signers',
             'shared_summary_json', 'version', 'updated_at'
           ])
           IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY[
             'status', 'voided_at', 'void_reason', 'title', 'subject', 'message',
             'inspect_error', 'detected_tags_json', 'share_summary_with_signers',
             'shared_summary_json', 'version', 'updated_at'
           ]) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json,
      NEW.seal_status, NEW.sealed_file_id, NEW.sealed_storage_key, NEW.sealed_generation, NEW.sealed_sha256,
      NEW.certificate_file_id, NEW.certificate_storage_key, NEW.certificate_generation, NEW.certificate_sha256,
      NEW.certificate_code, NEW.completed_at, NEW.declined_at, NEW.expired_at,
      NEW.retained_org_visible, NEW.retained_reader_ids)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json,
      OLD.seal_status, OLD.sealed_file_id, OLD.sealed_storage_key, OLD.sealed_generation, OLD.sealed_sha256,
      OLD.certificate_file_id, OLD.certificate_storage_key, OLD.certificate_generation, OLD.certificate_sha256,
      OLD.certificate_code, OLD.completed_at, OLD.declined_at, OLD.expired_at,
      OLD.retained_org_visible, OLD.retained_reader_ids) THEN
    RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'inspection, sealed, and completion metadata are system-managed';
  END IF;
  IF (NEW.share_summary_with_signers, NEW.shared_summary_json)
     IS DISTINCT FROM (OLD.share_summary_with_signers, OLD.shared_summary_json) THEN
    IF v_actor <> 'user'
       OR ludy_kernel.ctx_agent_id() IS NOT NULL
       OR ludy_kernel.ctx_user_id() IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id
           AND m.user_id = ludy_kernel.ctx_user_id()
           AND m.role IN ('owner', 'admin', 'member')
           AND (m.role IN ('owner', 'admin') OR m.user_id = OLD.created_by)
       ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the envelope creator, owner, or admin can update the counterparty summary';
    END IF;
  END IF;
  IF OLD.status = 'declined' AND NEW.status = 'declined' THEN
    IF OLD.decline_acknowledged_at IS NOT NULL
       OR NEW.decline_acknowledged_at IS NULL
       OR NEW.decline_acknowledged_by IS DISTINCT FROM ludy_kernel.ctx_user_id()
       OR (pg_catalog.to_jsonb(OLD) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at'])
          IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only decline acknowledgment metadata can change once on a declined envelope';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('draft', 'sent', 'in_progress') AND NEW.status = 'voided' THEN
    IF NEW.voided_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only void metadata can change when voiding';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      IF (NEW.sent_at, NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.decline_acknowledged_at, NEW.decline_acknowledged_by)
         IS DISTINCT FROM (OLD.sent_at, OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.decline_acknowledged_at, OLD.decline_acknowledged_by) THEN
        RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'lifecycle timestamps cannot be modified on a draft';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'sent' THEN
      IF OLD.inspect_status <> 'passed' THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before sending';
      END IF;
      IF NEW.sent_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'sent_at', 'version', 'updated_at'])
         IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'sent_at', 'version', 'updated_at']) THEN
        RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only status and sent_at can change when sending';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'draft envelope can only move to sent or voided';
  END IF;
  IF OLD.status IN ('sent', 'in_progress') AND NEW.status = OLD.status THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at'])
       IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'envelope is frozen after leaving draft';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Restate least-privilege EXECUTE grants across all replaced functions
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  ludy_sign.is_exportable_envelope_id(uuid, uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text),
  ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]),
  ludy_sign.envelope_guard()
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
      || 'ludy_sign.is_exportable_envelope_id(uuid, uuid), '
      || 'ludy_sign.is_exportable_sign_file(uuid, uuid, text), '
      || 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]), '
      || 'ludy_sign.envelope_guard() '
      || 'FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.is_exportable_envelope_id(uuid, uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text)
TO ludy_tenant;
