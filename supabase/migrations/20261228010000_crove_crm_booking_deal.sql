-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Engage / CRM (issue #3103, plan docs/plan/calendar.md "Deal links"): a booking can be linked to a deal. Idempotent; applied files stay untouched.
--
-- crove_crm.booking.deal_id         the deal a booking belongs to, or NULL (most bookings are not linked). The key is (org_id, deal_id), so a booking can never name another org's
--                                   deal; a deal that is deleted leaves its bookings in place, unlinked (ON DELETE SET NULL of the one column, the way deal_owner_fk does it).
--                                   A member links and unlinks through crm.booking.link_deal and crm.booking.unlink_deal; no other code writes it, but the definer below.
-- crove_crm.booking_deal_idx        the deal panel reads a deal's bookings in time order.
-- crove_crm.booking_request_deal    (new) the public booking page's request when the visitor came through a link that names a deal ("Đặt lịch" on a deal): it runs
--                                   crove_crm.booking_request (unchanged) and, in the same call and transaction, stores the deal on the new booking when that deal exists
--                                   in the same org. A deal id that names no deal of the org is dropped without a word, so the page cannot be used to find out which ids exist.
--                                   The visitor reads nothing of the deal. Execute only for crove_app, as booking_request's.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS deal_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conname = 'booking_deal_fk' AND c.conrelid = 'crove_crm.booking'::pg_catalog.regclass
  ) THEN
    ALTER TABLE crove_crm.booking
      ADD CONSTRAINT booking_deal_fk FOREIGN KEY (org_id, deal_id) REFERENCES crove_crm.deal (org_id, id) ON DELETE SET NULL (deal_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS booking_deal_idx ON crove_crm.booking (org_id, deal_id, starts_at) WHERE deal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_crm.booking_request_deal(
  p_org text, p_type text, p_starts_at timestamptz, p_name text, p_email text, p_phone text, p_note text, p_time_zone text, p_token_sha256 bytea, p_deal_id uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_id uuid;
BEGIN
  -- The request itself, with every check and the outbox event, exactly as a request without a deal; the link below is part of the same call and transaction.
  v_id := crove_crm.booking_request(p_org, p_type, p_starts_at, p_name, p_email, p_phone, p_note, p_time_zone, p_token_sha256);
  IF v_id IS NOT NULL AND p_deal_id IS NOT NULL THEN
    SELECT b.org_id INTO v_org FROM crove_crm.booking_event_type(p_org, p_type) b;
    UPDATE crove_crm.booking bk SET deal_id = d.id
    FROM crove_crm.deal d
    WHERE bk.org_id = v_org AND bk.id = v_id AND d.org_id = v_org AND d.id = p_deal_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_request_deal(text, text, timestamptz, text, text, text, text, text, bytea, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_request_deal(text, text, timestamptz, text, text, text, text, text, bytea, uuid) TO crove_app;
