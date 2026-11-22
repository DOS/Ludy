// SPDX-License-Identifier: AGPL-3.0-only
// Rows the AI specs of the meetings line store directly (#4050): a meeting of the signed-in user with the stored transcript the fake model's answers are written for, published decisions and open action items
// of an earlier meeting, an agenda event on the Today view (seeded clear of Vietnam midnight), and the count of the member-Vy runs of a feature. Speech to text, the recorder and publishing have their own specs; here the data is stored so that
// each spec is about one click on one feature. Every statement runs as the database superuser (e2e/lib/db.ts), so it sees what was stored.
import { randomUUID } from 'node:crypto';
import { TRANSCRIPT } from '../fake-model/fixtures.ts';
import { exec, sql } from './db.ts';

export interface Segment {
  from: number;
  to: number;
  who: string;
  said: string;
}

export interface SeedOptions {
  // How long ago the meeting started, in days (default: now).
  daysAgo?: number;
  // The segments of the meeting (default: the three-line transcript of the fake model). A spec adds a line holding a scenario token to change what the model says for this meeting.
  segments?: readonly Segment[];
  // The series the meeting belongs to, so an event of the same series briefs from it.
  seriesId?: string;
}

/** A meeting the user recorded, ready, with a transcript. Returns its id. */
export function seedMeeting(slug: string, email: string, title: string, options: SeedOptions = {}): string {
  const id = randomUUID();
  exec(
    `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
     SELECT t.org_id, :'id'::uuid, :'title', 'vi', now() - (:'days' || ' days')::interval, now() - (:'days' || ' days')::interval + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365, nullif(:'series', '')::uuid
       FROM ludy_kernel.tenant t, ludy_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { id, title, days: String(options.daysAgo ?? 0), series: options.seriesId ?? '', slug, email },
  );
  const segments = (options.segments ?? TRANSCRIPT).map((s) => ({ from_s: s.from, to_s: s.to, who: s.who, said: s.said }));
  if (segments.length > 0) {
    exec(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT m.org_id, m.id, v.from_s, v.to_s, v.who, v.said, 'draft'
         FROM crove_meetings.meeting m, jsonb_to_recordset(:'segments'::jsonb) AS v(from_s int, to_s int, who text, said text)
        WHERE m.id = :'id'::uuid`,
      { id, segments: JSON.stringify(segments) },
    );
  }
  return id;
}

/** What was decided in a meeting (published) and the action items still open from it (published, not yet given to anyone). */
export function publishOutcome(meetingId: string, decisions: readonly string[], openItems: readonly string[], who = 'Lan'): void {
  exec(
    `INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
     SELECT m.org_id, m.id, 'Tóm tắt cuộc họp', :'decisions'::jsonb, 'manual', 'published' FROM crove_meetings.meeting m WHERE m.id = :'id'::uuid`,
    { id: meetingId, decisions: JSON.stringify(decisions) },
  );
  for (const title of openItems) {
    exec(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, tainted, transcript_seconds)
       SELECT m.org_id, gen_random_uuid(), m.id, :'title', :'who', m.recorder_user_id, 'thứ sáu', 'published', 'suggested', false, 10 FROM crove_meetings.meeting m WHERE m.id = :'id'::uuid`,
      { id: meetingId, title, who },
    );
  }
}

// 09:00 today in Vietnam, the clock the Today view counts a day by.
const VN_NINE = `(date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh' + interval '9 hours')`;

/**
 * Waits out the last `windowSeconds` of the Vietnam day (17:00 UTC), so the events a spec seeds and the page it then loads fall on one Vietnam day (#4089). Without it a run that crosses midnight between the
 * seed and the page load puts the event on yesterday or tomorrow, and the Today view does not list it. It waits at most `windowSeconds` plus a second and only in that minute of the day; the whole test has 180 s.
 */
export function waitOutVietnamMidnight(windowSeconds = 60): void {
  const [row] = sql<{ left: number }>(`SELECT extract(epoch FROM ((date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') + interval '1 day') at time zone 'Asia/Ho_Chi_Minh') - now())::float8 AS "left"`);
  const left = row?.left ?? Number.POSITIVE_INFINITY;
  if (left < windowSeconds) exec(`SELECT pg_sleep((:'seconds')::float8)`, { seconds: String(left + 1) });
}

/**
 * An event on the user's agenda today, `hoursAfterNine` hours after 09:00 Vietnam time, of the given series (so it is briefed from the earlier meeting of that series). The first call connects the user's
 * calendar for reading events; no calendar adapter is configured in the e2e stack, so nothing syncs over these rows. Returns the event's id.
 */
export function seedTodayEvent(slug: string, email: string, title: string, seriesId: string, hoursAfterNine = 0): string {
  const id = randomUUID();
  waitOutVietnamMidnight();
  exec(
    `INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events)
     SELECT t.org_id, gen_random_uuid(), u.id, 'google', lower(:'email'), 'e2e', '{}', true
       FROM ludy_kernel.tenant t, ludy_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')
        AND NOT EXISTS (SELECT 1 FROM ludy_kernel.calendar_connection c WHERE c.org_id = t.org_id AND c.user_id = u.id)`,
    { slug, email },
  );
  exec(
    `INSERT INTO crove_meetings.calendar_agenda (org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, series_id)
     SELECT c.org_id, :'id'::uuid, c.id, c.user_id, gen_random_uuid()::text, :'title', ${VN_NINE} + (:'hours' || ' hours')::interval, ${VN_NINE} + (:'hours' || ' hours')::interval + interval '60 minutes', 'Asia/Ho_Chi_Minh', :'series'::uuid
       FROM ludy_kernel.calendar_connection c JOIN ludy_kernel.tenant t ON t.org_id = c.org_id JOIN ludy_kernel.user_account u ON u.id = c.user_id
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { id, slug, email, title, series: seriesId, hours: String(hoursAfterNine) },
  );
  return id;
}

export interface RunRow {
  status: 'running' | 'ready' | 'failed';
  error_code: string | null;
  body: string | null;
}

/** The member-Vy runs of a feature (meetings.title and the like) the org has started, oldest first. A run row is made when the member's click starts the run, before any model call, and holds a fixed code or counts, never the answer. */
export function runRows(slug: string, feature: string): RunRow[] {
  return sql<RunRow>(
    `SELECT r.status, r.error_code, r.body FROM ludy_kernel.member_vy_result r JOIN ludy_kernel.tenant t ON t.org_id = r.org_id WHERE t.slug = :'slug' AND r.feature = :'feature' ORDER BY r.created_at, r.id`,
    { slug, feature },
  );
}

/** How many runs of the feature the org has started. */
export const runsOf = (slug: string, feature: string): number => runRows(slug, feature).length;
