-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2518, ADR-0045, plan stock-and-marketplaces.md sections 8.5 and 12 row 7): the form of the quarterly return worksheet of a household business (01/CNKD) as data.
-- The return is not a book of Circular 152, so it does not go into crove_finance.household_form_version (whose `book` list feeds "the books a profile requires" and the screen that lists
-- them); it has its own small table of the same shape and the same rules. Idempotent; applied files stay untouched.
--
-- crove_finance.household_return_form_version   the law as data, global like the four household law tables (no org_id, read-only for every org, edited only by a migration): which return
--                                               form is in force on a date, its title, the PIT methods whose households file it, where the row comes from and a status. `commentary` until the
--                                               accountant has checked which version is current (#2520: Circular 89/2026 against 50/2026 and 18/2026), then `confirmed` by a later dated row,
--                                               never by editing one. A change of the form version is a new row, so a quarter keeps the version in force on its last day.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.household_return_form_version (
  -- The return as the tax authority names it; only 01/CNKD (the quarterly VAT and PIT return of a household that pays by a percentage of revenue) is built today.
  form text NOT NULL CHECK (form IN ('01/CNKD')),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]+$'),
  effective_from date NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- An empty list retires the form from that date: no method files it any more.
  pit_methods text[] NOT NULL CHECK (pit_methods <@ ARRAY['percentage', 'income']::text[]),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (form, version)
);
-- One version is in force per form on a date: two rows on one date would make the answer depend on the order the database returns them.
CREATE UNIQUE INDEX IF NOT EXISTS household_return_form_version_date_uq ON crove_finance.household_return_form_version (form, effective_from);
REVOKE ALL ON crove_finance.household_return_form_version FROM PUBLIC, crove_tenant;
GRANT SELECT ON crove_finance.household_return_form_version TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_return_form_version');

-- The seed. Which form version is current is unverified (plan section 5 row 7: 01/CNKD under Circular 89/2026, earlier 18/2026 and 50/2026), so the row is `commentary` and the accountant
-- (#2520) confirms it or corrects it by a later dated row.
INSERT INTO crove_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES
  ('01/CNKD', '2026.1', DATE '2026-01-01', 'Tờ khai thuế đối với hộ kinh doanh, cá nhân kinh doanh (01/CNKD)', ARRAY['percentage']::text[], 'Form 01/CNKD under Circular 89/2026 as quoted; which version is current against 50/2026 and 18/2026 is unverified (plan section 5 row 7); the accountant confirms (#2520)', 'commentary')
ON CONFLICT (form, version) DO NOTHING;
