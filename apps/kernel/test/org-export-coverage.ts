// SPDX-License-Identifier: AGPL-3.0-only
// Every table of a covered schema (every crove_* schema, COVERED_SCHEMAS) with an org_id column is in the owner export (EXPORT_TABLES, packages/kernel/src/offboarding.ts)
// or on NOT_EXPORTED with the reason (#3201). EXPORT_TABLES is a hand-kept list, so a table a migration adds would
// otherwise be left out of the owner's copy of their data without anyone noticing. offboarding.db.test.ts reads the catalog of its
// migrated database and fails on such a table; org-export-coverage.test.ts checks the reading and the messages on planted catalogs.
import { EXPORT_TABLES, OWNER_RUN_EXPORT_TABLES } from '@crove/kernel';

// The schemas the check covers: every crove_* schema with org_id tables. A new schema is a failure until its tables are decided (exported or named below).
export const COVERED_SCHEMAS: readonly string[] = ['crove_finance', 'crove_kernel', 'crove_crm', 'crove_hr', 'crove_meetings', 'crove_notes', 'crove_social', 'crove_ads', 'crove_projects', 'crove_sign'];

// The tables the export leaves out, with why (docs/runbooks/org-offboarding.md says the same in its export list).
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  // Credentials, tokens and keys: secrets, or useless outside this deployment.
  'crove_kernel.credential': 'sealed channel connection tokens: a credential (the connection row is exported without them)',
  'crove_kernel.calendar_credential': 'sealed calendar tokens: a credential',
  'crove_kernel.meeting_platform_credential': 'sealed meeting platform tokens: a credential',
  'crove_kernel.oauth_state': 'the state of a sign-in in flight: a short-lived credential',
  'crove_kernel.extension_auth_code': 'a browser extension sign-in code (hash): a credential',
  'crove_kernel.extension_token': 'a browser extension token (hash): a credential',
  'crove_kernel.subject_key': "the org's wrapped subject keys (ADR-0017): key material, useless outside the deployment",
  'crove_kernel.agent_grant': 'the access grants of AI clients: credential-bearing, readable only through definer functions, ended when the org closes',
  'crove_kernel.agent_grant_wake': 'the wake-up webhooks of those grants, with their sealed secrets: credential-bearing, definer-only',
  // Private to one member by row security (no owner or admin path): the snapshot reads as the system context, which would give the owner what the app never shows them.
  'crove_kernel.notification': "private to its member: a member's own notifications are readable by that member alone",
  'crove_kernel.notification_mute': "private to its member: a member's own mutes are readable by that member alone",
  'crove_kernel.today_mail': "private to its member: a member's own daily mail setting is readable by that member alone",
  'crove_kernel.calendar_connection': "private to its member: a member's own connected calendar account is readable by that member alone",
  'crove_kernel.meeting_platform_connection': "private to its member: a member's own connected meeting platform account is readable by that member alone",
  'crove_crm.booking_feed': "a member's calendar feed token (hash): a credential",
  // Credentials: sealed or hashed, useless outside this deployment.
  'crove_ads.ad_token_seal': 'sealed ad platform tokens: a credential',
  'crove_social.calendar_feed': "a calendar feed's token (hash): a credential, the row says nothing without it",
  'crove_social.chat_alert_target': 'the sealed address of a chat alert: a credential',
  'crove_meetings.chat_channel_target': 'the sealed address of a meeting chat channel: a credential',
  'crove_meetings.media_key': "the wrapped keys of a meeting's recording: key material",
  'crove_meetings.member_hook': "a member's own webhook with its sealed secret: a credential, private to its member",
  'crove_sign.signing_token': 'signing link token hashes: credentials',
  'crove_sign.signing_otp': 'email signing OTP hashes: short-lived credentials',
  'crove_sign.template_direct_link': 'template direct signing link token hashes: credentials',
  // Private to one member by row security (no owner or admin path), or readable only through the meeting's recorder and reader checks.
  'crove_social.notification': "private to its member: a member's own social notifications are readable by that member alone",
  'crove_social.notification_mail_off': "private to its member: a member's own mail preference",
  'crove_social.notification_mute': "private to its member: a member's own mutes",
  'crove_social.push_subscription': 'private to its member: a browser push subscription (endpoint and keys)',
  'crove_notes.todo': "private to its member: a member's own to-dos (counts are in notes.todo_count)",
  'crove_notes.todo_list': "private to its member: a member's own to-do lists (never exported under ADR-0037)",
  'crove_notes.note_version': 'rolling 20-snapshot revision history of notes: current shared notes are exported in notes.note and private notes stay out (ADR-0037)',
  'crove_meetings.calendar_agenda': "private to its member: a member's own agenda of upcoming meetings",
  'crove_meetings.chat_post': "readable by the meeting's recorder alone, as the author",
  'crove_meetings.chat_post_body': "the body of those posts: readable by the meeting's recorder alone",
  'crove_meetings.action_item': "the meeting's recorder, or its readers once it is shared and published: the system context is refused by is_meeting_reader, so it is not exported; a definer export of the published rows of shared meetings is #3388",
  'crove_meetings.audio_segment': "the meeting's readers only; is_meeting_reader refuses the system context; no export carries a recording (ADR-0047 point 7)",
  'crove_meetings.meeting_chapter': "the meeting's recorder, or its readers once published: the system context is refused by the row policy (a user context only), so it is not exported; the titles are derived from the transcript, which is not exported either",
  'crove_meetings.live_chunk': "the meeting's recorder only: a live transcript in progress",
  'crove_meetings.live_line': "the meeting's recorder only: a live transcript in progress",
  'crove_meetings.meeting_note': "the meeting's recorder only",
  'crove_meetings.meeting_reader': "who may read a meeting: readable through is_meeting_reader only, which refuses the system context",
  'crove_meetings.meeting_result': "the meeting's recorder, or its readers once it is shared and published: the system context is refused by is_meeting_reader, so it is not exported; a definer export of the published rows of shared meetings is #3388",
  'crove_meetings.meeting_video': "the meeting's attendees only: no export carries a recording (ADR-0047 point 7)",
  'crove_meetings.transcript_segment': "the meeting's recorder, or its readers once it is shared and published: the system context is refused by is_meeting_reader, so it is not exported; a definer export of the published rows of shared meetings is #3388",
  'crove_meetings.translation': "private to the member who asked for it, within the meeting's attendees",
  // Exported by another route.
  'crove_meetings.meeting': 'only the meetings shared with the org, through crove_kernel.meeting_export_rows() (meetings.meeting); attendees-only ones are counted in meetings.private_count',
  'crove_meetings.meeting_link': 'the links of those shared meetings, through crove_kernel.meeting_link_export_rows() (meetings.link)',
  // Runtime machinery, caches and logs.
  'crove_meetings.hook_delivery': 'a webhook delivery queue row: runtime machinery',
  'crove_social.digest_week': 'a weekly digest marker (sent_at): machinery',
  'crove_social.feed_item': 'the items a feed produced: a fetch cache, the posts they became are in social.post',
  'crove_social.link_preview': 'a cache of fetched link previews',
  'crove_social.report_schedule_run': 'a log of scheduled report runs: machinery',
  // Runtime machinery: recomputed, expiring or only meaningful while the org runs.
  'crove_ads.ad_token_revoke': 'the queue that revokes platform tokens, with the keyed hash of the grantor: machinery',
  'crove_kernel.agent_wake_delivery': 'a wake-up delivery queue row: runtime machinery',
  'crove_kernel.agent_wake_signal_seen': 'which wake-up signals were seen: runtime machinery',
  'crove_kernel.agent_wakeup': 'agent wake-ups: runtime machinery (offboarding already says so)',
  'crove_kernel.ai_run': 'agent run records with their cost and status: runtime machinery',
  'crove_kernel.auth_session_org': "a member's session in the org: session record, not tenant data",
  'crove_kernel.calendar_event_link': 'the sync state between a calendar event and its external copy (hash, attempts): recomputed by the next sync',
  'crove_kernel.conversation_composing': 'who is typing in a conversation: expires in seconds',
  'crove_kernel.conversation_read': 'read marks are per-member state (the conversation core comment says so)',
  'crove_kernel.external_call': 'the ledger of calls to outside platforms (idempotency of outbound calls): runtime machinery, no personal data',
  'crove_kernel.file_upload': 'an upload in flight (staging key, expiry): runtime machinery',
  'crove_kernel.idempotency_key': 'idempotency keys and their stored responses: machinery',
  'crove_kernel.inbound_address': 'inbound address tokens are secrets and permanent tombstones (#37)',
  'crove_kernel.inbound_drop': 'drop counts of an inbound address: machinery',
  'crove_kernel.meeting_platform_recording': "a meeting platform's recording list and staging keys: an import queue; the meeting it became is in meetings.meeting",
  'crove_kernel.org_usage': 'the raw AI and usage metering rows the budget is computed from: machinery, not tenant records',
  'crove_kernel.outbox_archive': 'the list of archived outbox days: machinery',
  'crove_kernel.outbox_held': 'the ids of events that wait while an app is off (ADR-0053): machinery',
  'crove_kernel.outbox_event': 'the outbox: machinery, archived by the retention job',
  'crove_kernel.outbox_pending': 'the outbox delivery queue: machinery',
  'crove_kernel.refusal_tally': 'refusal counters per window: rate-limit machinery',
  'crove_kernel.usage_deferral': 'a deferred metering retry: machinery',
  // Private to one member: the line's precedent exports counts only (kernel.member_vy_private_count).
  'crove_kernel.member_vy_memory': "private to its member (ADR-0049): readable by that member alone, no owner, admin or system context reads it; the count is in kernel.member_vy_private_count",
  'crove_kernel.member_vy_result': "private to its member (ADR-0049): readable by that member alone; the count is in kernel.member_vy_private_count",
};

const TABLE = /crove_[a-z0-9_]+\.[a-z0-9_]+(?!\w|\()/g;

// A table named only inside a subquery's WHERE would count as exported here; none does today.
// The tables the export reads rows of: the tables named in each `from`, without the functions (`crove_notes.private_counts()`),
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
