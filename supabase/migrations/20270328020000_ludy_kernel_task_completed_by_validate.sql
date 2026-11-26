-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #4821 (3/3): validate task_completed_by_done_only in its own transaction (SHARE UPDATE EXCLUSIVE only,
-- allowing concurrent reads and writes after 20270328000000 released its short ACCESS EXCLUSIVE DDL lock).
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.task
  VALIDATE CONSTRAINT task_completed_by_done_only;
