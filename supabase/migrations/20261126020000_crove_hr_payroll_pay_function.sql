-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2532, docs/plan/payroll.md section 6.4 and row 18, ADR-0046): what a person's work is for, which picks the expense account of the pay in the posting
-- (administration, sales, production, factory overhead, construction in progress). Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_employment.pay_function  a column of the terms, so a change of function is a new row like a raise (the rows are append-only). Every row that exists
--                                           takes `admin`, the account every small business has (642). The accounts per function and regime are data in @crove/l10n-vn,
--                                           not here. The new column is internal, like the region.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employment
  ADD COLUMN IF NOT EXISTS pay_function text NOT NULL DEFAULT 'admin' CHECK (pay_function IN ('admin', 'sales', 'production', 'overhead', 'construction'));
