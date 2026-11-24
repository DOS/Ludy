-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 3a / #4531 (Step 2 of 2, Owner Decision A2 on 2026-11-24):
-- Separate signed vs unsigned meeting_minutes envelope lifecycles:
--   1. Signed / completed meeting_minutes envelopes (status = 'completed') remain legal records under eSign retention:
--      never voided or hidden when text_retention_date expires or when ludy_meetings.meeting is deleted/purged.
--      Active meeting readers and creator retain access via retained_org_visible / retained_reader_ids snapshots.
--   2. Unsigned / in-flight meeting_minutes envelopes (status <> 'completed') follow active meeting reader scope
--      without a created_by bypass (404 parity on reader removal, viewer demotion, or text_retention_date expiry),
--      and are voided/erased when the meeting is deleted or purged.
--   3. Preserve existing 3-arg ludy_sign.can_access_meeting_minutes_envelope(uuid,uuid,uuid) signature alongside
--      the status-aware 6-arg ludy_sign.can_access_meeting_minutes_envelope_row(...) helper.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Retained legal-record reader snapshot columns on ludy_sign.envelope
-- ---------------------------------------------------------------------------

ALTER TABLE ludy_sign.envelope
  ADD COLUMN IF NOT EXISTS retained_org_visible boolean,
  ADD COLUMN IF NOT EXISTS retained_reader_ids uuid[];

