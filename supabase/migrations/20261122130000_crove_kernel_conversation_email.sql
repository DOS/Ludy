-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: customer email as conversations in Hộp thư (issue #2439, docs/plan/conversations.md section 6.7). Idempotent; applied files stay untouched.
--
-- Email is a third kind of conversation, `email`, next to comment threads and private messages: a thread is the mails that name each other
-- in Message-ID, In-Reply-To and References, shown as chat bubbles; the stored body is text (HTML never reaches the database as markup).
--   1. The kind set of every table that carries it (the thread, its messages, attachments, drafts and the "is replying" marker) takes
--      'email'. The sets are replaced in place, validated afterwards so no table is locked for a scan.
--   2. conversation.subject: the line the sender wrote (personal data, classed pii in the manifest), shown in the thread header.
--   3. conversation_message.email_refs: the Message-IDs a mail names in In-Reply-To and References, ids and no text. A mail joins the
--      thread that holds any of them as external_message_id (the unique key of every channel), within one org and one channel.
--   4. conversation_access: an email thread is private like a direct message (mail to a business is private): owners and admins, and members
--      holding kernel.conversation.direct.read, within the channel limit. conversation_readers (the worker's notify list) already treats every
--      kind but a comment thread that way.
--   5. The conversation address (security review of #2528): its own random token on the tenant (conversation_token), apart from the document
--      address, so publishing it exposes nothing of the invoice reader and rotating it breaks no supplier. Issued by an owner or admin the first time
--      (conversation_address_issue), rotated by the owner (conversation_address_rotate, rate limited as the document address is), looked up by the
--      worker (org_by_conversation_token). Its tokens live in the same append-only ledger as the document tokens (inbound_address, a kind column), so a
--      token ever issued is never issued again and a retired one never routes. Its own daily budget: the metric conversation_emails.
--   6. conversation_message.sender_verified and conversation.sender_unverified: whether the receiving server vouched for the sender (SPF, DKIM or
--      DMARC), which decides whether a mail may join a thread by its References and bring a contact link with it.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (
        'crove_kernel.conversation'::regclass,
        'crove_kernel.conversation_message'::regclass,
        'crove_kernel.conversation_attachment'::regclass,
        'crove_kernel.conversation_draft'::regclass,
        'crove_kernel.conversation_composing'::regclass)
      AND pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((kind = ANY (ARRAY[''comment_thread''::text, ''direct''::text])))'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (kind IN (''comment_thread'', ''direct'', ''email'')) NOT VALID', r.tbl, r.conname);
    EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE crove_kernel.conversation ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE crove_kernel.conversation DROP CONSTRAINT IF EXISTS conversation_subject_length;
ALTER TABLE crove_kernel.conversation ADD CONSTRAINT conversation_subject_length CHECK (subject IS NULL OR pg_catalog.length(subject) BETWEEN 1 AND 300) NOT VALID;
ALTER TABLE crove_kernel.conversation VALIDATE CONSTRAINT conversation_subject_length;

ALTER TABLE crove_kernel.conversation_message ADD COLUMN IF NOT EXISTS email_refs text[] NOT NULL DEFAULT '{}';
ALTER TABLE crove_kernel.conversation_message DROP CONSTRAINT IF EXISTS conversation_message_email_refs_size;
ALTER TABLE crove_kernel.conversation_message ADD CONSTRAINT conversation_message_email_refs_size CHECK (pg_catalog.cardinality(email_refs) <= 50) NOT VALID;
ALTER TABLE crove_kernel.conversation_message VALIDATE CONSTRAINT conversation_message_email_refs_size;

CREATE OR REPLACE FUNCTION crove_kernel.conversation_access(p_kind text, p_connection_id uuid, p_write boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE crove_kernel.ctx_actor_type()
    WHEN 'system' THEN true
    WHEN 'user' THEN COALESCE((
      SELECT CASE
        WHEN m.role IN ('owner', 'admin') THEN true
        WHEN p_write AND m.role = 'viewer' THEN false
        WHEN p_kind IN ('direct', 'email') AND NOT crove_kernel.ctx_has_permission('kernel.conversation.direct.read') THEN false
        WHEN p_kind NOT IN ('direct', 'comment_thread', 'email') THEN false
        ELSE NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
          OR EXISTS (SELECT 1 FROM crove_kernel.channel_access a
                     WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.channel_connection_id = p_connection_id)
      END
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id()), false)
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) TO crove_tenant;

-- A reply to an email thread is a mail row that carries the customer's address and subject and the member's whole answer (to_address, subject, payload):
-- whoever may not read the thread may not read it there either. The thread's own message decides (its row is read under the conversation policies); the
-- system keeps its own access, and a mail of any other source is untouched.
DROP POLICY IF EXISTS mail_message_conversation_reply ON crove_kernel.mail_message;
CREATE POLICY mail_message_conversation_reply ON crove_kernel.mail_message AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (source IS DISTINCT FROM 'kernel.conversation.reply' OR crove_kernel.ctx_actor_type() = 'system'
         OR EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = mail_message.org_id AND m.id = mail_message.source_id))
  WITH CHECK (source IS DISTINCT FROM 'kernel.conversation.reply' OR crove_kernel.ctx_actor_type() = 'system'
         OR EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = mail_message.org_id AND m.id = mail_message.source_id));

