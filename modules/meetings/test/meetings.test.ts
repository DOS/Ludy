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
  meetingsCommands,
  meetingsQueries,
} from '../src/meetings.ts';

describe('meetings manifest and constants', () => {
  it('exposes the expected manifest properties', () => {
    expect(meetingsManifest.id).toBe('meetings');
    expect(meetingsManifest.dependsOn).toEqual(['kernel']);
    expect(meetingsManifest.tables.crove_meetings.meeting).toBeDefined();
    expect(meetingsManifest.tables.crove_meetings.meeting_reader).toBeDefined();
    expect(meetingsManifest.tables.crove_meetings.audio_segment).toBeDefined();
    expect(meetingsManifest.tables.crove_meetings.meeting_video).toBeDefined();
    expect(meetingsManifest.tables.crove_meetings.media_key).toBeDefined();
    expect(meetingsManifest.routes).toHaveLength(3);
    expect(meetingsManifest.routes[0].path).toBe('meetings');
    expect(meetingsManifest.routes[1].path).toBe('meetings/record');
    expect(meetingsManifest.routes[2].path).toBe('meetings/$id');
    expect(meetingsManifest.nav).toEqual([]);
  });

  it('exposes MEETING columns and sensitive media_key configuration', () => {
    expect(MEETING).toBeDefined();
    expect(MEETING['org_id']).toBe('internal');
    expect(MEETING['id']).toBe('internal');
    expect(MEETING['recorder_user_id']).toBe('internal');
    expect(MEETING['consent_method']).toBe('internal');
    expect(MEETING['audio_retention_date']).toBe('internal');
    expect(MEETING['title']).toBe('pii');

    const mediaKey = meetingsManifest.tables.crove_meetings.media_key;
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
      'meetings.meeting.delete',
      'meetings.meeting.owner_delete',
      'meetings.meeting.owner_list',
      'meetings.reader.add',
      'meetings.reader.remove',
      'meetings.media_key.reseal',
      'meetings.settings.set',
      'meetings.consent_policy.set',
      'meetings.retention.shred',
      'meetings.shred.replay',
      'meetings.media.discard',
      'meetings.transcript.draft_store',
      'meetings.transcript.correct',
      'meetings.transcript.start',
      'meetings.transcript.cancel',
      'meetings.transcript.copy_result',
      'meetings.summary.save',
      'meetings.action_item.create',
      'meetings.action_item.edit',
      'meetings.action_item.delete',
      'meetings.result.publish',
      'meetings.action_item.accept',
      'meetings.action_item.accept_clean',
      'meetings.summary.copy_result',
      'meetings.draft.review',
      'meetings.summary.start',
      'meetings.link.add',
      'meetings.link.remove',
      'meetings.followup.send',
      'meetings.live.chunk',
      'meetings.live.start',
      'meetings.live.stop',
      'meetings.live.notes_start',
      'meetings.live.tick',
      'meetings.live.notes_copy',
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
      'meetings.meeting.extension_status',
      'meetings.meeting.recording_now',
      'meetings.meeting.audio_read',
      'meetings.meeting.video_read',
      'meetings.meeting.media_meta',
      'meetings.settings.get',
      'meetings.consent_policy.get',
      'meetings.media.orphan_keys',
      'meetings.transcript.get',
      'meetings.search',
      'meetings.transcript.status',
      'meetings.result.get',
      'meetings.action_item.source',
      'meetings.summary.status',
      'meetings.link.list',
      'meetings.link.by_target',
      'meetings.link.suggest',
      'meetings.followup.draft',
      'meetings.live.status',
      'meetings.live.notes_input',
    ]);

    expect(meetingList.name).toBe('meetings.meeting.list');
    expect(meetingGet.name).toBe('meetings.meeting.get');
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
