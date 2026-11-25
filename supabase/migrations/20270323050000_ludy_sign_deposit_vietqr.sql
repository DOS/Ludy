-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 6d (#4723): Post-sign non-blocking VietQR deposit request, immutable send-time
-- payment profile snapshot, signer transfer notice + receipt proof, and Accounting match bridge.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. ludy_sign.deposit_profile (org-wide VietQR / bank destination config)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ludy_sign.deposit_profile (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  bank_code text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(bank_code)) BETWEEN 1 AND 32),
  bank_name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(bank_name)) BETWEEN 1 AND 200),
  account_number text NOT NULL CHECK (account_number ~ '^[A-Za-z0-9]{4,34}$'),
  account_holder text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(account_holder)) BETWEEN 1 AND 200),
  finance_bank_account text CHECK (finance_bank_account IS NULL OR finance_bank_account ~ '^[0-9]{3,16}$'),
  vietqr_file_id uuid,
  vietqr_storage_key text,
  vietqr_generation text,
  vietqr_sha256 text CHECK (vietqr_sha256 IS NULL OR vietqr_sha256 ~ '^[0-9a-f]{64}$'),
  is_default boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES ludy_kernel.user_account (id),
  updated_by uuid REFERENCES ludy_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT deposit_profile_vietqr_file_fk FOREIGN KEY (org_id, vietqr_file_id)
    REFERENCES ludy_kernel.file (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT deposit_profile_vietqr_tuple CHECK (
    (
      vietqr_file_id IS NULL
      AND vietqr_storage_key IS NULL
      AND vietqr_generation IS NULL
      AND vietqr_sha256 IS NULL
    )
    OR (
      vietqr_file_id IS NOT NULL
      AND vietqr_storage_key IS NOT NULL
      AND vietqr_generation IS NOT NULL
      AND vietqr_sha256 IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_profile_default_uq
  ON ludy_sign.deposit_profile (org_id)
  WHERE is_default = true;
CREATE INDEX IF NOT EXISTS deposit_profile_vietqr_file_idx
  ON ludy_sign.deposit_profile (org_id, vietqr_file_id);
CREATE INDEX IF NOT EXISTS deposit_profile_created_by_idx
  ON ludy_sign.deposit_profile (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS deposit_profile_updated_by_idx
  ON ludy_sign.deposit_profile (updated_by)
  WHERE updated_by IS NOT NULL;

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
     OR v_file.source NOT IN ('sign_deposit_qr', 'upload', 'social') THEN
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

REVOKE ALL ON FUNCTION ludy_sign.deposit_guard_file_error(uuid, uuid, text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

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
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.deposit_profile_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS deposit_profile_touch_updated_at ON ludy_sign.deposit_profile;
DROP TRIGGER IF EXISTS deposit_profile_guard ON ludy_sign.deposit_profile;
CREATE TRIGGER deposit_profile_guard
  BEFORE INSERT OR UPDATE ON ludy_sign.deposit_profile
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.deposit_profile_guard();

SELECT ludy_kernel.apply_tenant_rls('ludy_sign.deposit_profile');

DROP POLICY IF EXISTS deposit_profile_select ON ludy_sign.deposit_profile;
CREATE POLICY deposit_profile_select ON ludy_sign.deposit_profile
  AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = deposit_profile.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS deposit_profile_insert ON ludy_sign.deposit_profile;
CREATE POLICY deposit_profile_insert ON ludy_sign.deposit_profile
  AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = deposit_profile.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS deposit_profile_update ON ludy_sign.deposit_profile;
CREATE POLICY deposit_profile_update ON ludy_sign.deposit_profile
  AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = deposit_profile.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = deposit_profile.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS deposit_profile_delete ON ludy_sign.deposit_profile;
CREATE POLICY deposit_profile_delete ON ludy_sign.deposit_profile
  AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = deposit_profile.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. ludy_sign.envelope_deposit (per-envelope config + immutable snapshot)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ludy_sign.envelope_deposit (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  amount numeric(20,4) NOT NULL CHECK (amount > 0 AND amount <= 9999999999999999.9999),
  currency text NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  memo_token text NOT NULL CHECK (memo_token ~ '^CK-[A-Z0-9]{6,12}$'),
  due_days smallint CHECK (due_days IS NULL OR due_days BETWEEN 0 AND 365),
  deposit_profile_id uuid,
  note text CHECK (note IS NULL OR pg_catalog.char_length(note) <= 300),
  snapshot_frozen_at timestamptz,
  snapshot_bank_code text,
  snapshot_bank_name text,
  snapshot_account_number text,
  snapshot_account_holder text,
  snapshot_finance_bank_account text CHECK (snapshot_finance_bank_account IS NULL OR snapshot_finance_bank_account ~ '^[0-9]{3,16}$'),
  snapshot_vietqr_file_id uuid,
  snapshot_vietqr_storage_key text,
  snapshot_vietqr_generation text,
  snapshot_vietqr_sha256 text CHECK (snapshot_vietqr_sha256 IS NULL OR snapshot_vietqr_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_emvco_payload text,
  signer_notice_at timestamptz,
  signer_notice_note text CHECK (signer_notice_note IS NULL OR pg_catalog.char_length(signer_notice_note) <= 300),
  signer_proof_file_id uuid,
  signer_proof_filename text CHECK (signer_proof_filename IS NULL OR pg_catalog.char_length(signer_proof_filename) BETWEEN 1 AND 200),
  signer_proof_sha256 text CHECK (signer_proof_sha256 IS NULL OR signer_proof_sha256 ~ '^[0-9a-f]{64}$'),
  signer_ip_hash text CHECK (signer_ip_hash IS NULL OR signer_ip_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES ludy_kernel.user_account (id),
  updated_by uuid REFERENCES ludy_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT envelope_deposit_envelope_uq UNIQUE (org_id, envelope_id),
  CONSTRAINT envelope_deposit_memo_uq UNIQUE (org_id, memo_token),
  CONSTRAINT envelope_deposit_envelope_fk FOREIGN KEY (org_id, envelope_id)
    REFERENCES ludy_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT envelope_deposit_vnd_integer_ck CHECK (
    currency <> 'VND' OR amount = pg_catalog.trunc(amount)
  ),
  CONSTRAINT envelope_deposit_snapshot_core CHECK (
    (
      snapshot_frozen_at IS NULL
      AND snapshot_bank_code IS NULL
      AND snapshot_bank_name IS NULL
      AND snapshot_account_number IS NULL
      AND snapshot_account_holder IS NULL
      AND snapshot_finance_bank_account IS NULL
      AND snapshot_vietqr_file_id IS NULL
      AND snapshot_vietqr_storage_key IS NULL
      AND snapshot_vietqr_generation IS NULL
      AND snapshot_vietqr_sha256 IS NULL
      AND snapshot_emvco_payload IS NULL
    )
    OR (
      snapshot_frozen_at IS NOT NULL
      AND snapshot_bank_code IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(snapshot_bank_code)) BETWEEN 1 AND 32
      AND snapshot_bank_name IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(snapshot_bank_name)) BETWEEN 1 AND 200
      AND snapshot_account_number IS NOT NULL
      AND snapshot_account_number ~ '^[A-Za-z0-9]{4,34}$'
      AND snapshot_account_holder IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(snapshot_account_holder)) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT envelope_deposit_snapshot_qr_tuple CHECK (
    (
      snapshot_vietqr_file_id IS NULL
      AND snapshot_vietqr_storage_key IS NULL
      AND snapshot_vietqr_generation IS NULL
      AND snapshot_vietqr_sha256 IS NULL
    )
    OR (
      snapshot_vietqr_file_id IS NOT NULL
      AND snapshot_vietqr_storage_key IS NOT NULL
      AND snapshot_vietqr_generation IS NOT NULL
      AND snapshot_vietqr_sha256 IS NOT NULL
    )
  ),
  CONSTRAINT envelope_deposit_proof_tuple CHECK (
    (
      signer_proof_file_id IS NULL
      AND signer_proof_filename IS NULL
      AND signer_proof_sha256 IS NULL
    )
    OR (
      signer_proof_file_id IS NOT NULL
      AND signer_proof_filename IS NOT NULL
      AND signer_proof_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS envelope_deposit_frozen_idx
  ON ludy_sign.envelope_deposit (org_id, snapshot_frozen_at DESC, envelope_id)
  WHERE snapshot_frozen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_deposit_profile_idx
  ON ludy_sign.envelope_deposit (org_id, deposit_profile_id)
  WHERE deposit_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_deposit_snapshot_qr_idx
  ON ludy_sign.envelope_deposit (org_id, snapshot_vietqr_file_id)
  WHERE snapshot_vietqr_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_deposit_proof_file_idx
  ON ludy_sign.envelope_deposit (org_id, signer_proof_file_id)
  WHERE signer_proof_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_deposit_created_by_idx
  ON ludy_sign.envelope_deposit (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_deposit_updated_by_idx
  ON ludy_sign.envelope_deposit (updated_by)
  WHERE updated_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Confidentiality + freeze + post-sign notice guard on envelope_deposit
-- ---------------------------------------------------------------------------

-- Forward-declare signature referenced by envelope_deposit_guard() proowner lookup.
CREATE OR REPLACE FUNCTION ludy_sign.public_record_deposit_notice(
  p_token_sha256 text,
  p_note text DEFAULT NULL,
  p_proof_filename text DEFAULT NULL,
  p_proof_content_type text DEFAULT NULL,
  p_proof_size_bytes integer DEFAULT NULL,
  p_proof_sha256 text DEFAULT NULL,
  p_proof_storage_key text DEFAULT NULL,
  p_proof_generation text DEFAULT NULL,
  p_ip_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN pg_catalog.jsonb_build_object('status', 'not_found');
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.freeze_envelope_deposit_snapshot(
  p_org_id uuid,
  p_envelope_id uuid,
  p_emvco_payload text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_now timestamptz DEFAULT pg_catalog.clock_timestamp()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_ctx_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', COALESCE(p_now, pg_catalog.clock_timestamp()));
  v_env record;
  v_dep record;
  v_profile record;
  v_file_err text;
  v_emvco text := NULLIF(pg_catalog.btrim(COALESCE(p_emvco_payload, '')), '');
  v_actor_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR p_org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() OR v_ctx_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = p_org_id
        AND m.user_id = v_ctx_user
        AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT ludy_kernel.org_app_on(p_org_id, 'sign') THEN
    RAISE EXCEPTION 'MODULE_OFF' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.status, e.source_kind
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = p_org_id
    AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_ENVELOPE_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_env.source_kind IN ('hr_contract', 'meeting_minutes') THEN
    RAISE EXCEPTION 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit requests are forbidden on hr_contract and meeting_minutes envelopes';
  END IF;

  IF v_env.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit snapshot can only be frozen while envelope is draft';
  END IF;

  SELECT ed.*
  INTO v_dep
  FROM ludy_sign.envelope_deposit ed
  WHERE ed.org_id = p_org_id
    AND ed.envelope_id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('frozen', false);
  END IF;

  IF v_dep.snapshot_frozen_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'frozen', true,
      'memoToken', v_dep.memo_token,
      'amount', v_dep.amount::text,
      'accountNumber', v_dep.snapshot_account_number,
      'accountHolder', v_dep.snapshot_account_holder
    );
  END IF;

  IF v_dep.deposit_profile_id IS NOT NULL THEN
    SELECT dp.*
    INTO v_profile
    FROM ludy_sign.deposit_profile dp
    WHERE dp.org_id = p_org_id
      AND dp.id = v_dep.deposit_profile_id;
  ELSE
    SELECT dp.*
    INTO v_profile
    FROM ludy_sign.deposit_profile dp
    WHERE dp.org_id = p_org_id
      AND dp.is_default = true;
  END IF;

  IF NOT FOUND
     OR pg_catalog.length(pg_catalog.btrim(COALESCE(v_profile.bank_code, ''))) NOT BETWEEN 1 AND 32
     OR pg_catalog.length(pg_catalog.btrim(COALESCE(v_profile.bank_name, ''))) NOT BETWEEN 1 AND 200
     OR COALESCE(v_profile.account_number, '') !~ '^[A-Za-z0-9]{4,34}$'
     OR pg_catalog.length(pg_catalog.btrim(COALESCE(v_profile.account_holder, ''))) NOT BETWEEN 1 AND 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'frozen', false,
      'error', 'SIGN_DEPOSIT_PROFILE_INCOMPLETE'
    );
  END IF;

  IF v_profile.vietqr_file_id IS NOT NULL THEN
    v_file_err := ludy_sign.deposit_guard_file_error(
      p_org_id,
      v_profile.vietqr_file_id,
      v_profile.vietqr_storage_key,
      v_profile.vietqr_generation,
      v_profile.vietqr_sha256
    );
    IF v_file_err IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'frozen', false,
        'error', v_file_err
      );
    END IF;
  END IF;

  IF v_emvco IS NOT NULL THEN
    IF pg_catalog.char_length(v_emvco) > 512
       OR v_emvco !~ '^000201010212.*5303704.*5802VN.*6304[0-9A-F]{4}$'
       OR pg_catalog.strpos(v_emvco, v_profile.account_number) = 0
       OR pg_catalog.strpos(v_emvco, v_dep.memo_token) = 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'frozen', false,
        'error', 'SIGN_DEPOSIT_EMVCO_INVALID'
      );
    END IF;
  END IF;

  v_actor_id := COALESCE(v_ctx_user, p_user_id);

  PERFORM pg_catalog.set_config('ludy.sign_deposit_freeze', p_envelope_id::text, true);
  BEGIN
    UPDATE ludy_sign.envelope_deposit ed
    SET snapshot_frozen_at = v_now,
        snapshot_bank_code = v_profile.bank_code,
        snapshot_bank_name = v_profile.bank_name,
        snapshot_account_number = v_profile.account_number,
        snapshot_account_holder = v_profile.account_holder,
        snapshot_finance_bank_account = v_profile.finance_bank_account,
        snapshot_vietqr_file_id = v_profile.vietqr_file_id,
        snapshot_vietqr_storage_key = v_profile.vietqr_storage_key,
        snapshot_vietqr_generation = v_profile.vietqr_generation,
        snapshot_vietqr_sha256 = v_profile.vietqr_sha256,
        snapshot_emvco_payload = v_emvco,
        updated_by = v_actor_id,
        updated_at = v_now
    WHERE ed.org_id = p_org_id
      AND ed.id = v_dep.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.sign_deposit_freeze', '', true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('ludy.sign_deposit_freeze', '', true);

  RETURN pg_catalog.jsonb_build_object(
    'frozen', true,
    'memoToken', v_dep.memo_token,
    'amount', v_dep.amount::text,
    'accountNumber', v_profile.account_number,
    'accountHolder', v_profile.account_holder
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.freeze_envelope_deposit_snapshot(uuid, uuid, text, uuid, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- Runs SECURITY INVOKER first on envelope_deposit so CURRENT_USER reflects the real SQL caller
-- and blocks GUC spoofing for notice/freeze/cleanup before SECURITY DEFINER envelope_deposit_guard() executes.
CREATE OR REPLACE FUNCTION ludy_sign.envelope_deposit_caller_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
  v_freeze_owner oid := (
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'ludy_sign.freeze_envelope_deposit_snapshot(uuid,uuid,text,uuid,timestamptz)'::pg_catalog.regprocedure
  );
  v_notice_owner oid := (
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'ludy_sign.public_record_deposit_notice(text,text,text,text,integer,text,text,text,text)'::pg_catalog.regprocedure
  );
  v_cleanup_owner oid := (
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure
  );
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_actor = 'agent' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NULLIF(pg_catalog.current_setting('ludy.sign_deposit_notice', true), '') IS NOT NULL
     AND (v_notice_owner IS NULL OR v_cur_role IS DISTINCT FROM v_notice_owner) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_SYSTEM_ONLY'
      USING ERRCODE = '42501',
            DETAIL = 'signer notice and proof fields are recorded only through the public signing link';
  END IF;

  IF NULLIF(pg_catalog.current_setting('ludy.sign_deposit_freeze', true), '') IS NOT NULL
     AND (v_freeze_owner IS NULL OR v_cur_role IS DISTINCT FROM v_freeze_owner) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_SYSTEM_ONLY'
      USING ERRCODE = '42501',
            DETAIL = 'deposit snapshot columns can only be frozen by send workflow';
  END IF;

  IF NULLIF(pg_catalog.current_setting('ludy.sign_meeting_cleanup', true), '') IS NOT NULL
     AND (v_cleanup_owner IS NULL OR v_cur_role IS DISTINCT FROM v_cleanup_owner) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit configuration cannot be deleted once sent or frozen';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.envelope_deposit_caller_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.envelope_deposit_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_source_kind text;
  v_env_sealed_file_id uuid;
BEGIN
  SELECT e.status, e.source_kind, e.sealed_file_id
  INTO v_env_status, v_env_source_kind, v_env_sealed_file_id
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = v_env_id
  FOR SHARE;

  IF TG_OP IN ('INSERT', 'UPDATE') AND v_env_source_kind IN ('hr_contract', 'meeting_minutes') THEN
    RAISE EXCEPTION 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit requests are forbidden on hr_contract and meeting_minutes envelopes';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := pg_catalog.now();
  END IF;

  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;

  IF v_actor = 'agent' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.snapshot_frozen_at IS NULL AND (v_env_status = 'draft' OR v_env_status IS NULL) THEN
      RETURN OLD;
    END IF;
    IF v_env_source_kind = 'meeting_minutes'
       AND v_env_status IS DISTINCT FROM 'completed'
       AND v_env_sealed_file_id IS NULL
       AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = OLD.org_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit configuration cannot be deleted once sent or frozen';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.snapshot_frozen_at IS NOT NULL
     AND pg_catalog.current_setting('ludy.sign_deposit_notice', true) = OLD.envelope_id::text THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY[
          'signer_notice_at', 'signer_notice_note', 'signer_proof_file_id',
          'signer_proof_filename', 'signer_proof_sha256', 'signer_ip_hash', 'updated_at'
        ])
       IS DISTINCT FROM
       (pg_catalog.to_jsonb(NEW) - ARRAY[
          'signer_notice_at', 'signer_notice_note', 'signer_proof_file_id',
          'signer_proof_filename', 'signer_proof_sha256', 'signer_ip_hash', 'updated_at'
        ]) THEN
      RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
        USING ERRCODE = '42501',
              DETAIL = 'deposit terms and snapshot cannot mutate when recording signer notice';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.snapshot_frozen_at IS NULL
     AND NEW.snapshot_frozen_at IS NOT NULL
     AND v_env_status = 'draft'
     AND pg_catalog.current_setting('ludy.sign_deposit_freeze', true) = OLD.envelope_id::text THEN
    IF (NEW.amount, NEW.currency, NEW.memo_token, NEW.due_days, NEW.deposit_profile_id, NEW.note,
        NEW.signer_notice_at, NEW.signer_notice_note, NEW.signer_proof_file_id,
        NEW.signer_proof_filename, NEW.signer_proof_sha256, NEW.signer_ip_hash)
       IS DISTINCT FROM
       (OLD.amount, OLD.currency, OLD.memo_token, OLD.due_days, OLD.deposit_profile_id, OLD.note,
        OLD.signer_notice_at, OLD.signer_notice_note, OLD.signer_proof_file_id,
        OLD.signer_proof_filename, OLD.signer_proof_sha256, OLD.signer_ip_hash) THEN
      RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
        USING ERRCODE = '42501',
              DETAIL = 'deposit terms cannot change when freezing snapshot';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.signer_notice_at, NEW.signer_notice_note, NEW.signer_proof_file_id, NEW.signer_proof_filename, NEW.signer_proof_sha256, NEW.signer_ip_hash)
     IS DISTINCT FROM
     (CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_notice_at ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_notice_note ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_proof_file_id ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_proof_filename ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_proof_sha256 ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.signer_ip_hash ELSE NULL END) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_SYSTEM_ONLY'
      USING ERRCODE = '42501',
            DETAIL = 'signer notice and proof fields are recorded only through the public signing link';
  END IF;

  IF (NEW.snapshot_frozen_at, NEW.snapshot_bank_code, NEW.snapshot_bank_name, NEW.snapshot_account_number,
      NEW.snapshot_account_holder, NEW.snapshot_finance_bank_account, NEW.snapshot_vietqr_file_id,
      NEW.snapshot_vietqr_storage_key, NEW.snapshot_vietqr_generation, NEW.snapshot_vietqr_sha256, NEW.snapshot_emvco_payload)
     IS DISTINCT FROM
     (CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_frozen_at ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_bank_code ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_bank_name ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_account_number ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_account_holder ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_finance_bank_account ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_vietqr_file_id ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_vietqr_storage_key ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_vietqr_generation ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_vietqr_sha256 ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.snapshot_emvco_payload ELSE NULL END) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_SYSTEM_ONLY'
      USING ERRCODE = '42501',
            DETAIL = 'deposit snapshot columns can only be frozen by send workflow';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_env_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
        USING ERRCODE = '42501',
              DETAIL = 'deposit request can only be configured while envelope is draft';
    END IF;
    IF NEW.deposit_profile_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ludy_sign.deposit_profile dp
         WHERE dp.org_id = NEW.org_id AND dp.id = NEW.deposit_profile_id
       ) THEN
      RAISE EXCEPTION 'SIGN_DEPOSIT_PROFILE_NOT_FOUND'
        USING ERRCODE = '23503',
              DETAIL = 'deposit_profile_id does not belong to this organization';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.snapshot_frozen_at IS NOT NULL OR v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_FROZEN'
      USING ERRCODE = '42501',
            DETAIL = 'deposit request cannot be modified after send';
  END IF;

  IF NEW.deposit_profile_id IS NOT NULL
     AND NEW.deposit_profile_id IS DISTINCT FROM OLD.deposit_profile_id
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.deposit_profile dp
       WHERE dp.org_id = NEW.org_id AND dp.id = NEW.deposit_profile_id
     ) THEN
    RAISE EXCEPTION 'SIGN_DEPOSIT_PROFILE_NOT_FOUND'
      USING ERRCODE = '23503',
            DETAIL = 'deposit_profile_id does not belong to this organization';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.envelope_deposit_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS envelope_deposit_guard ON ludy_sign.envelope_deposit;
DROP TRIGGER IF EXISTS a_envelope_deposit_caller_guard ON ludy_sign.envelope_deposit;
DROP TRIGGER IF EXISTS b_envelope_deposit_guard ON ludy_sign.envelope_deposit;
CREATE TRIGGER a_envelope_deposit_caller_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ludy_sign.envelope_deposit
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.envelope_deposit_caller_guard();
CREATE TRIGGER b_envelope_deposit_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ludy_sign.envelope_deposit
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.envelope_deposit_guard();

SELECT ludy_kernel.apply_tenant_rls('ludy_sign.envelope_deposit');

DROP POLICY IF EXISTS envelope_deposit_select ON ludy_sign.envelope_deposit;
CREATE POLICY envelope_deposit_select ON ludy_sign.envelope_deposit
  AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_deposit.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member', 'viewer')
    )
  );

DROP POLICY IF EXISTS writer_insert ON ludy_sign.envelope_deposit;
CREATE POLICY writer_insert ON ludy_sign.envelope_deposit
  AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_deposit.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_update ON ludy_sign.envelope_deposit;
CREATE POLICY writer_update ON ludy_sign.envelope_deposit
  AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_deposit.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_deposit.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_delete ON ludy_sign.envelope_deposit;
CREATE POLICY writer_delete ON ludy_sign.envelope_deposit
  AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_deposit.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_access ON ludy_sign.envelope_deposit;
CREATE POLICY hr_contract_envelope_access ON ludy_sign.envelope_deposit
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    EXISTS (
      SELECT 1
      FROM ludy_sign.envelope e
      WHERE e.org_id = envelope_deposit.org_id
        AND e.id = envelope_deposit.envelope_id
        AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM ludy_sign.envelope e
      WHERE e.org_id = envelope_deposit.org_id
        AND e.id = envelope_deposit.envelope_id
        AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Update file readability and org exportability for deposit files
-- ---------------------------------------------------------------------------

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
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope_deposit ed
    WHERE ed.org_id = v_org
      AND ed.signer_proof_file_id = p_file_id
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
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_deposit ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND (ed.snapshot_vietqr_file_id = p_file_id OR ed.signer_proof_file_id = p_file_id)
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
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_deposit ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
            AND (ed.snapshot_vietqr_file_id = p_file_id OR ed.signer_proof_file_id = p_file_id)
        )
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
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
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
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
    -- Keep pre-existing templates readable even if a confidential envelope later derived from them.
    IF NOT EXISTS (
      SELECT 1 FROM ludy_sign.template t
      WHERE t.org_id = v_org
        AND t.source_file_id = p_file_id
    ) THEN
      RETURN false;
    END IF;
  END IF;

  IF v_role IN ('owner', 'admin', 'member')
     AND EXISTS (
       SELECT 1 FROM ludy_sign.deposit_profile dp
       WHERE dp.org_id = v_org
         AND dp.vietqr_file_id = p_file_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.envelope e
       WHERE e.org_id = v_org
         AND e.source_kind IN ('hr_contract', 'meeting_minutes')
         AND (
           e.source_file_id = p_file_id
           OR e.sealed_file_id = p_file_id
           OR e.certificate_file_id = p_file_id
           OR EXISTS (
             SELECT 1 FROM ludy_sign.envelope_document ed
             WHERE ed.org_id = e.org_id
               AND ed.envelope_id = e.id
               AND ed.file_id = p_file_id
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
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
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
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
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
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND (
        (f.source = 'sign_document' AND f.created_by = v_user)
        OR (f.source = 'sign_deposit_qr' AND f.created_by = v_user AND v_role IN ('owner', 'admin'))
      )
  );
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
     AND p_source IS DISTINCT FROM 'sign_deposit_qr'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.envelope e
       WHERE e.org_id = v_org
         AND (
           e.source_file_id = p_file_id
           OR EXISTS (
             SELECT 1 FROM ludy_sign.envelope_document ed
             WHERE ed.org_id = e.org_id
               AND ed.envelope_id = e.id
               AND ed.file_id = p_file_id
           )
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
             SELECT 1 FROM ludy_sign.envelope_deposit ed
             WHERE ed.org_id = e.org_id
               AND ed.envelope_id = e.id
               AND (ed.snapshot_vietqr_file_id = p_file_id OR ed.signer_proof_file_id = p_file_id)
           )
         )
     ) THEN
    RETURN true;
  END IF;

  IF p_source = 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.field fld
       WHERE fld.org_id = v_org
         AND fld.attachment_file_id = p_file_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.envelope_deposit ed
       WHERE ed.org_id = v_org
         AND ed.signer_proof_file_id = p_file_id
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
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_deposit ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND (ed.snapshot_vietqr_file_id = p_file_id OR ed.signer_proof_file_id = p_file_id)
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
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_deposit ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND (ed.snapshot_vietqr_file_id = p_file_id OR ed.signer_proof_file_id = p_file_id)
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
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
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

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.envelope e2
        WHERE e2.org_id = v_org
          AND (
            e2.source_file_id = p_file_id
            OR EXISTS (
              SELECT 1 FROM ludy_sign.envelope_document ed2
              WHERE ed2.org_id = e2.org_id
                AND ed2.envelope_id = e2.id
                AND ed2.file_id = p_file_id
            )
          )
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
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.deposit_profile dp
    WHERE dp.org_id = v_org
      AND dp.vietqr_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND (
        e.source_file_id = p_file_id
        OR e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    JOIN ludy_kernel.tenant_member m
      ON m.org_id = f.org_id AND m.user_id = f.created_by
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source IN ('sign_document', 'sign_deposit_qr')
      AND m.role = 'owner'
  );
END $$;

-- ---------------------------------------------------------------------------
-- 5. Defensive cleanup_meeting_minutes_envelopes update
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
      PERFORM 1 FROM ludy_sign.envelope_document ed WHERE ed.org_id = p_org_id AND ed.envelope_id = ANY (v_unsigned_ids) ORDER BY ed.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.envelope_deposit ed WHERE ed.org_id = p_org_id AND ed.envelope_id = ANY (v_unsigned_ids) ORDER BY ed.id FOR UPDATE;

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

      DELETE FROM ludy_sign.envelope_deposit ed
      WHERE ed.org_id = p_org_id
        AND ed.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.field f
      WHERE f.org_id = p_org_id
        AND f.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = p_org_id
        AND ed.envelope_id = ANY (v_unsigned_ids);

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
-- 6. Public signer deposit summary helper (internal SECURITY DEFINER)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.deposit_public_summary_json(
  p_org_id uuid,
  p_envelope_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'amount', pg_catalog.trim_scale(ed.amount)::text,
    'currency', ed.currency,
    'memoToken', ed.memo_token,
    'dueDays', ed.due_days,
    'note', ed.note,
    'bankCode', ed.snapshot_bank_code,
    'bankName', ed.snapshot_bank_name,
    'accountNumber', ed.snapshot_account_number,
    'accountHolder', ed.snapshot_account_holder,
    'hasQrPng', (ed.snapshot_vietqr_file_id IS NOT NULL),
    'emvcoPayload', ed.snapshot_emvco_payload,
    'signerNoticeAt', CASE
      WHEN ed.signer_notice_at IS NOT NULL
      THEN pg_catalog.to_char(ed.signer_notice_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL
    END,
    'signerNoticeNote', ed.signer_notice_note,
    'signerProofFilename', ed.signer_proof_filename,
    'signerProofSha256', ed.signer_proof_sha256
  )
  FROM ludy_sign.envelope_deposit ed
  JOIN ludy_sign.envelope e
    ON e.org_id = ed.org_id AND e.id = ed.envelope_id
  WHERE ed.org_id = p_org_id
    AND ed.envelope_id = p_envelope_id
    AND ed.snapshot_frozen_at IS NOT NULL
    AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes');
$$;

-- ---------------------------------------------------------------------------
-- 7. Update public_record_view and public_submit for post-sign deposit state
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.public_record_view(
  p_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_in_person boolean := false;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_fields jsonb := '[]'::jsonb;
  v_documents jsonb := '[]'::jsonb;
  v_deposit jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token (public_append_event also holds envelope FOR UPDATE).
  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc' THEN
    RETURN NULL;
  END IF;

  v_in_person := v_tok.in_person_host_user_id IS NOT NULL;
  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;

  -- Reopen / refresh of an already-signed remote token ONLY when a non-confidential frozen deposit exists.
  IF v_tok.used_at IS NOT NULL
     AND v_signer.status = 'signed'
     AND NOT v_in_person
     AND v_env.status IN ('sent', 'in_progress', 'completed')
     AND v_env.source_kind NOT IN ('hr_contract', 'meeting_minutes') THEN
    v_deposit := ludy_sign.deposit_public_summary_json(v_lookup.org_id, v_env.id);
    IF v_deposit IS NULL THEN
      RETURN NULL;
    END IF;
    IF v_signer.require_email_otp AND NOT v_otp_verified THEN
      RETURN pg_catalog.jsonb_build_object(
        'state', 'otp_required',
        'orgName', v_tenant.name,
        'title', v_env.title,
        'maskedEmail', ludy_sign.mask_email(v_signer.email),
        'inPerson', false
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'state', 'already_completed',
      'title', v_env.title,
      'status', v_env.status,
      'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
      'deposit', v_deposit
    );
  END IF;

  IF v_tok.used_at IS NOT NULL
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  UPDATE ludy_sign.signing_token
  SET last_viewed_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id;

  IF v_signer.status = 'pending' THEN
    v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
    v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
    v_actor_label := pg_catalog.left(v_actor_label, 254);

    UPDATE ludy_sign.signer
    SET status = 'viewed',
        viewed_at = COALESCE(v_signer.viewed_at, v_now),
        signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
        signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
        updated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_signer.id;

    IF v_tok.in_person_host_user_id IS NOT NULL THEN
      PERFORM ludy_sign.public_append_event_with_host(
        v_lookup.org_id,
        v_env.id,
        v_signer.id,
        'signer_viewed',
        'signer',
        v_actor_label,
        v_env.source_sha256,
        pg_catalog.jsonb_build_object(
          'routingOrder', v_signer.routing_order,
          'hostUserId', v_tok.in_person_host_user_id::text
        ),
        v_ip_hash,
        v_ua,
        v_now,
        v_tok.in_person_host_user_id
      );
    ELSE
      PERFORM ludy_sign.public_append_event(
        v_lookup.org_id,
        v_env.id,
        v_signer.id,
        'signer_viewed',
        'signer',
        v_actor_label,
        v_env.source_sha256,
        pg_catalog.jsonb_build_object('routingOrder', v_signer.routing_order),
        v_ip_hash,
        v_ua,
        v_now
      );
    END IF;
  END IF;

  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', 'otp_required',
      'orgName', v_tenant.name,
      'title', v_env.title,
      'maskedEmail', ludy_sign.mask_email(v_signer.email),
      'inPerson', v_in_person
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', d.id,
        'docIndex', d.doc_index,
        'title', d.title,
        'pageCount', COALESCE(d.page_count, 1),
        'pageDimensions', COALESCE(d.page_dimensions_json, '[]'::jsonb),
        'sourceSha256', d.source_sha256
      )
      ORDER BY d.doc_index ASC, d.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_documents
  FROM ludy_sign.envelope_document d
  WHERE d.org_id = v_lookup.org_id
    AND d.envelope_id = v_env.id;

  IF pg_catalog.jsonb_array_length(v_documents) = 0 THEN
    v_documents := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', NULL,
        'docIndex', 1,
        'title', v_env.title,
        'pageCount', COALESCE(v_env.page_count, 1),
        'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
        'sourceSha256', v_env.source_sha256
      )
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', f.id,
        'documentId', f.document_id,
        'fieldType', f.field_type,
        'pageNumber', f.page_number,
        'xNorm', f.x_norm::text,
        'yNorm', f.y_norm::text,
        'wNorm', f.w_norm::text,
        'hNorm', f.h_norm::text,
        'label', f.label,
        'required', f.required,
        'fontSizePt', f.font_size_pt,
        'valueText', f.value_text,
        'options', f.options_json,
        'attachment', CASE WHEN f.attachment_file_id IS NOT NULL THEN pg_catalog.jsonb_build_object(
          'fileId', f.attachment_file_id,
          'filename', f.attachment_filename,
          'contentType', f.attachment_content_type,
          'sizeBytes', f.attachment_size_bytes,
          'sha256', f.attachment_sha256,
          'uploadedAt', CASE WHEN f.filled_at IS NOT NULL
            THEN pg_catalog.to_char(f.filled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ELSE NULL END
        ) ELSE NULL END
      )
      ORDER BY COALESCE(d.doc_index, 1) ASC, f.page_number, f.y_norm, f.x_norm, f.id
    ),
    '[]'::jsonb
  )
  INTO v_fields
  FROM ludy_sign.field f
  LEFT JOIN ludy_sign.envelope_document d
    ON d.org_id = f.org_id
   AND d.id = f.document_id
  WHERE f.org_id = v_lookup.org_id
    AND f.envelope_id = v_env.id
    AND f.signer_id = v_signer.id;

  RETURN pg_catalog.jsonb_build_object(
    'state', 'ready',
    'orgName', v_tenant.name,
    'title', v_env.title,
    'message', v_env.message,
    'signerName', v_signer.name,
    'roleLabel', v_signer.role_label,
    'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
    'expiresAt', pg_catalog.to_char(v_tok.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pageCount', COALESCE(v_env.page_count, 1),
    'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
    'documents', v_documents,
    'requireEmailOtp', v_signer.require_email_otp,
    'otpVerified', v_otp_verified,
    'allowDelegation', (v_env.allow_delegation AND v_tok.in_person_host_user_id IS NULL AND v_signer.signer_role IN ('signer', 'approver') AND v_signer.delegation_count < 2),
    'delegationCount', v_signer.delegation_count,
    'delegatedFromName', v_signer.delegated_from_name,
    'inPerson', v_in_person,
    'fields', v_fields,
    'sharedSummary', CASE
      WHEN v_env.share_summary_with_signers AND v_env.shared_summary_json IS NOT NULL THEN v_env.shared_summary_json
      ELSE NULL
    END
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.public_submit(
  p_token_sha256 text,
  p_consent_accepted boolean,
  p_signature_kind text,
  p_signature_typed_text text,
  p_fields jsonb,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_field record;
  v_sub jsonb;
  v_sub_text text;
  v_sub_png text;
  v_raw_b64 text;
  v_png_bytes bytea;
  v_sub_checked boolean;
  v_saw_sig_png boolean := false;
  v_filled_count integer := 0;
  v_doc_count integer := 1;
  v_sig_kind text;
  v_typed_text text := pg_catalog.left(NULLIF(pg_catalog.btrim(COALESCE(p_signature_typed_text, '')), ''), 200);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_total_signers integer := 0;
  v_remaining integer := 0;
  v_all_completed boolean := false;
  v_next_env_status text;
  v_next_order integer;
  v_outbox_id uuid;
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_org_name text;
  v_doc_title text;
  v_next_signer record;
  v_to_email text;
  v_to_hash text;
  v_suppressed boolean;
  v_invalid_field_count integer := 0;
  v_dup_field_count integer := 0;
  v_deposit jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer (all envelope signers ORDER BY id) -> signing_token -> field (ORDER BY id).
  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  PERFORM 1
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
  ORDER BY s.id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.id = v_lookup.signer_id;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status IN ('waiting', 'voided', 'expired')
     OR v_env.status IN ('draft', 'voided', 'expired')
     OR (v_tok.used_at IS NULL AND v_signer.status IN ('pending', 'viewed') AND v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_tok.used_at IS NOT NULL OR v_signer.status IN ('signed', 'declined') OR v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  IF NOT COALESCE(p_consent_accepted, false) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_CONSENT_REQUIRED',
      'httpStatus', 422,
      'message', 'Electronic signature consent must be accepted before submitting'
    );
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before signing'
    );
  END IF;

  IF p_signature_kind IS NOT NULL AND p_signature_kind NOT IN ('draw', 'type') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Invalid signature kind');
  END IF;

  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'fields must be an array');
  END IF;

  SELECT GREATEST(pg_catalog.count(*)::integer, 1)
  INTO v_doc_count
  FROM ludy_sign.envelope_document d
  WHERE d.org_id = v_lookup.org_id
    AND d.envelope_id = v_env.id;

  SELECT pg_catalog.count(*)::integer
  INTO v_invalid_field_count
  FROM pg_catalog.jsonb_array_elements(p_fields) elem
  WHERE pg_catalog.jsonb_typeof(elem) <> 'object'
     OR COALESCE(elem->>'fieldId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT EXISTS (
       SELECT 1
       FROM ludy_sign.field f
       WHERE f.org_id = v_lookup.org_id
         AND f.envelope_id = v_env.id
         AND f.signer_id = v_signer.id
         AND f.id = (elem->>'fieldId')::uuid
     );

  IF v_invalid_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Submitted field is not assigned to this signer'
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_dup_field_count
  FROM (
    SELECT (elem->>'fieldId')::uuid AS fid
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    GROUP BY (elem->>'fieldId')::uuid
    HAVING pg_catalog.count(*) > 1
  ) dup;

  IF v_dup_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DUPLICATE_FIELD',
      'httpStatus', 422,
      'message', 'Duplicate submission for the same field'
    );
  END IF;

  -- Lock and validate required fields across ALL packet documents under the single consent action.
  FOR v_field IN
    SELECT f.*, d.doc_index AS doc_index, d.title AS doc_title
    FROM ludy_sign.field f
    LEFT JOIN ludy_sign.envelope_document d
      ON d.org_id = f.org_id
     AND d.id = f.document_id
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY COALESCE(d.doc_index, 1) ASC, f.id ASC
    FOR UPDATE OF f
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type IN ('signature', 'stamp') THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Signature text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp payload does not contain a valid PNG image');
        END IF;
        v_saw_sig_png := true;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', CASE WHEN v_field.field_type = 'stamp'
            THEN 'Required stamp field is missing a PNG stamp'
            ELSE 'Required signature field is missing a PNG signature' END
        );
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Initials text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials payload does not contain a valid PNG image');
        END IF;
      END IF;
      IF v_sub_png IS NULL AND v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required initials field must be provided');
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'date' THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        IF pg_catalog.jsonb_typeof(v_sub->'valueChecked') <> 'boolean' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Checkbox value must be a boolean');
        END IF;
        v_sub_checked := (v_sub->>'valueChecked')::boolean;
        IF v_field.required AND v_sub_checked IS DISTINCT FROM true THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required checkbox field must be checked');
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required checkbox field must be checked');
      END IF;
    ELSIF v_field.field_type IN ('dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        IF v_field.options_json IS NULL OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(v_field.options_json) AS opt(val)
          WHERE opt.val = v_sub_text
        ) THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'error',
            'code', 'SIGN_INVALID_FIELD_OPTION',
            'httpStatus', 422,
            'message', 'Submitted choice is not among the allowed options for this field'
          );
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', 'Required choice field must have a selected option'
        );
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.required AND v_field.attachment_file_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_ATTACHMENT_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', 'Required supporting attachment must be uploaded before submitting'
        );
      END IF;
    END IF;
  END LOOP;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  IF v_tok.expires_at <= v_now
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE ludy_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  FOR v_field IN
    SELECT f.*
    FROM ludy_sign.field f
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY f.id
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type = 'signature' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = COALESCE(v_typed_text, NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '')),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'stamp' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), ''),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL AND v_sub_png LIKE 'data:image/png;base64,%' THEN
        v_sub_png := pg_catalog.substr(v_sub_png, 23);
      END IF;
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_png IS NOT NULL OR v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      ELSIF v_field.value_text IS NOT NULL THEN
        UPDATE ludy_sign.field
        SET value_text = NULL,
            filled_at = NULL,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type IN ('date', 'dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_checked = (v_sub->>'valueChecked')::boolean,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.attachment_file_id IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
      END IF;
    END IF;
  END LOOP;

  v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_sig_kind := COALESCE(p_signature_kind, CASE WHEN v_typed_text IS NOT NULL THEN 'type' WHEN v_saw_sig_png THEN 'draw' ELSE NULL END);

  UPDATE ludy_sign.signer
  SET status = 'signed',
      signed_at = v_now,
      consent_accepted_at = COALESCE(v_signer.consent_accepted_at, v_now),
      signature_kind = v_sig_kind,
      signature_typed_text = v_typed_text,
      signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
      signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  SELECT
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc')::integer,
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc' AND s.status <> 'signed')::integer
  INTO v_total_signers, v_remaining
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_env.id;

  v_all_completed := v_remaining = 0;
  v_next_env_status := CASE WHEN v_all_completed THEN 'completed' ELSE 'in_progress' END;

  UPDATE ludy_sign.envelope
  SET status = v_next_env_status,
      completed_at = CASE WHEN v_all_completed THEN v_now ELSE completed_at END,
      version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  IF v_tok.in_person_host_user_id IS NOT NULL THEN
    PERFORM ludy_sign.public_append_event_with_host(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'in_person_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count,
        'documentCount', v_doc_count,
        'hostUserId', v_tok.in_person_host_user_id::text
      ),
      v_ip_hash,
      v_ua,
      v_now,
      v_tok.in_person_host_user_id
    );
  ELSE
    PERFORM ludy_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count,
        'documentCount', v_doc_count
      ),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  PERFORM ludy_sign.webhook_enqueue_internal(
    v_lookup.org_id,
    v_env.id,
    'sign.signer.signed',
    v_next_env_status,
    v_now,
    v_signer.id,
    v_signer.signer_role,
    v_now,
    NULL,
    NULL,
    NULL
  );

  IF v_all_completed THEN
    PERFORM ludy_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      NULL,
      'envelope_completed',
      'system',
      'system:sign-public',
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('completedSignerCount', v_total_signers, 'documentCount', v_doc_count),
      NULL,
      NULL,
      v_now
    );

    INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (
      v_lookup.org_id,
      'sign.envelope.seal_queued',
      pg_catalog.jsonb_build_object('envelopeId', v_env.id::text),
      'system'
    )
    RETURNING id INTO v_outbox_id;

    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id)
    VALUES (v_lookup.org_id, v_outbox_id);

    PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  ELSIF v_env.routing_mode = 'sequential' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM ludy_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status <> 'signed'
        AND s.routing_order <= v_signer.routing_order
    ) THEN
      SELECT pg_catalog.min(s.routing_order)
      INTO v_next_order
      FROM ludy_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status = 'waiting';

      IF v_next_order IS NOT NULL THEN
        v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
        v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');

        FOR v_next_signer IN
          UPDATE ludy_sign.signer s
          SET status = 'pending',
              updated_at = v_now
          WHERE s.org_id = v_lookup.org_id
            AND s.envelope_id = v_env.id
            AND s.signer_role <> 'cc'
            AND s.status = 'waiting'
            AND s.routing_order = v_next_order
          RETURNING s.id, s.delivery_mode, s.email, s.role_label
        LOOP
          IF v_next_signer.delivery_mode = 'email' AND v_next_signer.email IS NOT NULL THEN
            v_to_email := pg_catalog.lower(pg_catalog.btrim(v_next_signer.email));
            v_to_hash := ludy_kernel.mail_address_hash(v_to_email);
            IF v_to_hash IS NOT NULL THEN
              SELECT EXISTS (
                SELECT 1
                FROM ludy_kernel.mail_suppression ms
                WHERE ms.org_id = v_lookup.org_id
                  AND ms.to_hash = v_to_hash
                  AND ms.scope = 'all'
                  AND ms.lifted_at IS NULL
              )
              INTO v_suppressed;

              INSERT INTO ludy_kernel.mail_message (
                org_id, stream, source, source_id, template_key, to_address, to_hash,
                subject, payload, message_id_header, status, created_by
              )
              VALUES (
                v_lookup.org_id,
                'transactional',
                'sign.envelope.send',
                v_next_signer.id,
                'sign.invite',
                v_to_email,
                v_to_hash,
                pg_catalog.left('Moi ky: ' || v_doc_title, 300),
                pg_catalog.jsonb_build_object(
                  'lang', 'vi',
                  'orgName', v_org_name,
                  'envelopeId', v_env.id::text,
                  'signerId', v_next_signer.id::text,
                  'docTitle', v_doc_title,
                  'roleLabel', COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_next_signer.role_label, '[[:cntrl:]]+', ' ', 'g')), 120), ''), 'Nguoi ky'),
                  'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL
                    THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    ELSE NULL END
                ),
                '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
                CASE WHEN v_suppressed THEN 'suppressed' ELSE 'queued' END,
                NULL
              );
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  IF v_tok.in_person_host_user_id IS NULL THEN
    v_deposit := ludy_sign.deposit_public_summary_json(v_lookup.org_id, v_env.id);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'signerStatus', 'signed',
    'envelopeStatus', v_next_env_status,
    'completed', v_all_completed,
    'inPerson', v_tok.in_person_host_user_id IS NOT NULL,
    'signedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deposit', v_deposit
  );