-- Erasing or purging an email thread also drops the subject and the text of the replies sent on it (the guard lets a column only be nulled).
GRANT UPDATE (subject, payload) ON crove_kernel.mail_message TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Sender authentication (5)
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.conversation_message ADD COLUMN IF NOT EXISTS sender_verified boolean;
ALTER TABLE crove_kernel.conversation ADD COLUMN IF NOT EXISTS sender_unverified boolean NOT NULL DEFAULT false;
-- A mail the receiving server vouched for clears the mark.
GRANT UPDATE (sender_unverified) ON crove_kernel.conversation TO crove_tenant;

-- ---------------------------------------------------------------------------
-- The conversation address (own token, tombstones, rotation)
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.inbound_address ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'document';
ALTER TABLE crove_kernel.inbound_address DROP CONSTRAINT IF EXISTS inbound_address_kind_check;
ALTER TABLE crove_kernel.inbound_address ADD CONSTRAINT inbound_address_kind_check CHECK (kind IN ('document', 'conversation')) NOT VALID;
ALTER TABLE crove_kernel.inbound_address VALIDATE CONSTRAINT inbound_address_kind_check;
-- One active token per org and kind.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_address_active_kind_uq ON crove_kernel.inbound_address (org_id, kind) WHERE retired_at IS NULL;
DROP INDEX IF EXISTS crove_kernel.inbound_address_active_uq;

-- The guard keeps a ledger row's kind with its token: the one change allowed is retiring it.
CREATE OR REPLACE FUNCTION crove_kernel.inbound_address_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
     AND NEW.org_id = OLD.org_id AND NEW.id = OLD.id AND NEW.token = OLD.token AND NEW.created_at = OLD.created_at AND NEW.kind = OLD.kind THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'INBOUND_ADDRESS_TOMBSTONE' USING ERRCODE = '42501',
    DETAIL = 'inbound addresses are never deleted or changed; an active one may only be retired, once';
END $$;

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS conversation_token text;
ALTER TABLE crove_kernel.tenant DROP CONSTRAINT IF EXISTS tenant_conversation_token_format;
ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_conversation_token_format CHECK (conversation_token IS NULL OR conversation_token ~ '^[0-9a-f]{24}$') NOT VALID;
ALTER TABLE crove_kernel.tenant VALIDATE CONSTRAINT tenant_conversation_token_format;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_conversation_token_uq ON crove_kernel.tenant (conversation_token) WHERE conversation_token IS NOT NULL;

