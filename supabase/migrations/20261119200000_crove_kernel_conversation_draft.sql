-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations CV8 (issue #2310, plan docs/plan/conversations.md sections 5.6 and 9, ADR-0041 section 8): Vy's reply drafts and
-- the saved replies. Idempotent; applied files stay untouched.
--
-- Who writes a draft. The system context, never an org-chart agent: a worker job reads the thread, calls the model over the customer's text
-- (tainted external text) and records the draft through a system command, so ADR-0029's agent write allowlist is unchanged (an agent context
-- is refused by crove_kernel.agent_write_guard, which apply_tenant_rls installs on every new table, and crove_kernel.conversation_access
-- returns false for an agent). A person only asks for one ("Vy soạn": a row in state requested) and decides about it (used or discarded); the
-- text and the tainted mark are the system's alone, enforced by crove_kernel.conversation_draft_guard.
--
-- crove_kernel.saved_reply         an org's saved text for a common answer, with the words it answers (keywords). The org's own text, read by every
--                                  member, written by owners, admins and members (never a viewer or an agent).
-- crove_kernel.conversation_draft  at most one live draft per conversation (a partial unique index over requested and live). requested: a person or the
--                                  relay asked and the job has not answered; live: the draft text is there (body), always tainted; used: the person
--                                  sent a reply that began from it (body dropped; the lengths and the size of the edit are kept for later learning,
--                                  never the text); discarded: a person dismissed it, the model gave none or the job was lost; stale: a newer
--                                  customer message arrived. The body exists only while the draft is live, so a retention purge or an erasure has
--                                  little to delete, and ON DELETE CASCADE from the thread takes the rest.
-- crove_kernel.conversation_setting.auto_draft   whether Vy drafts when a new conversation arrives (default on; owners and admins change it).
-- crove_kernel.conversation_draft_due            the worker's list of new conversations to draft for (worker login only); it also settles a request the job
--                                  never answered.
-- Queue kernel-conversation-draft: the draft job, ids only in its data.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Saved replies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.saved_reply (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 100),
  -- At most what a Zalo message takes (the smallest limit of the providers).
  body text NOT NULL CHECK (pg_catalog.length(body) BETWEEN 1 AND 2000),
  -- The words the reply answers ("giá", "địa chỉ"), matched against the customer's text with no diacritics and no case.
  keywords text[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(keywords) <= 20),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT saved_reply_author_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS saved_reply_author_idx ON crove_kernel.saved_reply (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.saved_reply');
REVOKE UPDATE ON crove_kernel.saved_reply FROM crove_tenant;
GRANT UPDATE (title, body, keywords, use_count, updated_at) ON crove_kernel.saved_reply TO crove_tenant;
-- Every member of the org reads them; owners, admins and members write them (a viewer and an agent do not).
DROP POLICY IF EXISTS saved_reply_insert ON crove_kernel.saved_reply;
CREATE POLICY saved_reply_insert ON crove_kernel.saved_reply AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = saved_reply.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS saved_reply_update ON crove_kernel.saved_reply;
CREATE POLICY saved_reply_update ON crove_kernel.saved_reply AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = saved_reply.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = saved_reply.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS saved_reply_delete ON crove_kernel.saved_reply;
CREATE POLICY saved_reply_delete ON crove_kernel.saved_reply AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = saved_reply.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- ---------------------------------------------------------------------------
-- Whether Vy drafts when a new conversation arrives
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.conversation_setting ADD COLUMN IF NOT EXISTS auto_draft boolean NOT NULL DEFAULT true;
GRANT UPDATE (auto_draft) ON crove_kernel.conversation_setting TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.conversation_draft (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  conversation_id uuid NOT NULL,
  -- The thread's own channel and kind, so the database decides who reads a draft by the same rule as its thread.
  channel_connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_thread', 'direct')),
  -- The thread's last message when the draft was asked for: a draft answers that message, and a newer one makes it stale.
  basis_seq integer NOT NULL CHECK (basis_seq >= 1),
  source text NOT NULL CHECK (source IN ('auto', 'asked')),
  requested_by uuid,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'live', 'used', 'discarded', 'stale')),
  -- Vy's text, only while the draft is live: tainted external-derived text, personal data of a third party.
  body text CHECK (body IS NULL OR pg_catalog.length(body) BETWEEN 1 AND 2000),
  -- A draft is always tainted: it came from a model reading a customer's text, and a person reads it before it goes.
  tainted boolean NOT NULL DEFAULT true CHECK (tainted),
  -- What became of a draft a person used: its length, the length of what was sent and the size of the edit between them (characters). Never text.
  draft_length integer CHECK (draft_length IS NULL OR draft_length >= 0),
  final_length integer CHECK (final_length IS NULL OR final_length >= 0),
  edit_size integer CHECK (edit_size IS NULL OR edit_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  written_at timestamptz,
  decided_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT conversation_draft_thread_fk FOREIGN KEY (org_id, conversation_id, channel_connection_id, kind)
    REFERENCES crove_kernel.conversation (org_id, id, channel_connection_id, kind) ON DELETE CASCADE,
  CONSTRAINT conversation_draft_requester_fk FOREIGN KEY (org_id, requested_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (requested_by),
  CONSTRAINT conversation_draft_body CHECK ((state = 'live') = (body IS NOT NULL)),
  CONSTRAINT conversation_draft_used CHECK (state <> 'used' OR (draft_length IS NOT NULL AND final_length IS NOT NULL AND edit_size IS NOT NULL))
);
-- At most one draft in play per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_draft_open_uq ON crove_kernel.conversation_draft (org_id, conversation_id) WHERE state IN ('requested', 'live');
CREATE INDEX IF NOT EXISTS conversation_draft_thread_idx ON crove_kernel.conversation_draft (org_id, conversation_id, basis_seq);
CREATE INDEX IF NOT EXISTS conversation_draft_requester_idx ON crove_kernel.conversation_draft (org_id, requested_by) WHERE requested_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.conversation_draft');
REVOKE UPDATE ON crove_kernel.conversation_draft FROM crove_tenant;
GRANT UPDATE (state, body, draft_length, final_length, edit_size, written_at, decided_at) ON crove_kernel.conversation_draft TO crove_tenant;
-- Read by those who read the thread (its channel limit and the direct-message permission included); written by those who may write it. What
-- each may write is the guard's: the text and the move to live are the system's alone.
DROP POLICY IF EXISTS conversation_draft_scope ON crove_kernel.conversation_draft;
CREATE POLICY conversation_draft_scope ON crove_kernel.conversation_draft AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.conversation_access(kind, channel_connection_id, false))
  WITH CHECK (crove_kernel.conversation_access(kind, channel_connection_id, true));