END $$;

-- ---------------------------------------------------------------------------
-- 8. Orgless public VietQR binary lookup & post-sign deposit notice procs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.public_deposit_qr_source(
  p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_row record;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    tok.org_id,
    tok.id AS token_id,
    tok.revoked_at,
    tok.expires_at AS token_expires_at,
    tok.in_person_host_user_id,
    e.status AS envelope_status,
    e.source_kind,
    s.id AS signer_id,
    s.signer_role,
    s.status AS signer_status,
    s.require_email_otp,
    t.status AS tenant_status,
    ed.snapshot_frozen_at,
    ed.snapshot_vietqr_file_id,
    ed.snapshot_vietqr_storage_key,
    ed.snapshot_vietqr_generation,
    ed.snapshot_vietqr_sha256
  INTO v_row
  FROM ludy_sign.signing_token tok
  JOIN ludy_sign.envelope e
    ON e.org_id = tok.org_id AND e.id = tok.envelope_id
  JOIN ludy_sign.signer s
    ON s.org_id = tok.org_id AND s.id = tok.signer_id AND s.envelope_id = tok.envelope_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = tok.org_id
  JOIN ludy_sign.envelope_deposit ed
    ON ed.org_id = tok.org_id AND ed.envelope_id = tok.envelope_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.revoked_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.in_person_host_user_id IS NOT NULL
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status IS DISTINCT FROM 'signed'
     OR v_row.envelope_status NOT IN ('sent', 'in_progress', 'completed')
     OR v_row.source_kind IN ('hr_contract', 'meeting_minutes')
     OR v_row.snapshot_frozen_at IS NULL
     OR v_row.snapshot_vietqr_file_id IS NULL
     OR v_row.snapshot_vietqr_storage_key IS NULL
     OR v_row.snapshot_vietqr_generation IS NULL
     OR v_row.snapshot_vietqr_sha256 IS NULL
     OR ludy_sign.deposit_guard_file_error(
          v_row.org_id,
          v_row.snapshot_vietqr_file_id,
          v_row.snapshot_vietqr_storage_key,
          v_row.snapshot_vietqr_generation,
          v_row.snapshot_vietqr_sha256
        ) IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF v_row.require_email_otp
     AND ludy_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_row.org_id,
      'otpRequired', true
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'otpRequired', false,
    'storageKey', v_row.snapshot_vietqr_storage_key,
    'generation', v_row.snapshot_vietqr_generation,
    'sha256', v_row.snapshot_vietqr_sha256
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.public_deposit_notice_preflight(
  p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_row record;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT
    tok.org_id,
    tok.id AS token_id,
    tok.revoked_at,
    tok.expires_at AS token_expires_at,
    tok.in_person_host_user_id,
    e.status AS envelope_status,
    e.source_kind,
    s.id AS signer_id,
    s.signer_role,
    s.status AS signer_status,
    s.require_email_otp,
    t.status AS tenant_status,
    ed.snapshot_frozen_at
  INTO v_row
  FROM ludy_sign.signing_token tok
  JOIN ludy_sign.envelope e
    ON e.org_id = tok.org_id AND e.id = tok.envelope_id
  JOIN ludy_sign.signer s
    ON s.org_id = tok.org_id AND s.id = tok.signer_id AND s.envelope_id = tok.envelope_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = tok.org_id
  JOIN ludy_sign.envelope_deposit ed
    ON ed.org_id = tok.org_id AND ed.envelope_id = tok.envelope_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND
     OR v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.revoked_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.in_person_host_user_id IS NOT NULL
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status IS DISTINCT FROM 'signed'
     OR v_row.envelope_status NOT IN ('sent', 'in_progress', 'completed')
     OR v_row.source_kind IN ('hr_contract', 'meeting_minutes')
     OR v_row.snapshot_frozen_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_row.org_id,
    'otpRequired', (
      v_row.require_email_otp
      AND ludy_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NULL
    )
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.public_record_deposit_notice(
  p_token_sha256 text,
  p_note text DEFAULT NULL,
  p_proof_filename text DEFAULT NULL,
  p_proof_content_type text DEFAULT NULL,
  p_proof_size_bytes integer DEFAULT NULL,
  p_proof_sha256 text DEFAULT NULL,
  p_proof_storage_key text DEFAULT NULL,
  p_proof_generation text DEFAULT NULL,
  p_ip_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_deposit_row record;
  v_otp_verified boolean := false;
  v_has_proof boolean := false;
  v_clean_note text;
  v_clean_filename text;
  v_proof_file_id uuid;
  v_existing_file record;
  v_ip_hash text;
  v_actor_label text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> envelope_deposit.
  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.id = v_lookup.signer_id
    AND s.envelope_id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  SELECT ed.*
  INTO v_deposit_row
  FROM ludy_sign.envelope_deposit ed
  WHERE ed.org_id = v_lookup.org_id
    AND ed.envelope_id = v_env.id
  FOR UPDATE;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_tok.in_person_host_user_id IS NOT NULL
     OR v_signer.signer_role = 'cc'
     OR v_signer.status IS DISTINCT FROM 'signed'
     OR v_env.status NOT IN ('sent', 'in_progress', 'completed')
     OR v_env.source_kind IN ('hr_contract', 'meeting_minutes')
     OR v_deposit_row.snapshot_frozen_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before reporting transfer'
    );
  END IF;

  IF p_note IS NOT NULL THEN
    v_clean_note := NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(p_note, '[[:cntrl:]]+', ' ', 'g')), 300), '');
  END IF;

  v_has_proof := p_proof_sha256 IS NOT NULL OR p_proof_storage_key IS NOT NULL OR p_proof_content_type IS NOT NULL OR p_proof_size_bytes IS NOT NULL;
  IF v_has_proof THEN
    IF p_proof_content_type IS DISTINCT FROM 'image/png' AND p_proof_content_type IS DISTINCT FROM 'image/jpeg' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'UNSUPPORTED_TYPE', 'httpStatus', 415, 'message', 'Deposit proof must be PNG or JPEG');
    END IF;
    IF p_proof_size_bytes IS NULL OR p_proof_size_bytes < 1 OR p_proof_size_bytes > 2097152 THEN
      RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'TOO_LARGE', 'httpStatus', 413, 'message', 'Deposit proof exceeds 2 MB');
    END IF;
    IF p_proof_sha256 IS NULL OR p_proof_sha256 !~ '^[0-9a-f]{64}$'
       OR p_proof_storage_key IS NULL OR pg_catalog.btrim(p_proof_storage_key) = ''
       OR p_proof_generation IS NULL OR pg_catalog.btrim(p_proof_generation) = '' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Invalid deposit proof metadata');
    END IF;
    v_clean_filename := pg_catalog.left(
      COALESCE(
        NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_proof_filename, ''), '[[:cntrl:]/\\]+', '-', 'g')), ''),
        CASE WHEN p_proof_content_type = 'image/png' THEN 'deposit-proof.png' ELSE 'deposit-proof.jpg' END
      ),
      160
    );

    INSERT INTO ludy_kernel.file (
      org_id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by, created_at
    )
    VALUES (
      v_lookup.org_id,
      p_proof_sha256,
      p_proof_storage_key,
      p_proof_generation,
      v_clean_filename,
      p_proof_content_type,
      p_proof_size_bytes::bigint,
      'sign_attachment',
      NULL,
      v_now
    )
    ON CONFLICT (org_id, sha256) DO NOTHING
    RETURNING id INTO v_proof_file_id;

    IF v_proof_file_id IS NULL THEN
      SELECT fl.id, fl.source
      INTO v_existing_file
      FROM ludy_kernel.file fl
      WHERE fl.org_id = v_lookup.org_id
        AND fl.sha256 = p_proof_sha256
      FOR UPDATE;

      IF NOT FOUND
         OR v_existing_file.source <> 'sign_attachment'
         OR EXISTS (
           SELECT 1
           FROM ludy_sign.envelope ce
           WHERE ce.org_id = v_lookup.org_id
             AND ce.source_kind IN ('hr_contract', 'meeting_minutes')
             AND (
               ce.source_file_id = v_existing_file.id
               OR ce.sealed_file_id = v_existing_file.id
               OR ce.certificate_file_id = v_existing_file.id
               OR EXISTS (
                 SELECT 1 FROM ludy_sign.ca_signing_request r
                 WHERE r.org_id = ce.org_id
                   AND r.envelope_id = ce.id
                   AND r.pades_file_id = v_existing_file.id
               )
               OR EXISTS (
                 SELECT 1 FROM ludy_sign.field fld
                 WHERE fld.org_id = ce.org_id
                   AND fld.envelope_id = ce.id
                   AND fld.attachment_file_id = v_existing_file.id
               )
             )
         ) THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'FILE_SOURCE_CONFLICT',
          'httpStatus', 409,
          'message', 'File already exists under a different source in this organization'
        );
      END IF;
      v_proof_file_id := v_existing_file.id;
    END IF;
  END IF;

  v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  PERFORM pg_catalog.set_config('ludy.sign_deposit_notice', v_env.id::text, true);
  BEGIN
    UPDATE ludy_sign.envelope_deposit ed
    SET signer_notice_at = COALESCE(ed.signer_notice_at, v_now),
        signer_notice_note = CASE
          WHEN v_clean_note IS NOT NULL THEN v_clean_note
          ELSE ed.signer_notice_note
        END,
        signer_proof_file_id = COALESCE(v_proof_file_id, ed.signer_proof_file_id),
        signer_proof_filename = COALESCE(v_clean_filename, ed.signer_proof_filename),
        signer_proof_sha256 = COALESCE(p_proof_sha256, ed.signer_proof_sha256),
        signer_ip_hash = COALESCE(v_ip_hash, ed.signer_ip_hash),
        updated_at = v_now
    WHERE ed.org_id = v_lookup.org_id
      AND ed.envelope_id = v_env.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.sign_deposit_notice', '', true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('ludy.sign_deposit_notice', '', true);

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  PERFORM ludy_sign.public_append_event(
    v_lookup.org_id,
    v_env.id,
    v_signer.id,
    'deposit_notice_recorded',
    'signer',
    v_actor_label,
    v_env.source_sha256,
    pg_catalog.jsonb_build_object(
      'memoToken', v_deposit_row.memo_token,
      'hasNote', (v_clean_note IS NOT NULL),
      'hasProof', (v_proof_file_id IS NOT NULL),
      'proofSha256', p_proof_sha256
    ),
    v_ip_hash,
    NULL,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_lookup.org_id,
    'deposit', ludy_sign.deposit_public_summary_json(v_lookup.org_id, v_env.id)
  );
