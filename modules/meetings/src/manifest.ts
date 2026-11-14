// SPDX-License-Identifier: AGPL-3.0-only
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const meetingsManifest = defineModule({
  id: 'meetings',
  dependsOn: ['kernel'],
  tables: {
    crove_meetings: {
      // What the recorder keeps of a meeting beyond the transcript (#2580): the summary with its decisions, and the action items. Free text, personal data.
      action_item: columns(
        ['org_id', 'id', 'meeting_id', 'who_parsed', 'when_parsed', 'transcript_seconds', 'stage', 'status', 'flags', 'tainted', 'task_id', 'accepted_by', 'accepted_at', 'source_run_id', 'created_at', 'updated_at'],
        { title: 'pii', who_drafted: 'pii', when_drafted: 'pii' },
      ),
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
      // One event of a member's minutes webhook (member_hook, A6, #3164): the body holds the text the recorder approved and is set to NULL the moment the delivery settles, so afterwards the row is ids, a status and times.
      hook_delivery: columns(['org_id', 'id', 'hook_id', 'meeting_id', 'type', 'status', 'attempts', 'last_code', 'created_at', 'handed_at', 'sent_at'], { body: 'pii' }),
      // The pieces of about 15 seconds a recorder sends while a live-notes meeting runs (ADR-0052 L4a, #3109): order, the ciphertext's file row, size and the recorder's own length. No key, no text.
      live_chunk: columns(['org_id', 'id', 'meeting_id', 'seq', 'file_id', 'size_bytes', 'length_seconds', 'created_at']),
      // The live transcript preview of a meeting being recorded (ADR-0052 L4a, #3110): the recorder's alone, replaced by the batch transcript. Its text is personal data.
      live_line: columns(['org_id', 'id', 'meeting_id', 'seq', 'start_seconds', 'end_seconds', 'tainted', 'source_run_id', 'created_at'], { text: 'pii' }),
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
          'live_notes',
          'extension_token_id',
          'consent_method',
          'consent_confirmed_by',
          'consent_confirmed_at',
          'consent_notice_version',
          // A code (tab_closed, mic_lost, ...), never text or personal data (A1, #3159).
          'recording_stop_reason',
          // A code (general, briefing, customer, supplier, one_on_one), never text (A4, #3162).
          'summary_template',
          'audio_retention_date',
          'text_retention_date',
          'created_at',
          'updated_at',
        ],
        { title: 'pii' },
      ),
      // Links of a meeting to a party, a deal and a calendar event (L1, #2587): ids and a time, no text.
      meeting_link: columns(['org_id', 'id', 'meeting_id', 'party_id', 'deal_id', 'calendar_event_id', 'created_by', 'created_at']),
      // The recorder's own rough notes of a meeting (A5, #3163): read, written and deleted by the recorder alone. Free text, personal data.
      meeting_note: columns(['org_id', 'id', 'meeting_id', 'created_at', 'updated_at'], { body: 'pii' }),
      meeting_reader: columns(['org_id', 'id', 'meeting_id', 'user_id', 'created_at']),
      meeting_result: columns(['org_id', 'id', 'meeting_id', 'feature', 'stage', 'tainted', 'source_run_id', 'created_at', 'updated_at'], { summary: 'pii', decisions: 'pii' }),
      meeting_video: columns([
        'org_id',
        'id',
        'meeting_id',
        'file_id',
        'length_seconds',
        'video_retention_date',
        'created_at',
      ]),
      // A member's own webhook for the minutes they publish (A6, #3164): definer-only. The address can carry a token in its path and the sealed secret is the broker's envelope, so both are sensitive.
      member_hook: columns(['org_id', 'id', 'user_id', 'fields', 'enabled', 'paused_reason', 'secret_hint', 'previous_until', 'failing_since', 'consecutive_failures', 'last_delivery_at', 'last_status', 'created_at', 'updated_at'], { url: 'sensitive', secret_sealed: 'sensitive', previous_sealed: 'sensitive' }),
      // The transcript (#2578): what was said, who it is attributed to, when. Text and speaker label are personal data.
      transcript_segment: columns(
        ['org_id', 'id', 'meeting_id', 'start_seconds', 'end_seconds', 'stage', 'corrected', 'tainted', 'source_run_id', 'created_at', 'updated_at'],
        { speaker_label: 'pii', text: 'pii', search: 'pii' },
      ),
      // The machine translation of a meeting's summary (meetings integrations E1, #3184): private to the member who asked, tainted. The body (the translated text) is personal data.
      translation: columns(['org_id', 'id', 'meeting_id', 'member_user_id', 'kind', 'target_language', 'source_stage', 'source_hash', 'tainted', 'source_run_id', 'created_at'], { body: 'pii' }),
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
// The version of the notice text lives in the contract (a client sends the version it showed); the current one is the default.
export { CONSENT_NOTICE_VERSION } from '@crove/kernel-contract';
