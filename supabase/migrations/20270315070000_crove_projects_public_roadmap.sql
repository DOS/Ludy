-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects Public Roadmap Slice 1 (issue #4399, ADR-0057, docs/plan/projects-public-roadmap.md):
-- isolated public roadmap board, moderated/submitted items, anonymous hashed votes, definer-only OTP challenges
-- and sealed notification subscribers, private-project refusal triggers (#2604), and narrow orgless SECURITY DEFINER
-- resolvers checking org_app_on + enabled = true -> NULL (opaque 404). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Isolated tenant tables (apply_tenant_rls)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_projects.roadmap_board (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 120 AND title = pg_catalog.btrim(title)),
  description text CHECK (description IS NULL OR pg_catalog.length(description) <= 1000),
  enabled boolean NOT NULL DEFAULT false,
  project_id uuid,
  allow_submissions boolean NOT NULL DEFAULT true,
  allow_voting boolean NOT NULL DEFAULT true,
  require_moderation boolean NOT NULL DEFAULT true,
  embed_allowed_origins text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_board_slug_uq UNIQUE (org_id, slug),
  CONSTRAINT roadmap_board_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE SET NULL (project_id)
);

CREATE INDEX IF NOT EXISTS roadmap_board_project_idx
  ON crove_projects.roadmap_board (org_id, project_id)
  WHERE project_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_projects.roadmap_board');

CREATE TABLE IF NOT EXISTS crove_projects.roadmap_item (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  linked_task_id uuid,
  source text NOT NULL CHECK (source IN ('internal', 'public_submission')),
  moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'published', 'merged', 'archived')),
  merged_into_item_id uuid,
  stage text NOT NULL DEFAULT 'under_review' CHECK (stage IN ('under_review', 'planned', 'in_progress', 'shipped')),
  category text CHECK (category IS NULL OR pg_catalog.length(category) BETWEEN 1 AND 60),
  public_title text NOT NULL CHECK (pg_catalog.length(public_title) BETWEEN 1 AND 200 AND public_title = pg_catalog.btrim(public_title)),
  public_summary text CHECK (public_summary IS NULL OR pg_catalog.length(public_summary) <= 4000),
  vote_count integer NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
  tainted boolean NOT NULL DEFAULT false,
  submitter_display_name text CHECK (submitter_display_name IS NULL OR pg_catalog.length(submitter_display_name) BETWEEN 1 AND 80),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_item_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_item_task_fk FOREIGN KEY (org_id, linked_task_id)
    REFERENCES crove_projects.project_task (org_id, task_id) ON DELETE SET NULL (linked_task_id),
  CONSTRAINT roadmap_item_merged_fk FOREIGN KEY (org_id, merged_into_item_id)
    REFERENCES crove_projects.roadmap_item (org_id, id) ON DELETE SET NULL (merged_into_item_id),
  CONSTRAINT roadmap_item_self_merge_chk CHECK (merged_into_item_id IS NULL OR merged_into_item_id <> id),
  CONSTRAINT roadmap_item_public_taint_chk CHECK (source <> 'public_submission' OR tainted = true)
);

