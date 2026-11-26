-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (#5028): validates channel_connection_chat_business_order_check added NOT VALID in 20270328030000
-- under SHARE UPDATE EXCLUSIVE so webhook reads and writes continue during validation. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.channel_connection
  VALIDATE CONSTRAINT channel_connection_chat_business_order_check;