ALTER TABLE ludy_sign.envelope DROP CONSTRAINT IF EXISTS envelope_retained_scope_check;
ALTER TABLE ludy_sign.envelope
  ADD CONSTRAINT envelope_retained_scope_check
  CHECK (
    (retained_org_visible IS NULL AND retained_reader_ids IS NULL)
    OR (
      source_kind = 'meeting_minutes'
      AND status = 'completed'
      AND retained_org_visible IS NOT NULL
      AND retained_reader_ids IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS envelope_meeting_minutes_source_idx
  ON ludy_sign.envelope (org_id, source_id, status)
  WHERE source_kind = 'meeting_minutes';

-- ---------------------------------------------------------------------------
-- 2. Reader-scope and status-aware visibility helpers in ludy_sign
-- ---------------------------------------------------------------------------

-- Internal definer-only helper for completed meeting_minutes legal records (#4531):
-- ignores text_retention_date while the meeting exists, and falls back to the
-- deleted-meeting reader snapshot when the meeting row has been deleted/purged.
-- migration-lint: cross-module reads ludy_meetings.meeting and ludy_meetings.meeting_reader for completed meeting_minutes legal-record visibility (#4531).
CREATE OR REPLACE FUNCTION ludy_sign.is_meeting_minutes_reader_record(
  p_org_id uuid,
  p_meeting_id uuid,
  p_retained_org_visible boolean DEFAULT NULL,
  p_retained_reader_ids uuid[] DEFAULT NULL
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
  v_vis text;
  v_recorder uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;

  IF p_meeting_id IS NOT NULL THEN
    SELECT mtg.visibility, mtg.recorder_user_id
    INTO v_vis, v_recorder
    FROM ludy_meetings.meeting mtg
    WHERE mtg.org_id = v_org
      AND mtg.id = p_meeting_id;

    IF FOUND THEN
      IF v_recorder = v_user THEN
        RETURN true;
      END IF;
      IF v_vis = 'org' AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) THEN
        RETURN true;
      END IF;

      RETURN EXISTS (
        SELECT 1 FROM ludy_meetings.meeting_reader r
        WHERE r.org_id = v_org
          AND r.meeting_id = p_meeting_id
          AND r.user_id = v_user
      );
    END IF;
  END IF;

  IF p_retained_reader_ids IS NOT NULL AND v_user = ANY (p_retained_reader_ids) THEN
    RETURN true;
  END IF;
  IF p_retained_org_visible IS TRUE AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) THEN
    RETURN true;
  END IF;

  RETURN false;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.is_meeting_minutes_reader_record(uuid, uuid, boolean, uuid[])
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.can_access_meeting_minutes_envelope_row(
  p_org_id uuid,
  p_meeting_id uuid,
  p_created_by uuid,
  p_status text,
  p_retained_org_visible boolean DEFAULT NULL,
  p_retained_reader_ids uuid[] DEFAULT NULL
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
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  IF v_actor <> 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;

  IF p_status = 'completed' THEN
    IF p_created_by IS NOT NULL AND v_user = p_created_by THEN
      RETURN true;
    END IF;
    RETURN ludy_sign.is_meeting_minutes_reader_record(
      v_org,
      p_meeting_id,
      p_retained_org_visible,
      p_retained_reader_ids
    );
  END IF;

  IF p_meeting_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN ludy_sign.is_meeting_minutes_reader(v_org, p_meeting_id)
    AND ludy_sign.has_shared_meeting_minutes(v_org, p_meeting_id);
END $$;

REVOKE ALL ON FUNCTION ludy_sign.can_access_meeting_minutes_envelope_row(uuid, uuid, uuid, text, boolean, uuid[])
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.can_access_meeting_minutes_envelope_row(uuid, uuid, uuid, text, boolean, uuid[]) TO ludy_tenant;

-- Preserve 3-arg signature compatibility (without created_by bypass) for existing invariant callers.
CREATE OR REPLACE FUNCTION ludy_sign.can_access_meeting_minutes_envelope(
  p_org_id uuid,
  p_meeting_id uuid,
  p_created_by uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN ludy_sign.can_access_meeting_minutes_envelope_row(
    p_org_id,
    p_meeting_id,
    p_created_by,
    'draft',
    NULL,
    NULL
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.can_access_meeting_minutes_envelope(uuid, uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.can_access_meeting_minutes_envelope(uuid, uuid, uuid) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 3. Meeting-deletion cleanup definer for ludy_sign (completed kept, unsigned voided/erased)
-- ---------------------------------------------------------------------------

-- Internal cross-module cleanup invoked ONLY by ludy_meetings trigger on meeting deletion/purge.
-- ZERO EXECUTE grants on PUBLIC / tenant / app / worker / definer_tenant.
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
      -- Canonical lock order on unsigned envelopes and children.
      PERFORM 1 FROM ludy_sign.signer s WHERE s.org_id = p_org_id AND s.envelope_id = ANY (v_unsigned_ids) ORDER BY s.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.field f WHERE f.org_id = p_org_id AND f.envelope_id = ANY (v_unsigned_ids) ORDER BY f.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.signing_token t WHERE t.org_id = p_org_id AND t.envelope_id = ANY (v_unsigned_ids) ORDER BY t.id FOR UPDATE;
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
          void_reason = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN 'meeting_deleted' ELSE e.void_reason END,
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

REVOKE ALL ON FUNCTION ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[])
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. Restate guards (envelope_guard, signer_guard, field_guard)
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
       AND NEW.retained_reader_ids IS NOT NULL
       AND (pg_catalog.to_jsonb(OLD) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at'])
           IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    IF OLD.status <> 'completed'
       AND OLD.sealed_file_id IS NULL
       AND (NEW.status = 'voided' OR NEW.status = OLD.status)
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

REVOKE ALL ON FUNCTION ludy_sign.envelope_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.signer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_correct_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.correct_signer_recipient(uuid,uuid,text,text,text,text,boolean,timestamptz)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  SELECT e.status, e.sealed_file_id INTO v_env_status, v_env_sealed_file_id
  FROM ludy_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IS DISTINCT FROM 'completed'
       AND v_env_sealed_file_id IS NULL
       AND v_cleanup_owner IS NOT NULL
       AND v_cur_role = v_cleanup_owner
       AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = OLD.org_id::text THEN
      RETURN OLD;
    END IF;
    IF v_env_status IN ('voided', 'expired', 'declined')
       AND v_env_sealed_file_id IS NULL
       AND v_cur_role = v_erase_owner
       AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
       AND v_actor = 'user'
       AND ludy_kernel.ctx_agent_id() IS NULL
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_env_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
    END IF;
    IF NEW.status <> 'waiting' THEN
      RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'new signers on a draft envelope must start in waiting status';
    END IF;
    IF NEW.token_last_reminded_at IS NOT NULL OR NEW.pre_expiry_reminded_at IS NOT NULL
       OR NEW.viewed_at IS NOT NULL OR NEW.signed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.otp_verified_at IS NOT NULL
       OR NEW.signature_kind IS NOT NULL OR NEW.signature_typed_text IS NOT NULL
       OR NEW.signer_user_agent IS NOT NULL OR NEW.signer_ip_hash IS NOT NULL
       OR NEW.consent_accepted_at IS NOT NULL
       OR NEW.delegated_from_name IS NOT NULL OR NEW.delegated_from_email IS NOT NULL
       OR NEW.delegation_reason IS NOT NULL OR NEW.delegation_count <> 0 THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence and delegation provenance columns are system-managed';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGNER_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF v_env_status IN ('draft', 'voided', 'expired', 'declined')
     AND v_env_sealed_file_id IS NULL
     AND v_erase_owner IS NOT NULL
     AND v_cur_role = v_erase_owner
     AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
     AND v_actor = 'user'
     AND ludy_kernel.ctx_agent_id() IS NULL
     AND ludy_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (
       SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
     )
     AND NEW.delegated_from_name IS NULL
     AND NEW.delegated_from_email IS NULL
     AND NEW.delegation_reason IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['delegated_from_name', 'delegated_from_email', 'delegation_reason', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['delegated_from_name', 'delegated_from_email', 'delegation_reason', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF v_env_status IN ('sent', 'in_progress')
     AND v_correct_owner IS NOT NULL
     AND v_cur_role = v_correct_owner
     AND pg_catalog.current_setting('crove.sign_correct_signer', true) = OLD.id::text
     AND v_actor = 'user'
     AND ludy_kernel.ctx_agent_id() IS NULL
     AND ludy_kernel.ctx_org_id() = OLD.org_id
     AND OLD.status IN ('waiting', 'pending', 'viewed')
     AND NEW.status = (CASE WHEN OLD.status = 'viewed' THEN 'pending' ELSE OLD.status END)
     AND NEW.viewed_at IS NULL
     AND NEW.otp_verified_at IS NULL
     AND NEW.token_last_reminded_at IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['name', 'email', 'phone', 'delivery_mode', 'require_email_otp', 'status', 'viewed_at', 'otp_verified_at', 'token_last_reminded_at', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['name', 'email', 'phone', 'delivery_mode', 'require_email_otp', 'status', 'viewed_at', 'otp_verified_at', 'token_last_reminded_at', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.pre_expiry_reminded_at, NEW.viewed_at, NEW.signed_at, NEW.declined_at, NEW.decline_reason, NEW.otp_verified_at,
      NEW.signature_kind, NEW.signature_typed_text, NEW.signer_user_agent, NEW.signer_ip_hash, NEW.consent_accepted_at,
      NEW.delegated_from_name, NEW.delegated_from_email, NEW.delegation_reason, NEW.delegation_count)
     IS DISTINCT FROM (OLD.pre_expiry_reminded_at, OLD.viewed_at, OLD.signed_at, OLD.declined_at, OLD.decline_reason, OLD.otp_verified_at,
      OLD.signature_kind, OLD.signature_typed_text, OLD.signer_user_agent, OLD.signer_ip_hash, OLD.consent_accepted_at,
      OLD.delegated_from_name, OLD.delegated_from_email, OLD.delegation_reason, OLD.delegation_count) THEN
    RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence and delegation provenance columns are system-managed';
  END IF;
  IF v_env_status = 'draft' THEN
    IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'reminder timestamp cannot be set while envelope is draft';
    END IF;
    IF (NEW.routing_order, NEW.role_label, NEW.name, NEW.email, NEW.phone, NEW.delivery_mode, NEW.require_email_otp, NEW.status)
       IS DISTINCT FROM (OLD.routing_order, OLD.role_label, OLD.name, OLD.email, OLD.phone, OLD.delivery_mode, OLD.require_email_otp, OLD.status) THEN
      IF NEW.status <> 'waiting' THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF v_env_status IN ('sent', 'in_progress', 'voided') THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'token_last_reminded_at', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'token_last_reminded_at', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signer identity and delivery cannot change after send';
    END IF;
    IF v_env_status = 'voided' THEN
      IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at
         OR NOT (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided') THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status = 'waiting' AND NEW.status = 'pending')
              OR (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided')) THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers are frozen after envelope leaves active state';
END $$;

REVOKE ALL ON FUNCTION ludy_sign.signer_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.field_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_preserve_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.preserve_draft_field_text_defaults(uuid,jsonb)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'FIELD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  SELECT e.status, e.sealed_file_id INTO v_env_status, v_env_sealed_file_id
  FROM ludy_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IS DISTINCT FROM 'completed'
       AND v_env_sealed_file_id IS NULL
       AND v_cleanup_owner IS NOT NULL
       AND v_cur_role = v_cleanup_owner
       AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = OLD.org_id::text THEN
      RETURN OLD;
    END IF;
    IF v_env_status IN ('voided', 'expired', 'declined')
       AND v_env_sealed_file_id IS NULL
       AND v_cur_role = v_erase_owner
       AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
       AND v_actor = 'user'
       AND ludy_kernel.ctx_agent_id() IS NULL
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.field_type = 'text'
     AND NEW.filled_at IS NULL
     AND NEW.value_checked IS NULL
     AND NEW.signature_png_base64 IS NULL
     AND NEW.attachment_file_id IS NULL
     AND v_cur_role = v_preserve_owner
     AND pg_catalog.current_setting('ludy.sign_preserve_text_defaults', true) = NEW.envelope_id::text THEN
    RETURN NEW;
  END IF;
  IF NEW.value_text IS NOT NULL
     OR NEW.value_checked IS NOT NULL
     OR NEW.signature_png_base64 IS NOT NULL
     OR NEW.attachment_file_id IS NOT NULL
     OR NEW.attachment_filename IS NOT NULL
     OR NEW.attachment_content_type IS NOT NULL
     OR NEW.attachment_size_bytes IS NOT NULL
     OR NEW.attachment_sha256 IS NOT NULL
     OR NEW.filled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'field values and attachments are filled only through public signing';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.field_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- ---------------------------------------------------------------------------
-- 5. Restate restrictive RLS policies on ludy_sign.envelope and can_read_sign_file
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS meeting_minutes_select ON ludy_sign.envelope;
CREATE POLICY meeting_minutes_select ON ludy_sign.envelope AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR ludy_sign.can_access_meeting_minutes_envelope_row(
      org_id,
      source_id,
      created_by,
      status,
      retained_org_visible,
      retained_reader_ids
    )
  );

DROP POLICY IF EXISTS meeting_minutes_update ON ludy_sign.envelope;
CREATE POLICY meeting_minutes_update ON ludy_sign.envelope AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR ludy_sign.can_access_meeting_minutes_envelope_row(
      org_id,
      source_id,
      created_by,
      status,
      retained_org_visible,
      retained_reader_ids
    )
  )
  WITH CHECK (
    source_kind <> 'meeting_minutes'
    OR ludy_sign.can_access_meeting_minutes_envelope_row(
      org_id,
      source_id,
      created_by,
      status,
      retained_org_visible,
      retained_reader_ids
    )
  );

DROP POLICY IF EXISTS meeting_minutes_delete ON ludy_sign.envelope;
CREATE POLICY meeting_minutes_delete ON ludy_sign.envelope AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR ludy_sign.can_access_meeting_minutes_envelope_row(
      org_id,
      source_id,
      created_by,
      status,
      retained_org_visible,
      retained_reader_ids
    )
  );

CREATE OR REPLACE FUNCTION ludy_sign.can_read_sign_file(p_file_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  IF v_actor <> 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;

  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org AND m.user_id = v_user;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_attachment'
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.field fld
    WHERE fld.org_id = v_org
      AND fld.attachment_file_id = p_file_id
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
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (
          e.source_kind = 'meeting_minutes'
          AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
            v_org,
            e.source_id,
            e.created_by,
            e.status,
            e.retained_org_visible,
            e.retained_reader_ids
          )
        )
      )
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

  IF EXISTS (
    SELECT 1 FROM ludy_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (
          e.source_kind = 'meeting_minutes'
          AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
            v_org,
            e.source_id,
            e.created_by,
            e.status,
            e.retained_org_visible,
            e.retained_reader_ids
          )
        )
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

  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND f.created_by = v_user
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.can_read_sign_file(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.can_read_sign_file(uuid) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 6. Restate ludy_tenant SECURITY DEFINER helpers using status-aware check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.mint_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_ret_org boolean;
  v_env_ret_readers uuid[];
  v_signer_status text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id, e.retained_org_visible, e.retained_reader_ids
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id, v_env_ret_org, v_env_ret_readers
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env_source_id, v_env_creator, v_env_status, v_env_ret_org, v_env_ret_readers
     ) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status INTO v_signer_status
  FROM ludy_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = COALESCE(v_user, v_env_creator)
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO ludy_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, COALESCE(v_user, v_env_creator))
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.mint_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.mint_signing_token(uuid, uuid, text, timestamptz) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.mint_in_person_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_ret_org boolean;
  v_env_ret_readers uuid[];
  v_env_expires_at timestamptz;
  v_signer_status text;
  v_signer_role text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user
    AND m.role IN ('owner', 'admin', 'member');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '2 hours' + interval '5 minutes' THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id, e.expires_at, e.retained_org_visible, e.retained_reader_ids
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id, v_env_expires_at, v_env_ret_org, v_env_ret_readers
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_expires_at IS NOT NULL AND v_env_expires_at <= v_now THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env_source_id, v_env_creator, v_env_status, v_env_ret_org, v_env_ret_readers
     ) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status, s.signer_role
  INTO v_signer_status, v_signer_role
  FROM ludy_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_role = 'cc' OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO ludy_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, in_person_host_user_id, created_by, created_at
  )
  VALUES (
    v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, v_user, v_user, v_now
  )
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.revoke_envelope_tokens(p_envelope_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_status text;
  v_env_ret_org boolean;
  v_env_ret_readers uuid[];
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT e.created_by, e.source_kind, e.source_id, e.status, e.retained_org_visible, e.retained_reader_ids
    INTO v_env_creator, v_env_source_kind, v_env_source_id, v_env_status, v_env_ret_org, v_env_ret_readers
    FROM ludy_sign.envelope e
    WHERE e.org_id = v_org AND e.id = p_envelope_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN 0;
    END IF;
    IF v_env_source_kind = 'hr_contract'
       AND v_user IS DISTINCT FROM v_env_creator
       AND v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF v_env_source_kind = 'meeting_minutes'
       AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
         v_org, v_env_source_id, v_env_creator, v_env_status, v_env_ret_org, v_env_ret_readers
       ) THEN
      RETURN 0;
    END IF;
  END IF;

  WITH revoked AS (
    UPDATE ludy_sign.signing_token t
    SET revoked_at = v_now,
        revoked_by = v_user
    WHERE t.org_id = v_org
      AND t.envelope_id = p_envelope_id
      AND t.revoked_at IS NULL
      AND t.used_at IS NULL
    RETURNING t.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM revoked;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  FROM ludy_sign.signing_token t
  WHERE o.org_id = v_org
    AND t.org_id = o.org_id
    AND t.id = o.signing_token_id
    AND t.envelope_id = p_envelope_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.revoke_envelope_tokens(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.revoke_envelope_tokens(uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.template_inherit_inspect(
  p_template_id uuid,
  p_envelope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_tpl record;
  v_env record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.page_dimensions_json, t.detected_tags_json,
         t.source_file_id, t.source_storage_key, t.source_generation, t.source_sha256
  INTO v_tpl
  FROM ludy_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR SHARE;

  IF NOT FOUND OR v_tpl.status NOT IN ('draft', 'active') OR v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RETURN false;
  END IF;

  SELECT e.id, e.status, e.inspect_status, e.source_kind, e.source_id, e.created_by,
         e.retained_org_visible, e.retained_reader_ids,
         e.source_file_id, e.source_storage_key, e.source_generation, e.source_sha256
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND OR v_env.status <> 'draft' OR v_env.inspect_status <> 'pending' THEN
    RETURN false;
  END IF;
  IF v_actor = 'user'
     AND v_env.source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env.created_by
     AND v_role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;
  IF v_actor = 'user'
     AND v_env.source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env.source_id, v_env.created_by, v_env.status, v_env.retained_org_visible, v_env.retained_reader_ids
     ) THEN
    RETURN false;
  END IF;
  IF v_env.source_file_id IS DISTINCT FROM v_tpl.source_file_id
     OR v_env.source_storage_key IS DISTINCT FROM v_tpl.source_storage_key
     OR v_env.source_generation IS DISTINCT FROM v_tpl.source_generation
     OR v_env.source_sha256 IS DISTINCT FROM v_tpl.source_sha256 THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SOURCE_MISMATCH' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', p_envelope_id::text, true);

  UPDATE ludy_sign.envelope
  SET inspect_status = 'passed',
      inspect_error = NULL,
      page_count = v_tpl.page_count,
      page_dimensions_json = v_tpl.page_dimensions_json,
      detected_tags_json = v_tpl.detected_tags_json,
      updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_envelope_id;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', '', true);

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.template_inherit_inspect(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.template_inherit_inspect(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.correct_signer_recipient(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_delivery_mode text,
  p_require_email_otp boolean,
  p_now timestamptz DEFAULT pg_catalog.now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_agent uuid := ludy_kernel.ctx_agent_id();
  v_now timestamptz := COALESCE(p_now, pg_catalog.now());
  v_role text;
  v_env record;
  v_signer record;
  v_name text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))), '');
  v_phone text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_phone, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_delivery_mode text := pg_catalog.btrim(COALESCE(p_delivery_mode, ''));
  v_require_otp boolean := false;
  v_next_status text;
  v_next_version integer;
  v_revoked_tokens integer := 0;
  v_invalidated_otps integer := 0;
  v_to_hash text;
  v_suppressed boolean := false;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR v_agent IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'MODULE_OFF' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_envelope_id IS NULL OR p_signer_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  IF v_env.source_kind = 'hr_contract'
     AND v_role NOT IN ('owner', 'admin')
     AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  IF v_env.source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env.source_id, v_env.created_by, v_env.status, v_env.retained_org_visible, v_env.retained_reader_ids
     ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  IF v_role NOT IN ('owner', 'admin') AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_FORBIDDEN',
      'httpStatus', 403,
      'message', 'Only the envelope creator, owner, or admin can correct a recipient'
    );
  END IF;

  IF v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_NOT_ACTIVE',
      'httpStatus', 409,
      'message', 'Recipients can only be corrected while the envelope is sent or in progress'
    );
  END IF;

  IF v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_EXPIRED',
      'httpStatus', 409,
      'message', 'Envelope has expired'
    );
  END IF;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'signer');
  END IF;

  v_require_otp := COALESCE(p_require_email_otp, v_signer.require_email_otp);

  IF v_signer.status NOT IN ('waiting', 'pending', 'viewed') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_SIGNER_ALREADY_COMPLETED',
      'httpStatus', 409,
      'message', 'Cannot correct a recipient who has already signed or declined'
    );
  END IF;

  IF v_name IS NULL OR pg_catalog.length(v_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Recipient name must be between 1 and 200 characters'
    );
  END IF;

  IF v_delivery_mode NOT IN ('link', 'email') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid delivery mode'
    );
  END IF;

  IF v_signer.signer_role = 'cc' AND v_require_otp THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_SIGNER',
      'httpStatus', 422,
      'message', 'CC recipients cannot require email OTP'
    );
  END IF;

  IF v_email IS NOT NULL AND NOT ludy_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid recipient email address'
    );
  END IF;

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_REQUIRED',
      'httpStatus', 422,
      'message', 'Email address is required for email delivery or email OTP'
    );
  END IF;

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NOT NULL THEN
    v_to_hash := ludy_kernel.mail_address_hash(v_email);
    IF v_to_hash IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address cannot receive invitations'
      );
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM ludy_kernel.mail_suppression ms
      WHERE ms.org_id = v_org
        AND ms.to_hash = v_to_hash
        AND ms.scope = 'all'
        AND ms.lifted_at IS NULL
    )
    INTO v_suppressed;
    IF v_suppressed THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address is suppressed'
      );
    END IF;
  END IF;

  IF v_phone IS NOT NULL AND (pg_catalog.length(v_phone) < 6 OR pg_catalog.length(v_phone) > 32) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Phone number must be between 6 and 32 characters'
    );
  END IF;

  PERFORM 1
  FROM ludy_sign.signing_token t
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL
  ORDER BY t.id
  FOR UPDATE;

  PERFORM 1
  FROM ludy_sign.signing_otp o
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE ludy_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;
  GET DIAGNOSTICS v_revoked_tokens = ROW_COUNT;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL;
  GET DIAGNOSTICS v_invalidated_otps = ROW_COUNT;

  v_next_status := CASE WHEN v_signer.status = 'viewed' THEN 'pending' ELSE v_signer.status END;
  v_next_version := v_env.version + 1;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', v_signer.id::text, true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', v_env.id::text, true);

  UPDATE ludy_sign.signer s
  SET name = v_name,
      email = v_email,
      phone = v_phone,
      delivery_mode = v_delivery_mode,
      require_email_otp = v_require_otp,
      status = v_next_status,
      viewed_at = NULL,
      otp_verified_at = NULL,
      token_last_reminded_at = NULL,
      updated_at = v_now
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = v_signer.id;

  UPDATE ludy_sign.envelope e
  SET version = v_next_version,
      updated_at = v_now
  WHERE e.org_id = v_org
    AND e.id = v_env.id;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', '', true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', '', true);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'envelopeId', v_env.id,
    'envelopeTitle', v_env.title,
    'envelopeExpiresAt', CASE WHEN v_env.expires_at IS NOT NULL
      THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL END,
    'sourceSha256', v_env.source_sha256,
    'version', v_next_version,
    'signerId', v_signer.id,
    'signerRole', v_signer.signer_role,
    'roleLabel', v_signer.role_label,
    'signerStatus', v_next_status,
    'name', v_name,
    'email', v_email,
    'phone', v_phone,
    'deliveryMode', v_delivery_mode,
    'requireEmailOtp', v_require_otp,
    'previousName', v_signer.name,
    'previousEmail', v_signer.email,
    'previousPhone', v_signer.phone,
    'previousDeliveryMode', v_signer.delivery_mode,
    'previousRequireEmailOtp', v_signer.require_email_otp,
    'revokedTokens', v_revoked_tokens,
    'invalidatedOtps', v_invalidated_otps
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  TO ludy_tenant;
