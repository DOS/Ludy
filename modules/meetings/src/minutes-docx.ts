// SPDX-License-Identifier: AGPL-3.0-only
// The published biên bản as a Word file (#4774, plan docs/plan/meetings.md L17), the module's side.
//
// meetings.minutes_docx.download   the file of the minutes a reader of the meeting may read: the published result (summary, decisions) and the published action items, laid out as the printable page does
//                                  and per the meeting's template (a built-in one, or the meeting's own copy of an organization's). A sensitive read: each one leaves an audit row naming the meeting, and
//                                  nothing of the text is in it.
//
// The reader rule is the minutes page's: the meeting is opened under the caller's own row security and its text period (a meeting the caller does not read, or whose text has gone, is a 404), and only rows
// whose stage is 'published' are selected, so a draft, a transcript, a private Vy result and a model's output never enter the file, whoever asks (the recorder included). With nothing published the answer is
// MINUTES_NOT_PUBLISHED (409), as the page shows "Bản nháp" and no content. The date, the people and the due dates come from the meeting and code (its start, its readers, the attendee matched, the date
// parsed), as on the page; names are display names only, never an email address. The place is the one typed on the page, not stored. No model is used and nothing is written.
import { sql } from 'kysely';
import {
  parseStoredSections,
  templateSections,
  textToSections,
  zMeetingSummaryTemplate,
  zMinutesDocx,
  zMinutesDocxInput,
  MINUTES_DOCX_MIME,
  type MeetingSummaryTemplate,
  type MinutesDocx,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { buildMinutesDocx, cleanLine, dueText, minutesFilename, vnMoment, type MinutesDoc, type MinutesDocSection } from './minutes-docx-file.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// A member with no display name (an email address is never a name) or no longer in the org.
const UNKNOWN_MEMBER = 'Thành viên';

export const minutesDocxDownload = defineQuery({
  name: 'meetings.minutes_docx.download',
  input: zMinutesDocxInput,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MinutesDocx> => {
    userOf(ctx.actor);
    const open = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const meeting = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['title', 'started_at', 'created_at', 'ended_at', 'summary_template', 'minutes_template_sections'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    // Published rows only, whoever asks: the recorder's row security would also show their draft, so the stage is asked for here.
    const result = await ctx.trx
      .selectFrom('ludy_meetings.meeting_result')
      .select(['summary', 'decisions'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'published')
      .executeTakeFirst();
    const items = await ctx.trx
      .selectFrom('ludy_meetings.action_item')
      .select(['title', 'who_parsed', sql<string | null>`when_parsed::text`.as('when_parsed')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'published')
      .orderBy('transcript_seconds')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (!result && items.length === 0) throw new DomainError('MINUTES_NOT_PUBLISHED', 409, 'The recorder has not shared the minutes yet');

    // The people: the recorder first, then the readers, and the owner of each item, by display name.
    const readers = await ctx.trx.selectFrom('ludy_meetings.meeting_reader').select('user_id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).orderBy('created_at').orderBy('id').execute();
    const people = [open.recorder_user_id, ...readers.map((r) => r.user_id).filter((id) => id !== open.recorder_user_id)];
    const wanted = [...new Set([...people, ...items.flatMap((i) => (i.who_parsed ? [i.who_parsed] : []))])];
    const names = new Map<string, string>();
    if (wanted.length > 0) {
      const { rows } = await sql<{ user_id: string; display_name: string | null }>`SELECT user_id, display_name FROM ludy_kernel.member_profiles(${wanted}::uuid[])`.execute(ctx.trx);
      // A name as the page shows it: one line, whitespace collapsed (the speaker label's length rule is not applied, so a long name is not lost).
      for (const r of rows) names.set(r.user_id, cleanLine(r.display_name ?? '').replace(/\s+/gu, ' ').trim());
    }
    const nameOf = (userId: string) => (names.get(userId) || UNKNOWN_MEMBER);

    const parsedTemplate = zMeetingSummaryTemplate.safeParse(meeting.summary_template);
    const template: MeetingSummaryTemplate = parsedTemplate.success ? parsedTemplate.data : 'general';
    const copy = template === 'custom' && meeting.minutes_template_sections !== null ? parseStoredSections(meeting.minutes_template_sections) : null;
    let sections: MinutesDocSection[] = [];
    if (result) {
      const defs = templateSections(template, copy);
      const parsed = textToSections(template, result.summary, copy);
      // Text not in the template's form (the template changed since it was shared) is shown whole, as it was shared.
      sections = parsed
        ? parsed
            .filter((s) => s.text !== '')
            .map((s, i) => ({ heading: `${i + 1}. ${defs.find((d) => d.key === s.key)?.title ?? s.key}`, text: s.text }))
        : result.summary.trim() === '' || result.summary.trim() === '-'
          ? []
          : [{ heading: null, text: result.summary }];
    }
    const company = await ctx.trx.selectFrom('ludy_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const startedAt = new Date((meeting.started_at ?? meeting.created_at) as Date | string);
    const from = vnMoment(startedAt);
    const doc: MinutesDoc = {
      company: company?.name ?? '',
      title: meeting.title,
      from,
      to: meeting.ended_at ? vnMoment(new Date(meeting.ended_at as Date | string)) : null,
      place: input.place,
      attendees: people.map(nameOf),
      sections,
      conclusions: result && Array.isArray(result.decisions) ? (result.decisions as unknown[]).filter((d): d is string => typeof d === 'string' && d.trim() !== '') : [],
      actions: items.map((i) => ({ title: i.title, owner: i.who_parsed ? nameOf(i.who_parsed) : null, due: dueText(i.when_parsed) })),
    };
    const bytes = buildMinutesDocx(doc);
    return zMinutesDocx.parse({
      filename: minutesFilename(meeting.title, `${from.year}-${from.month}-${from.day}`),
      mimeType: MINUTES_DOCX_MIME,
      bytes: bytes.length,
      contentBase64: Buffer.from(bytes).toString('base64'),
    });
  },
});

export const minutesDocxQueries = [minutesDocxDownload];
