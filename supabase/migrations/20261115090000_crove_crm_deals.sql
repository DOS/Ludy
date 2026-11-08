-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2225, plan docs/plan/crm.md §4.1 and §4.2, step K1): the pipeline stages and the deals. Idempotent;
-- applied files stay untouched.
--
-- crove_crm.pipeline_stage  the ordered stages of the org's one pipeline. A stage is open, won or lost; an org has at
--                           most 12, exactly one won and one lost, and those two are the last positions (the commands
--                           keep that; the unique index below holds the "one of each"). A fresh org has no rows:
--                           crm.pipeline.setup creates the defaults on first use.
-- crove_crm.deal            a sale in progress with a contact or company (a party): a title, an amount in VND, an
--                           expected close date, the member in charge, the stage and its place inside it. A deal's
--                           status is its stage's kind, never stored twice. A deal is deleted for real by its
--                           command; the audit row keeps what happened.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_crm.pipeline_stage (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 40 AND name = pg_catalog.btrim(name)),
  kind text NOT NULL CHECK (kind IN ('open', 'won', 'lost')),
  -- 1 upward, in the order of the pipeline. The commands keep it gapless and cap the pipeline at 12 stages, under the
  -- pipeline lock (no upper bound here, so a cap that changes is not a migration).
  position smallint NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- Deferred, so a reorder swaps positions inside one transaction; a command that writes a duplicate fails at commit.
  CONSTRAINT pipeline_stage_position_uq UNIQUE (org_id, position) DEFERRABLE INITIALLY DEFERRED
);
-- One won stage and one lost stage per org.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stage_terminal_uq ON crove_crm.pipeline_stage (org_id, kind) WHERE kind IN ('won', 'lost');
SELECT crove_kernel.apply_tenant_rls('crove_crm.pipeline_stage');

CREATE TABLE IF NOT EXISTS crove_crm.deal (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  party_id uuid NOT NULL,
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 200 AND title = pg_catalog.btrim(title)),
  amount numeric(20, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- VND only for now; another currency widens this check in a later migration (plan CRM-4).
  currency text NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  stage_id uuid NOT NULL,
  -- The deal's place inside its stage: a fractional key (packages/kernel-contract sort-key.ts), so a move rewrites one row.
  sort_key text COLLATE "C" NOT NULL CHECK (pg_catalog.length(sort_key) BETWEEN 1 AND 200),
  expected_close date,
  owner_user_id uuid,
  -- Only on a deal in a lost stage (the command keeps it).
  lost_reason text CHECK (lost_reason IS NULL OR pg_catalog.length(lost_reason) <= 200),
  -- Set while the deal is in a won or lost stage, null while it is open.
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT deal_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT deal_stage_fk FOREIGN KEY (org_id, stage_id) REFERENCES crove_crm.pipeline_stage (org_id, id) ON DELETE RESTRICT,
  -- A removed member leaves the deal without an owner.
  CONSTRAINT deal_owner_fk FOREIGN KEY (org_id, owner_user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (owner_user_id)
);
-- The board reads a stage in order; the contact's panel reads a party's deals; the owner's list reads theirs.
CREATE INDEX IF NOT EXISTS deal_stage_idx ON crove_crm.deal (org_id, stage_id, sort_key, id);
CREATE INDEX IF NOT EXISTS deal_party_idx ON crove_crm.deal (org_id, party_id);
CREATE INDEX IF NOT EXISTS deal_owner_idx ON crove_crm.deal (org_id, owner_user_id);
CREATE INDEX IF NOT EXISTS deal_open_close_idx ON crove_crm.deal (org_id, expected_close) WHERE closed_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.deal');
-- Who created a deal never changes.
REVOKE UPDATE ON crove_crm.deal FROM crove_tenant;
GRANT UPDATE (party_id, title, amount, stage_id, sort_key, expected_close, owner_user_id, lost_reason, closed_at, version, updated_by, updated_at) ON crove_crm.deal TO crove_tenant;
