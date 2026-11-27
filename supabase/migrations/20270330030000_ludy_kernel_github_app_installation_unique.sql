-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel channels: one org at a time holds a GitHub App installation (#5158, ADR-0060 B1).
-- Idempotent; prevents two organizations from claiming the same installation_id simultaneously.
SET LOCAL lock_timeout = '2s';

CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_github_app_installation_uq
  ON ludy_kernel.channel_connection (external_account_id) WHERE provider = 'github_app' AND status <> 'revoked';
