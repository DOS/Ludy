-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2818, ADR-0050 points 3 and 4, plan crm-quotes.md section 6): the Kế toán side of the quote hand-off. Idempotent; applied files stay untouched.
-- No new table and no foreign key into the CRM: a source is a reference by value (kind, id, line number), as the marketplace and payroll sources are.
--
-- einvoice_draft_line   gains source_kind, source_id and source_line_no: the order line a draft line was made from (`crm.sales_order`, the order id, the line number). A unique index
--                       over them makes one order line invoiceable once. A draft never rests in `rejected` (the job moves it back to `draft` in the same transaction), so every draft
--                       that exists holds its lines, and deleting a draft (only a `draft` can be deleted) frees them through the cascade. The same columns serve other sources later.
-- purchase_line         gains the same three columns, carried from the draft line when the issued invoice is recorded as a sale document, so the document-line stock path can skip a
--                       line whose stock the delivery of the order line owns (A4: stock moves once).
-- stock_move            gains source_type `crm_order_line` and crm_order_id / crm_order_line_no: the stock a delivered order line takes out, one forward move per (order, line) by a
--                       unique index. A return is a `reversal` row of that move (the existing reversal rules), never an edit.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Draft lines
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.einvoice_draft_line ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE crove_finance.einvoice_draft_line ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE crove_finance.einvoice_draft_line ADD COLUMN IF NOT EXISTS source_line_no int;
ALTER TABLE crove_finance.einvoice_draft_line DROP CONSTRAINT IF EXISTS einvoice_draft_line_source_ck;
ALTER TABLE crove_finance.einvoice_draft_line ADD CONSTRAINT einvoice_draft_line_source_ck CHECK (
  (source_kind IS NULL AND source_id IS NULL AND source_line_no IS NULL)
  OR (source_kind ~ '^[a-z][a-z0-9_.]{1,39}$' AND source_id IS NOT NULL AND source_line_no > 0)
);
-- One invoice per source line: a second draft of the same order line meets this index (ORDER_LINE_ALREADY_INVOICED).
CREATE UNIQUE INDEX IF NOT EXISTS einvoice_draft_line_source_uq ON crove_finance.einvoice_draft_line (org_id, source_kind, source_id, source_line_no) WHERE source_kind IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Document lines
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.purchase_line ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE crove_finance.purchase_line ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE crove_finance.purchase_line ADD COLUMN IF NOT EXISTS source_line_no int;
ALTER TABLE crove_finance.purchase_line DROP CONSTRAINT IF EXISTS purchase_line_source_ck;
ALTER TABLE crove_finance.purchase_line ADD CONSTRAINT purchase_line_source_ck CHECK (
  (source_kind IS NULL AND source_id IS NULL AND source_line_no IS NULL)
  OR (source_kind ~ '^[a-z][a-z0-9_.]{1,39}$' AND source_id IS NOT NULL AND source_line_no > 0)
);

-- ---------------------------------------------------------------------------
-- 3. Stock moves of a delivered order line
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS crm_order_id uuid;
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS crm_order_line_no int CHECK (crm_order_line_no IS NULL OR crm_order_line_no > 0);
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_type_check;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_type_check CHECK (source_type IN ('document_line', 'manual', 'reversal', 'order_line', 'count', 'crm_order_line'));
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_ck;
-- Each source names what it comes from and nothing else (20261124040000), and now a delivered order line of the CRM: its order and line number, taking stock out.
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_ck CHECK (
  CASE source_type
    WHEN 'document_line' THEN document_id IS NOT NULL AND line_no IS NOT NULL AND line_attempt IS NOT NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                              AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL
    WHEN 'order_line' THEN order_line_id IS NOT NULL AND order_move IS NOT NULL AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL
                           AND ((order_move = 'ship' AND quantity < 0) OR (order_move = 'return' AND quantity > 0))
                           AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL
    WHEN 'count' THEN count_line_id IS NOT NULL AND amount IS NOT NULL AND ((quantity > 0 AND amount > 0) OR (quantity < 0 AND amount < 0))
                      AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                      AND crm_order_id IS NULL AND crm_order_line_no IS NULL
    WHEN 'crm_order_line' THEN crm_order_id IS NOT NULL AND crm_order_line_no IS NOT NULL AND quantity < 0
                               AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                               AND count_line_id IS NULL AND amount IS NULL
    ELSE document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
         AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL
  END
);
-- One forward move per order line, whatever else happens: a retry, a second click and a second tab meet this index.
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_crm_order_uq ON crove_finance.stock_move (org_id, crm_order_id, crm_order_line_no) WHERE source_type = 'crm_order_line';