-- A draft row is removed by the system (a thread's deletion cascades past this policy), never by a member.
DROP POLICY IF EXISTS conversation_draft_delete ON crove_kernel.conversation_draft;
CREATE POLICY conversation_draft_delete ON crove_kernel.conversation_draft AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system');

-- What a person and what the system may write of a draft. A person asks (a row requested, no text, theirs) and decides (a live draft becomes used,
-- with its lengths, or discarded; a request they made may be discarded); the system writes the text (requested to live), settles what the job
-- could not answer and marks a draft stale. Nothing else, and a decided draft is final. A database owner's own statement has no context and is
-- not held to it.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row for another org is the tenant policy's to refuse (its own message), not this guard's.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF v_actor IS NOT DISTINCT FROM 'user'
       AND (NEW.state <> 'requested' OR NEW.body IS NOT NULL OR NEW.source <> 'asked' OR NEW.requested_by IS DISTINCT FROM crove_kernel.ctx_user_id()) THEN
      RAISE EXCEPTION 'DRAFT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member only asks for a draft: a request in their own name, with no text';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.conversation_id, NEW.channel_connection_id, NEW.kind, NEW.basis_seq, NEW.source, NEW.requested_by, NEW.tainted, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.conversation_id, OLD.channel_connection_id, OLD.kind, OLD.basis_seq, OLD.source, OLD.requested_by, OLD.tainted, OLD.created_at) THEN
    RAISE EXCEPTION 'DRAFT_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a draft keeps its thread, its basis and its taint';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state IN ('used', 'discarded', 'stale') THEN
    RAISE EXCEPTION 'DRAFT_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a decided draft never changes';
  END IF;
  IF v_actor IS NOT DISTINCT FROM 'user' THEN
    -- A person decides: a live draft is used (with its lengths) or discarded, a request is discarded; never text, never live.
    IF NEW.state NOT IN ('used', 'discarded') OR NEW.body IS NOT NULL OR NEW.written_at IS DISTINCT FROM OLD.written_at
       OR (NEW.state = 'discarded' AND (NEW.draft_length IS NOT NULL OR NEW.final_length IS NOT NULL OR NEW.edit_size IS NOT NULL))
       OR (NEW.state = 'used' AND OLD.state <> 'live') THEN
      RAISE EXCEPTION 'DRAFT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member decides about a draft; the text is the system''s';
    END IF;
  ELSIF v_actor IS NOT DISTINCT FROM 'system' THEN
    IF NEW.state = 'live' AND OLD.state <> 'requested' THEN
      RAISE EXCEPTION 'DRAFT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only a requested draft becomes live';
    END IF;
  ELSIF v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'DRAFT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'no actor but a member or the system writes a draft';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_draft_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS conversation_draft_guard ON crove_kernel.conversation_draft;
CREATE TRIGGER conversation_draft_guard BEFORE INSERT OR UPDATE ON crove_kernel.conversation_draft
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.conversation_draft_guard();

-- ---------------------------------------------------------------------------
-- The new conversations to draft for (worker login only)
-- ---------------------------------------------------------------------------
-- First a request the job never answered (older than 15 minutes) is settled as discarded, so the conversation can be asked about again. Then the
-- conversations of active orgs on an active connection that are new (the customer wrote last), whose org has not turned drafting off, whose last
-- customer message is less than 48 hours old and is not removed, and which have no draft in play and no draft decided for that very message (a
-- dismissed or failed draft is not made again until the customer writes again). The oldest first, at most p_limit.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_draft_due(p_limit integer)
RETURNS TABLE (org_id uuid, conversation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.conversation_draft d SET state = 'discarded', decided_at = pg_catalog.now()
  WHERE d.state = 'requested' AND d.created_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15);
  RETURN QUERY
  SELECT c.org_id, c.id
  FROM crove_kernel.conversation c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.channel_connection_id AND ch.status = 'active'
  LEFT JOIN crove_kernel.conversation_setting s ON s.org_id = c.org_id
  WHERE c.status = 'new' AND c.last_seq >= 1 AND COALESCE(s.auto_draft, true)
    AND c.last_inbound_at > pg_catalog.now() - pg_catalog.make_interval(hours => 48)
    AND EXISTS (SELECT 1 FROM crove_kernel.conversation_message m
                WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.seq = c.last_seq AND m.direction = 'in' AND m.platform_removed_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM crove_kernel.conversation_draft d
                    WHERE d.org_id = c.org_id AND d.conversation_id = c.id AND (d.state IN ('requested', 'live') OR d.basis_seq >= c.last_seq))
  ORDER BY c.last_inbound_at, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_draft_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_draft_due(integer) TO crove_worker;

-- The draft job's queue: ids only in its data (the thread's text is read from the rows, not carried).
SELECT crove_jobs.create_queue('kernel-conversation-draft', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
