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
  buildMeetingsCommands,
  buildMeetingsQueries,
  meetingAudioRead,
  meetingGet,
  meetingList,
  meetingVideoRead,
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
    expect(meetingsManifest.routes).toHaveLength(2);
    expect(meetingsManifest.routes[0].path).toBe('meetings');
    expect(meetingsManifest.routes[1].path).toBe('meetings/$id');
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
  it('builds all required commands with dependencies', () => {
    const fakeStore = {} as any;
    const fakeBroker = {} as any;
    const commands = buildMeetingsCommands({ store: fakeStore, broker: fakeBroker });

    const names = commands.map((c) => c.name);
    expect(names).toEqual([
      'meetings.meeting.create',
      'meetings.media.claim',
      'meetings.meeting.delete',
      'meetings.meeting.owner_delete',
      'meetings.reader.add',
      'meetings.reader.remove',
    ]);

    for (const cmd of commands) {
      expect(cmd.handler).toBeTypeOf('function');
    }
  });

  it('exposes meetings queries', () => {
    const queries = buildMeetingsQueries();
    const names = queries.map((q) => q.name);
    expect(names).toEqual([
      'meetings.meeting.list',
      'meetings.meeting.get',
      'meetings.meeting.audio_read',
      'meetings.meeting.video_read',
    ]);

    expect(meetingList.name).toBe('meetings.meeting.list');
    expect(meetingGet.name).toBe('meetings.meeting.get');
    expect(meetingAudioRead.name).toBe('meetings.meeting.audio_read');
    expect(meetingVideoRead.name).toBe('meetings.meeting.video_read');
  });
});
