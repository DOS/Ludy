// SPDX-License-Identifier: AGPL-3.0-only
// Every table of a covered schema (every crove_* schema, COVERED_SCHEMAS) with an org_id column is in the owner export (EXPORT_TABLES, packages/kernel/src/offboarding.ts)
// or on NOT_EXPORTED with the reason (#3201). EXPORT_TABLES is a hand-kept list, so a table a migration adds would
// otherwise be left out of the owner's copy of their data without anyone noticing. offboarding.db.test.ts reads the catalog of its
// migrated database and fails on such a table; org-export-coverage.test.ts checks the reading and the messages on planted catalogs.
import { EXPORT_TABLES, OWNER_RUN_EXPORT_TABLES } from '@ludy/kernel';

// The schemas the check covers: every crove_* schema with org_id tables. A new schema is a failure until its tables are decided (exported or named below).
export const COVERED_SCHEMAS: readonly string[] = ['ludy_finance', 'ludy_kernel', 'ludy_crm', 'ludy_hr', 'ludy_meetings', 'ludy_notes', 'ludy_social', 'ludy_ads', 'ludy_projects', 'ludy_sign'];

// The tables the export leaves out, with why (docs/runbooks/org-offboarding.md says the same in its export list).
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  // Credentials, tokens and keys: secrets, or useless outside this deployment.
  'ludy_kernel.credential': 'sealed channel connection tokens: a credential (the connection row is exported without them)',
  'ludy_kernel.calendar_credential': 'sealed calendar tokens: a credential',
  'ludy_kernel.meeting_platform_credential': 'sealed meeting platform tokens: a credential',
  'ludy_kernel.oauth_state': 'the state of a sign-in in flight: a short-lived credential',
  'ludy_kernel.extension_auth_code': 'a browser extension sign-in code (hash): a credential',
  'ludy_kernel.extension_token': 'a browser extension token (hash): a credential',
  'ludy_kernel.subject_key': "the org's wrapped subject keys (ADR-0017): key material, useless outside the deployment",
  'ludy_kernel.agent_grant': 'the access grants of AI clients: credential-bearing, readable only through definer functions, ended when the org closes',
  'ludy_kernel.agent_grant_wake': 'the wake-up webhooks of those grants, with their sealed secrets: credential-bearing, definer-only',
  // Private to one member by row security (no owner or admin path): the snapshot reads as the system context, which would give the owner what the app never shows them.
  'ludy_kernel.notification': "private to its member: a member's own notifications are readable by that member alone",
  'ludy_kernel.notification_mute': "private to its member: a member's own mutes are readable by that member alone",
  'ludy_kernel.push_subscription': 'private to its member: a browser push subscription (endpoint and keys)',
  'ludy_kernel.native_push_device': 'private to its member: a mobile device push registration (device token)',
  'ludy_kernel.native_push_sent': 'worker delivery ledger of native push dispatches; no member data',
  'ludy_kernel.today_mail': "private to its member: a member's own daily mail setting is readable by that member alone",
  'ludy_kernel.member_home_layout': "private to its member: a member's own Global Home layout preference is readable by that member alone",
  'ludy_kernel.calendar_connection': "private to its member: a member's own connected calendar account is readable by that member alone",
  'ludy_kernel.meeting_platform_connection': "private to its member: a member's own connected meeting platform account is readable by that member alone",
  'ludy_crm.booking_feed': "a member's calendar feed token (hash): a credential",
  'ludy_finance.bank_feed_hook': "a bank feed connection's webhook hook key (hash): a credential, definer-only",
  'ludy_finance.marketplace_hook': "a marketplace connection's push hook key (hash): a credential, definer-only",
  'ludy_finance.marketplace_hook_notice': "a raw marketplace push waiting for the worker (treated as personal data), deleted when the worker claims it and, when older than ten minutes, by the next claim or the nightly sweep: machinery, definer-only",
  'ludy_finance.bank_feed_webhook_notice': "a signed provider notice waiting for the worker (a raw body: personal data), deleted when the worker claims it and, when older than ten minutes, by the next claim or the nightly sweep: machinery, definer-only",
  // Credentials: sealed or hashed, useless outside this deployment.
  'ludy_ads.ad_token_seal': 'sealed ad platform tokens: a credential',
  'ludy_social.calendar_feed': "a calendar feed's token (hash): a credential, the row says nothing without it",
  'ludy_social.chat_alert_target': 'the sealed address of a chat alert: a credential',
  'ludy_meetings.chat_channel_target': 'the sealed address of a meeting chat channel: a credential',
  'ludy_meetings.media_key': "the wrapped keys of a meeting's recording: key material",
  'ludy_meetings.member_hook': "a member's own webhook with its sealed secret: a credential, private to its member",
  'ludy_sign.api_key': 'scoped external eSign REST API key hashes (key_sha256): definer-only credentials',
  'ludy_sign.ca_connection': 'sealed CA provider credentials (secret_envelope): definer-only credentials',
  'ludy_sign.webhook': 'outbound eSign webhook endpoints with broker-sealed HMAC secrets (secret_envelope): definer-only credentials',
  'ludy_sign.webhook_delivery': 'an outbound eSign webhook delivery queue and log row: runtime machinery',
  'ludy_sign.signing_token': 'signing link token hashes: credentials',
  'ludy_sign.signing_otp': 'email signing OTP hashes: short-lived credentials',
  'ludy_sign.template_direct_link': 'template direct signing link token hashes: credentials',
  'ludy_projects.roadmap_otp': 'public roadmap email OTP challenges and session claims: ephemeral credentials, definer-only',
  'ludy_projects.roadmap_subscriber': 'sealed public roadmap voter emails and unsubscribe token hashes: definer-only privacy boundary',
  'ludy_projects.github_webhook_hook': 'per-connection PAT GitHub webhook SHA-256 secret hashes and refusal counters: definer-only credential metadata',
  'ludy_projects.github_webhook_notice': 'transient raw GitHub webhook buffers deleted on worker claim and 10-minute sweep: definer-only machinery',
  'ludy_projects.github_sync_delivery': 'idempotent inbound/outbound GitHub sync delivery metadata ledger: definer-only operational machinery',
  'ludy_hr.attendance_qr_config': 'office attendance QR check-in SHA-256 secret hashes: operational credential config',
  // Private to one member by row security (no owner or admin path), or readable only through the meeting's recorder and reader checks.
  'ludy_social.notification': "private to its member: a member's own social notifications are readable by that member alone",
  'ludy_social.notification_mail_off': "private to its member: a member's own mail preference",
  'ludy_social.notification_mute': "private to its member: a member's own mutes",
  'ludy_social.push_subscription': 'private to its member: a browser push subscription (endpoint and keys)',
  'ludy_notes.todo': "private to its member: a member's own to-dos (counts are in notes.todo_count)",
  'ludy_notes.todo_list': "private to its member: a member's own to-do lists (never exported under ADR-0037)",
  'ludy_sign.member_signature': "private to its member: a member's own saved signature and initials are readable by that member alone",
  'ludy_notes.note_version': 'rolling 20-snapshot revision history of notes: current shared notes are exported in notes.note and private notes stay out (ADR-0037)',
  'ludy_meetings.calendar_agenda': "private to its member: a member's own agenda of upcoming meetings",
  'ludy_meetings.morning_notice': "private to its member: a member's own setting for the morning notice of the day's meetings (a time of day, a time zone, a language)",
  'ludy_meetings.weekly_notice': "private to its member: a member's own setting for the weekly notice of the week's meetings (a Monday time of day, a time zone, a language)",
  'ludy_meetings.minutes_link': "a link to the published minutes for people outside the org (#4822): a token hash is a credential, and a link names a meeting that its reader may not be allowed to read",
  'ludy_meetings.chat_post': "readable by the meeting's recorder alone, as the author",
  'ludy_meetings.chat_post_body': "the body of those posts: readable by the meeting's recorder alone",
  'ludy_meetings.audio_segment': "the meeting's readers only; is_meeting_reader refuses the system context; no export carries a recording (ADR-0047 point 7)",
  'ludy_meetings.meeting_chapter': "the meeting's recorder, or its readers once published: the system context is refused by the row policy (a user context only), so it is not exported; chapter titles stay out of org export",
  'ludy_meetings.tracker_alert': "a member's own opt-in to tracker alerts (no word, no meeting, no text), read by that member in a user context: the system context is refused by the row policy, so it is not exported",
  'ludy_meetings.tracker_term': "the words an owner or admin chose to follow across the org's meetings, read by the members of the org in a user context: the system context is refused by the row policy, so it is not exported",
  'ludy_meetings.meeting_highlight': "the meeting's recorder and its readers: the system context is refused by the row policy (a user context only), so it is not exported; highlight marks stay out of org export",
  'ludy_meetings.live_chunk': "the meeting's recorder only: a live transcript in progress",
  'ludy_meetings.live_line': "the meeting's recorder only: a live transcript in progress",
  'ludy_meetings.capture_session': "the meeting's recorder only: the record that a call is being captured (the kind of client and times; no content, no address)",
  'ludy_meetings.meeting_note': "the meeting's recorder only",
  'ludy_meetings.meeting_video': "the meeting's attendees only: no export carries a recording (ADR-0047 point 7)",
  'ludy_meetings.minutes_version': "the meeting's readers, once the minutes are shared and the recorder has published it: the system context is refused by is_meeting_reader, so it is not exported (the original minutes follow the same rule)",
  'ludy_meetings.translation': "private to the member who asked for it, within the meeting's attendees",
  // Exported by another route.
  'ludy_meetings.meeting': 'only the meetings shared with the org, through ludy_kernel.meeting_export_rows() (meetings.meeting); attendees-only ones are counted in meetings.private_count',
  'ludy_meetings.meeting_link': 'the links of those shared meetings, through ludy_kernel.meeting_link_export_rows() (meetings.link)',
  'ludy_meetings.meeting_label': 'the labels of those shared, unexpired meetings, through ludy_kernel.meeting_label_export_rows() (meetings.label)',
  'ludy_meetings.meeting_reader': 'the readers of those shared, unexpired meetings, through ludy_kernel.meeting_reader_export_rows() (meetings.reader)',
  'ludy_meetings.transcript_segment': 'the published transcript segments of those shared, unexpired meetings, through ludy_kernel.meeting_transcript_export_rows() (meetings.transcript_segment)',
  'ludy_meetings.meeting_result': 'the published summary and decisions of those shared, unexpired meetings, through ludy_kernel.meeting_result_export_rows() (meetings.result)',
  'ludy_meetings.action_item': 'the published action items of those shared, unexpired meetings, through ludy_kernel.meeting_action_item_export_rows() (meetings.action_item)',
  // Runtime machinery, caches and logs.
  'ludy_meetings.hook_delivery': 'a webhook delivery queue row: runtime machinery',
  'ludy_social.digest_week': 'a weekly digest marker (sent_at): machinery',
  'ludy_social.feed_item': 'the items a feed produced: a fetch cache, the posts they became are in social.post',
  'ludy_social.link_preview': 'a cache of fetched link previews',
  'ludy_social.report_schedule_run': 'a log of scheduled report runs: machinery',
  // Runtime machinery: recomputed, expiring or only meaningful while the org runs.
  'ludy_ads.ad_token_revoke': 'the queue that revokes platform tokens, with the keyed hash of the grantor: machinery',
  'ludy_kernel.agent_wake_delivery': 'a wake-up delivery queue row: runtime machinery',
  'ludy_kernel.agent_wake_signal_seen': 'which wake-up signals were seen: runtime machinery',
  'ludy_kernel.agent_wakeup': 'agent wake-ups: runtime machinery (offboarding already says so)',
  'ludy_kernel.ai_budget_reservation': 'short-lived in-flight AI budget reservation holds: runtime machinery',
  'ludy_kernel.ai_run': 'agent run records with their cost and status: runtime machinery',
  'ludy_kernel.auth_session_org': "a member's session in the org: session record, not tenant data",
  'ludy_kernel.calendar_event_link': 'the sync state between a calendar event and its external copy (hash, attempts): recomputed by the next sync',
  'ludy_kernel.conversation_composing': 'who is typing in a conversation: expires in seconds',
  'ludy_kernel.conversation_read': 'read marks are per-member state (the conversation core comment says so)',
  'ludy_kernel.external_call': 'the ledger of calls to outside platforms (idempotency of outbound calls): runtime machinery, no personal data',
  'ludy_kernel.file_upload': 'an upload in flight (staging key, expiry): runtime machinery',
  'ludy_kernel.idempotency_key': 'idempotency keys and their stored responses: machinery',
  'ludy_kernel.inbound_address': 'inbound address tokens are secrets and permanent tombstones (#37)',
  'ludy_kernel.inbound_drop': 'drop counts of an inbound address: machinery',
  'ludy_kernel.meeting_platform_recording': "a meeting platform's recording list and staging keys: an import queue; the meeting it became is in meetings.meeting",
  'ludy_kernel.org_usage': 'the raw AI and usage metering rows the budget is computed from: machinery, not tenant records',
  'ludy_kernel.outbox_archive': 'the list of archived outbox days: machinery',
  'ludy_kernel.outbox_held': 'the ids of events that wait while an app is off (ADR-0053): machinery',
  'ludy_kernel.outbox_event': 'the outbox: machinery, archived by the retention job',
  'ludy_kernel.outbox_pending': 'the outbox delivery queue: machinery',
  'ludy_kernel.refusal_tally': 'refusal counters per window: rate-limit machinery',
  'ludy_kernel.usage_deferral': 'a deferred metering retry: machinery',
  // Private to one member: the line's precedent exports counts only (kernel.member_vy_private_count).
  'ludy_kernel.member_vy_memory': "private to its member (ADR-0049): readable by that member alone, no owner, admin or system context reads it; the count is in kernel.member_vy_private_count",
  'ludy_kernel.member_vy_result': "private to its member (ADR-0049): readable by that member alone; the count is in kernel.member_vy_private_count",
};