CREATE INDEX IF NOT EXISTS roadmap_item_board_idx
  ON crove_projects.roadmap_item (org_id, board_id, moderation_status, stage, vote_count DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_item_linked_task_idx
  ON crove_projects.roadmap_item (org_id, linked_task_id)
  WHERE linked_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS roadmap_item_merged_idx
  ON crove_projects.roadmap_item (org_id, merged_into_item_id)
  WHERE merged_into_item_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_projects.roadmap_item');

CREATE TABLE IF NOT EXISTS crove_projects.roadmap_vote (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  item_id uuid NOT NULL,
  voter_email_hash text NOT NULL CHECK (voter_email_hash ~ '^[0-9a-f]{64}$'),
  notify_on_ship boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_vote_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_vote_item_fk FOREIGN KEY (org_id, item_id)
    REFERENCES crove_projects.roadmap_item (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_vote_unique UNIQUE (org_id, item_id, voter_email_hash)
);

CREATE INDEX IF NOT EXISTS roadmap_vote_board_idx
  ON crove_projects.roadmap_vote (org_id, board_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_vote_item_idx
  ON crove_projects.roadmap_vote (org_id, item_id, created_at DESC);

SELECT crove_kernel.apply_tenant_rls('crove_projects.roadmap_vote');

-- ---------------------------------------------------------------------------
-- 2. Definer-only MACHINERY tables (RLS enabled, agent write guard, ZERO grants)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_projects.roadmap_otp (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  email text NOT NULL CHECK (pg_catalog.length(email) BETWEEN 3 AND 254),
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  otp_sha256 text CHECK (otp_sha256 IS NULL OR otp_sha256 ~ '^[0-9a-f]{64}$'),
  claim_sha256 text CHECK (claim_sha256 IS NULL OR claim_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  verified_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_otp_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS roadmap_otp_board_idx
  ON crove_projects.roadmap_otp (org_id, board_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_otp_email_rate_idx
  ON crove_projects.roadmap_otp (org_id, board_id, email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_otp_ip_rate_idx
  ON crove_projects.roadmap_otp (org_id, board_id, ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_otp_claim_idx
  ON crove_projects.roadmap_otp (org_id, board_id, claim_sha256)
  WHERE claim_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS roadmap_otp_cleanup_idx
  ON crove_projects.roadmap_otp (expires_at, invalidated_at);

ALTER TABLE crove_projects.roadmap_otp ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_projects.roadmap_otp');
REVOKE ALL ON TABLE crove_projects.roadmap_otp
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE TABLE IF NOT EXISTS crove_projects.roadmap_subscriber (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  voter_email_hash text NOT NULL CHECK (voter_email_hash ~ '^[0-9a-f]{64}$'),
  email_sealed text NOT NULL CHECK (pg_catalog.length(email_sealed) BETWEEN 1 AND 4096),
  notify_on_ship boolean NOT NULL DEFAULT true,
  unsubscribe_token_sha256 text NOT NULL CHECK (unsubscribe_token_sha256 ~ '^[0-9a-f]{64}$'),
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_subscriber_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_subscriber_uq UNIQUE (org_id, board_id, voter_email_hash)
);

CREATE INDEX IF NOT EXISTS roadmap_subscriber_unsub_idx
  ON crove_projects.roadmap_subscriber (org_id, board_id, unsubscribe_token_sha256);

ALTER TABLE crove_projects.roadmap_subscriber ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_projects.roadmap_subscriber');
REVOKE ALL ON TABLE crove_projects.roadmap_subscriber
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 3. Private project & embed allowlist guards (ADR-0056 #2604 + ADR-0057)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_projects.roadmap_board_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_origin text;
  v_port_text text;
  v_port integer;
  v_proj record;
BEGIN
  IF NEW.embed_allowed_origins IS NULL THEN
    RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGINS' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(pg_catalog.array_length(NEW.embed_allowed_origins, 1), 0) > 20 THEN
    RAISE EXCEPTION 'ROADMAP_TOO_MANY_EMBED_ORIGINS' USING ERRCODE = '23514';
  END IF;
  FOREACH v_origin IN ARRAY NEW.embed_allowed_origins LOOP
    IF v_origin IS NULL
       OR v_origin !~ '^https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$' THEN
      RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGIN' USING ERRCODE = '23514';
    END IF;
    v_port_text := (pg_catalog.regexp_match(v_origin, ':([0-9]{1,5})$'))[1];
    IF v_port_text IS NOT NULL THEN
      v_port := v_port_text::integer;
      IF v_port < 1 OR v_port > 65535 THEN
        RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGIN' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  IF NEW.project_id IS NOT NULL THEN
    SELECT p.id, p.is_template, pg_catalog.to_jsonb(p) AS row_json
    INTO v_proj
    FROM crove_projects.project p
    WHERE p.org_id = NEW.org_id
      AND p.id = NEW.project_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ROADMAP_PROJECT_NOT_FOUND' USING ERRCODE = '23503';
    END IF;
    IF v_proj.is_template THEN
      RAISE EXCEPTION 'ROADMAP_TEMPLATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    IF COALESCE(v_proj.row_json->>'visibility', 'public') = 'private' THEN
      RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_board_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS roadmap_board_guard_tr ON crove_projects.roadmap_board;
CREATE TRIGGER roadmap_board_guard_tr
  BEFORE INSERT OR UPDATE ON crove_projects.roadmap_board
  FOR EACH ROW
  EXECUTE FUNCTION crove_projects.roadmap_board_guard();

CREATE OR REPLACE FUNCTION crove_projects.project_roadmap_privacy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF COALESCE(pg_catalog.to_jsonb(NEW)->>'visibility', 'public') = 'private'
     AND EXISTS (
       SELECT 1
       FROM crove_projects.roadmap_board rb
       WHERE rb.org_id = NEW.org_id
         AND rb.project_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.project_roadmap_privacy_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS project_roadmap_privacy_guard_tr ON crove_projects.project;
CREATE TRIGGER project_roadmap_privacy_guard_tr
  BEFORE UPDATE ON crove_projects.project
  FOR EACH ROW
  EXECUTE FUNCTION crove_projects.project_roadmap_privacy_guard();

-- ---------------------------------------------------------------------------
-- 4. Private crypto / validation helpers (zero grants outside definers)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_projects.roadmap_is_single_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_email IS NOT NULL
    AND pg_catalog.length(p_email) BETWEEN 3 AND 254
    AND p_email = pg_catalog.btrim(p_email)
    AND p_email !~ '[[:cntrl:][:space:]<>,;"]'
    AND pg_catalog.strpos(p_email, '@') > 1
    AND pg_catalog.strpos(pg_catalog.substr(p_email, pg_catalog.strpos(p_email, '@') + 1), '@') = 0
    AND pg_catalog.strpos(pg_catalog.substr(p_email, pg_catalog.strpos(p_email, '@') + 1), '.') > 1
    AND pg_catalog.right(p_email, 1) <> '.'
    AND pg_catalog.substr(p_email, pg_catalog.strpos(p_email, '@') - 1, 1) <> '.'
$$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_is_single_email(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_projects.roadmap_mask_email(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_at integer := pg_catalog.strpos(v_clean, '@');
  v_local text;
  v_domain text;
BEGIN
  IF v_at <= 1 THEN
    RETURN '***';
  END IF;
  v_local := pg_catalog.substr(v_clean, 1, v_at - 1);
  v_domain := pg_catalog.substr(v_clean, v_at + 1);
  IF pg_catalog.length(v_local) <= 2 THEN
    RETURN pg_catalog.left(v_local, 1) || '***@' || v_domain;
  END IF;
  RETURN pg_catalog.left(v_local, 2) || '***@' || v_domain;
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_mask_email(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_projects.roadmap_keyed_email_hash(
  p_org_id uuid,
  p_email text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean text := crove_kernel.invite_cap_key(COALESCE(p_email, ''));
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF p_org_id IS NULL OR v_clean = '' THEN
    RETURN NULL;
  END IF;
  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(
        v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(
          'crove:projects:roadmap:email:v1:' || p_org_id::text || ':' || v_clean,
          'UTF8'
        )
      )
    ),
    'hex'
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_keyed_email_hash(uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_projects.roadmap_keyed_ip_hash(
  p_org_id uuid,
  p_ip_hash text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean text := CASE WHEN p_ip_hash IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ~ '^[0-9a-f]{64}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ELSE NULL END;
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF p_org_id IS NULL OR v_clean IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(
        v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(
          'crove:projects:roadmap:ip:v1:' || p_org_id::text || ':' || v_clean,
          'UTF8'
        )
      )
    ),
    'hex'
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_keyed_ip_hash(uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 5. Narrow orgless SECURITY DEFINER public resolvers (ADR-0053, ADR-0057)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_view(
  p_org_slug text,
  p_board_slug text,
  p_claim_sha256 text DEFAULT NULL,
  p_voter_email text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_board record;
  v_voter_hash text := NULL;
  v_voter_masked text := NULL;
  v_notify boolean := NULL;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id,
    b.slug,
    b.title,
    b.description,
    b.allow_submissions,
    b.allow_voting,
    b.require_moderation,
    t.name AS org_name
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_claim_sha256 IS NOT NULL AND p_claim_sha256 ~ '^[0-9a-f]{64}$' THEN
    SELECT o.email_hash, crove_projects.roadmap_mask_email(o.email)
    INTO v_voter_hash, v_voter_masked
    FROM crove_projects.roadmap_otp o
    WHERE o.org_id = v_board.org_id
      AND o.board_id = v_board.board_id
      AND o.claim_sha256 = p_claim_sha256
      AND o.verified_at IS NOT NULL
      AND o.invalidated_at IS NULL
      AND o.expires_at > v_now
    ORDER BY o.verified_at DESC, o.id DESC
    LIMIT 1;
  ELSIF p_voter_email IS NOT NULL AND crove_projects.roadmap_is_single_email(pg_catalog.lower(pg_catalog.btrim(p_voter_email))) THEN
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, p_voter_email);
    v_voter_masked := crove_projects.roadmap_mask_email(p_voter_email);
  END IF;

  IF v_voter_hash IS NOT NULL THEN
    SELECT s.notify_on_ship
    INTO v_notify
    FROM crove_projects.roadmap_subscriber s
    WHERE s.org_id = v_board.org_id
      AND s.board_id = v_board.board_id
      AND s.voter_email_hash = v_voter_hash
    LIMIT 1;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', r.id,
        'stage', r.stage,
        'category', r.category,
        'publicTitle', r.public_title,
        'publicSummary', r.public_summary,
        'voteCount', r.vote_count,
        'tainted', r.tainted,
        'submitterDisplayName', r.submitter_display_name,
        'createdAt', pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'viewerHasVoted', r.viewer_has_voted
      )
      ORDER BY r.vote_count DESC, r.created_at DESC, r.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      i.id,
      i.stage,
      i.category,
      i.public_title,
      i.public_summary,
      i.vote_count,
      i.tainted,
      i.submitter_display_name,
      i.created_at,
      i.updated_at,
      CASE
        WHEN v_voter_hash IS NULL THEN false
        ELSE EXISTS (
          SELECT 1
          FROM crove_projects.roadmap_vote v
          WHERE v.org_id = v_board.org_id
            AND v.board_id = v_board.board_id
            AND v.item_id = i.id
            AND v.voter_email_hash = v_voter_hash
        )
      END AS viewer_has_voted
    FROM crove_projects.roadmap_item i
    WHERE i.org_id = v_board.org_id
      AND i.board_id = v_board.board_id
      AND i.moderation_status = 'published'
    ORDER BY i.vote_count DESC, i.created_at DESC, i.id DESC
    LIMIT 200
  ) r;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'board', pg_catalog.jsonb_build_object(
      'slug', v_board.slug,
      'orgSlug', v_org_slug,
      'orgName', v_board.org_name,
      'title', v_board.title,
      'description', v_board.description,
      'allowSubmissions', v_board.allow_submissions,
      'allowVoting', v_board.allow_voting,
      'requireModeration', v_board.require_moderation
    ),
    'viewer', pg_catalog.jsonb_build_object(
      'verified', v_voter_hash IS NOT NULL,
      'maskedEmail', v_voter_masked,
      'notifyOnShip', COALESCE(v_notify, false)
    ),
    'items', v_items
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_view(text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_view(text, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_resolve_board(
  p_org_slug text,
  p_board_slug text,
  p_voter_email text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_voter_email, ''))), '');
  v_board record;
  v_voter_hash text := NULL;
  v_has_sub boolean := false;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id,
    b.embed_allowed_origins
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_email IS NOT NULL AND crove_projects.roadmap_is_single_email(v_email) THEN
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, v_email);
    SELECT EXISTS (
      SELECT 1
      FROM crove_projects.roadmap_subscriber s
      WHERE s.org_id = v_board.org_id
        AND s.board_id = v_board.board_id
        AND s.voter_email_hash = v_voter_hash
    )
    INTO v_has_sub;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'boardId', v_board.board_id,
    'origins', pg_catalog.to_jsonb(v_board.embed_allowed_origins),
    'voterEmailHash', v_voter_hash,
    'hasSubscriber', v_has_sub
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_resolve_board(text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_resolve_board(text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_otp_request(
  p_org_slug text,
  p_board_slug text,
  p_email text,
  p_ip_hash text,
  p_mail_domain text DEFAULT 'mail.ludy.vn'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_exp timestamptz := v_now + interval '10 minutes';
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_domain text := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_mail_domain, '')), ''), 'mail.ludy.vn');
  v_board record;
  v_email_hash text;
  v_keyed_ip_hash text;
  v_mail_hash text;
  v_suppressed boolean := false;
  v_recent_email integer := 0;
  v_recent_ip integer := 0;
  v_otp_id uuid;
  v_org_name text;
  v_board_title text;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id,
    b.slug,
    b.title,
    b.allow_submissions,
    b.allow_voting,
    t.name AS org_name
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_board.allow_submissions AND NOT v_board.allow_voting THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_INTERACTION_DISABLED',
      'httpStatus', 403,
      'message', 'Public submissions and voting are currently disabled on this board'
    );
  END IF;

  IF NOT crove_projects.roadmap_is_single_email(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid email address'
    );
  END IF;

  v_email_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, v_email);
  v_keyed_ip_hash := crove_projects.roadmap_keyed_ip_hash(v_board.org_id, p_ip_hash);
  v_mail_hash := crove_kernel.mail_address_hash(v_email);
  IF v_email_hash IS NULL OR v_mail_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid email address'
    );
  END IF;
  IF v_keyed_ip_hash IS NULL THEN
    v_keyed_ip_hash := v_email_hash;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.mail_suppression ms
    WHERE ms.org_id = v_board.org_id
      AND ms.to_hash = v_mail_hash
      AND ms.scope = 'all'
      AND ms.lifted_at IS NULL
  )
  INTO v_suppressed;

  SELECT
    pg_catalog.count(*) FILTER (WHERE o.email_hash = v_email_hash)::integer,
    pg_catalog.count(*) FILTER (WHERE o.ip_hash = v_keyed_ip_hash)::integer
  INTO v_recent_email, v_recent_ip
  FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_board.org_id
    AND o.board_id = v_board.board_id
    AND o.created_at > v_now - interval '1 hour';

  IF v_recent_email >= 5 OR v_recent_ip >= 20 THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_OTP_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many OTP requests; wait before trying again'
    );
  END IF;

  PERFORM 1
  FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_board.org_id
    AND o.board_id = v_board.board_id
    AND o.email_hash = v_email_hash
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_projects.roadmap_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_board.org_id
    AND o.board_id = v_board.board_id
    AND o.email_hash = v_email_hash
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL;

  INSERT INTO crove_projects.roadmap_otp (
    org_id, board_id, email, email_hash, ip_hash, otp_sha256,
    expires_at, attempts, invalidated_at, created_at
  )
  VALUES (
    v_board.org_id,
    v_board.board_id,
    v_email,
    v_email_hash,
    v_keyed_ip_hash,
    NULL,
    v_exp,
    0,
    CASE WHEN v_suppressed THEN v_now ELSE NULL END,
    v_now
  )
  RETURNING id INTO v_otp_id;

  IF NOT v_suppressed THEN
    v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_board.org_name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
    v_board_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_board.title, '[[:cntrl:]]+', ' ', 'g')), 120), ''), 'Roadmap');

    INSERT INTO crove_kernel.mail_message (
      org_id, stream, source, source_id, template_key, to_address, to_hash,
      subject, payload, message_id_header, status, created_by
    )
    VALUES (
      v_board.org_id,
      'transactional',
      'projects.roadmap.otp_request',
      v_otp_id,
      'projects.roadmap_otp',
      v_email,
      v_mail_hash,
      pg_catalog.left('Ma xac thuc dong gop y kien: ' || v_board_title, 300),
      pg_catalog.jsonb_build_object(
        'lang', 'vi',
        'orgName', v_org_name,
        'boardId', v_board.board_id::text,
        'boardTitle', v_board_title,
        'otpId', v_otp_id::text,
        'expiresAt', pg_catalog.to_char(v_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
      'queued',
      NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'status', 'ok',
    'sent', true,
    'expiresInMinutes', 10,
    'maskedEmail', crove_projects.roadmap_mask_email(v_email)
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_otp_request(text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_otp_request(text, text, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_otp_verify(
  p_org_slug text,
  p_board_slug text,
  p_email text,
  p_code text,
  p_claim_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_claim_exp timestamptz := v_now + interval '2 hours';
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_board record;
  v_email_hash text;
  v_otp record;
  v_cand_hash text;
  v_next integer;
  v_locked boolean;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT crove_projects.roadmap_is_single_email(v_email) THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'status', 'validation_error', 'message', 'Invalid email address');
  END IF;

  IF p_code IS NULL OR p_code !~ '^\d{6}$' THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'status', 'validation_error', 'message', 'OTP code must be 6 digits');
  END IF;

  IF p_claim_sha256 IS NULL OR p_claim_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'status', 'validation_error', 'message', 'Invalid OTP session claim');
  END IF;

  v_email_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, v_email);

  SELECT o.id, o.otp_sha256, o.expires_at, o.attempts, o.invalidated_at
  INTO v_otp
  FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_board.org_id
    AND o.board_id = v_board.board_id
    AND o.email_hash = v_email_hash
    AND o.verified_at IS NULL
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'ok', false, 'locked', false, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.invalidated_at IS NOT NULL AND v_otp.otp_sha256 IS NULL AND v_otp.attempts < 5 AND v_otp.expires_at > v_now THEN
    v_next := v_otp.attempts + 1;
    v_locked := v_next >= 5;
    UPDATE crove_projects.roadmap_otp
    SET attempts = v_next
    WHERE org_id = v_board.org_id
      AND id = v_otp.id;
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'ok', false,
      'locked', v_locked,
      'attemptsRemaining', GREATEST(0, 5 - v_next)
    );
  END IF;

  IF v_otp.invalidated_at IS NOT NULL OR v_otp.attempts >= 5 THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'ok', false, 'locked', true, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.expires_at <= v_now THEN
    UPDATE crove_projects.roadmap_otp
    SET invalidated_at = v_now
    WHERE org_id = v_board.org_id
      AND id = v_otp.id;
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'ok', false, 'locked', false, 'attemptsRemaining', 0, 'expired', true);
  END IF;

  IF v_otp.otp_sha256 IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'ok', false,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts),
      'notReady', true
    );
  END IF;

  v_cand_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:projects:roadmap-otp:v1:' || v_board.board_id::text || ':' || v_otp.id::text || ':' || p_code, 'UTF8')
    ),
    'hex'
  );

  IF v_cand_hash = v_otp.otp_sha256 THEN
    UPDATE crove_projects.roadmap_otp
    SET verified_at = v_now,
        claim_sha256 = p_claim_sha256,
        expires_at = GREATEST(expires_at, v_claim_exp)
    WHERE org_id = v_board.org_id
      AND id = v_otp.id;

    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'boardId', v_board.board_id,
      'ok', true,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts),
      'voterEmailHash', v_email_hash,
      'verifiedEmail', v_email,
      'maskedEmail', crove_projects.roadmap_mask_email(v_email),
      'expiresAt', pg_catalog.to_char(v_claim_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  v_next := v_otp.attempts + 1;
  v_locked := v_next >= 5;
  UPDATE crove_projects.roadmap_otp
  SET attempts = v_next,
      invalidated_at = CASE WHEN v_locked THEN v_now ELSE NULL END
  WHERE org_id = v_board.org_id
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'ok', false,
    'locked', v_locked,
    'attemptsRemaining', GREATEST(0, 5 - v_next)
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_otp_verify(text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_otp_verify(text, text, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_claim_resolve(
  p_org_slug text,
  p_board_slug text,
  p_claim_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_board record;
  v_otp record;
  v_has_sub boolean := false;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' OR p_claim_sha256 IS NULL OR p_claim_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT o.email, o.email_hash
  INTO v_otp
  FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_board.org_id
    AND o.board_id = v_board.board_id
    AND o.claim_sha256 = p_claim_sha256
    AND o.verified_at IS NOT NULL
    AND o.invalidated_at IS NULL
    AND o.expires_at > v_now
  ORDER BY o.verified_at DESC, o.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('orgId', v_board.org_id, 'valid', false);
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_projects.roadmap_subscriber s
    WHERE s.org_id = v_board.org_id
      AND s.board_id = v_board.board_id
      AND s.voter_email_hash = v_otp.email_hash
  )
  INTO v_has_sub;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'boardId', v_board.board_id,
    'valid', true,
    'email', v_otp.email,
    'voterEmailHash', v_otp.email_hash,
    'hasSubscriber', v_has_sub
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_claim_resolve(text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_claim_resolve(text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_submit_idea(
  p_org_slug text,
  p_board_slug text,
  p_title text,
  p_summary text,
  p_category text,
  p_display_name text,
  p_claim_sha256 text DEFAULT NULL,
  p_voter_email text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_title text := pg_catalog.btrim(COALESCE(p_title, ''));
  v_summary text := NULLIF(pg_catalog.btrim(COALESCE(p_summary, '')), '');
  v_category text := NULLIF(pg_catalog.btrim(COALESCE(p_category, '')), '');
  v_display_name text := NULLIF(pg_catalog.btrim(COALESCE(p_display_name, '')), '');
  v_board record;
  v_voter_hash text := NULL;
  v_mod_status text;
  v_item crove_projects.roadmap_item%ROWTYPE;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id,
    b.allow_submissions,
    b.require_moderation
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_board.allow_submissions THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_SUBMISSIONS_DISABLED',
      'httpStatus', 403,
      'message', 'Public idea submissions are disabled on this board'
    );
  END IF;

  IF p_claim_sha256 IS NOT NULL AND p_claim_sha256 ~ '^[0-9a-f]{64}$' THEN
    SELECT o.email_hash
    INTO v_voter_hash
    FROM crove_projects.roadmap_otp o
    WHERE o.org_id = v_board.org_id
      AND o.board_id = v_board.board_id
      AND o.claim_sha256 = p_claim_sha256
      AND o.verified_at IS NOT NULL
      AND o.invalidated_at IS NULL
      AND o.expires_at > v_now
    ORDER BY o.verified_at DESC, o.id DESC
    LIMIT 1;
  ELSIF p_voter_email IS NOT NULL AND crove_projects.roadmap_is_single_email(pg_catalog.lower(pg_catalog.btrim(p_voter_email))) THEN
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, p_voter_email);
  END IF;

  IF v_voter_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_OTP_REQUIRED',
      'httpStatus', 401,
      'message', 'Email OTP verification is required to submit an idea'
    );
  END IF;

  IF pg_catalog.length(v_title) < 1 OR pg_catalog.length(v_title) > 200
     OR (v_summary IS NOT NULL AND pg_catalog.length(v_summary) > 4000)
     OR (v_category IS NOT NULL AND pg_catalog.length(v_category) > 60)
     OR (v_display_name IS NOT NULL AND pg_catalog.length(v_display_name) > 80) THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Idea fields exceed allowed lengths or are empty'
    );
  END IF;

  -- Submissions through the public portal ALWAYS start tainted and obey board.require_moderation ('pending' by default).
  v_mod_status := CASE WHEN v_board.require_moderation THEN 'pending' ELSE 'published' END;

  INSERT INTO crove_projects.roadmap_item (
    org_id, board_id, linked_task_id, source, moderation_status,
    stage, category, public_title, public_summary, vote_count,
    tainted, submitter_display_name, created_by, created_at, updated_at
  )
  VALUES (
    v_board.org_id,
    v_board.board_id,
    NULL,
    'public_submission',
    v_mod_status,
    'under_review',
    v_category,
    v_title,
    v_summary,
    0,
    true,
    v_display_name,
    p_actor_user_id,
    v_now,
    v_now
  )
  RETURNING * INTO v_item;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'status', 'ok',
    'item', pg_catalog.jsonb_build_object(
      'id', v_item.id,
      'stage', v_item.stage,
      'moderationStatus', v_item.moderation_status,
      'category', v_item.category,
      'publicTitle', v_item.public_title,
      'publicSummary', v_item.public_summary,
      'voteCount', v_item.vote_count,
      'tainted', v_item.tainted,
      'submitterDisplayName', v_item.submitter_display_name,
      'createdAt', pg_catalog.to_char(v_item.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'viewerHasVoted', false
    )
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_submit_idea(text, text, text, text, text, text, text, text, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_submit_idea(text, text, text, text, text, text, text, text, uuid) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_vote(
  p_org_slug text,
  p_board_slug text,
  p_item_id uuid,
  p_action text,
  p_claim_sha256 text DEFAULT NULL,
  p_voter_email text DEFAULT NULL,
  p_notify_on_ship boolean DEFAULT NULL,
  p_email_sealed text DEFAULT NULL,
  p_unsub_token_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_board record;
  v_item record;
  v_voter_hash text := NULL;
  v_exists boolean := false;
  v_voted boolean := false;
  v_vote_count integer := 0;
  v_effective_notify boolean := false;
  v_sub_notify boolean := NULL;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' OR p_item_id IS NULL OR p_action NOT IN ('vote', 'unvote', 'toggle') THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id,
    b.allow_voting
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_board.allow_voting THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_VOTING_DISABLED',
      'httpStatus', 403,
      'message', 'Voting is currently disabled on this board'
    );
  END IF;

  IF p_claim_sha256 IS NOT NULL AND p_claim_sha256 ~ '^[0-9a-f]{64}$' THEN
    SELECT o.email_hash
    INTO v_voter_hash
    FROM crove_projects.roadmap_otp o
    WHERE o.org_id = v_board.org_id
      AND o.board_id = v_board.board_id
      AND o.claim_sha256 = p_claim_sha256
      AND o.verified_at IS NOT NULL
      AND o.invalidated_at IS NULL
      AND o.expires_at > v_now
    ORDER BY o.verified_at DESC, o.id DESC
    LIMIT 1;
  ELSIF p_voter_email IS NOT NULL AND crove_projects.roadmap_is_single_email(pg_catalog.lower(pg_catalog.btrim(p_voter_email))) THEN
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, p_voter_email);
  END IF;

  IF v_voter_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_OTP_REQUIRED',
      'httpStatus', 401,
      'message', 'Email OTP verification is required to vote'
    );
  END IF;

  SELECT i.id, i.moderation_status
  INTO v_item
  FROM crove_projects.roadmap_item i
  WHERE i.org_id = v_board.org_id
    AND i.board_id = v_board.board_id
    AND i.id = p_item_id
  FOR UPDATE;

  IF NOT FOUND OR v_item.moderation_status <> 'published' THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'NOT_FOUND',
      'httpStatus', 404,
      'message', 'Not found'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_projects.roadmap_vote v
    WHERE v.org_id = v_board.org_id
      AND v.item_id = v_item.id
      AND v.voter_email_hash = v_voter_hash
  )
  INTO v_exists;

  v_effective_notify := COALESCE(p_notify_on_ship, false);

  IF p_action = 'vote' OR (p_action = 'toggle' AND NOT v_exists) THEN
    INSERT INTO crove_projects.roadmap_vote (
      org_id, board_id, item_id, voter_email_hash, notify_on_ship, created_at
    )
    VALUES (
      v_board.org_id,
      v_board.board_id,
      v_item.id,
      v_voter_hash,
      v_effective_notify,
      v_now
    )
    ON CONFLICT (org_id, item_id, voter_email_hash) DO UPDATE
      SET notify_on_ship = COALESCE(p_notify_on_ship, roadmap_vote.notify_on_ship);
    v_voted := true;
  ELSE
    DELETE FROM crove_projects.roadmap_vote v
    WHERE v.org_id = v_board.org_id
      AND v.item_id = v_item.id
      AND v.voter_email_hash = v_voter_hash;
    v_voted := false;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_vote_count
  FROM crove_projects.roadmap_vote v
  WHERE v.org_id = v_board.org_id
    AND v.item_id = v_item.id;

  UPDATE crove_projects.roadmap_item i
  SET vote_count = v_vote_count,
      updated_at = v_now
  WHERE i.org_id = v_board.org_id
    AND i.id = v_item.id;

  IF p_notify_on_ship = true THEN
    IF p_email_sealed IS NOT NULL AND p_unsub_token_sha256 IS NOT NULL AND p_unsub_token_sha256 ~ '^[0-9a-f]{64}$' THEN
      INSERT INTO crove_projects.roadmap_subscriber (
        org_id, board_id, voter_email_hash, email_sealed, notify_on_ship,
        unsubscribe_token_sha256, unsubscribed_at, created_at, updated_at
      )
      VALUES (
        v_board.org_id,
        v_board.board_id,
        v_voter_hash,
        p_email_sealed,
        true,
        p_unsub_token_sha256,
        NULL,
        v_now,
        v_now
      )
      ON CONFLICT (org_id, board_id, voter_email_hash) DO UPDATE
        SET email_sealed = EXCLUDED.email_sealed,
            notify_on_ship = true,
            unsubscribed_at = NULL,
            updated_at = v_now;
    ELSE
      UPDATE crove_projects.roadmap_subscriber s
      SET notify_on_ship = true,
          unsubscribed_at = NULL,
          updated_at = v_now
      WHERE s.org_id = v_board.org_id
        AND s.board_id = v_board.board_id
        AND s.voter_email_hash = v_voter_hash;
    END IF;
  ELSIF p_notify_on_ship = false THEN
    UPDATE crove_projects.roadmap_subscriber s
    SET notify_on_ship = false,
        unsubscribed_at = v_now,
        updated_at = v_now
    WHERE s.org_id = v_board.org_id
      AND s.board_id = v_board.board_id
      AND s.voter_email_hash = v_voter_hash;
  END IF;

  SELECT s.notify_on_ship
  INTO v_sub_notify
  FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = v_board.org_id
    AND s.board_id = v_board.board_id
    AND s.voter_email_hash = v_voter_hash
  LIMIT 1;

  IF FOUND THEN
    v_effective_notify := v_sub_notify;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'status', 'ok',
    'itemId', v_item.id,
    'voted', v_voted,
    'voteCount', v_vote_count,
    'notifyOnShip', COALESCE(v_effective_notify, false)
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_vote(text, text, uuid, text, text, text, boolean, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_vote(text, text, uuid, text, text, text, boolean, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_unsubscribe(
  p_org_slug text,
  p_board_slug text,
  p_unsub_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_org_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_board_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_board_slug, '')));
  v_board record;
  v_voter_hash text;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN crove_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND crove_kernel.org_app_on(b.org_id, 'projects')
    AND b.enabled = true
    AND (
      b.project_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM crove_projects.project p
        WHERE p.org_id = b.org_id
          AND p.id = b.project_id
          AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') = 'private'
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_unsub_token_sha256 IS NOT NULL AND p_unsub_token_sha256 ~ '^[0-9a-f]{64}$' THEN
    UPDATE crove_projects.roadmap_subscriber s
    SET notify_on_ship = false,
        unsubscribed_at = v_now,
        updated_at = v_now
    WHERE s.org_id = v_board.org_id
      AND s.board_id = v_board.board_id
      AND s.unsubscribe_token_sha256 = p_unsub_token_sha256
    RETURNING s.voter_email_hash INTO v_voter_hash;

    IF v_voter_hash IS NOT NULL THEN
      UPDATE crove_projects.roadmap_vote v
      SET notify_on_ship = false
      WHERE v.org_id = v_board.org_id
        AND v.board_id = v_board.board_id
        AND v.voter_email_hash = v_voter_hash;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'status', 'ok',
    'unsubscribed', true
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_unsubscribe(text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_unsubscribe(text, text, text) TO crove_app;

-- ---------------------------------------------------------------------------
-- 6. Worker OTP issuer, keeping cleanup sweep (ADR-0053), and PDPL machinery erasure
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_otp_issue(
  p_otp_id uuid,
  p_expires_at timestamptz,
  p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_ipad bytea;
  v_opad bytea;
  v_otp record;
  v_board record;
  v_ctr integer := 0;
  v_msg text;
  v_mac bytea;
  v_u32 bigint;
  v_code text;
  v_hash text;
  v_final_exp timestamptz;
BEGIN
  IF v_org IS NULL
     OR v_actor IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR p_otp_id IS NULL
     OR p_now IS NULL
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'ROADMAP_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'ROADMAP_INVALID_OTP_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT b.id, b.slug, b.title, b.enabled
  INTO v_board
  FROM crove_projects.roadmap_otp o
  JOIN crove_projects.roadmap_board b
    ON b.org_id = o.org_id
   AND b.id = o.board_id
  WHERE o.org_id = v_org
    AND o.id = p_otp_id
  FOR SHARE OF b;

  IF NOT FOUND
     OR NOT v_board.enabled
     OR NOT crove_kernel.org_app_on(v_org, 'projects') THEN
    RETURN NULL;
  END IF;

  SELECT o.id, o.board_id, o.email, o.otp_sha256, o.attempts, o.expires_at, o.verified_at, o.invalidated_at
  INTO v_otp
  FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_org
    AND o.id = p_otp_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_otp.verified_at IS NOT NULL
     OR v_otp.invalidated_at IS NOT NULL
     OR v_otp.attempts >= 5 THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  LOOP
    v_msg := 'crove:projects:roadmap-otp:hmac:v1:' || v_org::text || ':' || v_otp.board_id::text || ':' || v_otp.id::text || ':' || v_ctr::text;
    v_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_msg, 'UTF8')));
    v_u32 := pg_catalog.get_byte(v_mac, 0)::bigint * 16777216
           + pg_catalog.get_byte(v_mac, 1)::bigint * 65536
           + pg_catalog.get_byte(v_mac, 2)::bigint * 256
           + pg_catalog.get_byte(v_mac, 3)::bigint;
    IF v_u32 < 4294000000 OR v_ctr >= 64 THEN
      v_code := pg_catalog.lpad((v_u32 % 1000000)::text, 6, '0');
      EXIT;
    END IF;
    v_ctr := v_ctr + 1;
  END LOOP;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:projects:roadmap-otp:v1:' || v_otp.board_id::text || ':' || v_otp.id::text || ':' || v_code, 'UTF8')
    ),
    'hex'
  );

  IF v_otp.otp_sha256 IS NOT NULL AND v_otp.otp_sha256 IS DISTINCT FROM v_hash THEN
    RETURN NULL;
  END IF;

  v_final_exp := GREATEST(v_otp.expires_at, p_expires_at);

  UPDATE crove_projects.roadmap_otp
  SET otp_sha256 = v_hash,
      expires_at = v_final_exp
  WHERE org_id = v_org
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'otpId', v_otp.id,
    'boardId', v_board.id,
    'boardSlug', v_board.slug,
    'boardTitle', v_board.title,
    'email', v_otp.email,
    'code', v_code,
    'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_otp_issue(uuid, timestamptz, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_otp_issue(uuid, timestamptz, timestamptz) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_projects.cleanup_roadmap_otp_due_orgs(
  p_cutoff timestamptz,
  p_limit integer DEFAULT 500
) RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ROADMAP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT o.org_id
  FROM crove_projects.roadmap_otp o
  WHERE o.expires_at < p_cutoff
     OR o.invalidated_at < p_cutoff
  ORDER BY o.org_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
