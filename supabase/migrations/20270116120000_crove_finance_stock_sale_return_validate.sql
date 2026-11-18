-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3712 slice 1): validates the constraints 20270116110000 added NOT VALID. Existing rows have no return_of_move_id and keep their old sources, so they pass; the
-- validation takes only a SHARE UPDATE EXCLUSIVE lock, which reads and inserts do not wait for. Idempotent.
ALTER TABLE crove_finance.stock_move VALIDATE CONSTRAINT stock_move_source_type_check;
ALTER TABLE crove_finance.stock_move VALIDATE CONSTRAINT stock_move_source_ck;
ALTER TABLE crove_finance.stock_move VALIDATE CONSTRAINT stock_move_return_of_fk;
