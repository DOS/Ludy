# Crove Calendar: booking pages in CRM

> Plan for Calendar, the first slice of Phase 3 (CRM + Calendar), 2026-10-24. Owner decision of 2026-10-24 (kernel plan, Decision 20): start Calendar now, as an exception to Decision 2, before the rest of CRM. It follows the kernel plan's structure (§13 "Calendar lives in CRM"): the core (events, availability, free/busy) is a kernel `calendar` service other modules share, and the Calendly-style booking page is a feature of the `crm` module. Deals, pipelines and the rest of CRM still wait for wedge-customer demand. Vietnamese page for the owner: [calendar.vi.html](calendar.vi.html). Architecture record: [ADR-0024](../adr/0024-calendar-service.md).
>
> Reference: [Cal.diy](https://github.com/calcom/cal.diy) (MIT, the community edition of Cal.com) for slot computation, booking flows and edge cases. It is a reference, not a dependency: Crove does not embed or run it, because it has its own auth, database and users, and its README recommends it for personal, non-production use only. Code copied from it keeps its MIT notice in the file it lands in. The owner's archived fork (Crove-Cal) stays archived (Decision 8).

## 1. Goal and scope

Let a member of an org publish a booking page, so a client books a meeting in a free slot of that member's calendar, without an account and without back-and-forth. For the accounting-firm wedge: a client company books a call with its accountant, a time to hand over documents, or a monthly review.

**v1 (this plan):**
- Kernel `calendar` service: calendar events per member (UTC instant range plus the IANA time zone they were set in), weekly working hours, dates off, Vietnamese public holidays, and free/busy over a range. No double booking for a member, enforced by the database.
- `crm` module, enabled like any module (`CROVE_MODULES`, ADR-0031), with the booking slice only.
- Event types: title, duration, buffers before and after, minimum notice, booking horizon, daily limit, location (in person, phone, a fixed video link), the member who hosts it, a public slug.
- Public booking page `/-/b/<org>/<event-type>`: the free slots in the visitor's time zone, a short form (name, email, phone, note), confirmation on the page.
- A booking creates or matches a `party` by email, writes an `activity` on its timeline, and holds a calendar event on the host's calendar.
- Mails through the kernel mail pipeline: confirmation to the visitor and the host with an `.ics` file, reminders as jobs, and reschedule and cancel links that work once and need no account.
- In the app: a "Lịch hẹn" screen (upcoming and past bookings, cancel or move one), event types and working hours in settings, the booking on the party's timeline.

**Later (same plan, not v1):**
- External calendars: Google Calendar, Microsoft 365, CalDAV, two-way free/busy through connectors (needs the owner's OAuth app credentials).
- Meeting links created per booking (Google Meet, Zoom, Teams). C7 (#1375) builds the Google Meet one only, see "C7 as built" below; Zoom and Teams need more OAuth apps and stay out.
- Team event types: round-robin and collective (all hosts free).
- Deal links once CRM deals exist; paid bookings; AI that proposes slots from an email or a chat message (always a proposal a human approves); the `crm.scheduler` agent template (ADR-0029).

**Not in Calendar:** video calls hosted by Crove, payments, SMS reminders, a public API (Phase 3's `/v1` comes later).

## 2. Fit with what exists

| Need | Reuse | New |
|---|---|---|
| Who the client is | `crove_kernel.party` (match on email within the org) | none |
| Timeline entry | `crove_kernel.activity` | an activity kind `booking` |
| Mails | kernel mail queue and templates, `BRAND_NAME` (#1040) | templates `crm.booking.*` |
| Reminders | pg-boss jobs | a reminder job per booking |
| Public page | the public route pattern of the bio page (`/b/:slug`, #707) and the status page | `/-/b/...`, on the reasoned public list |
| Abuse | `RateLimiter`, per-IP and per-org budgets | an optional Turnstile check when the deployment sets keys |
| Holidays | none: the tax calendar does not apply public holidays (#921) | a Vietnamese public holiday list in `@crove/kernel-contract` (fixed dates plus a yearly table for Tết and Hùng Kings, which follow the lunar calendar), and an org's own dates off; the tax calendar can use it later |
| Calendar feed | the Social calendar feed (`/cal/:file`) | a member's booking feed later |

## 3. Design

### 3.1 Data (all tenant tables: `org_id`, `PRIMARY KEY (org_id, id)`, RLS through `apply_tenant_rls`)

- `crove_kernel.calendar_event`: `user_id` (the member), `starts_at`, `ends_at` (UTC), `time_zone` (IANA), `title`, `kind` (`manual`, `time_off`, `booking`; later `google`, `microsoft`, `caldav` with a `source_id`), `status` (`active`, `cancelled`, with `cancelled_at` and `cancelled_by`). Every active event is busy time. No two active bookings of one member overlap: `EXCLUDE USING gist (int8range(h, h, '[]') WITH &&, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (kind = 'booking' AND status = 'active')`, where `h` is `hashtextextended(org_id || ':' || user_id, 0)`, because Crove uses no extension (so no `btree_gist`); a hash collision only refuses a booking, never allows a double one. Manual events may overlap; the booking command checks them under a per-member lock.
- `crove_kernel.availability_rule`: a member's weekly working hours, one row per window (`weekday` 1 to 7, `start_minute`, `end_minute`, `time_zone`); no row means the default (Monday to Friday, 8:00 to 17:00, Vietnam time). Dates off are `time_off` events.
- `crove_crm.event_type`: `slug` (unique per org), `title`, `duration_min`, `buffer_before_min`, `buffer_after_min`, `min_notice_min`, `horizon_days`, `daily_limit`, `location_kind`, `location_value`, `host_member_id`, `active`, `description`.
- `crove_crm.booking`: `event_type_id`, `calendar_event_id`, `party_id`, `visitor_name`, `email`, `phone`, `note`, `status` (`pending`, `confirmed`, `refused`, `cancelled`; a move keeps the booking and changes its time), `revision`. The manage links in its mails (#1319) carry the booking's id, its revision and a MAC of both under the deployment's mail key, so nothing secret is stored and every mail of one revision carries a working link; a cancel or a move raises the revision, which ends every earlier link (single use per action).

### 3.2 Slots

A pure function computes the free slots of an event type over a range: the host's working hours in the host's time zone, minus dates off and Vietnamese holidays, minus busy events widened by the buffers, minus the minimum notice, within the horizon and the daily limit, stepped by the duration. It runs on UTC instants and converts at the edges, so a daylight-saving zone on either side stays correct. Property tests (fast-check) cover zones, buffers and limits. The booking page only ever receives free slots, never busy details.

### 3.3 Booking

The public page posts to an anonymous endpoint that runs one command through `Runtime.execute()` as a system actor scoped to the org, like the inbound mail route. The command re-checks the slot, matches or creates the party, inserts the calendar event (the exclusion constraint refuses a race), the booking and the activity, and queues the mails, in one transaction. A refused race answers "this time was just taken" and the page reloads the slots.

### 3.4 Public route and abuse

`/-/b/<org>/<type>` and its POST are added to the reasoned public list of the route-coverage invariant. Budgets per IP and per event type; an optional Turnstile check when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are set (Cloud sets them; self-host may leave them off). The page shows the org's name and the event type, nothing about other bookings.

### 3.5 Time

Instants are stored in UTC, with the IANA zone they were set in. The page shows times in the visitor's zone and names the zone. Mails show the visitor's zone for the visitor and the host's zone for the host.

## 4. Steps (one PR each, end to end, milestone "Calendar", P2)

| Step | Scope | Exit |
|---|---|---|
| C1 | Kernel calendar core: `calendar_event`, `availability`, Vietnamese holiday list, free/busy query, slot function, working hours in settings | Slot property tests pass; RLS tests; a manual busy event blocks its time; a holiday has no slots |
| C2 | `crm` module and event types: enablement, `crove_crm.event_type`, CRUD commands, the settings screen | The module turns on and off with `CROVE_MODULES`; event types per org, slugs unique |
| C3 | Public booking page and booking command: route, slots, form, party match, activity, exclusion constraint, rate limits, optional Turnstile | 200 concurrent bookings of one slot give exactly 1 success; the route is on the public list |
| C4 | Mails and links: confirmation with `.ics`, reminders as jobs, single-use reschedule and cancel links | A link works once; a cancelled booking frees the slot; reminders do not fire after a cancel |
| C5 | "Lịch hẹn" in the app: list, cancel or move by the host, booking on the party's timeline | e2e: book from the public page, see it in the app, cancel it, the slot is free again |

Later steps (C6 external calendars, C7 meeting links, C8 team event types) get their issues when v1 is done.

### C7 as built (#1375): a Google Meet per booking

Narrowed by the OPC/SME gate: an event type's location can be a **Google Meet created per booking**, through the host's Google connection of C6, or, as before, a fixed link. No AI part, on purpose.
- **No new Google scope.** C6's `calendar.events.owned` (the write-back scope) covers the event insert that makes the Meet: Google's `events.insert` takes `conferenceDataVersion=1` and a `conferenceData.createRequest` of the type `hangoutsMeet` in the same call. So no runbook step is added to the OAuth consent screen.
- **The event type.** A new location kind `google_meet` (the fixed link in `location_value` is optional and is the fallback). Only the host picks it, for a one-host type, and only with an active Google connection that has write-back on: a connection is its member's alone (the database shows it to nobody else), so an owner or admin cannot pick it for someone else, and a team type cannot have it in this slice. A type that already has it keeps it when someone else edits the rest. A host without a Google connection sees the kind is unavailable and keeps phone, in person or the fixed link.
- **Where the Meet is made.** In the C6 write-back job. `crm.booking.confirm` confirms a booking of a `google_meet` type as `meeting_state = 'pending'` when the host's connection can write; its calendar event carries `conference = true`, the write-back plan hands the worker the flag, and the Google adapter inserts the event with the conference request (its `requestId` is the event's id, so a retry never makes a second Meet) and reads the join link back (`hangoutLink`, else the video entry point; a request Google has not finished is looked at again twice). Only a `https://meet.google.com/...` address is kept as a link, in the adapter, in the command and in a CHECK of the table. A 400 on the insert (an account that cannot host Meet) writes the event without a conference.
- **Stored on the booking.** `crove_crm.booking.meeting_state` (`none`, `pending`, `ready`, `failed`) and `meeting_url`, set by the system command `crm.booking.meeting_settle`, which the worker calls after the Google call and before it records the link (a crash between the two repeats a write that makes no second Meet), or the delayed job below. A move patches the same event (the same Meet); a cancel deletes it (the Meet goes with it).
- **Mails and `.ics`.** The confirmation mails of a Meet booking are queued when the outcome is known (seconds), so the first mail already carries the link in its text, its `.ics` `LOCATION`, `URL` and description; the host's private calendar feed shows it too. Reminders and moves read the booking as it is when they are sent. A cancelled booking names no link.
- **A Google failure leaves the booking valid.** No link, an address that is not a Meet one, or no outcome within 3 minutes (a worker that was down, an outage: the delayed job `crm-booking-meet`, queued when the booking is confirmed, settles it) settles the booking as `failed`: its event stops asking for a conference, the mails go out with the type's fixed link when it has one, and the host's mail and the bookings list say that the Meet could not be made. The visitor's mail says nothing of the failure.
- **After the review.** (1) A host who cannot make a Meet when a booking of a Meet type is confirmed (the connection is gone, or write-back is off) gets the booking `failed` from the start, not `none`, so the host's mail says the Meet could not be made and the screen shows the badge, and the visitor has the fixed link; the host's note is in the mail of a new booking only, not in reminders and moves. (2) A connection whose token is about to run out is left to the sweep by the write-back job, which would have missed the 3 minutes: the job now counts such connections, and the worker asks for a sweep at once (at most one a minute; the sweep is what renews and writes, so nothing crosses it; a request made inside the minute, while a sweep runs here, or while another worker process holds it, waits for its turn and is retried for about ten minutes, instead of being dropped). (3) A booking moved while its Meet is pending holds the move's mails too (nobody was told the first time); the confirmation sent when the Meet is settled names the new time and the current revision. (4) A settled booking's event stops asking for a conference in both outcomes: a ready one keeps the Meet Google made, and a later write does not send the request again. (5) A Meet address is `https://meet.google.com/<code>` or `https://meet.google.com/lookup/<code>` (the form Google gives some conferences made through the API), in the adapter, the contract and the database. (6) The join link is chosen from the booking's own state first, so a type switched away from Meet afterwards keeps the link in later mails; the `.ics` has a `URL` line for the Meet link only, and the host's booking feed shows a ready booking's link whatever kind the type has now; the host's failure note does not depend on the type's kind now either. (7) A reminder is skipped while the booking's Meet is pending (its confirmation, sent within minutes, is the first mail). (8) The bookings list is read again every 5 seconds while a listed booking waits for its Meet (the settle sends no stream hint). (9) A host with two Google connections that write back has the event written to both, but only the one connected first asks for the Meet, so a booking has one join link. (10) The event type form falls back to a link when the host or the assignment of a Meet type is changed away from the rule. (11) The kernel's `conference` column is its own kernel migration (`20261121170000`), apart from the crm one. Not done, as follow-ups: a conference Google has not finished after the adapter's two looks is settled as failed (the event may get its Meet moments later), and the booking feed's `SEQUENCE` does not rise when the link arrives.
- **What the AI part is.** None. Preparing a meeting brief from the deal and the conversation is a later item.
- **Not in this slice:** Zoom and Teams, a Meet for a team type, the Meet of a booking made before the type was switched to it, and picking Meet for another host.

## 5. Exit criteria (v1)

- No double booking: 200 concurrent bookings of one slot give exactly 1 success.
- Times stored as UTC plus IANA zone; slots correct across zones, including one that changes offset inside the horizon.
- A visitor sees only free slots of the event type, nothing else about the host's calendar.
- Every write goes through `Runtime.execute()`; the public endpoint is rate limited and on the reasoned public list.
- `docker compose up` gives a working booking page with mails in Mailpit, with no external account.

## 6. Decisions and open questions

| # | Question | Default |
|---|---|---|
| CAL-1 | Change to the route-coverage invariant (a new public route). Adding to the reasoned public list is an invariant change: done in C3 with the security review, in two steps if the base copy refuses it | Two steps: the list entry first, the route after |
| CAL-2 | Turnstile on the booking page | Optional, on when keys are set; Cloud keys are an owner action |
| CAL-3 | Product name in the UI | "Lịch hẹn" inside CRM; sold with the `crm` entitlement (Decision 10) |
| CAL-4 | External calendars | Later (C6); needs Google and Microsoft OAuth apps, an owner action |
