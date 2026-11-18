-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3710 slice 2): validates the CHECK that 20270112130000 added NOT VALID on crove_finance.household_profile.vat_cut_eligible. It is its own file, so the scan of the
-- table runs in its own transaction, apart from the lock the ADD CONSTRAINT took. New and updated rows were checked from the moment the constraint existed; this only checks the rows that were there.
-- Idempotent: validating an already valid constraint does nothing. Applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.household_profile VALIDATE CONSTRAINT household_profile_vat_cut_eligible_check;
