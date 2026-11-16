-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #3310, ADR-0053 slice c, C2a): the public pages of CRM answer "not found" for an org that switched CRM off.
-- Idempotent (CREATE OR REPLACE keeps each function's owner and grants); applied files stay untouched.
--
-- The check is made where the org of a public address is found, with the SQL half of the gate (crove_kernel.org_app_on, the org's choice); see
-- the Social migration of the same change for the reasoning (an off app is the same answer as an address that never existed, and visitors' writes are
-- refused). The entitlement half is not asked here.
--
-- Five functions are restated, each the body of the newest migration that defines it with one change: `AND crove_kernel.org_app_on(t.org_id, 'crm')`
-- in the test that the tenant is active. booking_event_type is the shared lookup of the booking page, the status, the request and the deal request;
-- booking_manage_find of the manage link's view and its cancel or move request; the booking feed and the quote link view and logo look the tenant up
-- themselves.
SET LOCAL lock_timeout = '2s';

-- crove_crm.booking_feed_events: the body of 20261121230000_crove_crm_booking_meet.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_crm.booking_feed_events(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_feed crove_crm.booking_feed;
  v_tenant crove_kernel.tenant;
BEGIN
  -- 32 random bytes, base64url without padding (newFeedToken in modules/crm).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT f.* INTO v_feed FROM crove_crm.booking_feed f
  WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_feed.id IS NULL OR v_feed.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.* INTO v_tenant FROM crove_kernel.tenant t WHERE t.org_id = v_feed.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'crm');
  IF v_tenant.org_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- A member who left the org, became a viewer or whose account is disabled hosts no more: their address stops
  -- working. (Leaving or becoming a viewer also revokes the feed, crm.booking_feed.revoke_for_member, so being added
  -- back does not bring an old address back.)
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_feed.org_id AND m.user_id = v_feed.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH e AS (
      -- The member's own events of confirmed bookings: the lead's (calendar_event_id) or a co-host's of a collective
      -- booking (hold_event_ids). A move changes the event's times in place; a cancel cancels the event.
      SELECT b.id, ev.starts_at, ev.ends_at, b.revision, t.title, t.location_kind, t.location_value, b.visitor_name, b.meeting_state, b.meeting_url
      FROM crove_kernel.calendar_event ev
      JOIN crove_crm.booking b ON b.org_id = ev.org_id AND (b.calendar_event_id = ev.id OR ev.id = ANY (b.hold_event_ids))
      JOIN crove_crm.event_type t ON t.org_id = b.org_id AND t.id = b.event_type_id
      WHERE ev.org_id = v_feed.org_id AND ev.user_id = v_feed.user_id AND ev.kind = 'booking' AND ev.status = 'active'
        AND b.status = 'confirmed'
        AND ev.starts_at >= pg_catalog.now() - interval '30 days' AND ev.starts_at < pg_catalog.now() + interval '90 days'
      -- Past 1000, the ones nearest to now stay.
      ORDER BY pg_catalog.abs(EXTRACT(EPOCH FROM ev.starts_at - pg_catalog.now())), b.id
      LIMIT 1000
    )
    SELECT pg_catalog.jsonb_build_object(
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'events', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', e.id,
          'startsAt', e.starts_at,
          'endsAt', e.ends_at,
          'revision', e.revision,
          'title', e.title,
          -- A booking whose Meet is ready shows its join link (C7, #1375), whatever kind its type has now (the mails say the same), else the type's fixed link.
          'locationKind', CASE WHEN e.meeting_state = 'ready' THEN 'google_meet' ELSE e.location_kind END,
          'location', CASE WHEN e.meeting_state = 'ready' THEN e.meeting_url ELSE e.location_value END,
          'visitorName', e.visitor_name
        ) ORDER BY e.starts_at, e.id)
        FROM e
      ), '[]'::jsonb)
    )
  );
END $$;

-- crove_crm.booking_event_type: the body of 20261031020000_crove_crm_bookings.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_crm.booking_event_type(p_org text, p_type text)
RETURNS TABLE (org_id uuid, org_name text, event_type_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id, t.name, e.id
  FROM crove_kernel.tenant t
  JOIN crove_crm.event_type e ON e.org_id = t.org_id AND e.slug = p_type AND e.active
  WHERE t.slug = p_org AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'crm')
$$;

-- crove_crm.booking_manage_find: the body of 20261031250000_crove_crm_booking_manage.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_find(p_org text, p_type text, p_token text)
RETURNS TABLE (org_id uuid, booking_id uuid, token_revision integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_revision integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}\.[0-9]{1,9}\.[0-9a-f]{32}$' THEN
    RETURN;
  END IF;
  v_id := pg_catalog.split_part(p_token, '.', 1)::uuid;
  v_revision := pg_catalog.split_part(p_token, '.', 2)::integer;
  IF crove_crm.booking_manage_mac(v_id, v_revision) <> pg_catalog.split_part(p_token, '.', 3) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT bk.org_id, bk.id, v_revision
    FROM crove_crm.booking bk
    JOIN crove_kernel.tenant t ON t.org_id = bk.org_id AND t.slug = p_org AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'crm')
    JOIN crove_crm.event_type e ON e.org_id = bk.org_id AND e.id = bk.event_type_id AND e.slug = p_type
    WHERE bk.id = v_id;
END $$;

