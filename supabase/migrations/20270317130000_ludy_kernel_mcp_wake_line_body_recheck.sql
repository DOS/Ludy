-- SPDX-License-Identifier: AGPL-3.0-only
-- Wake delivery: re-check a line body when the row's own ids change (#4026, review of #4025; defense in depth, no login can do it).
-- The body check of a delivery of a line's type runs in the trigger agent_wake_delivery_line_body, which since 20270119160000 fires on `INSERT OR UPDATE OF body, type`. The body must carry the ids of its own row
-- (id, org, grant), so an update of `id`, `org_id` or `grant_id` alone, by the table owner, left a line body naming ids the row no longer has. The trigger now fires on those three columns as well. The fixed types
-- (signal, schedule, ping, minutes) are covered already: their CHECK (agent_wake_delivery_body_fixed) re-runs on every update of a row.
-- The other half of #4026 (a body without `created_at` passing mcp_wake_body_ok, because `jsonb_typeof(NULL) <> 'string'` is NULL) was fixed for every type when 20270209120000 restated the function with
-- `IS DISTINCT FROM 'string'`; this migration does not restate it, and test/invariant/mcp-wake-delivery.db.test.ts and mcp-wake-line-events.db.test.ts now pin the missing key for every type.
-- The trigger function is unchanged. Idempotent (drop and create). Pinned in test/invariant/mcp-wake-line-events.db.test.ts.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS agent_wake_delivery_line_body ON ludy_kernel.agent_wake_delivery;
CREATE TRIGGER agent_wake_delivery_line_body BEFORE INSERT OR UPDATE OF id, org_id, grant_id, body, type ON ludy_kernel.agent_wake_delivery
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.agent_wake_delivery_line_body();
