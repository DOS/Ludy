-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #4493 (Slice 2, ADR-0058): Projects Triage Inbox (crove_projects.project_triage_item).
-- Enforces tenant isolation (ludy_kernel.apply_tenant_rls) and #2604 private-project RESTRICTIVE RLS.

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_projects.project_triage_item (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('roadmap.item', 'kernel.conversation', 'meetings.meeting', 'manual')),
  source_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'snoozed', 'accepted', 'merged', 'declined')),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 300 AND title = pg_catalog.btrim(title)),
  description text CHECK (description IS NULL OR pg_catalog.length(description) <= 10000),
  tainted boolean NOT NULL DEFAULT true,
  snoozed_until timestamptz,
  accepted_task_id uuid,
  merged_into_task_id uuid,
  decline_reason text CHECK (decline_reason IS NULL OR pg_catalog.length(decline_reason) <= 1000),
  triaged_by uuid,
  triaged_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_triage_source_pair_ck CHECK (
    (source_type = 'manual' AND source_id IS NULL)
    OR (source_type <> 'manual' AND source_id IS NOT NULL)
  ),
  CONSTRAINT project_triage_snooze_ck CHECK (
    (status = 'snoozed' AND snoozed_until IS NOT NULL)
    OR (status <> 'snoozed')
  ),
  CONSTRAINT project_triage_accept_ck CHECK (
    status = 'accepted' OR accepted_task_id IS NULL
  ),
  CONSTRAINT project_triage_merge_ck CHECK (
    status = 'merged' OR merged_into_task_id IS NULL
  ),
  CONSTRAINT project_triage_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_triage_accepted_task_fk FOREIGN KEY (org_id, project_id, accepted_task_id)
    REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (accepted_task_id),
  CONSTRAINT project_triage_merged_task_fk FOREIGN KEY (org_id, project_id, merged_into_task_id)
    REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (merged_into_task_id)
);

CREATE INDEX IF NOT EXISTS project_triage_project_status_idx
  ON crove_projects.project_triage_item (org_id, project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS project_triage_org_status_idx
  ON crove_projects.project_triage_item (org_id, status, snoozed_until, created_at DESC);

CREATE INDEX IF NOT EXISTS project_triage_accepted_task_idx
  ON crove_projects.project_triage_item (org_id, project_id, accepted_task_id)
  WHERE accepted_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_triage_merged_task_idx
  ON crove_projects.project_triage_item (org_id, project_id, merged_into_task_id)
  WHERE merged_into_task_id IS NOT NULL;

SELECT ludy_kernel.apply_tenant_rls('crove_projects.project_triage_item');
REVOKE ALL ON crove_projects.project_triage_item FROM ludy_app, ludy_worker, ludy_definer_tenant;

DROP POLICY IF EXISTS project_visibility ON crove_projects.project_triage_item;
CREATE POLICY project_visibility ON crove_projects.project_triage_item
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT crove_projects.actor_bypasses_private_projects())
    OR crove_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (crove_projects.project_visible(org_id, project_id));
