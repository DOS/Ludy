-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_event_sign_playbook_init_idx ON ludy_kernel.audit_event (org_id, id DESC) WHERE command IN ('sign.playbook.rule_upsert', 'sign.playbook.rule_delete', 'sign.playbook.seed_defaults') AND outcome = 'ok';
