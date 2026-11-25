-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 6C review follow-up (#4654): narrow ludy_hr.employee_asset_handover
-- column-level UPDATE grants for ludy_tenant to omit immutable asset_name.
SET LOCAL lock_timeout = '2s';

REVOKE UPDATE ON TABLE ludy_hr.employee_asset_handover FROM ludy_tenant;
GRANT UPDATE (
  serial_number,
  returned_on,
  status,
  notes,
  cleared_by,
  updated_at
) ON TABLE ludy_hr.employee_asset_handover TO ludy_tenant;