-- A tenant's conversation token is its active ledger row of kind conversation, and a tenant with such a row has that token (checked at commit, as the
-- document token is): a token set by hand, one nulled, or a retired one is refused. Both none is fine (the address is issued on first use).
CREATE OR REPLACE FUNCTION crove_kernel.tenant_conversation_token_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_token text;
  v_active text;
BEGIN
  SELECT t.conversation_token INTO v_token FROM crove_kernel.tenant t WHERE t.org_id = NEW.org_id;
  SELECT a.token INTO v_active FROM crove_kernel.inbound_address a WHERE a.org_id = NEW.org_id AND a.kind = 'conversation' AND a.retired_at IS NULL;
  IF v_token IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'CONVERSATION_TOKEN_NOT_ISSUED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_conversation_token_active ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_conversation_token_active
  AFTER INSERT OR UPDATE OF conversation_token ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_conversation_token_active();

-- The first token, for the org and user in context: an owner or admin, once (a later call returns the same token). The address exists only for an
-- org that opens the Inbox, so an org that never uses email has no extra ledger row.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_address_issue()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_token text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CONVERSATION_ADDRESS_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT t.conversation_token INTO v_token FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;
  v_token := NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.inbound_address (org_id, token, kind) VALUES (v_org, crove_kernel.random_token(), 'conversation')
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE crove_kernel.tenant SET conversation_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;

-- The document address's rotation retires only a document token (the conversation token has its own rotation).
CREATE OR REPLACE FUNCTION crove_kernel.inbound_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_total', true), '');
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_now timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_token text;
  v_active boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 3);
  v_total := COALESCE(v_total_raw::integer, 50);

  -- One lock per org, then the tenant row, both held until the transaction ends (locks taken in this block's
  -- subtransaction stay held after it commits). Both waits are bounded; a deadlock is refused the same way: a
  -- concurrent rotation with an idempotency key already holds a KEY SHARE lock on the tenant row (the foreign key of
  -- its idempotency_key row) while it waits here for the advisory lock, and the holder's FOR UPDATE waits for that
  -- KEY SHARE. The deadlock detector aborts one of the two, which then gets the same 429 busy answer.
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.inbound.rotate:' || v_org::text, 0));
    PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
    v_active := FOUND;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  IF NOT v_active THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT (pg_catalog.count(*) FILTER (WHERE a.retired_at IS NOT NULL))::integer,
         (pg_catalog.count(*) FILTER (WHERE a.retired_at > v_now - interval '24 hours'))::integer
    INTO v_all, v_recent
  FROM crove_kernel.inbound_address a
  WHERE a.org_id = v_org AND a.kind = 'document';
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    -- Room for one more opens when the per_day-th newest rotation in the window leaves it (also right when the
    -- limit was lowered below the number already in the window).
    SELECT a.retired_at INTO v_oldest
    FROM crove_kernel.inbound_address a
    WHERE a.org_id = v_org AND a.kind = 'document' AND a.retired_at > v_now - interval '24 hours'
    ORDER BY a.retired_at DESC
    OFFSET v_per_day - 1 LIMIT 1;
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'inbound_rotate_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - v_now)))::integer)::text;
  END IF;

  UPDATE crove_kernel.inbound_address SET retired_at = v_now WHERE org_id = v_org AND kind = 'document' AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES (v_org, crove_kernel.random_token())
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE crove_kernel.tenant SET inbound_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;

