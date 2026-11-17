// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { consentMethodAllowed, type ConsentMethod, type MeetingLanguage, type MeetingSummaryTemplate, type MeetingVisibility } from '@crove/kernel-contract';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import { readConsentPolicy, readRetentionSettings, retentionDates } from './retention.ts';

// The one place a meeting row, its consent record and its readers are written. meetings.meeting.create (a recording, an upload, the extension) and meetings.import.start (a recording a
// meeting platform finished, C1 #3173) both call it, so the org's consent policy, the retention stamps and the reader check are the same for both. Each caller writes its own audit row.
export interface NewMeeting {
  userId: string;
  title: string;
  language: MeetingLanguage;
  visibility: MeetingVisibility;
  // When the call began. A live recording and an upload start now; an import keeps the platform's start time.
  startedAt: Date;
  // The day the retention periods are counted from: always the moment the meeting is created here, so an imported old call is not already past its period.
  retentionFrom: Date;
  lengthSeconds: number | null;
  keepVideo: boolean;
  liveNotes: boolean;
  summaryTemplate: MeetingSummaryTemplate;
  consentMethod: ConsentMethod;
  consentNoticeVersion: string;
  readerUserIds: readonly string[] | undefined;
  extensionTokenId: string | null;
}

export async function createMeetingRow(ctx: CommandContext, m: NewMeeting): Promise<string> {
  // A strict org accepts only a written consent method (A2, #3160): the same refusal for an in-app recording, an extension recording and an
  // upload, since all three make their meeting here. Nothing is created and no audio can follow. A policy changed later does not touch this one.
  if (!consentMethodAllowed(await readConsentPolicy(ctx.trx, ctx.orgId), m.consentMethod)) {
    throw new DomainError('CONSENT_METHOD_NOT_ALLOWED', 422, 'This organization accepts only a written consent method');
  }
  const meetingId = randomUUID();
  // The periods the org's settings give today, stamped on the meeting so the period the participants were told stays true (plan section 9).
  const dates = retentionDates(m.retentionFrom, await readRetentionSettings(ctx.trx, ctx.orgId));

  await ctx.trx
    .insertInto('crove_meetings.meeting')
    .values({
      org_id: ctx.orgId,
      id: meetingId,
      recorder_user_id: m.userId,
      visibility: m.visibility,
      title: m.title,
      language: m.language,
      status: 'ready',
      started_at: m.startedAt,
      ended_at: null,
      length_seconds: m.lengthSeconds,
      keep_video: m.keepVideo,
      live_notes: m.liveNotes,
      summary_template: m.summaryTemplate,
      consent_method: m.consentMethod,
      consent_confirmed_by: m.userId,
      consent_confirmed_at: m.retentionFrom,
      consent_notice_version: m.consentNoticeVersion,
      audio_retention_date: dates.audio,
      text_retention_date: dates.text,
      extension_token_id: m.extensionTokenId,
    })
    .execute();

  if (m.visibility === 'attendees' && m.readerUserIds && m.readerUserIds.length > 0) {
    const uniqueReaderIds = Array.from(new Set(m.readerUserIds.filter((id) => id !== m.userId)));
    if (uniqueReaderIds.length > 0) {
      const validMembers = await ctx.trx
        .selectFrom('crove_kernel.tenant_member')
        .select(['user_id'])
        .where('org_id', '=', ctx.orgId)
        .where('user_id', 'in', uniqueReaderIds)
        .where('role', 'in', ['owner', 'admin', 'member'])
        .execute();
      if (validMembers.length !== uniqueReaderIds.length) {
        throw new DomainError('INVALID_READER', 400, 'All readers must be active non-viewer members of this organization');
      }
      for (const readerId of uniqueReaderIds) {
        await ctx.trx
          .insertInto('crove_meetings.meeting_reader')
          .values({
            org_id: ctx.orgId,
            id: randomUUID(),
            meeting_id: meetingId,
            user_id: readerId,
          })
          .onConflict((oc) => oc.columns(['org_id', 'meeting_id', 'user_id']).doNothing())
          .execute();
      }
    }
  }
  return meetingId;
}
