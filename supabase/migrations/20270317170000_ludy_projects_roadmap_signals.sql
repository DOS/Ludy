-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects Omnichannel Roadmap Signals Slice 1 (issue #4492, ADR-0058):
--   - Idempotent composite unique constraint on ludy_projects.roadmap_item (org_id, board_id, id).
--   - Internal tenant table ludy_projects.roadmap_signal linking CRM Deals, Inbox Conversations,
--     and Meetings to roadmap_item rows with per-item source deduplication, strict currency pairing,
--     covering btree indexes for composite FKs, and tenant RLS + agent write guard.
--   - public_roadmap_view and public_roadmap_* routines never query roadmap_signal.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_projects'
      AND t.relname = 'roadmap_item'
      AND c.conname = 'roadmap_item_board_uq'
  ) THEN
    ALTER TABLE ludy_projects.roadmap_item
      ADD CONSTRAINT roadmap_item_board_uq UNIQUE (org_id, board_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ludy_projects.roadmap_signal (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  board_id uuid NOT NULL,
  roadmap_item_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('crm.deal', 'kernel.conversation', 'meetings.meeting')),
  source_id uuid NOT NULL,
  account_label text CHECK (
    account_label IS NULL
    OR (pg_catalog.length(account_label) BETWEEN 1 AND 160 AND account_label = pg_catalog.btrim(account_label))
  ),
  quote_excerpt text CHECK (
    quote_excerpt IS NULL
    OR (pg_catalog.length(quote_excerpt) BETWEEN 1 AND 1000 AND quote_excerpt = pg_catalog.btrim(quote_excerpt))
  ),
  deal_value NUMERIC(18, 2) CHECK (deal_value IS NULL OR deal_value >= 0),
  deal_currency text CHECK (deal_currency IS NULL OR deal_currency ~ '^[A-Z]{3}$'),
  tainted boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT roadmap_signal_currency_pair_ck CHECK ((deal_value IS NULL) = (deal_currency IS NULL)),
  CONSTRAINT roadmap_signal_board_fk FOREIGN KEY (org_id, board_id)
    REFERENCES ludy_projects.roadmap_board (org_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_signal_item_fk FOREIGN KEY (org_id, board_id, roadmap_item_id)
    REFERENCES ludy_projects.roadmap_item (org_id, board_id, id) ON DELETE CASCADE,
  CONSTRAINT roadmap_signal_item_source_uq UNIQUE (org_id, roadmap_item_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS roadmap_signal_board_idx
  ON ludy_projects.roadmap_signal (org_id, board_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_signal_item_idx
  ON ludy_projects.roadmap_signal (org_id, board_id, roadmap_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roadmap_signal_source_idx
  ON ludy_projects.roadmap_signal (org_id, source_type, source_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.roadmap_signal');
