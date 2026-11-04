-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2502, ADR-0044 points 3 to 5, plan einvoice-issue.md): what it takes to issue a sales e-invoice. Idempotent; applied files stay untouched.
-- Nothing here calls a provider: a draft is asked for approval, and the approved execution moves it to `submitting`, where the job of the next step picks it up.
--
-- einvoice_draft            new columns, all written by the system context only: the number, the time and the authority code the provider gave, the signed XML and the
--                           PDF it returned (files of the org), the error code of a refusal, when the invoice was submitted, when it is to be asked about next and how many
--                           times it was. The guard (replaced below) holds each move of the state machine and which columns it may change.
-- einvoice_content_hash     the SHA-256 of everything an invoice is issued from (entity, series, date, currency, buyer, totals, every line), computed from the stored rows. The
--                           preparer puts it in the proposal; the definer below compares it again, so an invoice changed after it was asked for cannot be issued.
-- approved_execution        true only while the statement runs inside the execution of an approved proposal of this org, for exactly this command, decided by the signed-in
--                           user of this context in this very transaction, whose payload names what is being written (the model is crove_ads.approved_execution).
-- einvoice_submit           the one way a person moves a draft to `submitting`. A definer owned by a role of its own (crove_definer_einvoice, no login), EXECUTE for the API login only. It
--                           requires the approved execution of finance.einvoice.issue for this draft, this content hash and this total, locks the draft before it reads it, and sets
--                           the state and the submit time, nothing else; the draft guard admits that one move from that owner and from no one else.
-- einvoice_draft_line_guard replaced to take the draft FOR KEY SHARE, so a line cannot be written between the definer's read of the lines and its commit (the definer holds the
--                           draft FOR UPDATE).
-- The approval policy of finance.einvoice.issue is in 20261122190000_crove_kernel_approval_policy_einvoice.sql, a crove_kernel migration.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Columns of the draft
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS issued_number text CHECK (issued_number IS NULL OR char_length(issued_number) BETWEEN 1 AND 50);
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS authority_code text CHECK (authority_code IS NULL OR char_length(authority_code) BETWEEN 1 AND 100);
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS signed_file_id uuid;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS pdf_file_id uuid;
-- A code, never a provider's message.
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,59}$');
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS next_check_at timestamptz;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS check_attempts integer NOT NULL DEFAULT 0 CHECK (check_attempts >= 0);
-- The channel connection the draft was SENT through, written by the job at its first send and never changed (a clean slate empties it with the key): asking about the invoice,
-- polling it and fetching its files go through this connection and no other, so a second connection of the entity (another seller tax code) can never answer "unknown" for
-- an invoice the first one holds. A plain id, no foreign key: the connection may be gone, and the draft is then held, never released and never sent again.
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS channel_connection_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_signed_file_fk' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_signed_file_fk FOREIGN KEY (org_id, signed_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE SET NULL (signed_file_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_pdf_file_fk' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_pdf_file_fk FOREIGN KEY (org_id, pdf_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE SET NULL (pdf_file_id);
  END IF;
  -- An issued invoice has its number and the time it was issued; a draft that has left `draft` was submitted.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_issued_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_issued_check CHECK (state <> 'issued' OR (issued_number IS NOT NULL AND issued_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_submitted_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_submitted_check CHECK (state IN ('draft', 'rejected') OR submitted_at IS NOT NULL);
  END IF;
END $$;
-- The foreign keys (G3 fk-index).
CREATE INDEX IF NOT EXISTS einvoice_draft_signed_file_idx ON crove_finance.einvoice_draft (org_id, signed_file_id) WHERE signed_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS einvoice_draft_pdf_file_idx ON crove_finance.einvoice_draft (org_id, pdf_file_id) WHERE pdf_file_id IS NOT NULL;
-- The sweep of invoices to ask the provider about.
CREATE INDEX IF NOT EXISTS einvoice_draft_check_idx ON crove_finance.einvoice_draft (next_check_at) WHERE state IN ('submitting', 'pending') AND next_check_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The content an invoice is issued from, as one hash
-- ---------------------------------------------------------------------------
-- Runs as the caller, so it reads the draft and its lines through the caller's own policies; null when the draft is not visible. Every figure is read as text from its
-- column, whose scale is fixed, so the same rows always give the same text. The fields are the items of a JSON array (a string is quoted and escaped there), so no text, a
-- control character in it included, can move a boundary from one field to the next without changing the hash.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_content_hash(p_org uuid, p_draft uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      d.legal_entity_id::text, COALESCE(d.series_id::text, ''), d.invoice_date::text, d.currency, d.buyer_kind,
      COALESCE(d.buyer_tax_code, ''), COALESCE(d.buyer_name, ''), COALESCE(d.buyer_address, ''), COALESCE(d.buyer_email, ''),
      d.subtotal::text, d.vat_amount::text, d.total::text,
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(l.line_no::text, l.description, COALESCE(l.unit, ''), l.quantity::text, l.unit_price::text, l.amount::text, l.vat_rate, l.vat_amount::text)
          ORDER BY l.line_no)
        FROM crove_finance.einvoice_draft_line l WHERE l.org_id = d.org_id AND l.draft_id = d.id), '[]'::pg_catalog.jsonb))::text,
    'UTF8')), 'hex')
  FROM crove_finance.einvoice_draft d
  WHERE d.org_id = p_org AND d.id = p_draft
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. The approved execution
-- ---------------------------------------------------------------------------
-- The same test as crove_ads.approved_execution, for a finance command. Answers true only while the statement runs inside the execution of an approved proposal: a
-- proposal of the org in context, for exactly this command, in the state `approved` (which the runtime never commits: it is `executed` by the end of the transaction that
-- approved it), at revision 1, decided by the signed-in user of this context in this very transaction, whose payload names the change being written. The system and agent
-- contexts never pass. A raw statement outside that transaction finds no `approved` row; one inside it can write only the change the approver was shown.
CREATE OR REPLACE FUNCTION crove_finance.approved_execution(p_command text, p_match jsonb DEFAULT NULL, p_amount numeric DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.proposal p
    WHERE p.org_id = crove_kernel.ctx_org_id()
      AND p.command = p_command
      AND p.status = 'approved'
      AND p.revision = 1
      AND p.executed_command_id IS NOT NULL
      AND crove_kernel.ctx_actor_type() = 'user'
      AND p.decided_by IS NOT NULL
      AND p.decided_by = crove_kernel.ctx_user_id()
      AND p.decided_at = pg_catalog.now()
      AND (p_match IS NULL OR p.payload @> p_match)
      AND (p_amount IS NULL OR (p.payload ->> 'amount')::numeric = p_amount)
  )