END $$;

REVOKE ALL ON FUNCTION crove_projects.cleanup_roadmap_otp_due_orgs(timestamptz, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.cleanup_roadmap_otp_due_orgs(timestamptz, integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_projects.cleanup_roadmap_otp_org(
  p_cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_deleted integer := 0;
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ROADMAP_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  DELETE FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_org
    AND (o.expires_at < p_cutoff OR o.invalidated_at < p_cutoff);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION crove_projects.cleanup_roadmap_otp_org(timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.cleanup_roadmap_otp_org(timestamptz) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_projects.personal_erase_roadmap_machinery(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_clean text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_email_hash text;
  v_otp_deleted integer := 0;
  v_sub_deleted integer := 0;
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_agent_id() IS NOT NULL
     OR crove_kernel.ctx_user_id() IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'ROADMAP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_clean = '' THEN
    RETURN pg_catalog.jsonb_build_object('otps', 0, 'subscribers', 0);
  END IF;

  v_email_hash := crove_projects.roadmap_keyed_email_hash(v_org, v_clean);

  DELETE FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_org
    AND (pg_catalog.lower(pg_catalog.btrim(o.email)) = v_clean OR o.email_hash = v_email_hash);
  GET DIAGNOSTICS v_otp_deleted = ROW_COUNT;

  DELETE FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = v_org
    AND s.voter_email_hash = v_email_hash;
  GET DIAGNOSTICS v_sub_deleted = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('otps', v_otp_deleted, 'subscribers', v_sub_deleted);
END $$;

REVOKE ALL ON FUNCTION crove_projects.personal_erase_roadmap_machinery(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.personal_erase_roadmap_machinery(text) TO crove_tenant;
