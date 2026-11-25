// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AUDIO_MAX_BYTES,
  AUDIO_RETENTION_DAYS,
  CONSENT_NOTICE_VERSION,
  MEETING,
  meetingsManifest,
  TEXT_RETENTION_DAYS,
  VIDEO_MAX_BYTES,
  VIDEO_RETENTION_DAYS,
} from '../src/manifest.ts';
import {
  meetingAudioRead,
  meetingGet,
  meetingList,
  meetingMediaMeta,
  mediaExtension,
  meetingMediaRecord,
  meetingVideoRead,
  meetingVisibleIds,
  meetingsCommands,
  meetingsQueries,
} from '../src/meetings.ts';

describe('meetings manifest and constants', () => {
  it('exposes the expected manifest properties', () => {
    expect(meetingsManifest.id).toBe('meetings');
    expect(meetingsManifest.dependsOn).toEqual(['kernel']);
    expect(meetingsManifest.tables.ludy_meetings.meeting).toBeDefined();
    expect(meetingsManifest.tables.ludy_meetings.meeting_reader).toBeDefined();
    expect(meetingsManifest.tables.ludy_meetings.audio_segment).toBeDefined();
    expect(meetingsManifest.tables.ludy_meetings.meeting_video).toBeDefined();
    expect(meetingsManifest.tables.ludy_meetings.media_key).toBeDefined();
    expect(meetingsManifest.routes).toHaveLength(4);
    expect(meetingsManifest.routes[0].path).toBe('meetings');
    expect(meetingsManifest.routes[1].path).toBe('meetings/record');
    expect(meetingsManifest.routes[2].path).toBe('meetings/$id');
    // The printable minutes, outside the org's frame (A4, #3162).
    expect(meetingsManifest.routes[3].path).toBe('print/meeting-minutes/$id');
    // One menu item, in the Cộng tác app next to the team's tasks and notes (#3225).
    expect(meetingsManifest.nav).toEqual([{ app: 'teamwork', group: 'work', path: 'meetings', label: 'meetings' }]);
  });

  it('exposes MEETING columns and sensitive media_key configuration', () => {
    expect(MEETING).toBeDefined();
    expect(MEETING['org_id']).toBe('internal');
    expect(MEETING['id']).toBe('internal');
    expect(MEETING['recorder_user_id']).toBe('internal');
    expect(MEETING['consent_method']).toBe('internal');
    expect(MEETING['audio_retention_date']).toBe('internal');
    expect(MEETING['title']).toBe('pii');

    const mediaKey = meetingsManifest.tables.ludy_meetings.media_key;
    expect(mediaKey['wrapped_key']).toBe('sensitive');
  });

  it('enforces retention and file size constants', () => {
    expect(AUDIO_MAX_BYTES).toBe(300 * 1024 * 1024);
    expect(VIDEO_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(AUDIO_RETENTION_DAYS).toBe(30);
    expect(VIDEO_RETENTION_DAYS).toBe(7);
    expect(TEXT_RETENTION_DAYS).toBe(365);
    expect(CONSENT_NOTICE_VERSION).toBe('2026-11-v1');
  });
});

describe('meetings commands and queries construction', () => {
  it('exposes all required commands', () => {
    const names = meetingsCommands.map((c) => c.name);
    expect(names).toEqual([
      'meetings.meeting.create',
      'meetings.media.record',
      'meetings.meeting.recording_stopped',
      'meetings.meeting.delete',
      'meetings.meeting.owner_delete',
      'meetings.meeting.owner_list',
      'meetings.reader.add',
      'meetings.reader.remove',
      'meetings.media_key.reseal',
      'meetings.settings.set',
      'meetings.consent_policy.set',
      'meetings.minutes_esign.set',
      'meetings.minutes_link.switch.set',
      'meetings.minutes_link.create',
      'meetings.minutes_link.revoke',
      'meetings.retention.shred',
      'meetings.shred.replay',
      'meetings.media.discard',
      'meetings.transcript.draft_store',
      'meetings.transcript.correct',
      'meetings.transcript.redact',
      'meetings.transcript.start',
      'meetings.transcript.cancel',
      'meetings.transcript.copy_result',
      'meetings.minutes.set_template',
      'meetings.summary.save',
      'meetings.action_item.create',
      'meetings.action_item.edit',
      'meetings.action_item.delete',
      'meetings.result.publish',
      'meetings.action_item.accept',
      'meetings.action_item.accept_clean',
      'meetings.notes.save',
      'meetings.chapters.save',
      'meetings.tracker.add',
      'meetings.tracker.remove',
      'meetings.tracker.alert_set',
      'meetings.tracker.alert_notice',
      'meetings.highlight.add',
      'meetings.highlight.remove',
      'meetings.label.add',
      'meetings.label.remove',
      'meetings.chapters.start',
      'meetings.title.start',
      'meetings.meeting.rename',
      'meetings.commitments.start',
      'meetings.template_suggest.start',
      'meetings.open_points.start',
      'meetings.sales_insight.start',
      'meetings.summary.copy_result',
      'meetings.chapters.copy_result',
      'meetings.speaker.name',
      'meetings.series.set',
      'meetings.series.nudge',
      'meetings.template.create',
      'meetings.template.update',
      'meetings.template.archive',
      'meetings.minutes_version.publish',
      'meetings.minutes_version.unpublish',
      'meetings.glossary.add',
      'meetings.glossary.update',
      'meetings.glossary.remove',
      'meetings.draft.review',
      'meetings.summary.start',
      'meetings.summary.ready',
      'meetings.summary.ready_notice',
      'meetings.translation.copy_result',
      'meetings.translate.start',
      'meetings.translation.transcript_start',
      'meetings.translation.transcript_stop',
      'meetings.ask.start',
      'meetings.brief.start',
      'meetings.digest.start',
      'meetings.voice_cue.draft',
      'meetings.morning.set',
      'meetings.morning.notice',
      'meetings.assignee.start',
      'meetings.adherence.start',
      'meetings.agenda.set_read_events',
      'meetings.agenda.clear',
      'meetings.agenda.link',
      'meetings.agenda.replace',
      'meetings.chat.channel_save',
      'meetings.chat.channel_remove',
      'meetings.chat.post',
      'meetings.chat.queued',
      'meetings.chat.record',
      'meetings.chat.reseal',
      'meetings.link.add',
      'meetings.link.remove',
      'meetings.followup.send',
      'meetings.followup.note_start',
      'meetings.deal_update.start',
      'meetings.deal_update.confirm',
      'meetings.live.chunk',
      'meetings.capture.heartbeat',
      'meetings.live.assemble_record',
      'meetings.live.start',
      'meetings.live.stop',
      'meetings.live.notes_start',
      'meetings.live.tick',
      'meetings.live.notes_copy',
      'meetings.hook.set',
      'meetings.hook.rotate_secret',
      'meetings.hook.clear',
      'meetings.hook.test',
      'meetings.hooks.switch.set',
      'meetings.hook.queued',
      'meetings.hook.record',
      'meetings.import.start',
      'meetings.import.discard_empty',
      'meetings.import.take_transcript',
    ]);

    expect(meetingMediaRecord.name).toBe('meetings.media.record');
    for (const cmd of meetingsCommands) {
      expect(cmd.handler).toBeTypeOf('function');
    }
  });

  it('exposes meetings queries', () => {
    const names = meetingsQueries.map((q) => q.name);
    expect(names).toEqual([
      'meetings.meeting.list',
      'meetings.meeting.get',
      'meetings.meeting.visible_ids',
      'meetings.meeting.extension_status',
      'meetings.meeting.recording_now',
      'meetings.meeting.audio_read',
      'meetings.meeting.video_read',
      'meetings.meeting.media_meta',
      'meetings.settings.get',
      'meetings.consent_policy.get',
      'meetings.minutes_esign.get',
      'meetings.minutes_link.switch.get',
      'meetings.minutes_link.list',
      'meetings.media.orphan_keys',
      'meetings.transcript.get',
      'meetings.transcript.redact_candidates',
      'meetings.search',
      'meetings.transcript.status',
      'meetings.result.get',
      'meetings.action_item.source',
      'meetings.notes.get',
      'meetings.chapters.get',
      'meetings.chapters.status',
      'meetings.title.status',
      'meetings.commitments.status',
      'meetings.template.suggest',
      'meetings.template_suggest.status',
      'meetings.open_points.status',
      'meetings.sales_insight.status',
      'meetings.sales_insight.facts',
      'meetings.notes.preview',
      'meetings.summary.attendees',
      'meetings.speaker.suggestions',
      'meetings.series.open_items',
      'meetings.template.list',
      'meetings.minutes_version.get',
      'meetings.glossary.list',
      'meetings.glossary.for_meeting',
      'meetings.summary.status',
      'meetings.translation.source',
      'meetings.translation.status',
      'meetings.translation.get',
      'meetings.translation.transcript_status',
      'meetings.translation.transcript_source',
      'meetings.translation.transcript_get',
      'meetings.ask.lines',
      'meetings.ask.status',
      'meetings.brief.facts',
      'meetings.brief.status',
      'meetings.digest.facts',
      'meetings.digest.status',
      'meetings.load.week',
      'meetings.tracker.list',
      'meetings.tracker.hits',
      'meetings.tracker.week',
      'meetings.tracker.alert_get',
      'meetings.highlight.list',
      'meetings.label.list',
      'meetings.label.index',
      'meetings.minutes_docx.download',
      'meetings.today.facts',
      'meetings.morning.get',
      'meetings.assignee.facts',
      'meetings.assignee.status',
      'meetings.adherence.agenda',
      'meetings.adherence.facts',
      'meetings.adherence.status',
      'meetings.agenda.list',
      'meetings.agenda.next',
      'meetings.agenda.suggest',
      'meetings.chat.channels',
      'meetings.chat.preview',
      'meetings.chat.status',
      'meetings.chat.delivery',
      'meetings.chat.target',
      'meetings.link.list',
      'meetings.link.by_target',
      'meetings.link.suggest',
      'meetings.followup.draft',
      'meetings.followup.note_status',
      'meetings.deal_update.status',
      'meetings.deal_update.facts',
      'meetings.live.status',
      'meetings.live.notes_input',
      'meetings.live.assemble_plan',
      'meetings.hook.get',
      'meetings.hook.delivery',
      'meetings.hook.target',
      'meetings.mcp.list',
      'meetings.mcp.minutes',
      'meetings.mcp.open_actions',
      'meetings.mcp.series_open_items',
      'meetings.mcp.decisions',
      'meetings.mcp.search',
      'meetings.mcp.visible_ids',
      'meetings.transcript.download',
      'meetings.speaking_style.get',
    ]);

    expect(meetingList.name).toBe('meetings.meeting.list');
    expect(meetingGet.name).toBe('meetings.meeting.get');
    expect(meetingVisibleIds.name).toBe('meetings.meeting.visible_ids');
    expect(meetingAudioRead.name).toBe('meetings.meeting.audio_read');
    expect(meetingVideoRead.name).toBe('meetings.meeting.video_read');
    expect(meetingMediaMeta.name).toBe('meetings.meeting.media_meta');
  });
});

describe('mediaExtension (#2703)', () => {
  it('names the stored file by the sniffed container', () => {
    expect(mediaExtension('audio/ogg', 'audio')).toBe('ogg');
    expect(mediaExtension('audio/webm', 'audio')).toBe('webm');
    expect(mediaExtension('audio/mp4', 'audio')).toBe('m4a');
    expect(mediaExtension('audio/mpeg', 'audio')).toBe('mp3');
    expect(mediaExtension('audio/wav', 'audio')).toBe('wav');
    expect(mediaExtension('video/webm', 'video')).toBe('webm');
    expect(mediaExtension('video/mp4', 'video')).toBe('mp4');
  });

  it('falls back for an unknown type', () => {
    expect(mediaExtension('application/x-unknown', 'audio')).toBe('bin');
    expect(mediaExtension('application/x-unknown', 'video')).toBe('mp4');
  });
});
