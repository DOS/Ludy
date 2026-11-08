-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 stage B precondition (#2756): a member_vy_result belongs to its member's own run and lives at most 31 days.
--   member_vy_result_bind  BEFORE INSERT: the run's agent is a member_vy agent of the same member, and
--                          expires_at <= created_at + 31 days. The store command enforces the same; the database refuses the rest.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_result_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.ai_run r
    JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
    WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND a.kind = 'member_vy' AND a.member_user_id = NEW.member_user_id) THEN
    -- Worded as the row-level refusal it is (a result is the member's alone), with the reason in the hint.
    RAISE EXCEPTION 'new row violates row-level security policy for table "member_vy_result"' USING ERRCODE = '42501', HINT = 'MEMBER_VY_RESULT_RUN_MISMATCH';
  END IF;
  IF NEW.expires_at > NEW.created_at + interval '31 days' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_EXPIRY_TOO_LONG' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_result_bind() FROM PUBLIC;
DROP TRIGGER IF EXISTS member_vy_result_bind ON crove_kernel.member_vy_result;
CREATE TRIGGER member_vy_result_bind BEFORE INSERT ON crove_kernel.member_vy_result
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_result_bind();
