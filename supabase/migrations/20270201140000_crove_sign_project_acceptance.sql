-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 3b (#3812, docs/plan/esign.md): widen crove_sign.envelope.source_kind CHECK constraint
-- to allow 'project_acceptance' for Ludy Du an project acceptance minutes handoff (zero cross-schema FKs).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_sign.envelope DROP CONSTRAINT IF EXISTS envelope_source_kind_check;
ALTER TABLE crove_sign.envelope
  ADD CONSTRAINT envelope_source_kind_check
  CHECK (source_kind IN ('standalone', 'crm_quote', 'crm_order', 'hr_contract', 'project_acceptance'));
