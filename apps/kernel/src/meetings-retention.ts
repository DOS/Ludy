// SPDX-License-Identifier: AGPL-3.0-only
// Retention and shredding of meeting audio, video and text, the worker's side (issue #2579, ADR-0047 point 7, plan docs/plan/meetings.md section 9).
//
// Four jobs, each safe to run twice, each reaching meetings only through the worker-only definers of crove_meetings and the system commands of
// modules/meetings/src/retention.ts (one write path):
//   - runMeetingsRetention, nightly (the retention run, 02:30 Vietnam time): the meetings whose audio, video or text period has ended
//     (meetings_due) get meetings.retention.shred in their own org. Shredding deletes the kind's media_key row, so every copy of the ciphertext (current
//     and old versions, bucket backups) is unreadable from that commit on. The database checks each date again: a bug here can fail a run, never shred early.
//   - sweepMeetingMedia, every minute: the ciphertext file rows no segment or video row names (a deleted, expired or replayed meeting's) lose their object,
//     then their row ("deleted as the store allows": a versioned bucket keeps noncurrent versions for its lifecycle rule, and they are ciphertext whose
//     key is gone). The object goes first, so a crash between the two steps repeats the delete and never leaves a row pointing nowhere unseen.
//   - syncShredRefs, every minute: a meeting a person deleted before its date (the recorder, or an owner for a personal-data request) gets a shred reference
//     in the archive store, shred/v1/meeting-<org>-<id>.json, written once under the archive's Object Lock. It holds ids and the time only. A restore rolls
//     the database back, the deletion with it, so the references are what remember it (ADR-0017 section 8). The deletions are read from the audit trail,
//     since the API process holds no archive credential.
//   - replayShreds, at worker start and by `shred-replay` after a restore: every meeting a reference names is deleted again, then the sweep removes what it
//     left. Idempotent, and it deletes only the meetings the references list: a reference exists only because a person deleted that meeting.
// Nothing here logs a title, a transcript or a key: ids and counts.
import { z } from 'zod';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { BlobStore, Runtime, SystemActor } from '@crove/kernel-runtime';
import { opsAlert } from './ops-alert.ts';
import { ArchiveObjectExistsError, type ArchiveStore } from './worm.ts';

const ACTOR: SystemActor = { type: 'system', component: 'meetings.retention' };
export const SHRED_REF_PREFIX = 'shred/v1/';
// A reference outlives every backup that could bring its meeting back: a nightly run is kept 30 days and a WAL chain four to five weeks
// (docs/runbooks/backup-and-restore.md); the bucket's lifecycle rule on shred/ removes it afterwards.
export const SHRED_REF_LOCK_DAYS = 90;
// The first sync of a worker reads this far back, so a worker that was down still writes the references of deletions it missed.
export const SHRED_REF_FIRST_LOOKBACK_DAYS = 45;
const DUE_BATCH = 200;
const MAX_BATCHES = 50;
const ORPHAN_BATCH = 100;
const MAX_ORPHAN_BATCHES = 50;
const BLOB_DELETES_IN_FLIGHT = 5;

type Log = Pick<Console, 'log' | 'error'>;

export interface RetentionRun {
  shredded: { audio: number; video: number; text: number };
  failed: number;
}

/** One nightly pass: every meeting whose period has ended, in its own org. A failing meeting is left for the next run and never holds the others behind it. */
export async function runMeetingsRetention(deps: { runtime: Runtime; workerDb: Db; log?: Log; batch?: number }): Promise<RetentionRun> {
  const log = deps.log ?? console;
  const run: RetentionRun = { shredded: { audio: 0, video: 0, text: 0 }, failed: 0 };
  for (let pass = 0; pass < MAX_BATCHES; pass++) {
    const { rows } = await sql<{ org_id: string; meeting_id: string; kind: 'audio' | 'video' | 'text' }>`
      SELECT org_id, meeting_id, kind FROM crove_meetings.meetings_due(${deps.batch ?? DUE_BATCH}::int)`.execute(deps.workerDb);
    let applied = 0;
    for (const row of rows) {
      try {
        const out = await deps.runtime.execute<{ applied: boolean }>('meetings.retention.shred', { meetingId: row.meeting_id, kind: row.kind }, { actor: ACTOR, orgId: row.org_id });
        if (out.applied) {
          run.shredded[row.kind] += 1;
          applied += 1;
        }
      } catch (error) {
        run.failed += 1;
        // Ids and the error's name only.
        log.error(`[meetings-retention] ${row.kind} of meeting ${row.meeting_id.slice(0, 8)} in org ${row.org_id.slice(0, 8)} failed`, error instanceof Error ? error.name : typeof error);
      }
    }
    // A batch that shredded nothing would list the same meetings again.
    if (rows.length < (deps.batch ?? DUE_BATCH) || applied === 0) break;
  }
  log.log(`[meetings-retention] audio=${run.shredded.audio} video=${run.shredded.video} text=${run.shredded.text} failed=${run.failed}`);
  if (run.failed > 0) opsAlert(`[meetings-retention] ALERT ${run.failed} meeting(s) could not be shredded; the next run tries again`);
  return run;
}

export interface MediaSweep {
  deleted: number;
  failed: number;
}

