-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS task_completed_by_done_idx ON ludy_kernel.task (org_id, completed_by, done_at DESC) WHERE completed_by IS NOT NULL;
