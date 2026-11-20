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
// `party` is looked up by its tax code and `item` by its code (S3a). `party_name` (S3b, #4124) is a party WITHOUT a tax code, keyed by its id in Ludy and looked up by name: one active entry of that name is a
// `name_proposal` (the entry's code and name, a blocker until a person confirms it), several are `ambiguous`, none is `unknown`. For a party a person already confirmed the worker answers `confirmed` (the
// code is still in the catalogue and active: the row stays) or `unknown` (it is not: the row goes and the party is blocked again).
export const MISA_AMIS_MATCH_KINDS = ['party', 'item', 'party_name', 'unit', 'stock'] as const;
export const MISA_AMIS_MATCH_RESULT_STATES = ['matched', 'unknown', 'ambiguous', 'name_proposal', 'confirmed'] as const;
export const MISA_AMIS_MATCH_RESULTS_MAX = 2000;
// The longest name of a catalogue entry kept on a proposal; a longer one is cut by the worker.
export const MISA_AMIS_CANDIDATE_NAME_MAX = 200;
export const zMisaAmisMatchResult = z.strictObject({
  kind: z.enum(MISA_AMIS_MATCH_KINDS),
  ref: z.string().min(1).max(64),
  state: z.enum(MISA_AMIS_MATCH_RESULT_STATES),
  // The one entry's code and id: for `matched`, `name_proposal` and `confirmed`; null otherwise.
  code: z.string().min(1).max(100).nullable(),
  // MISA's ids are GUIDs of any version (a SQL Server sequential GUID is not an RFC UUID), so the id is checked for shape, not for version.
  entryId: z.guid().nullable(),
  // The proposed entry's name, only for `name_proposal` (it can be a person's name: stored on that row alone, erased with the person's data, never logged).
  candidateName: z.string().min(1).max(MISA_AMIS_CANDIDATE_NAME_MAX).nullable().optional(),
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

// The proposals a person looks at to confirm or reject (S3b, #4124): a party of Ludy with no tax code and the one active catalogue entry of the same name the last check found. Owners and admins only.
export const zMisaAmisNameProposal = z.strictObject({
  // The row the person is looking at: a decision names it and the candidate's code, so it is about this proposal and no other.
  id: zId,
  partyId: zId,
  // The party as Ludy has it, and the entry as the catalogue has it: both are names, shown as text and never logged.
  partyName: z.string(),
  candidateName: z.string(),
  candidateCode: z.string(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type MisaAmisNameProposal = z.infer<typeof zMisaAmisNameProposal>;
export const zMisaAmisNameProposalsAsk = z.strictObject({ connectionId: zId });
export type MisaAmisNameProposalsAsk = z.infer<typeof zMisaAmisNameProposalsAsk>;

// A person confirms the proposal for a party (it becomes the party's code in AMIS and the proposal's name is forgotten) or rejects it (the row is deleted; the next check may propose it again). The decision is about the
// row the person saw (its id) and the candidate on it (its code): a row that is gone, was replaced by a newer check or no longer is a proposal is refused, so a different candidate than the one on screen is never confirmed.
export const zMisaAmisNameDecision = z.strictObject({ connectionId: zId, partyId: zId, proposalId: zId, candidateCode: z.string().min(1).max(100) });
export type MisaAmisNameDecision = z.infer<typeof zMisaAmisNameDecision>;
export const zMisaAmisNameDecided = z.strictObject({ decided: z.boolean() });
export type MisaAmisNameDecided = z.infer<typeof zMisaAmisNameDecided>;