-- crove_crm.quote_link_view: the body of 20261201040000_crove_crm_quote_logo.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_crm.quote_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_crm.quote_link;
  v_quote crove_crm.quote;
  v_today date := (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO v_link FROM crove_crm.quote_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'crm')) THEN
    RETURN NULL;
  END IF;
  -- Locked first (a send of a revision waits), so the status read here is the one the two updates below act on.
  SELECT q.* INTO v_quote FROM crove_crm.quote q WHERE q.org_id = v_link.org_id AND q.id = v_link.quote_id FOR UPDATE;
  IF v_quote.id IS NULL OR v_quote.status NOT IN ('sent', 'accepted', 'declined') THEN
    RETURN NULL;
  END IF;
  -- The quote row first, then the link: the send of a revision locks them in that order too, so the two cannot deadlock.
  IF v_quote.first_viewed_at IS NULL THEN
    UPDATE crove_crm.quote SET first_viewed_at = pg_catalog.now() WHERE org_id = v_quote.org_id AND id = v_quote.id AND status IN ('sent', 'accepted', 'declined');
  END IF;
  UPDATE crove_crm.quote_link SET views = views + 1, first_viewed_at = coalesce(first_viewed_at, pg_catalog.now()) WHERE org_id = v_link.org_id AND id = v_link.id AND revoked_at IS NULL;
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'number', v_quote.number,
      'revision', v_quote.revision,
      'status', v_quote.status,
      'expired', v_quote.status = 'sent' AND v_quote.valid_until < v_today,
      'validUntil', v_quote.valid_until,
      'sentAt', v_quote.sent_at,
      'notes', v_quote.remarks,
      'terms', v_quote.terms,
      'subtotal', v_quote.subtotal::text,
      'vatAmount', v_quote.vat_amount::text,
      'total', v_quote.total::text,
      -- The seller as it was when the quote was sent; a quote sent before the snapshot existed (no seller_name) shows the live letterhead.
      'seller', CASE WHEN v_quote.seller_name IS NOT NULL THEN pg_catalog.jsonb_build_object(
          'name', v_quote.seller_name,
          'taxCode', v_quote.seller_tax_code,
          'address', v_quote.seller_address,
          'phone', v_quote.seller_phone,
          'email', v_quote.seller_email,
          'bankNote', v_quote.seller_bank_note)
        ELSE (
        SELECT pg_catalog.jsonb_build_object(
          'name', coalesce(e.name, t.name),
          'taxCode', e.tax_code,
          'address', t.address,
          'phone', s.phone,
          'email', s.email,
          'bankNote', s.bank_note)
        FROM crove_kernel.tenant t
        LEFT JOIN crove_kernel.legal_entity e ON e.org_id = t.org_id AND e.id = v_quote.issuer_entity_id
        LEFT JOIN crove_crm.quote_setting s ON s.org_id = t.org_id
        WHERE t.org_id = v_quote.org_id) END,
      -- Whether the quote's letterhead has a logo (the one frozen at the send, else the org's own); the image itself comes from quote_link_logo, by the same token.
      'hasLogo', EXISTS (
        SELECT 1 FROM crove_kernel.file f
        WHERE f.org_id = v_quote.org_id AND f.source = 'social' AND f.content_type IN ('image/png', 'image/jpeg')
          AND f.id = CASE WHEN v_quote.seller_logo_frozen THEN v_quote.seller_logo_file_id
                          ELSE (SELECT s.logo_file_id FROM crove_crm.quote_setting s WHERE s.org_id = v_quote.org_id) END),
      'buyer', pg_catalog.jsonb_build_object('name', v_quote.buyer_name, 'taxCode', v_quote.buyer_tax_code, 'address', v_quote.buyer_address),
      'lines', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'lineNo', l.line_no,
          'kind', l.kind,
          'description', l.description,
          'unit', l.unit,
          'quantity', l.quantity::text,
          'unitPrice', l.unit_price::text,
          'discountPercent', l.discount_percent::text,
          'vatRate', l.vat_rate,
          'amount', l.amount::text,
          'vatAmount', l.vat_amount::text) ORDER BY l.line_no)
        FROM crove_crm.quote_line l
        WHERE l.org_id = v_quote.org_id AND l.quote_id = v_quote.id), '[]'::jsonb)));
END $$;

-- crove_crm.quote_link_logo: the body of 20261201040000_crove_crm_quote_logo.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_crm.quote_link_logo(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_crm.quote_link;
  v_quote crove_crm.quote;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO v_link FROM crove_crm.quote_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'crm')) THEN
    RETURN NULL;
  END IF;
  SELECT q.* INTO v_quote FROM crove_crm.quote q WHERE q.org_id = v_link.org_id AND q.id = v_link.quote_id;
  IF v_quote.id IS NULL OR v_quote.status NOT IN ('sent', 'accepted', 'declined') THEN
    RETURN NULL;
  END IF;
  -- Only the logo of the quote's own org (the one frozen at the send, else the org's own), and only an image the upload checks let in.
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'storageKey', f.storage_key,
      'generation', f.generation,
      'sha256', f.sha256,
      'contentType', f.content_type,
      'sizeBytes', f.size_bytes)
    FROM crove_kernel.file f
    WHERE f.org_id = v_quote.org_id AND f.source = 'social' AND f.content_type IN ('image/png', 'image/jpeg')
      AND f.id = CASE WHEN v_quote.seller_logo_frozen THEN v_quote.seller_logo_file_id
                      ELSE (SELECT s.logo_file_id FROM crove_crm.quote_setting s WHERE s.org_id = v_quote.org_id) END);
END $$;
