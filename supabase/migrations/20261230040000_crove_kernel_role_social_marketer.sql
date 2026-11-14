-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2612, ADR-0049 decision 10): the Marketing department preset role (social.marketer) for Social
-- and Ads, offered when the deployment runs social, org-wide, granting vy.use alone through role_permission.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

INSERT INTO crove_kernel.role (key, module, scope)
VALUES ('social.marketer', 'social', 'org')
ON CONFLICT (key) DO NOTHING;

INSERT INTO crove_kernel.role_permission (role_key, permission)
VALUES ('social.marketer', 'vy.use')
ON CONFLICT (role_key, permission) DO NOTHING;
