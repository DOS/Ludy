// SPDX-License-Identifier: AGPL-3.0-only
import { MODULE_SCREENS, columns, defineModule } from '@ludy/kernel-contract';

export const meetingsManifest = defineModule({
  id: 'meetings',
  dependsOn: ['kernel'],
  tables: {
    ludy_meetings: {
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
        // True for a recording joined from the live pieces, which a late complete upload may replace (#3187).
        'joined_from_pieces',
        'created_at',
      ]),
      // A member's own Google Calendar meetings, read to suggest "record this meeting" (B1, #3165): title, start, end, time zone, a join address and the number of invitees, never an invitee address, a description or an attachment. Read by the member alone.
      calendar_agenda: columns(
        [
          'org_id',
          'id',
          'connection_id',
          'user_id',
          'external_id',
          'starts_at',
          'ends_at',
          'time_zone',
          'invitee_count',
          'meeting_id',
          // A hash of the provider and the recurring event id (md5, kept as a uuid), never the provider's own id (#3542).
          'series_id',
          'updated_at',
        ],
        { title: 'pii', join_url: 'sensitive' },
      ),
      // The record that a call is being captured right now (ADR-0055 slice 1, #4123): the kind of client, the times and a hash that tells one call from another. No content, no address, no title.
      capture_session: columns(['org_id', 'id', 'meeting_id', 'recorder_user_id', 'kind', 'agenda_id', 'meeting_key', 'started_at', 'last_seen_at', 'ended_at', 'ended_reason']),
      // The org's channels for minutes, Slack or Teams (B4, #3168): a name and the address's host. No secret: the address is sealed in chat_channel_target.
      chat_channel: columns(['org_id', 'id', 'kind', 'label', 'host', 'created_by', 'created_at', 'updated_at']),
      // The sealed address of a minutes channel (B4, #3168): definer-only, opened by the worker's job (the API seals it and never opens it).
      chat_channel_target: columns(['org_id', 'id', 'channel_id', 'key_id', 'sealed_at'], { envelope: 'sensitive' }),
      // The recorder's log of minutes posted to a channel (B4, #3168): ids, a state, the status, a code and hashes; never the text.
      chat_post: columns(['org_id', 'id', 'meeting_id', 'channel_id', 'user_id', 'facts_key', 'text_hash', 'state', 'attempts', 'http_status', 'code', 'created_at', 'handed_at', 'sending_at', 'settled_at']),
      // The message of a queued post (B4, #3168): definer-only, deleted when the post settles. The body is the meeting's text, personal data.
      chat_post_body: columns(['org_id', 'id', 'post_id', 'created_at'], { body: 'pii' }),
      // The glossary an org's owner or admin keeps (#4043): terms (a product, an acronym, jargon) Vy spells the org's way. Plain text the org wrote; the settings screen asks for no people's names
      // or personal details, and the command refuses an email or web address and a number. Nothing here is a meeting's own text.
      glossary_term: columns(['org_id', 'id', 'term', 'created_by', 'created_at', 'updated_at']),
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
          // When a transcription or summary was started on the recording (#3187): a joined recording is replaced only while this is empty.
          'audio_used_at',
          // A code (general, briefing, customer, supplier, one_on_one), never text (A4, #3162).
          'summary_template',
          'audio_retention_date',
          'text_retention_date',
          // The series the meeting is in: a random id, or the hash of the recurring calendar event it was linked to (#3542). Never text.
          'series_id',
          // The meeting's own copy of the org template it was summarized with (#3578): its name, its sections and their hash. Layout the org wrote, not personal data (the class 'internal':
          // listed here, not under a personal class); the settings screen asks for no names or personal details in a template.
          'minutes_template_name',
          'minutes_template_sections',
          'minutes_template_hash',
          // True while the draft is a platform's transcript that was cut (#3922): a flag, never text.
          'platform_transcript_cut',
          'created_at',
          'updated_at',
        ],
        { title: 'pii' },
      ),
      // The chapters (table of contents) of a meeting (#3844): a title and the second of the transcript line it starts at; a draft the recorder reads, published for the readers. A title is plain text, personal data.
      meeting_chapter: columns(['org_id', 'id', 'meeting_id', 'stage', 'position', 'start_seconds', 'tainted', 'source_run_id', 'created_at', 'updated_at'], { title: 'pii' }),
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
      // The minutes templates an org's owner or admin writes (#3578): a name and 1 to 8 sections (title, hint for Vy). Layout the org wrote, not personal data; the settings screen asks for no
      // names or personal details in a template. The meeting's own copy of one is on the meeting row.
      minutes_template: columns(['org_id', 'id', 'name', 'sections', 'archived_at', 'created_by', 'created_at', 'updated_at']),
      // A member's own opt-in to the morning notice of the day's meetings (#3955): a time of day, their time zone and the language of the mail. One row per member, theirs alone; no title, name or text of a meeting is in it.
      morning_notice: columns(['org_id', 'id', 'user_id', 'send_minute', 'time_zone', 'language', 'created_at', 'updated_at']),
      // The transcript (#2578): what was said, who it is attributed to, when. Text and speaker label are personal data.
      transcript_segment: columns(
        ['org_id', 'id', 'meeting_id', 'start_seconds', 'end_seconds', 'stage', 'corrected', 'tainted', 'source_run_id', 'source', 'created_at', 'updated_at'],
        { speaker_label: 'pii', text: 'pii', search: 'pii' },
      ),
      // The machine translation of a meeting's summary (meetings integrations E1, #3184): private to the member who asked, tainted. The body (the translated text) is personal data.
      translation: columns(['org_id', 'id', 'meeting_id', 'member_user_id', 'kind', 'target_language', 'source_stage', 'source_hash', 'tainted', 'source_run_id', 'created_at'], { body: 'pii' }),
    },
  },
  permissions: [],
  entities: [
    // A term of the org's glossary (#4043): the target of its update and remove commands.
    { type: 'meetings.glossary_term', table: 'glossary_term', legalEntityScoped: false, audit: 'command' },
    { type: 'meetings.meeting', table: 'meeting', legalEntityScoped: false, audit: 'command' },
    // A minutes template the org wrote (#3578): the target of its update and archive commands.
    { type: 'meetings.minutes_template', table: 'minutes_template', legalEntityScoped: false, audit: 'command' },
  ],
  ...MODULE_SCREENS.meetings,
});

export const MEETING = meetingsManifest.tables.ludy_meetings.meeting;

export const AUDIO_RETENTION_DAYS = 30;
export const TEXT_RETENTION_DAYS = 365;
export const VIDEO_RETENTION_DAYS = 7;
export const AUDIO_MAX_BYTES = 300 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// The version of the notice text lives in the contract (a client sends the version it showed); the current one is the default.
export { CONSENT_NOTICE_VERSION } from '@ludy/kernel-contract';
