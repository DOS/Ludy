-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3712 slice 2a): validates the constraints 20270116160000 added NOT VALID. No existing voucher has surplus_count_id, so both pass. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher VALIDATE CONSTRAINT journal_voucher_surplus;
ALTER TABLE crove_finance.journal_voucher VALIDATE CONSTRAINT journal_voucher_surplus_count_fk;
