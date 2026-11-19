// SPDX-License-Identifier: AGPL-3.0-only
// The check of a connection's vouchers against the firm's own MISA catalogue (#4112, S3a of #4103): what a person asks for and what the preview shows of it. The catalogue is read by the worker (the access code is
// sealed and only the worker opens it), in its memory only; what is kept is, per party (its tax code) and per item (its code), whether exactly one active catalogue entry matched, none did or several did, and the
// matched entry's code. Nothing here carries a catalogue name, address or tax code.
import { z } from 'zod';
import { zId } from './schemas.ts';

// What the preview says of the last check of its connection: no check yet, one waiting for the worker, one done, or one that could not be made (a fixed reason, never MISA's text).
export const MISA_AMIS_MATCH_STATUSES = ['none', 'requested', 'done', 'failed'] as const;
export const MISA_AMIS_MATCH_FAILURE_CODES = ['credentials', 'unreachable', 'invalid_response', 'catalogue_too_large'] as const;
export const zMisaAmisMatchStatus = z.strictObject({
  state: z.enum(MISA_AMIS_MATCH_STATUSES),
  failure: z.enum(MISA_AMIS_MATCH_FAILURE_CODES).nullable(),
  // When the person asked for the check that is waiting or last ran, and when it finished (null while it waits or when there is none).
  requestedAt: z.iso.datetime({ offset: true }).nullable(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type MisaAmisMatchStatus = z.infer<typeof zMisaAmisMatchStatus>;

// The request is a connection and the batch the person is looking at (the preview's own ask, in the route's input, so the worker checks the parties and items of exactly those vouchers).
// `running` is true when a check of this connection was already waiting (asked in the last ten minutes): a second press returns it and queues nothing.
export const zMisaAmisMatchCheckQueued = z.strictObject({ queued: z.boolean(), running: z.boolean() });
export type MisaAmisMatchCheckQueued = z.infer<typeof zMisaAmisMatchCheckQueued>;

// The worker's record of a check (system only): the result of each party and item it looked up.
export const MISA_AMIS_MATCH_RESULT_STATES = ['matched', 'unknown', 'ambiguous'] as const;
export const MISA_AMIS_MATCH_RESULTS_MAX = 2000;
export const zMisaAmisMatchResult = z.strictObject({
  kind: z.enum(['party', 'item']),
  ref: z.string().min(1).max(64),
  state: z.enum(MISA_AMIS_MATCH_RESULT_STATES),
  // The one matched entry's code and id; null unless `matched`.
  code: z.string().min(1).max(100).nullable(),
  // MISA's ids are GUIDs of any version (a SQL Server sequential GUID is not an RFC UUID), so the id is checked for shape, not for version.
  entryId: z.guid().nullable(),
});
export type MisaAmisMatchResult = z.infer<typeof zMisaAmisMatchResult>;
export const zMisaAmisMatchRecordCheck = z.strictObject({
  connectionId: zId,
  // The request the worker took (the time it was filed, from the target): a record for an older request than the one now waiting is ignored, so a slow job never records its results under a newer batch.
  requestedAt: z.iso.datetime({ offset: true }),
  state: z.enum(['done', 'failed']),
  failure: z.enum(MISA_AMIS_MATCH_FAILURE_CODES).nullable(),
  results: z.array(zMisaAmisMatchResult).max(MISA_AMIS_MATCH_RESULTS_MAX),
});
export type MisaAmisMatchRecordCheck = z.infer<typeof zMisaAmisMatchRecordCheck>;
