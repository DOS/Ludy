-- SPDX-License-Identifier: AGPL-3.0-only
-- An origin mark and a taint mark on what a connected coworker writes (#4149, found in the security review of #3861; ADR-0051 decision 8: the agent's output is tainted data). Until now a note, a deal, a quote
-- and a timeline row that Dy wrote were stored under the name of the person who connected the app and looked like that person's own words. Now the database marks them, from the sealed context and never from
-- anything a caller sends:
--   actor_origin  'ui' (a person's own act, and every row there was) or 'mcp' (written in the sealed engage write context of a connected app), on crove_kernel.conversation_note, crove_crm.deal,
--                 crove_crm.quote, crove_crm.quote_line and crove_kernel.activity (a timeline row);
--   tainted       on the four tables that hold text: true whenever the text may be the agent's: a row made in the engage context, and a deal whose title or lost reason, or a quote the engage context changed
--                 (a draft quote's save replaces its remarks, terms and lines). It is never lowered: a person who rewrites the text sees the mark stay until they decide what to do with it in the app.
-- CHECK: a row of origin 'mcp' is tainted. The columns are no tenant role's to write (the tenant has column-level INSERT and UPDATE grants, and these are not among them), so the only way to set one is the
-- trigger below, which reads the context through crove_kernel.ctx_mcp_engage_write() (the policies' own question: it names no kind of its own). The triggers are named so that they fire after
-- agent_write_guard (alphabetical), which therefore judges the statement the command wrote, not the mark. Idempotent; applied files untouched.
SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module the mark belongs to the table of the line that owns the row and ships with the one write that needs it (#4149, ADR-0051 decision 8).
ALTER TABLE crove_crm.deal ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote_line ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.conversation_note ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui', ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.activity ADD COLUMN IF NOT EXISTS actor_origin text NOT NULL DEFAULT 'ui';

-- The checks, added NOT VALID and validated after (no existing row can fail them: every row took the defaults).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crove_crm.deal', 'crove_crm.quote', 'crove_crm.quote_line', 'crove_kernel.conversation_note'] LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT mcp_origin_ck CHECK (actor_origin IN (''ui'', ''mcp'') AND (actor_origin <> ''mcp'' OR tainted)) NOT VALID', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT mcp_origin_ck', t);
  END LOOP;
  BEGIN
    ALTER TABLE crove_kernel.activity ADD CONSTRAINT mcp_origin_ck CHECK (actor_origin IN ('ui', 'mcp')) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  ALTER TABLE crove_kernel.activity VALIDATE CONSTRAINT mcp_origin_ck;
END $$;

-- ---------------------------------------------------------------------------
-- The stamps
-- ---------------------------------------------------------------------------
-- A row made in the engage write context is the connected app's and tainted; every other row is a person's (or the system's) and is not marked, whatever a caller sent.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_origin_stamp_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_mcp_engage_write() THEN
    NEW.actor_origin := 'mcp';
    NEW.tainted := true;
  ELSE
    NEW.actor_origin := 'ui';
    NEW.tainted := false;
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
      v_text_changed := NEW.title IS DISTINCT FROM OLD.title OR NEW.lost_reason IS DISTINCT FROM OLD.lost_reason;
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
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_stamp_insert() TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_stamp_update() TO crove_tenant;

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
