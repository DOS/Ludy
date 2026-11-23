-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects Public Roadmap Slice 2 (#4400, ADR-0057):
--   - Tenant table `crove_projects.roadmap_announcement` (draft | published changelog releases + notification timestamp).
--   - `mail_hash` + `unsub_token_sealed` on `crove_projects.roadmap_subscriber` so internal callers never see raw addresses,
--     suppression filters apply deterministically before queuing/confirming, and worker dispatch restores unsubscribe links.
--   - Public changelog exposure in `crove_projects.public_roadmap_view` + footer `public_roadmap_subscribe` definer.
--   - Tenant recipient-count helper and worker-only dispatch definers.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Roadmap announcements (isolated tenant table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_projects.roadmap_announcement (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 200),
  body_md text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(body_md)) BETWEEN 1 AND 12000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  linked_item_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  notifications_sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_announcement_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_announcement_published_at_ck
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS roadmap_announcement_board_idx
  ON crove_projects.roadmap_announcement (org_id, board_id, status, published_at DESC, id DESC);

SELECT ludy_kernel.apply_tenant_rls('crove_projects.roadmap_announcement');

-- ---------------------------------------------------------------------------
-- 2. Subscriber mail_hash + sealed unsubscribe token support
-- ---------------------------------------------------------------------------
ALTER TABLE crove_projects.roadmap_subscriber
  ADD COLUMN IF NOT EXISTS mail_hash text
    CHECK (mail_hash IS NULL OR mail_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE crove_projects.roadmap_subscriber
  ADD COLUMN IF NOT EXISTS unsub_token_sealed text
    CHECK (unsub_token_sealed IS NULL OR pg_catalog.length(unsub_token_sealed) BETWEEN 1 AND 4096);

CREATE INDEX IF NOT EXISTS roadmap_subscriber_mail_hash_idx
  ON crove_projects.roadmap_subscriber (org_id, board_id, mail_hash)
  WHERE mail_hash IS NOT NULL;

UPDATE crove_projects.roadmap_subscriber s
SET mail_hash = ludy_kernel.mail_address_hash(o.email)
FROM (
  SELECT DISTINCT ON (org_id, board_id, email_hash)
    org_id,
    board_id,
    email_hash,
    email
  FROM crove_projects.roadmap_otp
  WHERE email IS NOT NULL
  ORDER BY org_id, board_id, email_hash, verified_at DESC NULLS LAST, id DESC
) o
WHERE s.org_id = o.org_id
  AND s.board_id = o.board_id
  AND s.voter_email_hash = o.email_hash
  AND s.mail_hash IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Public view update (append published announcements + linked shipped badges)
--    Preserves exact 4-argument signature and org_app_on(..., 'projects') guard.
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
  v_announcements jsonb := '[]'::jsonb;
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
  JOIN ludy_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND ludy_kernel.org_app_on(b.org_id, 'projects')
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

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'bodyMd', a.body_md,
        'publishedAt', pg_catalog.to_char(a.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'linkedItems', COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', li.id,
              'publicTitle', li.public_title,
              'stage', li.stage,
              'category', li.category
            )
            ORDER BY u.ord
          )
          FROM pg_catalog.unnest(a.linked_item_ids) WITH ORDINALITY AS u(item_id, ord)
          JOIN crove_projects.roadmap_item li
            ON li.org_id = v_board.org_id
           AND li.board_id = v_board.board_id
           AND li.id = u.item_id
           AND li.moderation_status = 'published'
           AND li.stage = 'shipped'
        ), '[]'::jsonb)
      )
      ORDER BY a.published_at DESC, a.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_announcements
  FROM (
    SELECT
      ra.id,
      ra.title,
      ra.body_md,
      ra.published_at,
      ra.linked_item_ids
    FROM crove_projects.roadmap_announcement ra
    WHERE ra.org_id = v_board.org_id
      AND ra.board_id = v_board.board_id
      AND ra.status = 'published'
    ORDER BY ra.published_at DESC, ra.id DESC
    LIMIT 100
  ) a;

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
    'items', v_items,
    'announcements', v_announcements
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_view(text, text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_view(text, text, text, text) TO ludy_app;

-- ---------------------------------------------------------------------------
-- 4. Update public_roadmap_vote (preserving exact 9-arg signature) to store mail_hash
-- ---------------------------------------------------------------------------
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
  v_voter_email text := NULL;
  v_mail_hash text := NULL;
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
  JOIN ludy_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND ludy_kernel.org_app_on(b.org_id, 'projects')
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
    SELECT o.email_hash, pg_catalog.lower(pg_catalog.btrim(o.email))
    INTO v_voter_hash, v_voter_email
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
    v_voter_email := pg_catalog.lower(pg_catalog.btrim(p_voter_email));
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, v_voter_email);
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

  IF v_voter_email IS NOT NULL AND v_voter_email <> '' THEN
    v_mail_hash := ludy_kernel.mail_address_hash(v_voter_email);
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
        org_id, board_id, voter_email_hash, email_sealed, mail_hash, notify_on_ship,
        unsubscribe_token_sha256, unsubscribed_at, created_at, updated_at
      )
      VALUES (
        v_board.org_id,
        v_board.board_id,
        v_voter_hash,
        p_email_sealed,
        v_mail_hash,
        true,
        p_unsub_token_sha256,
        NULL,
        v_now,
        v_now
      )
      ON CONFLICT (org_id, board_id, voter_email_hash) DO UPDATE
        SET email_sealed = EXCLUDED.email_sealed,
            mail_hash = COALESCE(EXCLUDED.mail_hash, roadmap_subscriber.mail_hash),
            notify_on_ship = true,
            unsubscribed_at = NULL,
            updated_at = v_now;
    ELSE
      UPDATE crove_projects.roadmap_subscriber s
      SET notify_on_ship = true,
          mail_hash = COALESCE(s.mail_hash, v_mail_hash),
          unsubscribed_at = NULL,
          updated_at = v_now
      WHERE s.org_id = v_board.org_id
        AND s.board_id = v_board.board_id
        AND s.voter_email_hash = v_voter_hash;
    END IF;
  ELSIF p_notify_on_ship = false THEN
    UPDATE crove_projects.roadmap_subscriber s
    SET notify_on_ship = false,
        mail_hash = COALESCE(s.mail_hash, v_mail_hash),
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
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_vote(text, text, uuid, text, text, text, boolean, text, text) TO ludy_app;

