-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #1375, calendar plan step C7, part of #1374): a Google Meet created per booking, through the host's Google connection of C6.
-- Idempotent; applied files stay untouched.
--
-- 1. crove_crm.event_type.location_kind gains google_meet: the meeting link is made for each booking (the fixed link in location_value, when
--    one is set, is the fallback for a booking whose Meet could not be made).
-- 2. crove_crm.booking.meeting_state and meeting_url: none (the type makes no Meet, or the host cannot), pending (the worker is making it:
--    the booking's mails wait for the outcome, so the first mail already carries the link), ready (meeting_url is the join link, only ever a
--    meet.google.com address) or failed (Google did not give one: the booking stands and the fixed link, if any, is used).
-- 3. crove_kernel.calendar_event.conference: the event asks the provider to make a conference for it when the C6 write-back writes it.
-- 4. The queue crm-booking-meet: the delayed job that settles a booking whose Meet is still pending after a few minutes (a worker that was
--    down, a Google outage), so no mail waits for ever.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.event_type DROP CONSTRAINT IF EXISTS event_type_location_kind_check;
ALTER TABLE crove_crm.event_type ADD CONSTRAINT event_type_location_kind_check CHECK (location_kind IN ('in_person', 'phone', 'video', 'google_meet'));

ALTER TABLE crove_crm.booking
  ADD COLUMN IF NOT EXISTS meeting_state text NOT NULL DEFAULT 'none' CHECK (meeting_state IN ('none', 'pending', 'ready', 'failed')),
  -- The link and the state go together: a ready booking has the link, any other has none.
  ADD COLUMN IF NOT EXISTS meeting_url text CHECK (meeting_url IS NULL OR meeting_url ~ '^https://meet\.google\.com/(lookup/)?[a-z0-9-]{3,64}$')
    CHECK ((meeting_url IS NOT NULL) = (meeting_state = 'ready'));

ALTER TABLE crove_kernel.calendar_event ADD COLUMN IF NOT EXISTS conference boolean NOT NULL DEFAULT false;

SELECT crove_jobs.create_queue('crm-booking-meet', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);

-- 5. The booking feed of a host (a private calendar subscription) shows a Google Meet booking's join link in its location once it is made. The function is
--    the body of 20261102040000 (the newest definition) with only two changes: the booking's meeting columns are read, and the location says the link.
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
  SELECT t.* INTO v_tenant FROM crove_kernel.tenant t WHERE t.org_id = v_feed.org_id AND t.status = 'active';
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
          'locationKind', e.location_kind,
          -- A Google Meet booking shows the join link once it is made (C7, #1375), else the type's fixed link.
          'location', CASE WHEN e.location_kind = 'google_meet' AND e.meeting_state = 'ready' THEN e.meeting_url ELSE e.location_value END,
          'visitorName', e.visitor_name
        ) ORDER BY e.starts_at, e.id)
        FROM e
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_feed_events(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_feed_events(text) TO crove_app;
