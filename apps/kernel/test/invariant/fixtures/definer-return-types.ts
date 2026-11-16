// SPDX-License-Identifier: AGPL-3.0-only
// What a SECURITY DEFINER function of crove_meetings may return (the rule of meetings-readers.db.test.ts, issue #2575, ADR-0047): metadata scalars only, never meeting text, with ONE narrow and
// locked exception decided by the owner on 2026-11-15 in the Meetings PO's chat (meetings integrations A6, issue #3164, the member's minutes webhook), extended by exactly one function the same day
// for B4 (issue #3168, minutes posted to Slack and Teams), and by one more for #3499 (the term list of names sent with the audio, ADR-0047 point 5 as amended 2026-11-16;
// OWNER DECISION PLACEHOLDER: the owner's approval in the coordinator's chat, date and words to be filled in before this PR opens): six named functions may return named columns of named types,
// because the delivery job must read the address, the sealed secrets and the stored body of what it sends, the tables are definer-only, and the transcription run must read the names it
// sends behind the audio door. The exception is exact:
// a function name, a column name and a column type, each pinned, and the roles that may execute the function are pinned with it (HOOK_DEFINER_EXECUTORS, asserted by the database test).
// Anything else in crove_meetings that returns text, jsonb or an array of text still fails. Kept in this directory so the suite stays self-contained.

const ALLOWED_SCALARS = new Set(['void', 'uuid', 'boolean', 'integer', 'bigint', 'smallint', 'timestamp with time zone', 'date', 'bytea']);

// The exception: function -> column -> exact type. `body` is the webhook body (the title, summary, decisions and action items the recorder ticked, built in their own publish transaction and
// wiped when the delivery settles); it may be returned by hook_delivery_get and by chat_post_get (B4: the message of a queued post to a Slack or Teams channel, deleted when the post settles), and by nothing else.
export const HOOK_DEFINER_TEXT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hook_get: { url: 'text', fields: 'text[]', paused_reason: 'text', secret_hint: 'text', last_status: 'text' },
  hook_for_publish: { fields: 'text[]' },
  hook_delivery_get: { type: 'text', status: 'text', body: 'jsonb' },
  hook_target: { url: 'text', secret_sealed: 'jsonb', previous_sealed: 'jsonb' },
  chat_post_get: { kind: 'text', status: 'text', body: 'jsonb' },
  // #3499: the display names and party names of one meeting, for the recorder's own transcription run only (it runs the audio door's whole gate first); no other column.
  terms_for_member_vy: { term: 'text' },
};

// The roles that may execute each of the six, and nobody else (PUBLIC, crove_tenant, crove_definer_tenant and the login role of the other side get nothing). The function's owner is not a grantee.
export const HOOK_DEFINER_EXECUTORS: Readonly<Record<string, readonly string[]>> = {
  hook_get: ['crove_app'],
  hook_for_publish: ['crove_app'],
  hook_delivery_get: ['crove_worker'],
  hook_target: ['crove_worker'],
  chat_post_get: ['crove_worker'],
  terms_for_member_vy: ['crove_worker'],
};

// The only two functions that may return a column named `body`, whatever its type.
export const BODY_FUNCTIONS: readonly string[] = ['hook_delivery_get', 'chat_post_get'];

// `proname` is the function's name without its schema; `rawRetType` is pg_get_function_result.
export function validateDefinerReturnType(rawRetType: string, proname = ''): { ok: boolean; reason?: string } {
  const norm = rawRetType.toLowerCase().trim();
  if (norm === 'trigger') return { ok: true };
  const stripped = norm.replace(/^setof\s+/, '');
  if (ALLOWED_SCALARS.has(stripped)) return { ok: true };
  const tableMatch = stripped.match(/^table\s*\((.*)\)$/);
  if (tableMatch) {
    const cols = (tableMatch[1] as string).split(',').map((c) => c.trim()).filter(Boolean);
    if (cols.length === 0) return { ok: false, reason: 'empty TABLE(...) definition' };
    const exception = Object.hasOwn(HOOK_DEFINER_TEXT, proname) ? HOOK_DEFINER_TEXT[proname] : undefined;
    for (const col of cols) {
      const parts = col.split(/\s+/);
      const colName = parts[0] as string;
      const colType = parts.slice(1).join(' ');
      if (colName === 'body' && !BODY_FUNCTIONS.includes(proname)) return { ok: false, reason: `a column named body is returned only by ${BODY_FUNCTIONS.join(' and ')}: ${proname || '(function)'} has ${col}` };
      if (ALLOWED_SCALARS.has(colType)) continue;
      if ((colType === 'text' || colType === 'varchar' || colType === 'character varying') && (colName === 'key_id' || colName === 'kind')) continue;
      if (exception && Object.hasOwn(exception, colName) && exception[colName] === colType) continue;
      return { ok: false, reason: `disallowed column in TABLE(...): ${col} (type ${colType} not permitted for ${colName})` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `disallowed return type: ${rawRetType}` };
}