-- ---------------------------------------------------------------------------
-- 5. Public subscribe toggle (Changelog footer opt-in / opt-out for verified viewers)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.public_roadmap_subscribe(
  p_org_slug text,
  p_board_slug text,
  p_notify boolean,
  p_claim_sha256 text DEFAULT NULL,
  p_voter_email text DEFAULT NULL,
  p_email_sealed text DEFAULT NULL,
  p_unsub_token_sha256 text DEFAULT NULL,
  p_unsub_token_sealed text DEFAULT NULL
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
  v_voter_hash text := NULL;
  v_voter_email text := NULL;
  v_mail_hash text := NULL;
  v_effective boolean := false;
BEGIN
  IF v_org_slug = '' OR v_board_slug = '' OR p_notify IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    b.org_id,
    b.id AS board_id
  INTO v_board
  FROM crove_projects.roadmap_board b
  JOIN ludy_kernel.tenant t
    ON t.org_id = b.org_id
  WHERE t.slug = v_org_slug
    AND b.slug = v_board_slug
    AND t.status = 'active'
    AND ludy_kernel.org_app_on(b.org_id, 'projects')
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
    SELECT o.email_hash, pg_catalog.lower(pg_catalog.btrim(o.email))
    INTO v_voter_hash, v_voter_email
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
    v_voter_email := pg_catalog.lower(pg_catalog.btrim(p_voter_email));
    v_voter_hash := crove_projects.roadmap_keyed_email_hash(v_board.org_id, v_voter_email);
  END IF;

  IF v_voter_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_board.org_id,
      'status', 'error',
      'code', 'ROADMAP_OTP_REQUIRED',
      'httpStatus', 401,
      'message', 'Email OTP verification is required to subscribe'
    );
  END IF;

  IF v_voter_email IS NOT NULL AND v_voter_email <> '' THEN
    v_mail_hash := ludy_kernel.mail_address_hash(v_voter_email);
  END IF;

  IF p_notify THEN
    IF p_email_sealed IS NOT NULL AND p_unsub_token_sha256 IS NOT NULL AND p_unsub_token_sha256 ~ '^[0-9a-f]{64}$' THEN
      INSERT INTO crove_projects.roadmap_subscriber (
        org_id, board_id, voter_email_hash, email_sealed, mail_hash, notify_on_ship,
        unsubscribe_token_sha256, unsub_token_sealed, unsubscribed_at, created_at, updated_at
      )
      VALUES (
        v_board.org_id,
        v_board.board_id,
        v_voter_hash,
        p_email_sealed,
        v_mail_hash,
        true,
        p_unsub_token_sha256,
        p_unsub_token_sealed,
        NULL,
        v_now,
        v_now
      )
      ON CONFLICT (org_id, board_id, voter_email_hash) DO UPDATE
        SET email_sealed = EXCLUDED.email_sealed,
            mail_hash = COALESCE(EXCLUDED.mail_hash, roadmap_subscriber.mail_hash),
            notify_on_ship = true,
            unsubscribe_token_sha256 = CASE
              WHEN roadmap_subscriber.unsub_token_sealed IS NULL AND EXCLUDED.unsub_token_sealed IS NOT NULL
                THEN EXCLUDED.unsubscribe_token_sha256
              ELSE roadmap_subscriber.unsubscribe_token_sha256
            END,
            unsub_token_sealed = COALESCE(roadmap_subscriber.unsub_token_sealed, EXCLUDED.unsub_token_sealed),
            unsubscribed_at = NULL,
            updated_at = v_now;
    ELSE
      UPDATE crove_projects.roadmap_subscriber s
      SET notify_on_ship = true,
          mail_hash = COALESCE(s.mail_hash, v_mail_hash),
          unsub_token_sealed = COALESCE(s.unsub_token_sealed, p_unsub_token_sealed),
          unsubscribed_at = NULL,
          updated_at = v_now
      WHERE s.org_id = v_board.org_id
        AND s.board_id = v_board.board_id
        AND s.voter_email_hash = v_voter_hash;
    END IF;
  ELSE
    UPDATE crove_projects.roadmap_subscriber s
    SET notify_on_ship = false,
        mail_hash = COALESCE(s.mail_hash, v_mail_hash),
        unsubscribed_at = v_now,
        updated_at = v_now
    WHERE s.org_id = v_board.org_id
      AND s.board_id = v_board.board_id
      AND s.voter_email_hash = v_voter_hash;
  END IF;

  SELECT COALESCE(s.notify_on_ship, false)
  INTO v_effective
  FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = v_board.org_id
    AND s.board_id = v_board.board_id
    AND s.voter_email_hash = v_voter_hash
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_board.org_id,
    'status', 'ok',
    'notifyOnShip', COALESCE(v_effective, false)
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.public_roadmap_subscribe(text, text, boolean, text, text, text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.public_roadmap_subscribe(text, text, boolean, text, text, text, text, text) TO ludy_app;

-- ---------------------------------------------------------------------------
-- 6. PDPL erasure helper update: also match mail_hash when present
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.personal_erase_roadmap_machinery(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_clean text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_email_hash text;
  v_mail_hash text;
  v_otp_deleted integer := 0;
  v_sub_deleted integer := 0;
BEGIN
  IF v_org IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_agent_id() IS NOT NULL
     OR ludy_kernel.ctx_user_id() IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'ROADMAP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_clean = '' THEN
    RETURN pg_catalog.jsonb_build_object('otps', 0, 'subscribers', 0);
  END IF;

  v_email_hash := crove_projects.roadmap_keyed_email_hash(v_org, v_clean);
  v_mail_hash := ludy_kernel.mail_address_hash(v_clean);

  DELETE FROM crove_projects.roadmap_otp o
  WHERE o.org_id = v_org
    AND (pg_catalog.lower(pg_catalog.btrim(o.email)) = v_clean OR o.email_hash = v_email_hash);
  GET DIAGNOSTICS v_otp_deleted = ROW_COUNT;

  DELETE FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = v_org
    AND (s.voter_email_hash = v_email_hash OR (v_mail_hash IS NOT NULL AND s.mail_hash = v_mail_hash));
  GET DIAGNOSTICS v_sub_deleted = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('otps', v_otp_deleted, 'subscribers', v_sub_deleted);
END $$;

REVOKE ALL ON FUNCTION crove_projects.personal_erase_roadmap_machinery(text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.personal_erase_roadmap_machinery(text) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 7. Tenant recipient count preview (zero email exposure)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.roadmap_announcement_recipient_count(p_board_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_count integer := 0;
BEGIN
  IF v_org IS NULL
     OR p_board_id IS NULL
     OR ludy_kernel.ctx_actor_type() NOT IN ('user', 'system')
     OR NOT ludy_kernel.org_app_on(v_org, 'projects') THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crove_projects.roadmap_board b
    WHERE b.org_id = v_org
      AND b.id = p_board_id
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
  ) THEN
    RETURN 0;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_count
  FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = v_org
    AND s.board_id = p_board_id
    AND s.notify_on_ship = true
    AND s.unsubscribed_at IS NULL
    AND (
      s.mail_hash IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ludy_kernel.mail_suppression ms
        WHERE ms.org_id = s.org_id
          AND ms.to_hash = s.mail_hash
          AND ms.scope IN ('all', 'marketing')
          AND ms.lifted_at IS NULL
      )
    );

  RETURN COALESCE(v_count, 0);
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_announcement_recipient_count(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.roadmap_announcement_recipient_count(uuid) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 8. Worker-only dispatch definers (ludy_worker only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.worker_roadmap_announcement_context(
  p_org_id uuid,
  p_announcement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row record;
  v_linked jsonb := '[]'::jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ROADMAP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_org_id IS NULL OR p_announcement_id IS NULL OR NOT ludy_kernel.org_app_on(p_org_id, 'projects') THEN
    RETURN NULL;
  END IF;

  SELECT
    t.slug AS org_slug,
    t.name AS org_name,
    b.id AS board_id,
    b.slug AS board_slug,
    b.title AS board_title,
    a.id AS announcement_id,
    a.title AS title,
    a.body_md AS body_md,
    a.linked_item_ids,
    a.published_at,
    a.notifications_sent_at
  INTO v_row
  FROM crove_projects.roadmap_announcement a
  JOIN crove_projects.roadmap_board b
    ON b.org_id = a.org_id
   AND b.id = a.board_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = a.org_id
  WHERE a.org_id = p_org_id
    AND a.id = p_announcement_id
    AND a.status = 'published'
    AND a.notifications_sent_at IS NOT NULL
    AND b.enabled = true
    AND t.status = 'active'
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

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', li.id,
        'publicTitle', li.public_title
      )
      ORDER BY u.ord
    ),
    '[]'::jsonb
  )
  INTO v_linked
  FROM pg_catalog.unnest(v_row.linked_item_ids) WITH ORDINALITY AS u(item_id, ord)
  JOIN crove_projects.roadmap_item li
    ON li.org_id = p_org_id
   AND li.board_id = v_row.board_id
   AND li.id = u.item_id
   AND li.moderation_status = 'published'
   AND li.stage = 'shipped';

  RETURN pg_catalog.jsonb_build_object(
    'orgSlug', v_row.org_slug,
    'orgName', v_row.org_name,
    'boardId', v_row.board_id,
    'boardSlug', v_row.board_slug,
    'boardTitle', v_row.board_title,
    'announcementId', v_row.announcement_id,
    'title', v_row.title,
    'bodyMd', v_row.body_md,
    'publishedAt', pg_catalog.to_char(v_row.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'linkedItems', v_linked
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.worker_roadmap_announcement_context(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.worker_roadmap_announcement_context(uuid, uuid) TO ludy_worker;

CREATE OR REPLACE FUNCTION crove_projects.worker_roadmap_announcement_subscribers(
  p_org_id uuid,
  p_board_id uuid,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 200
) RETURNS TABLE (
  id uuid,
  voter_email_hash text,
  email_sealed text,
  unsub_token_sealed text,
  mail_hash text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ROADMAP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_org_id IS NULL OR p_board_id IS NULL OR NOT ludy_kernel.org_app_on(p_org_id, 'projects') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crove_projects.roadmap_board b
    JOIN ludy_kernel.tenant t
      ON t.org_id = b.org_id
    WHERE b.org_id = p_org_id
      AND b.id = p_board_id
      AND b.enabled = true
      AND t.status = 'active'
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
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.voter_email_hash,
    s.email_sealed,
    s.unsub_token_sealed,
    s.mail_hash
  FROM crove_projects.roadmap_subscriber s
  WHERE s.org_id = p_org_id
    AND s.board_id = p_board_id
    AND s.notify_on_ship = true
    AND s.unsubscribed_at IS NULL
    AND (p_after_id IS NULL OR s.id > p_after_id)
    AND (
      s.mail_hash IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ludy_kernel.mail_suppression ms
        WHERE ms.org_id = s.org_id
          AND ms.to_hash = s.mail_hash
          AND ms.scope IN ('all', 'marketing')
          AND ms.lifted_at IS NULL
      )
    )
  ORDER BY s.id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_projects.worker_roadmap_announcement_subscribers(uuid, uuid, uuid, integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.worker_roadmap_announcement_subscribers(uuid, uuid, uuid, integer) TO ludy_worker;

CREATE OR REPLACE FUNCTION crove_projects.worker_roadmap_subscriber_seal_unsub(
  p_org_id uuid,
  p_board_id uuid,
  p_subscriber_id uuid,
  p_unsub_token_sha256 text,
  p_unsub_token_sealed text,
  p_mail_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sealed text;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ROADMAP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_org_id IS NULL OR p_board_id IS NULL OR p_subscriber_id IS NULL
     OR p_unsub_token_sha256 IS NULL OR p_unsub_token_sha256 !~ '^[0-9a-f]{64}$'
     OR p_unsub_token_sealed IS NULL OR pg_catalog.btrim(p_unsub_token_sealed) = '' THEN
    RETURN NULL;
  END IF;

  UPDATE crove_projects.roadmap_subscriber s
  SET unsubscribe_token_sha256 = CASE
        WHEN s.unsub_token_sealed IS NULL THEN p_unsub_token_sha256
        ELSE s.unsubscribe_token_sha256
      END,
      unsub_token_sealed = COALESCE(s.unsub_token_sealed, p_unsub_token_sealed),
      mail_hash = CASE
        WHEN s.mail_hash IS NULL AND p_mail_hash IS NOT NULL AND p_mail_hash ~ '^[0-9a-f]{64}$'
          THEN p_mail_hash
        ELSE s.mail_hash
      END,
      updated_at = pg_catalog.now()
  WHERE s.org_id = p_org_id
    AND s.board_id = p_board_id
    AND s.id = p_subscriber_id
  RETURNING s.unsub_token_sealed INTO v_sealed;

  RETURN v_sealed;
END $$;

REVOKE ALL ON FUNCTION crove_projects.worker_roadmap_subscriber_seal_unsub(uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.worker_roadmap_subscriber_seal_unsub(uuid, uuid, uuid, text, text, text) TO ludy_worker;

-- System-actor-only helper used at mail send time by `projects.roadmap.shipped_mail_data` to read
-- a subscriber's sealed unsubscribe token (never email_sealed, never callable by user/agent actors).
CREATE OR REPLACE FUNCTION crove_projects.roadmap_subscriber_unsub_sealed(
  p_board_id uuid,
  p_subscriber_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_row record;
BEGIN
  IF v_org IS NULL
     OR p_board_id IS NULL
     OR p_subscriber_id IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT ludy_kernel.org_app_on(v_org, 'projects') THEN
    RETURN NULL;
  END IF;

  SELECT s.voter_email_hash, s.unsub_token_sealed
  INTO v_row
  FROM crove_projects.roadmap_subscriber s
  JOIN crove_projects.roadmap_board b
    ON b.org_id = s.org_id
   AND b.id = s.board_id
  WHERE s.org_id = v_org
    AND s.board_id = p_board_id
    AND s.id = p_subscriber_id
    AND s.notify_on_ship = true
    AND s.unsubscribed_at IS NULL
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

  IF NOT FOUND OR v_row.unsub_token_sealed IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'voterEmailHash', v_row.voter_email_hash,
    'unsubTokenSealed', v_row.unsub_token_sealed
  );
END $$;

REVOKE ALL ON FUNCTION crove_projects.roadmap_subscriber_unsub_sealed(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.roadmap_subscriber_unsub_sealed(uuid, uuid) TO ludy_tenant;