const TABLE = /(?:crove|ludy)_[a-z0-9_]+\.[a-z0-9_]+(?!\w|\()/g;

// A table named only inside a subquery's WHERE would count as exported here; none does today.
// The tables the export reads rows of: the tables named in each `from`, without the functions (`ludy_notes.private_counts()`),
// which answer counts or filtered rows and are not a table of their own.
// The owner-run tables (OWNER_RUN_EXPORT_TABLES, the hr payroll tables an owner reads live) count as exported too: they are in the owner's copy, by another route.
export function exportedTables(
  tables: Readonly<Record<string, { from: string }>> = EXPORT_TABLES,
  ownerRun: Readonly<Record<string, { from: string }>> = OWNER_RUN_EXPORT_TABLES,
): Set<string> {
  const out = new Set<string>();
  for (const { from } of [...Object.values(tables), ...Object.values(ownerRun)]) for (const m of from.matchAll(TABLE)) out.add(m[0]);
  return out;
}

export function exportCoverageProblems(catalogTables: readonly string[], exported: ReadonlySet<string>, notExported: Readonly<Record<string, string>> = NOT_EXPORTED): string[] {
  const problems: string[] = [];
  const catalog = new Set(catalogTables.filter((t) => COVERED_SCHEMAS.includes(t.slice(0, t.indexOf('.')))));
  for (const table of [...catalog].sort()) {
    if (exported.has(table) || table in notExported) continue;
    problems.push(
      `${table} has org_id, but the owner export does not contain it: add it to EXPORT_TABLES in packages/kernel/src/offboarding.ts (with the columns to omit) ` +
        'and to the export list of docs/runbooks/org-offboarding.md, or, if it must stay out, add it to NOT_EXPORTED in apps/kernel/test/org-export-coverage.ts with the reason',
    );
  }
  const schemas = new Set(catalogTables.map((t) => t.slice(0, t.indexOf('.'))));
  for (const schema of [...schemas].sort()) {
    if (!COVERED_SCHEMAS.includes(schema)) problems.push(`${schema} has tables with org_id, but is not in COVERED_SCHEMAS (apps/kernel/test/org-export-coverage.ts): add it once its tables are in EXPORT_TABLES or on NOT_EXPORTED with a reason`);
  }
  for (const table of Object.keys(notExported).sort()) {
    if (!catalog.has(table)) problems.push(`${table} is on NOT_EXPORTED but is no covered crove_* table with org_id: remove it from NOT_EXPORTED`);
    else if (exported.has(table)) problems.push(`${table} is on NOT_EXPORTED but the export contains it: remove it from NOT_EXPORTED`);
  }
  return problems;
}

// Every name an entry omits is a column of the table it reads: `jsonb - text[]` ignores an unknown key, so a misspelled omit would export the column it meant to keep out. `columns` maps
// each crove_* table to its column names (the DB test reads them from information_schema). An entry that reads a function, not a table, is skipped.
export function omitProblems(
  columns: ReadonlyMap<string, ReadonlySet<string>>,
  tables: Readonly<Record<string, { from: string; omit: readonly string[] }>> = EXPORT_TABLES,
  ownerRun: Readonly<Record<string, { from: string; omit: readonly string[] }>> = OWNER_RUN_EXPORT_TABLES,
): string[] {
  const problems: string[] = [];
  for (const [name, spec] of [...Object.entries(tables), ...Object.entries(ownerRun)]) {
    const table = spec.from.match(new RegExp(TABLE.source))?.[0];
    if (!table || spec.omit.length === 0) continue;
    const have = columns.get(table);
    if (!have) {
      problems.push(`${name} reads ${table}, which has no columns in the catalog`);
      continue;
    }
    for (const column of spec.omit) if (!have.has(column)) problems.push(`${name} omits ${column}, which is no column of ${table}`);
  }
  return problems;
}
