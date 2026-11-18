-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_move_return_of_idx ON crove_finance.stock_move (org_id, return_of_move_id) WHERE return_of_move_id IS NOT NULL;
