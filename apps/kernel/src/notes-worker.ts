// The worker's part of the notes module (issue #1671, ADR-0037 §4): a former member's private notes are removed 30 days
// after they left (a queued job, and a daily sweep for a removal that queued none, #1733), the trash is emptied daily, and every 5 minutes the due to-do reminders are sent (#1675). startWorker() works and queues these jobs only when the module is
// installed (Runtime.installed('notes'), CROVE_MODULES), so a deployment without notes neither queues nor works them.
// Jobs carry ids only; the commands run in the org's system context and reach private notes through definers that
// answer counts, never text.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { INPUT_ERROR_CODES, type ExtractClient } from '@crove/extract-contract';
import { NOTE_ATTACHMENT_EXTRACTED_TEXT_MAX, NOTE_ATTACHMENT_MAX_BYTES, NOTE_MEMBER_PURGE_DAYS } from '@crove/kernel-contract';
import { BlobNotFoundError, BlobTooLargeError, DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT, trashCutoff, type NoteAttachmentExtractSource } from '@crove/mod-notes';
import { jobKey } from './job-keys.ts';
import { QUEUES } from './jobs-schema.ts';
import { DOCX_CONTENT_TYPE } from './note-attachments.ts';
import type { JobSender } from './worker.ts';

// After the nightly retention purge (02:30), on the same clock.
export const NOTES_TRASH_CRON = '45 2 * * *';
export const NOTES_TRASH_TZ = 'Asia/Ho_Chi_Minh';
// Orgs one sweep empties at most; the rest wait for the next night.
const TRASH_SWEEP_ORGS = 500;
// The reminder sweep (notes.md §3.8): every 5 minutes, at most this many reminders a pass; the rest wait for the next.
export const NOTES_REMIND_CRON = '*/5 * * * *';
const REMIND_SWEEP_LIMIT = 1000;
const MEMBER_PURGE_RETRY_LIMIT = 5;
// Former members one daily pass purges at most; the rest wait for the next night.
const FORMER_MEMBER_SWEEP_LIMIT = 500;

export interface NotesMemberPurgeJob {
  orgId: string;
  userId: string;
  // The kernel.member.removed event that queued it.
  eventId: string;
}

const ACTOR = { type: 'system' as const, component: 'notes' };

// A member removed (kernel.member.removed, payload userId): their private notes are removed NOTE_MEMBER_PURGE_DAYS later,
// unless they are a member again by then (the definer checks). One job per removal event. pg-boss keeps a delayed job
// for its retention window counted from its start time, so a job 30 days ahead is not dropped before it runs.
export function queueNotesMemberPurge(boss: JobSender, row: { org_id: string; event_id: string; type: string; payload: Record<string, unknown> }, now = new Date()) {
  if (row.type !== 'kernel.member.removed' || typeof row.payload.userId !== 'string') return null;
  const userId = row.payload.userId;
  return boss.send(QUEUES.notesMemberPurge, { orgId: row.org_id, userId, eventId: row.event_id } satisfies NotesMemberPurgeJob, {
    singletonKey: jobKey(row.org_id, QUEUES.notesMemberPurge, `${userId}:${row.event_id}`),
    startAfter: new Date(now.getTime() + NOTE_MEMBER_PURGE_DAYS * 86_400_000),
    retryLimit: MEMBER_PURGE_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  });
}

// One pass of the trash: every org with notes in the trash past the limit, emptied in its own system context. Logs ids
// and codes only.
export async function sweepNotesTrash(deps: { runtime: Runtime; workerDb: Db }, now = new Date()): Promise<number> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_notes.trash_due(${trashCutoff(now)}::timestamptz, ${TRASH_SWEEP_ORGS}::int)`.execute(deps.workerDb);
  let removed = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ removed: number }>('notes.trash.empty', {}, { actor: ACTOR, orgId: row.org_id });
      removed += done.removed;
    } catch (error) {
      console.warn(`[notes-trash] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return removed;
}

