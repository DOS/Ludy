// SPDX-License-Identifier: AGPL-3.0-only
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const meetingsManifest = defineModule({
  id: 'meetings',
  dependsOn: ['kernel'],
  tables: {
    crove_meetings: {
      audio_segment: columns([
        'org_id',
        'id',
        'meeting_id',
        'file_id',
        'segment_order',
        'start_offset_seconds',
        'length_seconds',
        'created_at',
      ]),
      media_key: columns(
        ['org_id', 'id', 'meeting_id', 'key_id', 'kind', 'created_at'],
        { wrapped_key: 'sensitive' },
      ),
      meeting: columns(
        [
          'org_id',
          'id',
          'recorder_user_id',
          'visibility',
          'language',
          'status',
          'started_at',
          'ended_at',
          'length_seconds',
          'keep_video',
          'consent_method',
          'consent_confirmed_by',
          'consent_confirmed_at',
          'consent_notice_version',
          'audio_retention_date',
          'text_retention_date',
          'created_at',
          'updated_at',
        ],
        { title: 'pii' },
      ),
      meeting_reader: columns(['org_id', 'id', 'meeting_id', 'user_id', 'created_at']),
      meeting_video: columns([
        'org_id',
        'id',
        'meeting_id',
        'file_id',
        'length_seconds',
        'video_retention_date',
        'created_at',
      ]),
    },
  },
  permissions: [],
  entities: [
    { type: 'meetings.meeting', table: 'meeting', legalEntityScoped: false, audit: 'command' },
  ],
  ...MODULE_SCREENS.meetings,
});

export const MEETING = meetingsManifest.tables.crove_meetings.meeting;

export const AUDIO_RETENTION_DAYS = 30;
export const TEXT_RETENTION_DAYS = 365;
export const VIDEO_RETENTION_DAYS = 7;
export const AUDIO_MAX_BYTES = 300 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const CONSENT_NOTICE_VERSION = '2026-11-v1';
