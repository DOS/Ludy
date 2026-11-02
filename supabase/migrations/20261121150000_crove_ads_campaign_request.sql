-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W1b (issue #2295, plan docs/plan/ads-write.md section 10, ADR-0043): a member's request to the AI coworker for a campaign draft, the
-- state of that request, and the queue of the job that answers it. Nothing here calls a platform and nothing spends: the answer is a draft that a
-- person reads, edits and submits like one they wrote. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_campaign_request  one row is one ask: the member's brief and objective for one ad account (their own words, at most 1000 characters,
--                              never a customer's), in the account's legal entity (trigger b_legal_entity, composite foreign key and the same
--                              RESTRICTIVE le_scope policy as the drafts). States: requested (waiting for the job), written (the system stored a
--                              draft and names it) and none (no draft, with a code that says why: the AI is off, the org's AI budget or limit is
--                              spent, the org is rationed, the model failed or its answer did not pass the checks). The member sees the code, so a refusal is never
--                              silent. At most one request waits per member: the command holds it (under an advisory lock of the member), not a unique index, so
--                              the row policies' matrix can insert freely and a request cannot be piled up into model spend.
--
-- crove_ads.campaign_request_guard  holds the row whatever path reaches it: a request is born waiting, in the name of the member who asks (an agent
--                              never writes one); only the system settles it, once (requested to written, naming an AI draft of the same account and member, or
--                              requested to none with a code), and a settled request never changes. A database owner's own statement has no
--                              context and is not held to it (the sweep and the org purge run that way).
--
-- crove_ads.campaign_request_sweep  the sweep run by the worker whether or not a model is configured: a request the job never answered (older than
--                              15 minutes) is settled as none with the code EXPIRED, so the member can ask again.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_campaign_request (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  objective text NOT NULL CHECK (objective IN ('traffic', 'engagement', 'messenger')),
  -- What the member wants to promote, in their words (a Social post's text may be pasted here by the builder); the Social post it came from is kept
  -- by id only (no foreign key between module schemas).
  brief text NOT NULL CHECK (pg_catalog.length(brief) BETWEEN 1 AND 1000),
  source_post_id uuid,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'written', 'none')),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  draft_id uuid,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_campaign_request_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ad_campaign_request_draft_fk FOREIGN KEY (org_id, draft_id)
    REFERENCES crove_ads.ad_campaign_draft (org_id, id),
  -- A request is settled exactly when it is not waiting, it names a draft exactly when it was written, and it has a code exactly when it was not.
  CONSTRAINT ad_campaign_request_settled_ck CHECK ((state = 'requested') = (settled_at IS NULL)),
  CONSTRAINT ad_campaign_request_written_ck CHECK ((state = 'written') = (draft_id IS NOT NULL)),
  CONSTRAINT ad_campaign_request_none_ck CHECK ((state = 'none') = (code IS NOT NULL))
);
-- The builder lists an account's requests, newest first (also the account foreign key's index); the draft foreign key's own index.
CREATE INDEX IF NOT EXISTS ad_campaign_request_account_idx ON crove_ads.ad_campaign_request (org_id, ad_account_id, legal_entity_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS ad_campaign_request_draft_idx ON crove_ads.ad_campaign_request (org_id, draft_id) WHERE draft_id IS NOT NULL;
-- The sweep looks for the requests still waiting.
CREATE INDEX IF NOT EXISTS ad_campaign_request_waiting_idx ON crove_ads.ad_campaign_request (requested_at) WHERE state = 'requested';

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_campaign_request');
-- A request is never deleted by a tenant role (the org purge deletes it with the account); the system settles it, so tenant roles may update the
-- settling columns only and the guard decides who.
REVOKE UPDATE, DELETE ON crove_ads.ad_campaign_request FROM crove_tenant;
GRANT UPDATE (state, code, draft_id, settled_at) ON crove_ads.ad_campaign_request TO crove_tenant;

DROP POLICY IF EXISTS le_scope ON crove_ads.ad_campaign_request;
CREATE POLICY le_scope ON crove_ads.ad_campaign_request AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_campaign_request;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_campaign_request FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_campaign_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_ads.campaign_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row for another org is the tenant policy's to refuse (its own message), not this guard's.
    IF crove_kernel.ctx_org_id() IS NOT NULL AND NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    -- A request is born waiting, in the name of the member who asks, stamped here whatever the writer sent. Only a member (or the system, which the RLS
    -- matrix's own-org control needs to be able to insert and which no command does) writes one; an agent never does.
    IF v_actor IS NOT NULL AND v_actor NOT IN ('user', 'system') THEN
      RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only a member asks for a draft';
    END IF;
    IF NEW.state <> 'requested' OR NEW.code IS NOT NULL OR NEW.draft_id IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a request is born waiting';
    END IF;
    NEW.requested_by := COALESCE(v_user, NEW.requested_by);
    -- In the name of a member of the org: a member's own id is stamped above, and the system's insert must name one (the database owner's own statement
    -- has no context and no org to check against, so it is held only to being born waiting).
    IF v_actor = 'system' AND NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.requested_by) THEN
      RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a request is made in the name of a member of the org';
    END IF;
    NEW.requested_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;
  -- The one change that is not a writer's: the cascade of the account's legal entity (ON UPDATE CASCADE of the account's foreign key), which
  -- alters nothing else; tenant roles have no UPDATE grant on the column.
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id') THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.ad_account_id, NEW.objective, NEW.brief, NEW.source_post_id, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.ad_account_id, OLD.objective, OLD.brief, OLD.source_post_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a request keeps its account, its brief and its author';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'requested' THEN
    RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a settled request never changes';
  END IF;
  -- Only the system settles it (a database owner's statement has no context and is not held here).
  IF v_actor IS NOT NULL AND v_actor <> 'system' THEN
    RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the system settles a request';
  END IF;
  IF NEW.state = 'written' THEN
    -- It names an AI draft of the same account that the same member asked for.
    IF NOT EXISTS (
      SELECT 1 FROM crove_ads.ad_campaign_draft d
      WHERE d.org_id = NEW.org_id AND d.id = NEW.draft_id AND d.ad_account_id = NEW.ad_account_id AND d.origin = 'ai' AND d.created_by = NEW.requested_by
    ) THEN
      RAISE EXCEPTION 'ADS_REQUEST_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a written request names an AI draft of its account and its author';
    END IF;
  END IF;
  NEW.settled_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.campaign_request_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS campaign_request_guard ON crove_ads.ad_campaign_request;
CREATE TRIGGER campaign_request_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_campaign_request FOR EACH ROW EXECUTE FUNCTION crove_ads.campaign_request_guard();
ALTER TABLE crove_ads.ad_campaign_request ENABLE ALWAYS TRIGGER campaign_request_guard;

-- The sweep of requests the job never answered, run by the worker with or without a model: older than 15 minutes, settled as none (EXPIRED) so the
-- member can ask again. Answers how many.
CREATE OR REPLACE FUNCTION crove_ads.campaign_request_sweep() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_settled integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_campaign_request r SET state = 'none', code = 'EXPIRED'
  WHERE r.state = 'requested' AND r.requested_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15);
  GET DIAGNOSTICS v_settled = ROW_COUNT;
  RETURN v_settled;
END $$;
REVOKE ALL ON FUNCTION crove_ads.campaign_request_sweep() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.campaign_request_sweep() TO crove_worker;

-- The job's queue: ids only in its data (the brief is read from the row, not carried).
SELECT crove_jobs.create_queue('ads-campaign-draft', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