-- The conversation address's rotation: the same lock, owner check, rate limit and tombstone as the document address's, over its own ledger rows.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_address_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_total', true), '');
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_now timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_token text;
  v_active boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 3);
  v_total := COALESCE(v_total_raw::integer, 50);

  -- One lock per org, then the tenant row, both held until the transaction ends (locks taken in this block's
  -- subtransaction stay held after it commits). Both waits are bounded; a deadlock is refused the same way: a
  -- concurrent rotation with an idempotency key already holds a KEY SHARE lock on the tenant row (the foreign key of
  -- its idempotency_key row) while it waits here for the advisory lock, and the holder's FOR UPDATE waits for that
  -- KEY SHARE. The deadlock detector aborts one of the two, which then gets the same 429 busy answer.
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.conversation.address_rotate:' || v_org::text, 0));
    PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
    v_active := FOUND;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  IF NOT v_active THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT (pg_catalog.count(*) FILTER (WHERE a.retired_at IS NOT NULL))::integer,
         (pg_catalog.count(*) FILTER (WHERE a.retired_at > v_now - interval '24 hours'))::integer
    INTO v_all, v_recent
  FROM crove_kernel.inbound_address a
  WHERE a.org_id = v_org AND a.kind = 'conversation';
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    -- Room for one more opens when the per_day-th newest rotation in the window leaves it (also right when the
    -- limit was lowered below the number already in the window).
    SELECT a.retired_at INTO v_oldest
    FROM crove_kernel.inbound_address a
    WHERE a.org_id = v_org AND a.kind = 'conversation' AND a.retired_at > v_now - interval '24 hours'
    ORDER BY a.retired_at DESC
    OFFSET v_per_day - 1 LIMIT 1;
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'inbound_rotate_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - v_now)))::integer)::text;
  END IF;

  UPDATE crove_kernel.inbound_address SET retired_at = v_now WHERE org_id = v_org AND kind = 'conversation' AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.inbound_address (org_id, token, kind) VALUES (v_org, crove_kernel.random_token(), 'conversation')
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE crove_kernel.tenant SET conversation_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;

-- The worker's resolver of the conversation address: the token's ledger row must be active, so a retired token never routes.
CREATE OR REPLACE FUNCTION crove_kernel.org_by_conversation_token(p_token text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id
  FROM crove_kernel.tenant t
  JOIN crove_kernel.inbound_address a ON a.org_id = t.org_id AND a.token = t.conversation_token AND a.kind = 'conversation' AND a.retired_at IS NULL
  WHERE t.conversation_token = pg_catalog.lower(p_token) AND t.status = 'active'
$$;

-- EXECUTE matrix: the API issues and rotates, the worker resolves, the trigger function is callable by nobody. Ownership as the document address's rotation.
REVOKE ALL ON FUNCTION crove_kernel.tenant_conversation_token_active() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.conversation_address_issue() FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.conversation_address_rotate() FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.org_by_conversation_token(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_address_issue() TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_address_rotate() TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.org_by_conversation_token(text) TO crove_worker;

DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_definer_tenant;
ALTER FUNCTION crove_kernel.inbound_rotate() OWNER TO crove_definer_tenant;
ALTER FUNCTION crove_kernel.conversation_address_issue() OWNER TO crove_definer_tenant;
ALTER FUNCTION crove_kernel.conversation_address_rotate() OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.inbound_rotate() FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_rotate() TO crove_app;
-- The definer reads the tenant row and the ledger and updates the tenant's conversation token (its owner holds these already for the document token).
GRANT UPDATE (conversation_token) ON crove_kernel.tenant TO crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The daily budget of customer mail, apart from the invoice reader's
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.org_usage DROP CONSTRAINT IF EXISTS org_usage_metric_check;
ALTER TABLE crove_kernel.org_usage ADD CONSTRAINT org_usage_metric_check CHECK (metric IN ('inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost', 'conversation_emails')) NOT VALID;
ALTER TABLE crove_kernel.org_usage VALIDATE CONSTRAINT org_usage_metric_check;
ALTER TABLE crove_kernel.usage_deferral DROP CONSTRAINT IF EXISTS usage_deferral_metric_check;
ALTER TABLE crove_kernel.usage_deferral ADD CONSTRAINT usage_deferral_metric_check
  CHECK (metric IN ('inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost', 'ai_budget', 'conversation_emails')) NOT VALID;
ALTER TABLE crove_kernel.usage_deferral VALIDATE CONSTRAINT usage_deferral_metric_check;