/** Deletes the objects of orphan meeting media files, then their rows. */
export async function sweepMeetingMedia(deps: { runtime: Runtime; workerDb: Db; store: BlobStore; log?: Log }): Promise<MediaSweep> {
  const log = deps.log ?? console;
  const out: MediaSweep = { deleted: 0, failed: 0 };
  for (let pass = 0; pass < MAX_ORPHAN_BATCHES; pass++) {
    const { rows } = await sql<{ org_id: string; file_id: string }>`
      SELECT org_id, file_id FROM crove_meetings.meetings_orphan_media(${ORPHAN_BATCH}::int)`.execute(deps.workerDb);
    if (rows.length === 0) break;
    const byOrg = new Map<string, string[]>();
    for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.file_id]);
    let progress = 0;
    for (const [orgId, fileIds] of byOrg) {
      const options = { actor: ACTOR, orgId };
      try {
        const keys = await deps.runtime.query<Array<{ fileId: string; storageKey: string; shared: boolean }>>('meetings.media.orphan_keys', { fileIds }, options);
        for (let i = 0; i < keys.length; i += BLOB_DELETES_IN_FLIGHT) {
          await Promise.all(
            keys.slice(i, i + BLOB_DELETES_IN_FLIGHT).map(async (k) => {
              try {
                // An object another file row still names is left; only this row goes.
                if (!k.shared) await deps.store.delete(k.storageKey);
                const done = await deps.runtime.execute<{ discarded: boolean }>('meetings.media.discard', { fileId: k.fileId }, options);
                if (done.discarded) {
                  out.deleted += 1;
                  progress += 1;
                }
              } catch (error) {
                out.failed += 1;
                log.error(`[meetings-retention] media file ${k.fileId.slice(0, 8)} in org ${orgId.slice(0, 8)} not removed`, error instanceof Error ? error.name : typeof error);
              }
            }),
          );
        }
      } catch (error) {
        out.failed += fileIds.length;
        log.error(`[meetings-retention] media files of org ${orgId.slice(0, 8)} not listed`, error instanceof Error ? error.name : typeof error);
      }
    }
    // A batch that removed nothing would list the same rows again; they are tried on the next sweep.
    if (progress === 0 || rows.length < ORPHAN_BATCH) break;
  }
  if (out.deleted > 0 || out.failed > 0) log.log(`[meetings-retention] media files removed=${out.deleted} failed=${out.failed}`);
  return out;
}

export const zShredRef = z.strictObject({
  format: z.literal('crove-shred-ref'),
  version: z.literal(1),
  kind: z.literal('meetings.meeting'),
  orgId: z.string().uuid(),
  meetingId: z.string().uuid(),
  deletedAt: z.iso.datetime({ offset: true }),
});
export type ShredRef = z.infer<typeof zShredRef>;

export function shredRefKey(orgId: string, meetingId: string): string {
  // One flat level under the prefix, so the local store (which lists a directory) and S3 list it alike.
  return `${SHRED_REF_PREFIX}meeting-${orgId}-${meetingId}.json`;
}

/**
 * Writes the shred reference of every meeting deleted since `since`, once each (an existing object is the same reference). Returns how many are in the
 * store for those deletions, and the number new.
 */
export async function syncShredRefs(deps: { workerDb: Db; store: ArchiveStore; since: Date; written?: Set<string> }): Promise<{ seen: number; written: number }> {
  const { rows } = await sql<{ org_id: string; meeting_id: string; occurred_at: Date }>`
    SELECT org_id, meeting_id, occurred_at FROM crove_meetings.meetings_deleted_since(${deps.since}::timestamptz)`.execute(deps.workerDb);
  let written = 0;
  for (const row of rows) {
    const key = shredRefKey(row.org_id, row.meeting_id);
    if (deps.written?.has(key)) continue;
    const ref: ShredRef = { format: 'crove-shred-ref', version: 1, kind: 'meetings.meeting', orgId: row.org_id, meetingId: row.meeting_id, deletedAt: row.occurred_at.toISOString() };
    try {
      await deps.store.put(key, new TextEncoder().encode(`${JSON.stringify(ref)}\n`), { retentionDays: SHRED_REF_LOCK_DAYS });
      written += 1;
    } catch (error) {
      // The key is taken: an earlier pass wrote this reference.
      if (!(error instanceof ArchiveObjectExistsError)) throw error;
    }
    deps.written?.add(key);
  }
  return { seen: rows.length, written };
}

export interface ShredReplay {
  listed: number;
  deleted: number;
  failed: number;
}

/**
 * Deletes again every meeting a shred reference names, in its own org (a restore brought it back with its keys). A reference that does not parse, or whose
 * name and content disagree, is skipped and reported: it never deletes anything. An org that is closed or gone fails its own references only.
 */
export async function replayShreds(deps: { runtime: Runtime; store: ArchiveStore; log?: Log }): Promise<ShredReplay> {
  const log = deps.log ?? console;
  const out: ShredReplay = { listed: 0, deleted: 0, failed: 0 };
  for (const key of await deps.store.list(SHRED_REF_PREFIX)) {
    out.listed += 1;
    try {
      const bytes = await deps.store.get(key);
      const parsed = bytes ? zShredRef.safeParse(JSON.parse(new TextDecoder().decode(bytes))) : null;
      if (!parsed?.success || shredRefKey(parsed.data.orgId, parsed.data.meetingId) !== key) {
        out.failed += 1;
        log.error(`[shred-replay] ${key} is not a shred reference this build reads; skipped`);
        continue;
      }
      const { deleted } = await deps.runtime.execute<{ deleted: boolean }>('meetings.shred.replay', { meetingId: parsed.data.meetingId }, { actor: ACTOR, orgId: parsed.data.orgId });
      if (deleted) out.deleted += 1;
    } catch (error) {
      out.failed += 1;
      log.error(`[shred-replay] ${key} not replayed`, error instanceof Error ? error.name : typeof error);
    }
  }
  log.log(`[shred-replay] references=${out.listed} meetings deleted again=${out.deleted} failed=${out.failed}`);
  return out;
}
