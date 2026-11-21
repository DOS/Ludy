-- SPDX-License-Identifier: AGPL-3.0-only
-- The org purge no longer pays quadratic work for the taint keys of deleted quote lines (issue #4168, item 1, from the security review of #4162 / #4149).
-- crove_kernel.mcp_origin_keep_line_taint() (20270123300000) appends the md5 of each deleted tainted line to the transaction-local setting `crove.tainted_line_keys` and copies and scans that setting on every
-- row. A draft save is bounded at 100 lines, but the org purge deletes every quote line of the org in one statement, so an org with a few hundred thousand distinct tainted lines made the work grow quadratically
-- and could pass the purge's 30-minute statement timeout. The keys exist so that a replacement inserted in the same transaction with the same text stays tainted (the person's save of a draft quote replaces
-- its lines whole). The system context (the purge, the retention jobs) inserts no replacement lines, so it records no key at all: the trigger returns at once for a system actor. Every other actor (a person,
-- an app's engage write, an agent) keeps the keys exactly as before (a draft save is bounded at 100 lines, and a person's delete stays within one deal or party). The body is otherwise the one of 20270123300000; signature, owner and privileges are unchanged.
-- Idempotent (create or replace); applied files untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.mcp_origin_keep_line_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_keys text;
BEGIN
  IF OLD.tainted AND crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    v_keys := COALESCE(pg_catalog.current_setting('crove.tainted_line_keys', true), '');
    v_key := pg_catalog.md5(OLD.description || pg_catalog.chr(1) || COALESCE(OLD.unit, ''));
    IF pg_catalog.strpos(',' || v_keys || ',', ',' || v_key || ',') = 0 THEN
      PERFORM pg_catalog.set_config('crove.tainted_line_keys', v_keys || ',' || v_key, true);
    END IF;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_origin_keep_line_taint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_origin_keep_line_taint() TO crove_tenant;