$$;
REVOKE ALL ON FUNCTION crove_finance.approved_execution(text, jsonb, numeric) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. The role and the definer that move a draft to `submitting`
-- ---------------------------------------------------------------------------
-- A role of its own that owns this one function and nothing else. It is a member of crove_tenant, so tenant RLS still applies inside the function (the org in context, the
-- member's role), and it holds no privilege the tenant role lacks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crove_definer_einvoice') THEN
    CREATE ROLE crove_definer_einvoice NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- Drift guard (as crove_definer_tenant has): the guard trusts the identity of this role, so a role of the name that was made another way is refused, not adopted.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'crove_definer_einvoice'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR NOT rolinherit)
  ) THEN
    RAISE EXCEPTION 'role crove_definer_einvoice must be NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END $$;
GRANT crove_tenant TO crove_definer_einvoice;
GRANT EXECUTE ON FUNCTION crove_finance.approved_execution(text, jsonb, numeric) TO crove_definer_einvoice;

CREATE OR REPLACE FUNCTION crove_finance.einvoice_submit(p_draft uuid, p_content_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_draft crove_finance.einvoice_draft%ROWTYPE;
BEGIN
  -- A signed-in owner or admin of the org in context: the agent and system contexts never issue, and the approval below says the same again.
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'EINVOICE_ISSUE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The draft is locked before anything about it is read (and its lines are written under a KEY SHARE of it), so what is hashed below is what is committed.
  SELECT * INTO v_draft FROM crove_finance.einvoice_draft d WHERE d.org_id = v_org AND d.id = p_draft FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EINVOICE_ISSUE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_draft.state <> 'draft' OR v_draft.series_id IS NULL THEN
    RAISE EXCEPTION 'EINVOICE_ISSUE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_content_hash IS NULL OR crove_finance.einvoice_content_hash(v_org, p_draft) IS DISTINCT FROM p_content_hash THEN
    RAISE EXCEPTION 'EINVOICE_CONTENT_CHANGED' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_finance.approved_execution('finance.einvoice.issue', pg_catalog.jsonb_build_object('draftId', p_draft::text, 'contentHash', p_content_hash), v_draft.total) THEN
    RAISE EXCEPTION 'EINVOICE_ISSUE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The state and the submit time, and a refusal's old code cleared: the draft guard admits exactly this change from this owner.
  UPDATE crove_finance.einvoice_draft d
     SET state = 'submitting', submitted_at = pg_catalog.clock_timestamp(), error_code = NULL, updated_at = pg_catalog.now()
   WHERE d.org_id = v_org AND d.id = p_draft;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_submit(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_submit(uuid, text) TO crove_app;

-- Owned by the role above (the grants are set first and carry over). A runner that is not a superuser (hosted PostgreSQL) may only hand a function to a role it can SET ROLE to,
-- and the new owner needs CREATE on the schema while the ownership moves; that CREATE is revoked right after.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_einvoice TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_finance TO crove_definer_einvoice;
ALTER FUNCTION crove_finance.einvoice_submit(uuid, text) OWNER TO crove_definer_einvoice;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_einvoice;

-- ---------------------------------------------------------------------------
-- 5. The draft guard, with the new columns and the one move a person's approved issue makes
-- ---------------------------------------------------------------------------
-- The state machine of a draft (ADR-0044 point 4). Runs as the writer.
--   A person (any non-system writer) edits a draft and nothing else: it cannot choose the key, change the state, the key, the provider's reference or any column of the
--   issue (number, time, authority code, files, error code, submit time, next check, attempts), and it cannot touch or delete a draft that has left `draft`. The one
--   exception is the move draft -> submitting by crove_finance.einvoice_submit, recognized by the role that owns that function: it changes the state, the submit time (set from
--   empty), the error code (cleared) and the time touched, and nothing else.
--   The system context (the issue job) moves a draft along these transitions and no others, each raising EINVOICE_STATE otherwise:
--     draft -> submitting (not by the system: the person's approved issue above); submitting -> pending, issued, rejected or failed; pending -> issued, rejected or failed;
--     rejected -> draft (a new key, no provider reference, no submit time, a clean slate); failed -> draft only for a code that says nothing was sent (a tax code, a
--     connection, a credential refused before the send), the same clean slate and a new key. A failed invoice whose fate is not known (STATUS_UNKNOWN) stays failed.
--   `issued` is terminal (only its two file links and an error code are added after it). Once a draft has left `draft` its content (series, date, buyer, amounts) is frozen for the system context too. A transition changes the state, the
--   provider's reference, the number, the time issued, the authority code and the two files (each set once, from empty), the error code, the next check time, the attempts
--   count, and on rejected -> draft the key.
--   Whoever the writer is, a draft that has left `draft` is deleted only by the org's purge.
--   The foreign keys' own action (a member, a party or a file removed) only empties `created_by`, `buyer_party_id`, `signed_file_id` or `pdf_file_id`, whatever the state and the writer.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_system boolean := (SELECT crove_kernel.ctx_actor_type()) = 'system';
  v_move text;
  -- Everything a transition may touch besides the state: compared as a whole, with the columns that have their own rule taken out below.
  v_free text[] := ARRAY['state', 'provider_ref', 'idempotency_key', 'updated_at', 'issued_number', 'issued_at', 'authority_code', 'signed_file_id', 'pdf_file_id', 'error_code', 'submitted_at', 'next_check_at', 'check_attempts', 'channel_connection_id'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_catalog.to_jsonb(NEW) - ARRAY['created_by', 'buyer_party_id', 'signed_file_id', 'pdf_file_id'] = pg_catalog.to_jsonb(OLD) - ARRAY['created_by', 'buyer_party_id', 'signed_file_id', 'pdf_file_id']
     AND (NEW.created_by IS NULL OR NEW.created_by IS NOT DISTINCT FROM OLD.created_by)
     AND (NEW.buyer_party_id IS NULL OR NEW.buyer_party_id IS NOT DISTINCT FROM OLD.buyer_party_id)
     -- The evidence links are emptied only by the foreign key's own action (a trigger inside a trigger), never by a statement a person or the job writes.
     AND (NEW.signed_file_id IS NOT DISTINCT FROM OLD.signed_file_id OR (NEW.signed_file_id IS NULL AND pg_catalog.pg_trigger_depth() > 1))
     AND (NEW.pdf_file_id IS NOT DISTINCT FROM OLD.pdf_file_id OR (NEW.pdf_file_id IS NULL AND pg_catalog.pg_trigger_depth() > 1)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'draft' THEN
      RETURN OLD;
    END IF;
    -- The org's purge, and only it (the checks of crove_kernel.purge_append_only_guard): the role that owns org_purge, the transaction-local mark it sets
    -- around these deletes, the worker login in the org's system context, the org offboarding. Nested, so every other caller meets only the catalog checks.
    IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure)
       AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text THEN
      IF pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
         AND crove_kernel.ctx_actor_type() = 'system'
         AND crove_kernel.ctx_org_id() = OLD.org_id
         AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION '%', CASE WHEN v_system THEN 'EINVOICE_STATE' ELSE 'EINVOICE_NOT_DRAFT' END USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.provider_ref IS NOT NULL
       OR NEW.issued_number IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.authority_code IS NOT NULL OR NEW.signed_file_id IS NOT NULL OR NEW.pdf_file_id IS NOT NULL
       OR NEW.error_code IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.next_check_at IS NOT NULL OR NEW.check_attempts <> 0 OR NEW.channel_connection_id IS NOT NULL THEN
      RAISE EXCEPTION '%', CASE WHEN v_system THEN 'EINVOICE_STATE' ELSE 'EINVOICE_NOT_DRAFT' END USING ERRCODE = '42501';
    END IF;
    -- The key is the database's, never a person's.
    IF NOT v_system THEN
      NEW.idempotency_key := pg_catalog.gen_random_uuid();
    END IF;
    RETURN NEW;
  END IF;

  -- An update.
  IF NOT v_system THEN
    -- The person's approved issue: the one move draft -> submitting, by the owner of crove_finance.einvoice_submit and no one else.
    IF OLD.state = 'draft' AND NEW.state = 'submitting' THEN
      IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) IS DISTINCT FROM (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_finance.einvoice_submit(uuid, text)'::pg_catalog.regprocedure) THEN
        RAISE EXCEPTION 'EINVOICE_FIELD_LOCKED' USING ERRCODE = '42501';
      END IF;
      IF pg_catalog.to_jsonb(NEW) - ARRAY['state', 'submitted_at', 'error_code', 'updated_at'] <> pg_catalog.to_jsonb(OLD) - ARRAY['state', 'submitted_at', 'error_code', 'updated_at']
         OR OLD.submitted_at IS NOT NULL OR NEW.submitted_at IS NULL OR NEW.error_code IS NOT NULL OR NEW.series_id IS NULL THEN
        RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
      END IF;
      -- The role's identity is not the approval: the same approved execution the definer tests, for this draft and its total, is required here too, so a session that can act as
      -- the role still cannot move a draft to `submitting` without the approval the database can see.
      IF NOT crove_finance.approved_execution('finance.einvoice.issue', pg_catalog.jsonb_build_object('draftId', NEW.id::text), NEW.total) THEN
        RAISE EXCEPTION 'EINVOICE_FIELD_LOCKED' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.issued_number IS DISTINCT FROM OLD.issued_number OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.authority_code IS DISTINCT FROM OLD.authority_code
       OR NEW.signed_file_id IS DISTINCT FROM OLD.signed_file_id OR NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.next_check_at IS DISTINCT FROM OLD.next_check_at OR NEW.check_attempts IS DISTINCT FROM OLD.check_attempts
       OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id THEN
      RAISE EXCEPTION 'EINVOICE_FIELD_LOCKED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'issued' THEN
    -- Terminal: only the evidence is added after it, once the files are fetched and stored: the two file links (each set once, from empty) and the error code of that step.
    IF NEW.state = 'issued'
       AND pg_catalog.to_jsonb(NEW) - ARRAY['signed_file_id', 'pdf_file_id', 'error_code', 'updated_at'] = pg_catalog.to_jsonb(OLD) - ARRAY['signed_file_id', 'pdf_file_id', 'error_code', 'updated_at']
       AND (OLD.signed_file_id IS NULL OR NEW.signed_file_id IS NOT DISTINCT FROM OLD.signed_file_id)
       AND (OLD.pdf_file_id IS NULL OR NEW.pdf_file_id IS NOT DISTINCT FROM OLD.pdf_file_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  IF NEW.state = OLD.state THEN
    -- No move. A draft is edited (its key, reference and issue columns stay); any other state changes only what a poll changes: the error code, the next check
    -- time, the attempts, and the time touched.
    IF OLD.state = 'draft' THEN
      IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
         OR NEW.issued_number IS DISTINCT FROM OLD.issued_number OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.authority_code IS DISTINCT FROM OLD.authority_code
         OR NEW.signed_file_id IS DISTINCT FROM OLD.signed_file_id OR NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
         OR NEW.next_check_at IS DISTINCT FROM OLD.next_check_at OR NEW.check_attempts IS DISTINCT FROM OLD.check_attempts OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id THEN
        RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
      END IF;
    ELSIF pg_catalog.to_jsonb(NEW) - ARRAY['updated_at', 'error_code', 'next_check_at', 'check_attempts', 'channel_connection_id'] <> pg_catalog.to_jsonb(OLD) - ARRAY['updated_at', 'error_code', 'next_check_at', 'check_attempts', 'channel_connection_id']
          -- The connection of the first send is set once, from empty.
          OR (OLD.channel_connection_id IS NOT NULL AND NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id) THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  v_move := OLD.state || '>' || NEW.state;
  -- draft -> submitting is the person's approved issue, never the system's.
  IF v_move NOT IN ('submitting>pending', 'submitting>issued', 'submitting>rejected', 'submitting>failed', 'pending>issued', 'pending>rejected', 'pending>failed',
                    'failed>draft', 'rejected>draft') THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  -- A failed draft goes back only when nothing was sent: the codes of what stopped it before the send.
  IF v_move = 'failed>draft' AND (OLD.error_code IS NULL OR OLD.error_code <> ALL (ARRAY['PROVIDER_NOT_READY', 'TAX_CODE_NEEDED', 'SELLER_TAX_CODE_CHANGED', 'DRAFT_MISMATCH', 'CREDENTIALS', 'PROVIDER_UNAVAILABLE'])) THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  -- And only when the ledger agrees nothing was sent: the issue call of the old key is absent or failed, never started, ambiguous or succeeded.
  IF v_move = 'failed>draft' AND EXISTS (
       SELECT 1 FROM crove_kernel.external_call c WHERE c.org_id = OLD.org_id AND c.key = 'einvoice:issue:' || OLD.idempotency_key::text AND c.state <> 'failed') THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  -- The content stays as it was.
  IF pg_catalog.to_jsonb(NEW) - v_free <> pg_catalog.to_jsonb(OLD) - v_free THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  -- The fields set once, from empty: the provider's reference, the number, the time issued, the authority code and the two files.
  IF (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
     OR (OLD.issued_number IS NOT NULL AND NEW.issued_number IS DISTINCT FROM OLD.issued_number)
     OR (OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at)
     OR (OLD.authority_code IS NOT NULL AND NEW.authority_code IS DISTINCT FROM OLD.authority_code)
     OR (OLD.signed_file_id IS NOT NULL AND NEW.signed_file_id IS DISTINCT FROM OLD.signed_file_id)
     OR (OLD.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id)
     OR (OLD.channel_connection_id IS NOT NULL AND NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id) THEN
    IF v_move NOT IN ('rejected>draft', 'failed>draft') THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_move IN ('rejected>draft', 'failed>draft') THEN
    -- A fresh key and a clean slate: no reference, number, time, authority code, file, submit time, next check or attempt of the rejected try (the error code stays, so
    -- the person sees why it was rejected until the next issue clears it).
    IF NEW.idempotency_key = OLD.idempotency_key OR NEW.provider_ref IS NOT NULL OR NEW.issued_number IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.authority_code IS NOT NULL
       OR NEW.signed_file_id IS NOT NULL OR NEW.pdf_file_id IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.next_check_at IS NOT NULL OR NEW.check_attempts <> 0 OR NEW.channel_connection_id IS NOT NULL THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- The same key, and the submit time as it was.
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
    -- An issued invoice has its number and time (the table's check says so too); the files only come with a number.
    IF NEW.state <> 'issued' AND (NEW.issued_number IS DISTINCT FROM OLD.issued_number OR NEW.issued_at IS DISTINCT FROM OLD.issued_at) THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- A line is written only while its draft is a draft, whoever writes it, the system context included (the issue job changes the draft's state, never its lines); a
-- line of a draft that has left `draft` is deleted only by the org's purge. Runs as the writer, which reads the draft through its own policies. The draft is read FOR KEY SHARE
-- (in id order), so a line written while a person's approved issue holds the draft FOR UPDATE waits for it and then sees `submitting`.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The org's purge, and only it (the checks of crove_kernel.purge_append_only_guard): the role that owns org_purge, the transaction-local mark it sets
    -- around these deletes, the worker login in the org's system context, the org offboarding. Nested, so every other caller meets only the catalog checks.
    IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure)
       AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text THEN
      IF pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
         AND crove_kernel.ctx_actor_type() = 'system'
         AND crove_kernel.ctx_org_id() = OLD.org_id
         AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  -- The draft a line is in now (OLD on an update or a delete) and the one it is going to (NEW on an insert or an update): a line of a draft that has left
  -- `draft` can neither be changed nor be moved to another draft, and no line can be added to one that has.
  FOR v_state IN
    SELECT d.state FROM crove_finance.einvoice_draft d
    WHERE d.org_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.org_id ELSE OLD.org_id END
      AND d.id IN (CASE WHEN TG_OP = 'INSERT' THEN NEW.draft_id ELSE OLD.draft_id END, CASE WHEN TG_OP = 'DELETE' THEN OLD.draft_id ELSE NEW.draft_id END)
    ORDER BY d.id
    FOR KEY SHARE OF d
  LOOP
    -- A line whose draft is gone (the cascade of a draft's own delete) or not visible is not for this guard to judge.
    IF v_state <> 'draft' THEN
      RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