END $$;

-- ---------------------------------------------------------------------------
-- 9. Least-privilege EXECUTE grants for new/restated routines
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  ludy_sign.can_read_sign_file(uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text),
  ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]),
  ludy_sign.deposit_guard_file_error(uuid, uuid, text, text, text),
  ludy_sign.deposit_profile_guard(),
  ludy_sign.envelope_deposit_caller_guard(),
  ludy_sign.envelope_deposit_guard(),
  ludy_sign.freeze_envelope_deposit_snapshot(uuid, uuid, text, uuid, timestamptz),
  ludy_sign.deposit_public_summary_json(uuid, uuid),
  ludy_sign.public_record_view(text, text, text),
  ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text),
  ludy_sign.public_deposit_qr_source(text),
  ludy_sign.public_deposit_notice_preflight(text),
  ludy_sign.public_record_deposit_notice(text, text, text, text, integer, text, text, text, text)
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
      || 'ludy_sign.can_read_sign_file(uuid), '
      || 'ludy_sign.is_exportable_sign_file(uuid, uuid, text), '
      || 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]), '
      || 'ludy_sign.deposit_guard_file_error(uuid, uuid, text, text, text), '
      || 'ludy_sign.deposit_profile_guard(), '
      || 'ludy_sign.envelope_deposit_caller_guard(), '
      || 'ludy_sign.envelope_deposit_guard(), '
      || 'ludy_sign.freeze_envelope_deposit_snapshot(uuid, uuid, text, uuid, timestamptz), '
      || 'ludy_sign.deposit_public_summary_json(uuid, uuid), '
      || 'ludy_sign.public_record_view(text, text, text), '
      || 'ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text), '
      || 'ludy_sign.public_deposit_qr_source(text), '
      || 'ludy_sign.public_deposit_notice_preflight(text), '
      || 'ludy_sign.public_record_deposit_notice(text, text, text, text, integer, text, text, text, text) '
      || 'FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.can_read_sign_file(uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text),
  ludy_sign.freeze_envelope_deposit_snapshot(uuid, uuid, text, uuid, timestamptz)
TO ludy_tenant;

GRANT EXECUTE ON FUNCTION
  ludy_sign.public_record_view(text, text, text),
  ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text),
  ludy_sign.public_deposit_qr_source(text),
  ludy_sign.public_deposit_notice_preflight(text),
  ludy_sign.public_record_deposit_notice(text, text, text, text, integer, text, text, text, text)
TO ludy_app;
