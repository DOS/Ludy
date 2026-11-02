-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W1 (issue #2295, plan docs/plan/ads-write.md sections 3.2, 9 and 10, ADR-0043): the campaign draft, the plan an owner or admin builds and
-- submits for approval. Nothing here calls a platform and nothing spends: a draft is local until W2 launches an approved one. Idempotent; applied
-- files stay untouched.
--
-- crove_ads.ad_campaign_draft  one row is one campaign with its ad set and its ad (the lean first slice: one ad set, one ad with one to three text
--                              variants; objectives traffic, engagement and messenger; location, age, gender and interests; automatic placements;
--                              a daily budget and an end date). A draft in progress needs only a name and an objective: every other plan column
--                              is filled in as it is built, and local validation (in the module) says what is missing. Its legal entity is its
--                              ad account's (trigger b_legal_entity and the composite foreign key, as ad_spend_day) and it sits under the same
--                              RESTRICTIVE le_scope policy. Statuses: draft, approved (by the execution of an approved ads.campaign.launch
--                              proposal and nothing else) and discarded; W2 adds the launch states with its own migration. Money is numeric in the
--                              account's currency; the largest amount the plan can spend (`max_spend`, the daily budget times the days of the
--                              flight) is stored with the draft and is what the approval signs.
--
-- crove_ads.campaign_draft_guard  holds the draft whatever path reaches it (fired for every role, the table's owner included): a draft is born
--                              as a draft; the plan and the status of an approved or discarded draft never change; a draft with a request for
--                              approval waiting in the Inbox is frozen (no plan change and no discarding: a change after the request is a new
--                              request); the status becomes `approved` only inside the execution of an approved proposal of
--                              ads.campaign.launch that names this draft, its revision and its largest amount (crove_ads.approved_execution),
--                              and the guard stamps the proposal and the time; every change of the plan raises the revision and stamps who and
--                              when, whatever the writer sent.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_campaign_draft (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 200),
  objective text NOT NULL CHECK (objective IN ('traffic', 'engagement', 'messenger')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'discarded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- The account's currency, from the account (never a column here): a budget is a decimal in its own units, above zero.
  daily_budget numeric CHECK (daily_budget IS NULL OR (daily_budget > 0 AND daily_budget < 'Infinity'::numeric AND daily_budget <> 'NaN'::numeric)),
  start_on date,
  end_on date,
  -- Locations, age range, gender and interests: a known set of keys, validated by the command and the contract.
  targeting jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(targeting) = 'object'),
  link_url text CHECK (link_url IS NULL OR pg_catalog.length(link_url) <= 2000),
  -- The Facebook Page of a Messenger ad (a channel connection of the org), the Social post the creative came from (its id only: no foreign key
  -- between module schemas) and a file of the media library.
  page_connection_id uuid,
  source_post_id uuid,
  media_file_id uuid,
  -- One to three text variants of the one ad: headline, primary text, call to action.
  variants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(variants) = 'array' AND pg_catalog.jsonb_array_length(variants) <= 3),
  -- Who wrote it, and the plan fields the AI coworker wrote and a person has not changed since (each is marked as drafted and stays editable).
  origin text NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'ai')),
  ai_fields text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (pg_catalog.cardinality(ai_fields) <= 20),
  max_spend numeric CHECK (max_spend IS NULL OR (max_spend >= 0 AND max_spend < 'Infinity'::numeric AND max_spend <> 'NaN'::numeric)),
  -- Set by the guard when the draft is approved: the approved proposal and the time.
  proposal_id uuid,
  approved_at timestamptz,
  created_by uuid NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_campaign_draft_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ad_campaign_draft_page_fk FOREIGN KEY (org_id, page_connection_id)
    REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT ad_campaign_draft_media_fk FOREIGN KEY (org_id, media_file_id)
    REFERENCES crove_kernel.file (org_id, id),
  -- An approved draft names its proposal and its time, and no other draft does.
  CONSTRAINT ad_campaign_draft_approved_ck CHECK ((status = 'approved') = (proposal_id IS NOT NULL AND approved_at IS NOT NULL))
);
-- The builder lists an account's drafts, newest first; the other two are the foreign keys' own indexes.
CREATE INDEX IF NOT EXISTS ad_campaign_draft_account_idx ON crove_ads.ad_campaign_draft (org_id, ad_account_id, legal_entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ad_campaign_draft_page_idx ON crove_ads.ad_campaign_draft (org_id, page_connection_id) WHERE page_connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_campaign_draft_media_idx ON crove_ads.ad_campaign_draft (org_id, media_file_id) WHERE media_file_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_campaign_draft');
-- A draft is discarded, never deleted by a tenant role (the org purge deletes it with the account); tenant roles update the plan, the status and who
-- changed it, never the keys.
REVOKE UPDATE, DELETE ON crove_ads.ad_campaign_draft FROM crove_tenant;
GRANT UPDATE (name, objective, status, revision, daily_budget, start_on, end_on, targeting, link_url, page_connection_id, source_post_id, media_file_id, variants, origin, ai_fields, max_spend, proposal_id, approved_at, updated_by, updated_at)
  ON crove_ads.ad_campaign_draft TO crove_tenant;

-- The legal entity scope, as the other ads tables (20261115120000): an actor reads and writes only the entities its sealed context names.
DROP POLICY IF EXISTS le_scope ON crove_ads.ad_campaign_draft;
CREATE POLICY le_scope ON crove_ads.ad_campaign_draft AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_campaign_draft;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_campaign_draft FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_campaign_draft ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_ads.campaign_draft_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_pending boolean;
  v_proposal uuid;
  v_plan_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A draft is born a draft, with its time and its author stamped here, whatever the writer sent.
    IF NEW.status <> 'draft' OR NEW.proposal_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'ADS_DRAFT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    NEW.created_by := COALESCE(v_user, NEW.created_by);
    NEW.updated_by := NULL;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  -- The one change that is not a writer's: the cascade of the account's legal entity (ON UPDATE CASCADE of the account's foreign key, when the
  -- account moves to another entity), which alters nothing else; tenant roles have no UPDATE grant on the column. It passes for a draft in any
  -- state, so moving an account is never blocked by a draft that is over.
  IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id AND (pg_catalog.to_jsonb(NEW) - 'legal_entity_id') = (pg_catalog.to_jsonb(OLD) - 'legal_entity_id') THEN
    RETURN NEW;
  END IF;
  -- A draft belongs to its account for good, and an approved or discarded one is over.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.ad_account_id IS DISTINCT FROM OLD.ad_account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADS_DRAFT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'ADS_DRAFT_FROZEN' USING ERRCODE = '42501';
  END IF;
  -- Who wrote it never changes, and a person's edit can only take a field off the list of the ones the AI coworker drafted.
  IF NEW.origin IS DISTINCT FROM OLD.origin OR NOT (NEW.ai_fields <@ OLD.ai_fields) THEN
    RAISE EXCEPTION 'ADS_DRAFT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_plan_changed := ROW(NEW.name, NEW.objective, NEW.daily_budget, NEW.start_on, NEW.end_on, NEW.targeting, NEW.link_url, NEW.page_connection_id, NEW.source_post_id, NEW.media_file_id, NEW.variants, NEW.max_spend)
    IS DISTINCT FROM ROW(OLD.name, OLD.objective, OLD.daily_budget, OLD.start_on, OLD.end_on, OLD.targeting, OLD.link_url, OLD.page_connection_id, OLD.source_post_id, OLD.media_file_id, OLD.variants, OLD.max_spend);
  IF NEW.status = 'approved' THEN
    -- Only the execution of the approved proposal of this very plan: its draft, its revision and its largest amount. The plan does not move.
    IF v_plan_changed OR NEW.revision IS DISTINCT FROM OLD.revision OR OLD.max_spend IS NULL
       OR NOT crove_ads.approved_execution('ads.campaign.launch', pg_catalog.jsonb_build_object('draftId', OLD.id::text, 'revision', OLD.revision), OLD.max_spend) THEN
      RAISE EXCEPTION 'ADS_DRAFT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT p.id INTO v_proposal FROM crove_kernel.proposal p
    WHERE p.org_id = OLD.org_id AND p.command = 'ads.campaign.launch' AND p.status = 'approved' AND p.payload @> pg_catalog.jsonb_build_object('draftId', OLD.id::text, 'revision', OLD.revision)
    ORDER BY p.id DESC LIMIT 1;
    NEW.proposal_id := v_proposal;
    NEW.approved_at := pg_catalog.clock_timestamp();
    NEW.updated_by := v_user;
    NEW.updated_at := NEW.approved_at;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('draft', 'discarded') OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'ADS_DRAFT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A request for approval waiting in the Inbox freezes the draft: what the approver is shown is what runs.
  IF v_plan_changed OR NEW.status = 'discarded' THEN
    SELECT EXISTS (
      SELECT 1 FROM crove_kernel.proposal p
      WHERE p.org_id = OLD.org_id AND p.command = 'ads.campaign.launch' AND p.status = 'pending' AND p.payload @> pg_catalog.jsonb_build_object('draftId', OLD.id::text)
    ) INTO v_pending;
    IF v_pending THEN
      RAISE EXCEPTION 'ADS_DRAFT_SUBMITTED' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- Every change of the plan is a new revision, stamped with who and when.
  NEW.revision := CASE WHEN v_plan_changed THEN OLD.revision + 1 ELSE OLD.revision END;
  NEW.updated_by := v_user;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.campaign_draft_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS campaign_draft_guard ON crove_ads.ad_campaign_draft;
CREATE TRIGGER campaign_draft_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_campaign_draft FOR EACH ROW EXECUTE FUNCTION crove_ads.campaign_draft_guard();
ALTER TABLE crove_ads.ad_campaign_draft ENABLE ALWAYS TRIGGER campaign_draft_guard;
