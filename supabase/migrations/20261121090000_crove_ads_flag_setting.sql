-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads (issue #2378, slice 2): the org's thresholds of the spend flags. Nothing here calls a platform, moves money or changes a
-- campaign. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_flag_setting  the org's one row of flag thresholds (UNIQUE (org_id)): how many days of a month must be over before the
--                            pace is judged, the factor by which a day may exceed its share of a cap, the factor by which a campaign's
--                            cost per result may exceed its median, and the least results and history days that rule needs. A NULL
--                            threshold means the default the code carries (so a safer default reaches every org that never set one).
--                            Org-wide, so it names no legal entity.
--
-- A table of its own, not columns of crove_ads.ad_org_setting: that table's guard stamps updated_at on every update, and the proposal
-- that unblocks launches compares that stamp with the time of the block, so a threshold edit there would invalidate a pending unblock.
-- The row is plain numbers, so the table follows the other org settings: every tenant role may read it by row policy (the query that shows it
-- is for owners and admins), and only an owner or admin of the org, or the system, writes it, by row policy as well as by its command.
-- Tenant roles update the thresholds and who set them, nothing else.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_flag_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Days of the month that must be over before the pace is judged against a cap.
  pace_min_days smallint CHECK (pace_min_days IS NULL OR (pace_min_days >= 1 AND pace_min_days <= 15)),
  -- A day's spend flags above this many times its share of a cap; a ratio, above 1 and at most 10, decimal arithmetic in the code.
  day_factor numeric CHECK (day_factor IS NULL OR (day_factor > 1 AND day_factor <= 10)),
  -- A campaign's cost per result over the last 3 days flags above this many times its median of the 14 days before.
  cpr_factor numeric CHECK (cpr_factor IS NULL OR (cpr_factor > 1 AND cpr_factor <= 10)),
  -- The least results in the last 3 days, and the least days with results in the history, for that rule to judge a campaign.
  cpr_min_results integer CHECK (cpr_min_results IS NULL OR (cpr_min_results >= 1 AND cpr_min_results <= 100000)),
  cpr_min_history_days smallint CHECK (cpr_min_history_days IS NULL OR (cpr_min_history_days >= 3 AND cpr_min_history_days <= 14)),
  set_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_flag_setting_org_uq UNIQUE (org_id),
  CONSTRAINT ad_flag_setting_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS ad_flag_setting_set_by_idx ON crove_ads.ad_flag_setting (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_flag_setting');
REVOKE UPDATE ON crove_ads.ad_flag_setting FROM crove_tenant;
GRANT UPDATE (pace_min_days, day_factor, cpr_factor, cpr_min_results, cpr_min_history_days, set_by, updated_at) ON crove_ads.ad_flag_setting TO crove_tenant;

DROP POLICY IF EXISTS ad_flag_setting_insert ON crove_ads.ad_flag_setting;
CREATE POLICY ad_flag_setting_insert ON crove_ads.ad_flag_setting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = ad_flag_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS ad_flag_setting_update ON crove_ads.ad_flag_setting;
CREATE POLICY ad_flag_setting_update ON crove_ads.ad_flag_setting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = ad_flag_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = ad_flag_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS ad_flag_setting_delete ON crove_ads.ad_flag_setting;
CREATE POLICY ad_flag_setting_delete ON crove_ads.ad_flag_setting AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = ad_flag_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
