-- SPDX-License-Identifier: AGPL-3.0-only
-- An origin mark and a taint mark on what a connected coworker writes (#4149, found in the security review of #3861; ADR-0051 decision 8: the agent's output is tainted data). Until now a note, a deal, a quote,
-- a contact and a timeline row that Dy wrote were stored under the name of the person who connected the app and looked like that person's own words. Now the database marks them, from the sealed context and never
-- from anything a caller sends:
--   actor_origin  'mcp' (written in the sealed engage write context of a connected app) or 'ui' (NOT a connected app: a person's own act, and also what an org-chart agent or the system writes; every row that existed
--                 took it), on crove_kernel.conversation_note, crove_kernel.party, crove_crm.deal, crove_crm.quote, crove_crm.quote_line and crove_kernel.activity (a timeline row);
--   tainted       on the five tables that hold text: true whenever the text may be the agent's: a row made in the engage context, a deal whose title or lost reason, or a quote the engage context changed (a draft
--                 quote's save replaces its remarks, terms and lines), and a quote line (or a revision of a quote) whose text is the text of a tainted line or quote: the taint follows the text, so a line a person copies from a
--                 coworker's quote keeps it, and a line they rewrite does not. It is never lowered by an update: a person who rewrites a note or a deal keeps the mark until they decide what to do with it in the app.
-- CHECK: a row of origin 'mcp' is tainted. The columns are no tenant role's to write (the tenant has column-level INSERT and UPDATE grants, and these are not among them, except where it holds a table-level grant,
-- where the triggers below overwrite what a statement names), so the only way to set one is a trigger, which reads the context through crove_kernel.ctx_mcp_engage_write() (the policies' own question: it names no
-- kind of its own). The triggers are ENABLE ALWAYS (a replica session does not skip them) and named so that they fire after agent_write_guard (alphabetical), which therefore judges the statement the command wrote,
-- not the mark. Idempotent; applied files untouched.
SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module the mark belongs to the table of the line that owns the row and ships with the one write that needs it (#4149, ADR-0051 decision 8).
ALTER TABLE crove_crm.deal ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote_line ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.conversation_note ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.party ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.activity ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui';

-- The checks, added NOT VALID (they bind every new or changed row at once); the next migration validates them in a transaction of its own, so the scan of each table does not run under the lock the added
-- columns take (no existing row can fail them: every row took the defaults).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crove_crm.deal', 'crove_crm.quote', 'crove_crm.quote_line', 'crove_kernel.conversation_note', 'crove_kernel.party'] LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT mcp_origin_ck CHECK (actor_origin IN (''ui'', ''mcp'') AND (actor_origin <> ''mcp'' OR tainted)) NOT VALID', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
  BEGIN
    ALTER TABLE crove_kernel.activity ADD CONSTRAINT mcp_origin_ck CHECK (actor_origin IN ('ui', 'mcp')) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- The stamps
-- ---------------------------------------------------------------------------
-- A row made in the engage write context is the connected app's and tainted; every other row is not a connected app's ('ui': a person's, the system's, an org-chart agent's) and is not marked, whatever a caller
-- sent, but for the text it copies (below).
CREATE OR REPLACE FUNCTION crove_kernel.mcp_origin_stamp_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_mcp_engage_write() THEN
    NEW.actor_origin := 'mcp';
    NEW.tainted := true;
  ELSE
    NEW.actor_origin := 'ui';
    NEW.tainted := false;
    -- A person's revision of a quote copies its text: it is the person's quote, and the text keeps the mark of the quote it came from (a coworker's text stays marked through a revision).
    IF TG_TABLE_NAME = 'quote' THEN
      -- A nested test: plpgsql may evaluate both sides of an AND, and only a quote has revises_id.
      IF NEW.revises_id IS NOT NULL THEN
        NEW.tainted := COALESCE((SELECT q.tainted OR EXISTS (SELECT 1 FROM crove_crm.quote_line l WHERE l.org_id = q.org_id AND l.quote_id = q.id AND l.tainted)
                                 FROM crove_crm.quote q WHERE q.org_id = NEW.org_id AND q.id = NEW.revises_id), false);
      END IF;
    ELSIF TG_TABLE_NAME = 'quote_line' THEN
      -- The taint follows the text: a line whose text (description and unit) is the text of a tainted line of the org (a line copied into a revision, picked from an earlier quote or taken from a hint, all of
      -- which a person saves as a new line) is tainted, though a person saves it; a line they type or rewrite is not. The row stays the person's (origin 'ui').
      NEW.tainted := EXISTS (SELECT 1 FROM crove_crm.quote_line l WHERE l.org_id = NEW.org_id AND l.tainted AND l.description = NEW.description AND l.unit IS NOT DISTINCT FROM NEW.unit);
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_origin_stamp_insert() FROM PUBLIC;

-- An update never changes where a row came from and never lowers the taint. A deal the engage context changes becomes tainted when its text changes (the title or the lost reason; a move of stage
-- or order writes no text); a quote it changes becomes tainted whatever it changes (every change of a draft quote is a save of its text, terms, lines or totals).
CREATE OR REPLACE FUNCTION crove_kernel.mcp_origin_stamp_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_text_changed boolean;
BEGIN
  NEW.actor_origin := OLD.actor_origin;
  NEW.tainted := OLD.tainted;
  IF crove_kernel.ctx_mcp_engage_write() THEN
    IF TG_TABLE_NAME = 'deal' THEN
      -- Clearing a lost reason (a deal moved back to an open stage) writes no text; a new or changed one does.
      v_text_changed := NEW.title IS DISTINCT FROM OLD.title OR (NEW.lost_reason IS NOT NULL AND NEW.lost_reason IS DISTINCT FROM OLD.lost_reason);
    ELSE
      v_text_changed := true;
    END IF;
    IF v_text_changed THEN
      NEW.tainted := true;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_origin_stamp_update() FROM PUBLIC;

-- The update stamp of a table with no taint column (a timeline row), and of the rows nothing in the engage context updates (a note, a contact): the origin never changes and the taint is kept, so a statement that names
-- a mark changes nothing.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_origin_keep_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.actor_origin := OLD.actor_origin;
  IF TG_TABLE_NAME <> 'activity' THEN
    NEW.tainted := OLD.tainted;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_origin_keep_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_stamp_insert() TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_stamp_update() TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_keep_update() TO crove_tenant;

-- migration-lint: cross-module the stamp is installed on the table of the line that owns the row (#4149).
DROP TRIGGER IF EXISTS mcp_origin_stamp ON crove_crm.deal;
-- migration-lint: cross-module see above.
CREATE TRIGGER mcp_origin_stamp BEFORE INSERT ON crove_crm.deal FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_insert();
-- migration-lint: cross-module see above.
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_crm.deal;
-- migration-lint: cross-module see above.
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_crm.deal FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_update();
-- migration-lint: cross-module see above.
DROP TRIGGER IF EXISTS mcp_origin_stamp ON crove_crm.quote;
-- migration-lint: cross-module see above.
CREATE TRIGGER mcp_origin_stamp BEFORE INSERT ON crove_crm.quote FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_insert();
-- migration-lint: cross-module see above.
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_crm.quote;
-- migration-lint: cross-module see above.
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_crm.quote FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_update();
-- migration-lint: cross-module see above.
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_crm.quote_line;
-- migration-lint: cross-module see above (the tenant holds a table-level UPDATE on the lines, so an update must not move the mark).
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_crm.quote_line FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_update();
-- migration-lint: cross-module see above.
DROP TRIGGER IF EXISTS mcp_origin_stamp ON crove_crm.quote_line;
-- migration-lint: cross-module see above.
CREATE TRIGGER mcp_origin_stamp BEFORE INSERT ON crove_crm.quote_line FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_insert();
DROP TRIGGER IF EXISTS mcp_origin_stamp ON crove_kernel.conversation_note;
CREATE TRIGGER mcp_origin_stamp BEFORE INSERT ON crove_kernel.conversation_note FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_insert();
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_kernel.conversation_note;
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_kernel.conversation_note FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_keep_update();
DROP TRIGGER IF EXISTS mcp_origin_stamp ON crove_kernel.party;
CREATE TRIGGER mcp_origin_stamp BEFORE INSERT ON crove_kernel.party FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_stamp_insert();
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_kernel.party;
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_kernel.party FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_keep_update();
DROP TRIGGER IF EXISTS mcp_origin_stamp_update ON crove_kernel.activity;
CREATE TRIGGER mcp_origin_stamp_update BEFORE UPDATE ON crove_kernel.activity FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_origin_keep_update();

-- Always on, whatever session_replication_role a session runs under (a replica session must not skip a stamp), as quote_guard is.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS t, g.tgname FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
           WHERE g.tgname IN ('mcp_origin_stamp', 'mcp_origin_stamp_update') AND NOT g.tgisinternal LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', r.t, r.tgname);
  END LOOP;
END $$;

-- The text a person copies finds its tainted source by the text; a partial index keeps that look-up to the tainted lines.
-- migration-lint: cross-module the look-up belongs to the lines' table and ships with the stamp that asks it (#4149).
CREATE INDEX IF NOT EXISTS quote_line_tainted_text_idx ON crove_crm.quote_line (org_id, description) WHERE tainted;

-- A timeline row written in the engage context is the connected app's: the person's name stays as its actor (the grant is no org-chart agent), and the mark says an app made it. activity_stamp_agent restated
-- whole from 20270122190000 with the one new assignment.
CREATE OR REPLACE FUNCTION crove_kernel.activity_stamp_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
BEGIN
  NEW.actor_origin := 'ui';
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'actor' = 'agent' THEN
    IF v_ctx ->> 'kind' = 'member_vy' THEN
      RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'crove_kernel.activity';
    END IF;
    IF v_ctx ->> 'kind' IN ('mcp_engage_write', 'mcp_ads_draft') AND v_ctx ->> 'grantor' IS NOT NULL THEN
      -- A connected app's entry is the person's who connected it (the grant is no org-chart agent, so no agent id fits), marked as the app's; the audit row of the call names the grant, client and agent.
      NEW.agent_id := NULL;
      NEW.actor_id := (v_ctx ->> 'grantor')::uuid;
      NEW.actor_origin := 'mcp';
      RETURN NEW;
    END IF;
    NEW.agent_id := (v_ctx ->> 'agent')::uuid;
    NEW.actor_id := NULL;
  ELSE
    NEW.agent_id := NULL;
  END IF;
  RETURN NEW;
END $$;