// One pass of the reminders: the due ones, claimed (marked sent) by crove_notes.todo_reminders_claim, each becoming one
// notification for its owner through notes.todo.remind in the org's system context, tried twice (a lock timeout, a
// serialization failure). A failure after that skips the reminder rather than retry it on every pass (notes.md §3.8:
// at most once). The claim returns ids, owners and times, never text; logs carry ids and codes only.
export async function sweepNotesReminders(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; id: string; remind_at: Date }>`
    SELECT org_id, id, remind_at FROM crove_notes.todo_reminders_claim(${REMIND_SWEEP_LIMIT}::int)`.execute(deps.workerDb);
  let sent = 0;
  for (const row of rows) {
    // The claim marked the reminder sent; an org whose Notes is off (ADR-0053) does not get it late either, and nothing is logged for it.
    if (!(await deps.runtime.appOn(row.org_id, 'notes').catch(() => true))) continue;
    const remind = () =>
      deps.runtime.execute<{ sent: number }>('notes.todo.remind', { todoId: row.id, remindAt: new Date(row.remind_at).toISOString() }, { actor: ACTOR, orgId: row.org_id });
    try {
      // A second try is harmless: the notification's key and the check of the to-do write it once.
      sent += (await remind().catch(remind)).sent;
    } catch (error) {
      console.warn(`[notes-remind] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return sent;
}

// One pass of the former members (#1733), after the trash: the users who own private notes or to-dos in an org they
// left more than NOTE_MEMBER_PURGE_DAYS ago, whose removal queued no purge (the module off when they left, a job
// dropped), each purged in the org's system context. The definer itself refuses a member or a removal younger than
// that, so this sweep cannot purge early. A user whose membership ended with no removal in the audit trail (an SQL
// delete, a restore) has no date to count from: their items are kept and logged, never purged here. Logs org prefixes
// and codes only.
export async function sweepNotesFormerMembers(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; user_id: string; recorded: boolean }>`
    SELECT org_id, user_id, recorded FROM crove_notes.former_members_due(${FORMER_MEMBER_SWEEP_LIMIT}::int)`.execute(deps.workerDb);
  let removed = 0;
  for (const row of rows) {
    if (!row.recorded) {
      console.warn(`[notes-member-purge] org ${row.org_id.slice(0, 8)}: a former member with no recorded removal, items kept`);
      continue;
    }
    try {
      removed += (await runNotesMemberPurge(deps.runtime, { orgId: row.org_id, userId: row.user_id })).removed;
    } catch (error) {
      console.warn(`[notes-member-purge] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return removed;
}

// A queued purge: the former member's private notes in that org, unless they are a member again. A job that starts a
// moment before the database's 30 days are over (clocks apart) removes nothing; the next daily sweep then does it.
export async function runNotesMemberPurge(runtime: Runtime, job: { orgId: string; userId: string; eventId?: string }): Promise<{ removed: number }> {
  const input = job.eventId === undefined ? { userId: job.userId } : { userId: job.userId, eventId: job.eventId };
  const done = await runtime.execute<{ removed: number }>('notes.member_items.purge', input, { actor: ACTOR, orgId: job.orgId });
  console.log(`[notes-member-purge] org ${job.orgId.slice(0, 8)}: removed ${done.removed}`);
  return done;
}

export const NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT = 3;

export interface NotesAttachmentExtractJob {
  orgId: string;
  attachmentId: string;
}

export function queueNoteAttachmentExtract(
  boss: JobSender,
  row: { org_id: string; event_id: string; type: string; payload: Record<string, unknown> },
) {
  if (row.type !== NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT || typeof row.payload.attachmentId !== 'string') return null;
  const attachmentId = row.payload.attachmentId;
  return boss.send(
    QUEUES.notesAttachmentExtract,
    { orgId: row.org_id, attachmentId } satisfies NotesAttachmentExtractJob,
    {
      singletonKey: jobKey(row.org_id, QUEUES.notesAttachmentExtract, attachmentId),
      retryLimit: NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT,
      retryDelay: 15,
      retryBackoff: true,
    },
  );
}

export async function runNoteAttachmentExtract(
  deps: { runtime: Runtime; store: BlobStore; extract: ExtractClient },
  job: NotesAttachmentExtractJob,
  retryCount = 0,
): Promise<{ status: 'done' | 'skipped' | 'failed' | 'skipped_not_pending' | 'app_off' }> {
  if (!(await deps.runtime.appOn(job.orgId, 'notes', { fresh: true }).catch(() => true))) {
    return { status: 'app_off' };
  }
  const source = await deps.runtime.query<NoteAttachmentExtractSource | null>(
    'notes.attachment.extract_source',
    { attachmentId: job.attachmentId },
    { actor: ACTOR, orgId: job.orgId },
  );
  if (!source) return { status: 'skipped_not_pending' };

  const record = (status: 'done' | 'skipped' | 'failed', extractedText: string | null) =>
    deps.runtime.execute<{ updated: boolean }>(
      'notes.attachment.extract_record',
      { attachmentId: job.attachmentId, status, extractedText },
      { actor: ACTOR, orgId: job.orgId },
    );

  let bytes: Uint8Array;
  try {
    bytes = await deps.store.get(source.storageKey, null, NOTE_ATTACHMENT_MAX_BYTES);
  } catch (error) {
    if (error instanceof BlobNotFoundError || error instanceof BlobTooLargeError || retryCount >= NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT) {
      await record('failed', null);
      return { status: 'failed' };
    }
    throw error;
  }

  const contentType = source.contentType.toLowerCase();
  if (contentType === 'text/plain' || contentType === 'text/markdown' || contentType === 'text/csv') {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const cleaned = raw.replaceAll('\0', '').trim().slice(0, NOTE_ATTACHMENT_EXTRACTED_TEXT_MAX);
    await record('done', cleaned.length > 0 ? cleaned : null);
    return { status: 'done' };
  }

  if (contentType !== 'application/pdf' && contentType !== DOCX_CONTENT_TYPE) {
    await record('skipped', null);
    return { status: 'skipped' };
  }

  const kind = contentType === 'application/pdf' ? 'pdf_text' : 'docx_text';
  let result: Awaited<ReturnType<ExtractClient['extract']>>;
  try {
    result = await deps.extract.extract(kind, bytes);
  } catch (error) {
    if (retryCount >= NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT) {
      await record('failed', null);
      return { status: 'failed' };
    }
    throw error;
  }

  if (!result.ok) {
    if (INPUT_ERROR_CODES.includes(result.code) || retryCount >= NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT) {
      await record('failed', null);
      return { status: 'failed' };
    }
    throw new Error(`crove-extract ${kind} transient error: ${result.code}`);
  }

  if (result.kind !== 'pdf_text' && result.kind !== 'docx_text') {
    await record('failed', null);
    return { status: 'failed' };
  }

  const cleaned = result.text.replaceAll('\0', '').trim().slice(0, NOTE_ATTACHMENT_EXTRACTED_TEXT_MAX);
  await record('done', cleaned.length > 0 ? cleaned : null);
  return { status: 'done' };
}

const BLOB_SWEEP_MS = 60_000;
const BLOB_SWEEP_BATCH = 200;
let lastNoteBlobSweep = 0;

export async function sweepNoteAttachmentBlobs(deps: {
  workerDb: Db;
  store: BlobStore;
  now?: () => number;
  force?: boolean;
}): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastNoteBlobSweep < BLOB_SWEEP_MS) return 0;
  lastNoteBlobSweep = now;
  let deleted = 0;
  for (let pass = 0; pass < 10; pass++) {
    const { rows } = await sql<{ blob_key: string }>`
      SELECT blob_key FROM crove_notes.attachment_blob_claim(${BLOB_SWEEP_BATCH}::int)
    `.execute(deps.workerDb);
    if (rows.length === 0) break;
    const done: string[] = [];
    for (const { blob_key: key } of rows) {
      try {
        await deps.store.delete(key);
        done.push(key);
      } catch {
        // Left to its 5-minute lease; keys are never logged.
      }
    }
    if (done.length > 0) {
      await sql`SELECT crove_notes.attachment_blob_done(${done}::text[])`.execute(deps.workerDb);
    }
    deleted += done.length;
    if (done.length < rows.length) {
      console.error(`[notes-attachments] ${rows.length - done.length} blob(s) not deleted; claimed again after the lease`);
      break;
    }
    if (rows.length < BLOB_SWEEP_BATCH) break;
  }
  return deleted;
}
