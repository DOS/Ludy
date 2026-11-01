// Extractions of a file and re-extraction (issue #40, plan §8.4). Every run of the extraction job on a file is a
// numbered version (crove_kernel.extraction.version); a version is never overwritten. The proposal read from a file
// follows its newest successful version: a re-extraction becomes a new revision of the pending proposal, through
// the same revision mechanism as an edit (#87), so an approval of the earlier revision never carries over.
//
// Concurrency: every command that writes a file's extractions locks the file row first (FOR UPDATE), then the
// file's proposal. Approve, edit and reject lock the proposal and then refuse while a re-extraction is pending.
// A pending run is at most one per file (partial UNIQUE index), and the database numbers versions.
import { sql } from 'kysely';
import { z } from 'zod';
import { STAGED_STATEMENT_MAX_BYTES, zCheck, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { actorRef, addAuthor, eligibleApprovers, parseAuthors, type ActorRef } from './approval.ts';
import { isArchiveType } from './files.ts';

// Who may ask for a re-extraction: the roles that may edit a proposal (EDITOR_ROLES in approval.ts). A
// re-extraction changes a pending proposal's content as an edit does, and never approves anything.
const REEXTRACT_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
// A pending run older than this is presumed lost (the worker retries for a few minutes, then records a failure):
// it no longer blocks decisions on the proposal, a new request replaces it, and if its job still finishes, the
// result is kept in the file's history but never applied to a proposal. The rule uses only the database clock
// (created_at against now() or clock_timestamp()), never the app server's, so clock skew between the two cannot
// move it.
export const REEXTRACT_STALE_MINUTES = 15;
// What a pending run that went stale shows as its error.
export const STALE_RUN_ERROR = 'Đọc lại quá lâu nên đã dừng; hãy bấm Đọc lại để thử lại';
// Extraction runs one file may have. Each run can cost an AI call; one pending run at a time is the main limit.
export const MAX_EXTRACTION_VERSIONS = 20;

// Asked of the finance module (finance.extraction.lookup) through ctx.query, as VOIDED_PROPOSALS_QUERY is, so the kernel
// does not read the finance schema (#204); a deployment without finance has no purchase proposals to duplicate.
export const DUPLICATE_LOOKUP_QUERY = 'finance.extraction.lookup';

// The duplicate check made again where it can be trusted (#2137). Documents are read at the same time, so the lookup a
// reader made before recording can miss a copy another reader records a moment later: two copies of one invoice in a
// ZIP would then both go in with no warning. `key` names the identity of the document (the invoice, for finance); the
// record takes a transaction-level advisory lock on it, asks the lookup again inside its own transaction, and when it now
// finds an earlier proposal it flags this one: duplicateOf is set and `check` goes first in the run's checks and in the
// payload's. The second to record is the one flagged, since it sees the first's committed proposal.
export const zDuplicateGuard = z.object({
  key: z.string().min(1).max(500),
  // The reading is the seller's original (an e-invoice XML, #2269) and may take the place of a duplicate that is still
  // pending and was read from a PDF or a photo: the guard asks the lookup (`duplicateProposalUpgradable`) under its
  // lock, and the record revises that proposal instead of flagging this reading as its duplicate.
  upgrades: z.boolean().optional(),
  // The input of the lookup query, without the file (the command adds it).
  lookup: z.record(z.string(), z.unknown()),
  check: zCheck,
});

export const zProposalDraft = z.object({
  kind: z.string(),
  command: z.string(),
  title: z.string().max(300),
  payload: z.record(z.string(), z.unknown()),
  duplicateOf: zId.nullable(),
  duplicateGuard: zDuplicateGuard.optional(),
});

// In flight: created within the stale window, measured at the start of the transaction (now()). A decision that
// passes this check started after the run went stale.
const pendingSince = sql<boolean>`created_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int)`;

export interface LatestExtraction {
  id: string;
  version: number;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  // A pending run that is not stale.
  inFlight: boolean;
  // The legal entity whose document the file is (#1280); a re-extraction stays in it.
  legalEntityId: string;
}

// The file's newest extraction run, or undefined if it has not been read yet.
export async function latestExtraction(ctx: QueryContext, fileId: string): Promise<LatestExtraction | undefined> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select(['id', 'version', 'status', 'error', 'legal_entity_id', pendingSince.as('fresh')])
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  const inFlight = row.status === 'pending' && row.fresh;
  const error = row.status === 'pending' && !inFlight ? STALE_RUN_ERROR : row.error;
  return { id: row.id, version: row.version, status: row.status, error, inFlight, legalEntityId: row.legal_entity_id };
}

// Of the given proposals, those whose recorded purchase document was voided by reversing its journal entry (#165).
// Asked of the finance module (finance.documents.voided_proposals) through ctx.query, so the kernel does not read the
// finance schema (#204); a deployment without finance has no recorded purchases, so none.
export const VOIDED_PROPOSALS_QUERY = 'finance.documents.voided_proposals';
export async function voidedProposals(ctx: QueryContext, proposalIds: readonly string[]): Promise<Set<string>> {
  if (proposalIds.length === 0) return new Set();
  const found = await ctx.query<string[]>(VOIDED_PROPOSALS_QUERY, { proposalIds });
  return new Set(found.status === 'ok' ? found.value : []);
}

// An executed proposal whose recorded purchase document was voided (above). The invoice is no longer in Crove's
// books, so its file may be read again into a new proposal and recorded anew; any other executed proposal ends the
// file's reading for good.
export async function executedButVoided(ctx: QueryContext, proposal: { id: string; status: string } | undefined): Promise<boolean> {
  if (proposal?.status !== 'executed') return false;
  return (await voidedProposals(ctx, [proposal.id])).has(proposal.id);
}

// Refuses a decision (approve, edit, reject) on a proposal whose file is being read again: the result would
// replace the content being decided on. Called after the proposal row is locked, so a re-extraction requested
// first is seen here, and one requested later finds the decided proposal. `extractionId` is the run the proposal's
// current revision was read from: when it is of another file than the proposal's source file (the original XML of an
// invoice first read from a PDF, #2269), that file's re-reading counts too.
export async function refuseWhileReextracting(ctx: CommandContext, fileId: string | null, extractionId: string | null = null): Promise<void> {
  const files = fileId ? [fileId] : [];
  if (extractionId) {
    const read = await ctx.trx.selectFrom('crove_kernel.extraction').select('file_id').where('org_id', '=', ctx.orgId).where('id', '=', extractionId).executeTakeFirst();
    if (read && !files.includes(read.file_id)) files.push(read.file_id);
  }
  if (files.length === 0) return;
  const pending = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select('version')
    .where('org_id', '=', ctx.orgId)
    .where('file_id', 'in', files)
    .where('status', '=', 'pending')
    .where(pendingSince)
    .executeTakeFirst();
  if (pending) {
    throw new DomainError('EXTRACTION_PENDING', 409, 'Chứng từ đang được đọc lại; hãy chờ kết quả rồi thử lại', { version: pending.version });
  }
}

// The legal entity a file's first reading belongs to (#1280): the entity of the member who uploaded it when that member
// is limited to legal entities (its only one; with several, the org's default entity when it is one of them, else the
// first), so the member sees what it uploaded; otherwise (owners, admins, members with an org-wide role, an emailed
// file) null, which the fill trigger turns into the org's default entity. The same rule as enter_context's le_scope.
export async function uploaderEntity(ctx: CommandContext, uploader: string | null): Promise<string | null> {
  if (!uploader) return null;
  const { rows } = await sql<{ entity: string | null }>`
    SELECT CASE
      WHEN m.role IN ('owner', 'admin') THEN NULL
      WHEN EXISTS (SELECT 1 FROM crove_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL) THEN NULL
      ELSE (
        SELECT a.legal_entity_id FROM crove_kernel.role_assignment a
        LEFT JOIN crove_kernel.legal_entity e ON e.org_id = a.org_id AND e.id = a.legal_entity_id
        WHERE a.org_id = m.org_id AND a.user_id = m.user_id
        ORDER BY e.is_default DESC NULLS LAST, a.legal_entity_id
        LIMIT 1)
    END AS entity
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = ${ctx.orgId} AND m.user_id = ${uploader}`.execute(ctx.trx);
  return rows[0]?.entity ?? null;
}

// `statement`: the run is of a bank statement (#2142), whose .xlsx arrives stored as a ZIP, so a ZIP is let through.
async function lockFile(ctx: CommandContext, fileId: string, statement = false) {
  const file = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'filename', 'created_by', 'content_type', 'upload_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .forUpdate()
    .executeTakeFirst();
  if (!file) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
  // A ZIP archive (#314) is opened once by kernel.file.archive.record; it is never read as a document.
  if (isArchiveType(file.content_type) && !statement) throw new DomainError('ARCHIVE_NOT_READ', 409, 'Tệp ZIP đã được mở thành từng chứng từ; hãy đọc lại từng chứng từ');
  return file;
}

// Whether the file's newest run is a bank statement a member imported (#2142).
async function statementImported(ctx: CommandContext, fileId: string): Promise<boolean> {
  const run = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select('result')
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  const result = run?.result as { kind?: unknown; summary?: { state?: unknown } } | null | undefined;
  return result?.kind === 'bank_statement' && result.summary?.state === 'imported';
}

// Whether a read of the file was a bank statement's (#2142): an .xlsx stored as a ZIP that the worker read as a statement
// records a run of method 'unsupported' (an archive records 'archive'), and may be read again, for instance once the
// account it names is mapped.
async function readAsStatement(ctx: CommandContext, fileId: string): Promise<boolean> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .where('method', '=', 'unsupported')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

// The file's newest proposal, locked. A file has one proposal unless an earlier one was rejected and the file was
// read again. A proposal revised from the file's reading (the original of a PDF's invoice, #2269) is the file's too, and so
// is the executed proposal the file was attached to as its original (#2320): reading that file again changes nothing in
// the books, so it is refused as for any posted invoice.
async function lockFileProposal(ctx: CommandContext, fileId: string) {
  return ctx.trx
    .selectFrom('crove_kernel.proposal')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where((eb) =>
      eb.or([
        eb('source_file_id', '=', fileId),
        eb('extraction_id', 'in', eb.selectFrom('crove_kernel.extraction').select('id').where('org_id', '=', ctx.orgId).where('file_id', '=', fileId)),
        eb(
          'id',
          'in',
          eb.selectFrom('crove_kernel.extraction').select('original_of_proposal_id').where('org_id', '=', ctx.orgId).where('file_id', '=', fileId).where('original_of_proposal_id', 'is not', null),
        ),
      ]),
    )
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
}

// Whether the proposal's current revision was read from a file other than `fileId`: the original (XML) of an invoice
// first read from a PDF took its place (#2269), so reading the PDF again must not put the weaker reading back.
async function readFromAnotherFile(ctx: CommandContext, proposal: { extraction_id: string | null }, fileId: string): Promise<boolean> {
  if (!proposal.extraction_id) return false;
  const run = await ctx.trx.selectFrom('crove_kernel.extraction').select('file_id').where('org_id', '=', ctx.orgId).where('id', '=', proposal.extraction_id).executeTakeFirst();
  return run !== undefined && run.file_id !== fileId;
}

// A proposal stays in its legal entity (#1764): its entity never changes (ADR-0021, b_legal_entity).
export const legalEntityMoveRefused = () =>
  new DomainError(
    'LEGAL_ENTITY_MOVE_REFUSED',
    409,
    'Đề xuất này thuộc một pháp nhân khác; không chuyển sang pháp nhân khác được. Hãy từ chối đề xuất rồi tải chứng từ lên lại ở pháp nhân cần ghi sổ',
  );

// Asks for the file to be read again. The API never parses: this records a pending run and emits
// kernel.file.reextract_requested, which the worker relays to the extraction job, as for an upload.
// R1: internal and it decides nothing (the result is a new revision that still needs an approval).
export const reextractFile = defineCommand({
  name: 'kernel.file.reextract',
  // legalEntityId (#1764): read it again in another entity, which the caller sees, once no proposal of the file waits
  // for a decision (a pending one stays in its entity); omitted, the previous reading's entity.
  input: z.object({ fileId: zId, legalEntityId: zId.optional() }),
  // It queues the extraction job again, which sends the file to the AI endpoint (plan §4.7: a job with egress
  // derives R2; #1662).
  risk: 'R2',
  sideEffect: 'external',
  access: REEXTRACT_ROLES,
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới yêu cầu đọc lại được');
    const file = await lockFile(ctx, input.fileId, true);
    // A ZIP is read again only when it was read as a bank statement (#2142); an archive of documents is never read again.
    if (isArchiveType(file.content_type) && !(await readAsStatement(ctx, input.fileId))) {
      throw new DomainError('ARCHIVE_NOT_READ', 409, 'Tệp ZIP đã được mở thành từng chứng từ; hãy đọc lại từng chứng từ');
    }
    const latest = await latestExtraction(ctx, input.fileId);
    if (!latest) throw new DomainError('EXTRACTION_PENDING', 409, 'Tệp đang được đọc lần đầu; hãy chờ kết quả');
    // A bank statement already imported is read no more (#2142): its lines are stored, and a second reading could only
    // stage them again, perhaps into another account.
    if (await statementImported(ctx, input.fileId)) throw new DomainError('STATEMENT_IMPORTED', 409, 'Sao kê này đã được nhập nên không đọc lại được');
    if (latest.inFlight) {
      throw new DomainError('EXTRACTION_PENDING', 409, 'Tệp đang được đọc lại; hãy chờ kết quả', { version: latest.version });
    }
    if (latest.version >= MAX_EXTRACTION_VERSIONS) {
      throw new DomainError('REEXTRACT_LIMIT', 409, `Tệp này đã được đọc ${latest.version} lần, không đọc lại thêm được`, {
        limit: MAX_EXTRACTION_VERSIONS,
      });
    }
    const proposal = await lockFileProposal(ctx, input.fileId);
    if (proposal?.status === 'executed' && !(await executedButVoided(ctx, proposal))) {
      throw new DomainError('PROPOSAL_DECIDED', 409, 'Hóa đơn này đã được ghi sổ nên không đọc lại được');
    }
    if (proposal?.status === 'pending' && (await readFromAnotherFile(ctx, proposal, input.fileId))) {
      throw new DomainError('READ_FROM_ORIGINAL', 409, 'Đề xuất này đã được cập nhật từ hóa đơn gốc XML nên đọc lại tệp này sẽ không đổi gì; hãy đọc lại tệp XML');
    }
    let entity = latest.legalEntityId;
    if (input.legalEntityId !== undefined && input.legalEntityId.toLowerCase() !== latest.legalEntityId) {
      if (proposal?.status === 'pending' || proposal?.status === 'approved') throw legalEntityMoveRefused();
      const seen = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.legalEntityId).executeTakeFirst();
      if (!seen) throw new DomainError('LEGAL_ENTITY_NOT_ALLOWED', 403, 'Bạn không có quyền với sổ sách của pháp nhân này');
      entity = seen.id;
    }
    let superseded: number | null = null;
    if (latest.status === 'pending') {
      // A stale run (presumed lost) is closed as failed; if its job still finishes, it finds no pending run.
      await ctx.trx
        .updateTable('crove_kernel.extraction')
        .set({ status: 'failed', error: 'Quá thời gian chờ đọc lại; đã yêu cầu đọc lại lần nữa', completed_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', latest.id)
        .where('status', '=', 'pending')
        .execute();
      superseded = latest.version;
    }
    const run = await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        file_id: input.fileId,
        legal_entity_id: entity,
        method: null,
        status: 'pending',
        result: null,
        checks: '[]',
        error: null,
        // The trigger sets it from the sealed context anyway (a tenant role cannot name another requester).
        requested_by: ctx.actor.userId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        // The version is the next after the readings the caller sees (extraction_assign_version): taken, the file has
        // a reading of an entity outside the caller's scope (#1764 review). Answered as a file it cannot read, naming
        // nothing of that reading.
        const pg = error as { code?: string; constraint?: string } | null;
        if (pg?.code === '23505' && pg.constraint === 'extraction_version_uq') throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
        throw error;
      });
    ctx.audit({
      version: run.version,
      previous_version: latest.version,
      superseded_version: superseded,
      proposal_id: proposal?.id ?? null,
      proposal_revision: proposal?.revision ?? null,
      ...(entity !== latest.legalEntityId ? { legal_entity_id: entity, previous_legal_entity_id: latest.legalEntityId } : {}),
    });
    await ctx.activity('kernel.file', input.fileId, 'extraction.requested', `Yêu cầu đọc lại chứng từ (lần đọc ${run.version})`);
    await ctx.emit('kernel.file.reextract_requested', { fileId: input.fileId, version: run.version });
    return { fileId: input.fileId, version: run.version };
  },
});

// The same document uploaded again naming another entity (#1764), the way to book it there after its proposal was
// rejected: it is read again in that entity, when the caller sees its last reading, none is in flight and nothing of it
// waits for a decision or is booked; a proposal still pending is refused with the reason, and any other case stays a
// plain duplicate.
export async function readAgainIn(ctx: CommandContext, fileId: string, legalEntityId: string): Promise<void> {
  const file = await ctx.trx.selectFrom('crove_kernel.file').select('content_type').where('org_id', '=', ctx.orgId).where('id', '=', fileId).executeTakeFirst();
  if (!file || isArchiveType(file.content_type)) return;
  const latest = await latestExtraction(ctx, fileId);
  if (!latest || latest.inFlight || latest.legalEntityId === legalEntityId.toLowerCase()) return;
  const proposal = await lockFileProposal(ctx, fileId);
  if (proposal?.status === 'pending' || proposal?.status === 'approved') throw legalEntityMoveRefused();
  if (proposal?.status === 'executed' && !(await executedButVoided(ctx, proposal))) return;
  await ctx.run('kernel.file.reextract', { fileId, legalEntityId });
}

interface DuplicateAnswer {
  duplicateDocumentId: string | null;
  duplicateProposalId: string | null;
  // The duplicate proposal is pending and was read from a PDF or a photo (#2269).
  duplicateProposalUpgradable?: boolean;
  // The duplicate proposal is executed, was read from a PDF or a photo and is the one match (#2320), and whether the
  // original's amounts are not the posted document's.
  duplicateProposalAttachable?: boolean;
  attachDiffers?: boolean;
}

// The readings of an invoice that a pending proposal can be revised from: the weak ones, read from a PDF or a photo.
const UPGRADABLE_METHODS: readonly unknown[] = ['pdf_text_ai', 'image_ai'];

// The input of kernel.extraction.record with its duplicate guard applied (#2137, zDuplicateGuard): the lock on the
// document's identity taken first, the lookup asked again, and a copy found now flagged. The lock is held until the
// command commits, so a reader that recorded the same document a moment earlier has committed (or not started) by the
// time this one looks. Without a guard, or without a proposal, the input is returned as it is.
// `flagged` is the input with a copy found now flagged; `input` is the input as it came, and `upgrade` the id of a pending
// proposal this reading may take the place of (#2269) when the guard says it is the original's: the caller revises it
// instead, and falls back to `flagged` when the proposal can no longer be revised. `attach` is the executed proposal the
// reading is the original of (#2320): the caller attaches the run to it as evidence, and falls back to `flagged` when the
// proposal no longer qualifies.
async function withDuplicateGuard<T extends { fileId: string; checks: Array<z.infer<typeof zCheck>>; proposal: z.infer<typeof zProposalDraft> | null }>(
  ctx: CommandContext,
  input: T,
): Promise<{ input: T; flagged: T; upgrade: string | null; attach: { proposalId: string; differs: boolean } | null }> {
  const guard = input.proposal?.duplicateGuard;
  if (!input.proposal || !guard) return { input, flagged: input, upgrade: null, attach: null };
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_kernel.extraction_duplicate:${ctx.orgId}:${guard.key}`}, 0))`.execute(ctx.trx);
  const answer = await ctx.query<DuplicateAnswer>(DUPLICATE_LOOKUP_QUERY, { ...guard.lookup, fileId: input.fileId });
  if (answer.status !== 'ok' || (!answer.value.duplicateDocumentId && !answer.value.duplicateProposalId)) return { input, flagged: input, upgrade: null, attach: null };
  const upgrade =
    guard.upgrades === true && answer.value.duplicateProposalUpgradable === true && !answer.value.duplicateDocumentId ? (answer.value.duplicateProposalId ?? null) : null;
  // The posted case (#2320): the one match is an executed PDF or photo reading that is the document in force's own.
  const attach =
    guard.upgrades === true && answer.value.duplicateProposalAttachable === true && answer.value.duplicateProposalId
      ? { proposalId: answer.value.duplicateProposalId, differs: answer.value.attachDiffers === true }
      : null;
  // The input without the duplicate flag the worker may have set from its own, earlier lookup: an original that takes a
  // proposal's place is not its duplicate.
  const unflag = (checks: Array<z.infer<typeof zCheck>>) => checks.filter((c) => c.code !== guard.check.code);
  const payloadChecksIn = input.proposal.payload['checks'];
  const clean: T = {
    ...input,
    checks: unflag(input.checks),
    proposal: {
      ...input.proposal,
      duplicateOf: null,
      payload: Array.isArray(payloadChecksIn) ? { ...input.proposal.payload, checks: unflag(payloadChecksIn as Array<z.infer<typeof zCheck>>) } : input.proposal.payload,
    },
  };
  ctx.audit({ duplicate_guard: upgrade ? 'upgrade' : attach ? 'attach' : 'found', duplicate_of: answer.value.duplicateProposalId });
  const flagged = (checks: Array<z.infer<typeof zCheck>>) => (checks.some((c) => c.code === guard.check.code) ? checks : [guard.check, ...checks]);
  const payloadChecks = input.proposal.payload['checks'];
  return {
    input: upgrade || attach ? clean : input,
    upgrade,
    attach,
    flagged: {
      ...input,
      checks: flagged(input.checks),
      proposal: {
        ...input.proposal,
        duplicateOf: input.proposal.duplicateOf ?? answer.value.duplicateProposalId,
        payload: Array.isArray(payloadChecks)
          ? { ...input.proposal.payload, checks: flagged(payloadChecks as Array<z.infer<typeof zCheck>>) }
          : input.proposal.payload,
      },
    },
  };
}

// The pending proposal an original may take the place of (#2269), locked, or undefined when it cannot any more: a decision
// came first (it is no longer pending), a person changed it (an account, a rate or an entity they chose), it is of another
// kind or command, it was not read from a PDF or a photo, or it belongs to another legal entity than the original's (a
// proposal stays in its entity). The lock is taken
// after the guard's, so a decision that went through first is seen here and one that comes later finds the new revision.
async function lockUpgradable(ctx: CommandContext, proposalId: string, draft: z.infer<typeof zProposalDraft>, file: { created_by: string | null; upload_entity_id: string | null }) {
  const row = await ctx.trx.selectFrom('crove_kernel.proposal').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', proposalId).forUpdate().executeTakeFirst();
  if (!row || row.status !== 'pending' || row.kind !== draft.kind || row.command !== draft.command) return undefined;
  const payload = row.payload as { extractionMethod?: unknown; legalEntityId?: unknown; lines?: Array<{ accountRule?: { source?: unknown } }>; invoice?: { foreign?: { source?: unknown } } } | null;
  if (!UPGRADABLE_METHODS.includes(payload?.extractionMethod)) return undefined;
  // What a person chose on the reading (an account for a line, an exchange rate, a legal entity) is theirs: the original
  // does not replace it silently, it is flagged for them to decide, as before.
  if (payload?.legalEntityId !== undefined || payload?.invoice?.foreign?.source === 'entered' || payload?.lines?.some((l) => l.accountRule?.source === 'user')) return undefined;
  const entity =
    file.upload_entity_id ??
    (await uploaderEntity(ctx, file.created_by)) ??
    (await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst())?.id;
  return row.legal_entity_id === entity ? row : undefined;
}

// The executed proposal an original is attached to (#2320), locked, or undefined when it cannot any more: it is not executed
// (or was voided by a reversal, then the original is a new invoice to read), it is of another kind or command, it was not
// read from a PDF or a photo, or it belongs to another legal entity than the original's. Shared, not exclusive: nothing of
// the proposal changes; the lock only keeps a reversal from voiding it between this check and the run's insert.
async function lockAttachable(
  ctx: CommandContext,
  proposalId: string,
  draft: z.infer<typeof zProposalDraft>,
  file: { created_by: string | null; upload_entity_id: string | null },
) {
  const row = await ctx.trx.selectFrom('crove_kernel.proposal').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', proposalId).forShare().executeTakeFirst();
  if (!row || row.status !== 'executed' || row.kind !== draft.kind || row.command !== draft.command) return undefined;
  if (await executedButVoided(ctx, row)) return undefined;
  const payload = row.payload as { extractionMethod?: unknown } | null;
  if (!UPGRADABLE_METHODS.includes(payload?.extractionMethod)) return undefined;
  const entity =
    file.upload_entity_id ??
    (await uploaderEntity(ctx, file.created_by)) ??
    (await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst())?.id;
  return row.legal_entity_id === entity ? row : undefined;
}

// Records the result of an extraction run (worker only). Without `version` it is the first extraction of a new
// file (a no-op once the file has any run). With `version` it finishes that pending re-extraction (a no-op if the
// run is no longer pending), and the file's pending proposal gets a new revision with the new content.
export const recordExtraction = defineCommand({
  name: 'kernel.extraction.record',
  input: z.object({
    fileId: zId,
    version: z.number().int().positive().optional(),
    method: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported']),
    status: z.enum(['done', 'failed']),
    result: z.unknown().nullable(),
    // zCheck, so a check's code and parameters (#677) reach the run row and the proposal.
    checks: z.array(zCheck),
    error: z.string().max(2000).nullable(),
    proposal: zProposalDraft.nullable(),
    // Why a failed run failed (#1998): `service` when the reading service itself kept failing (the AI provider refused
    // or did not answer, the parser sandbox was down) after every retry, which the operator must see; `document`
    // (the default) when the document could not be read. A code in kernel.file.read_failed, which the prober counts.
    failure: z.enum(['service', 'document']).optional(),
    // What a done run with no proposal says in the file's history (#2142), for example how many bank lines a statement brought.
    summary: z.string().max(500).optional(),
    // The run is of a bank statement (#2142), which may be an .xlsx stored as a ZIP: with no proposal, method 'unsupported'.
    statement: z.boolean().optional(),
    // The legal entity a staged statement's run belongs to (#2142): the one its account is mapped to, so only members who
    // see that entity see the statement's account, lines and totals. A statement run only; the first run of a file.
    legalEntityId: zId.optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, original) => {
    // A run of a bank statement (#2142) has no proposal and the method 'unsupported'; only such a run may name a ZIP.
    if (original.statement === true && (original.proposal !== null || original.method !== 'unsupported')) {
      throw new DomainError('INVALID', 422, 'Lần đọc sao kê không có đề xuất');
    }
    // The rows a staged statement keeps in the run's result are bounded (#2142): the staging checks it, and so does this.
    if (original.statement === true && Buffer.byteLength(JSON.stringify(original.result ?? null), 'utf8') > STAGED_STATEMENT_MAX_BYTES + 64 * 1024) {
      throw new DomainError('STATEMENT_TOO_LARGE', 422, 'Sao kê có quá nhiều dữ liệu để chờ nhập; hãy chia thành nhiều tệp theo tháng');
    }
    const file = await lockFile(ctx, original.fileId, original.statement === true);
    const guarded = await withDuplicateGuard(ctx, original);
    // An original (XML) read while the same invoice's PDF or photo reading is still pending takes its place (#2269): the
    // first run only; a re-read never does.
    const upgraded =
      guarded.upgrade !== null && original.version === undefined && original.proposal ? await lockUpgradable(ctx, guarded.upgrade, original.proposal, file) : undefined;
    // The original of an invoice already posted from a PDF or a photo (#2320) is attached to the posted proposal: the first
    // run only, and only while that proposal still qualifies.
    const attachedTo =
      !upgraded && guarded.attach !== null && original.version === undefined && original.proposal && original.status === 'done'
        ? await lockAttachable(ctx, guarded.attach.proposalId, original.proposal, file)
        : undefined;
    const input = upgraded || attachedTo ? guarded.input : guarded.flagged;
    const outcome = {
      method: input.method,
      status: input.status,
      result: input.result === null ? null : JSON.stringify(input.result),
      checks: JSON.stringify(input.checks),
      error: input.error,
      completed_at: ctx.now,
    };
    let run: { id: string; version: number; requested_by: string | null };
    let current: Awaited<ReturnType<typeof lockFileProposal>>;
    // Whether this run may change a proposal: always for the first extraction; for a re-extraction only while it is
    // still in flight.
    let applies = true;
    if (input.version === undefined) {
      const existing = await ctx.trx
        .selectFrom('crove_kernel.extraction')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('file_id', '=', input.fileId)
        .limit(1)
        .executeTakeFirst();
      if (existing) return { extractionId: existing.id, proposalId: null, duplicate: true };
      // The entity the upload named (#1764), else the uploader's own.
      const entity = (original.statement === true ? original.legalEntityId : undefined) ?? file.upload_entity_id ?? (await uploaderEntity(ctx, file.created_by));
      // The original of a posted invoice (#2320): the run is inserted done, tied to the posted proposal as its evidence, and
      // nothing else happens. No proposal of its own (the invoice is not posted twice), the entry and the document are not
      // touched, and a difference in the amounts is only a warning the Inbox shows to a person.
      if (attachedTo && guarded.attach) {
        const differs = guarded.attach.differs;
        const attached = await ctx.trx
          .insertInto('crove_kernel.extraction')
          .values({
            org_id: ctx.orgId,
            file_id: input.fileId,
            ...(entity ? { legal_entity_id: entity } : {}),
            ...outcome,
            original_of_proposal_id: attachedTo.id,
            original_differs: differs,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        ctx.audit({ version: attached.version, status: input.status, attached_to_proposal_id: attachedTo.id, differs });
        const signature = (input.result as { signature?: { status?: unknown } } | null)?.signature?.status;
        await ctx.activity(
          'kernel.proposal',
          attachedTo.id,
          'proposal.original_attached',
          `Đã nhận hóa đơn gốc XML ${file.filename} cho hóa đơn đã ghi sổ (chữ ký: ${typeof signature === 'string' ? signature : 'không có'}; ${differs ? 'số liệu KHÁC chứng từ đã ghi sổ, cần người kiểm tra' : 'số liệu khớp chứng từ đã ghi sổ'})`.slice(0, 500),
        );
        await ctx.activity('kernel.file', input.fileId, 'extraction.read', `Hóa đơn gốc của hóa đơn đã ghi sổ từ tệp khác`);
        return { extractionId: attached.id, proposalId: null, duplicate: false };
      }
      run = await ctx.trx
        .insertInto('crove_kernel.extraction')
        .values({ org_id: ctx.orgId, file_id: input.fileId, ...(entity ? { legal_entity_id: entity } : {}), ...outcome })
        .returning(['id', 'version', 'requested_by'])
        .executeTakeFirstOrThrow();
      // The proposal the original takes the place of is revised below, as a pending proposal is by a re-reading.
      current = upgraded;
    } else {
      const pending = await ctx.trx
        .selectFrom('crove_kernel.extraction')
        .select(['id', 'version', 'status', 'requested_by', 'legal_entity_id'])
        .where('org_id', '=', ctx.orgId)
        .where('file_id', '=', input.fileId)
        .where('version', '=', input.version)
        .forUpdate()
        .executeTakeFirst();
      if (!pending || pending.status !== 'pending') return { extractionId: pending?.id ?? null, proposalId: null, duplicate: true };
      // A re-read of a bank statement whose account is now mapped in another legal entity than the run's (#2142). A run
      // keeps its entity and the statement's account and totals must not reach members of the run's entity, so this run is
      // closed as failed, with nothing of the statement, and the reading is recorded as a new run in the account's entity.
      if (
        original.statement === true &&
        input.status === 'done' &&
        original.legalEntityId !== undefined &&
        pending.legal_entity_id !== null &&
        pending.legal_entity_id !== original.legalEntityId.toLowerCase()
      ) {
        await ctx.trx
          .updateTable('crove_kernel.extraction')
          .set({ method: 'unsupported', status: 'failed', result: null, checks: '[]', error: 'Sao kê thuộc sổ của pháp nhân khác; hãy xem lần đọc mới nhất', completed_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', pending.id)
          .execute();
        const moved = await ctx.trx
          .insertInto('crove_kernel.extraction')
          .values({ org_id: ctx.orgId, file_id: input.fileId, legal_entity_id: original.legalEntityId, ...outcome })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        ctx.audit({ version: moved.version, status: input.status, applied: true, moved_from_version: pending.version });
        await ctx.activity('kernel.file', input.fileId, 'extraction.read', input.summary ?? 'Đã đọc tệp');
        return { extractionId: moved.id, proposalId: null, duplicate: false };
      }
      // The proposal is locked before the run's age is read, and the age is read on the clock at this moment
      // (clock_timestamp()), not at the start of the transaction: a decision that went through because the run was
      // stale either committed before this lock, and then the run is older still here, or waits for this command
      // and then finds a newer revision (STALE_REVISION).
      current = await lockFileProposal(ctx, input.fileId);
      const { rows } = await sql<{ fresh: boolean }>`
        SELECT created_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int) AS fresh
        FROM crove_kernel.extraction WHERE org_id = ${ctx.orgId}::uuid AND id = ${pending.id}::uuid`.execute(ctx.trx);
      applies = rows[0]?.fresh === true;
      // The proposal's revision was read from another file (the original, #2269): a re-reading of this one leaves it.
      if (applies && current?.status === 'pending' && (await readFromAnotherFile(ctx, current, input.fileId))) applies = false;
      await ctx.trx
        .updateTable('crove_kernel.extraction')
        .set(outcome)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', pending.id)
        .execute();
      run = pending;
    }
    ctx.audit({ version: run.version, status: input.status, applied: applies });

    // Authors (P10): the extraction itself, the user who uploaded the source file (the content is read from what
    // they supplied; a forwarded email has no authenticated sender, so it adds nobody) and, for a re-extraction,
    // the user who asked for it (they chose to replace the content with a new reading).
    const readers: ActorRef[] = [actorRef(ctx.actor)];
    if (file.created_by) readers.push({ type: 'user', id: file.created_by });
    if (run.requested_by) readers.push({ type: 'user', id: run.requested_by });
    const withReaders = (authors: ActorRef[]) => readers.reduce(addAuthor, authors);

    if (!input.proposal) {
      // A run that is done with no proposal read a file into something else than an invoice (a bank statement into bank
      // lines, #2142): its own account of it, not a failure.
      if (input.status === 'done') {
        await ctx.activity('kernel.file', input.fileId, 'extraction.read', input.summary ?? 'Đã đọc tệp');
        return { extractionId: run.id, proposalId: null, duplicate: false };
      }
      await ctx.activity('kernel.file', input.fileId, 'extraction.failed', input.error ?? 'Không đọc được chứng từ');
      // Whoever is waiting for this reading is told (#671, kernel.notification.dispatch).
      if (input.status === 'failed') await ctx.emit('kernel.file.read_failed', { fileId: input.fileId, version: run.version, reason: input.failure ?? 'document' });
      if (applies && current?.status === 'pending') {
        await ctx.activity('kernel.proposal', current.id, 'proposal.reextract_failed', `Đọc lại không thành công (lần đọc ${run.version}); đề xuất giữ nguyên bản ${current.revision}`);
      }
      return { extractionId: run.id, proposalId: null, duplicate: false };
    }

    // A run that went stale is presumed lost: decisions and edits may have happened since, so its late result stays
    // in the file's history only. An executed proposal is never followed by a new one while the invoice is in the
    // books, and a request on it is refused; once its document is voided by a reversal (#165), a new proposal
    // follows, as after a rejection.
    if (!applies || (current?.status === 'executed' && !(await executedButVoided(ctx, current)))) {
      await ctx.activity('kernel.file', input.fileId, 'extraction.not_applied', `Kết quả đọc lại (lần đọc ${run.version}) đến quá muộn hoặc đề xuất đã được xử lý nên không được áp dụng`);
      return { extractionId: run.id, proposalId: null, duplicate: false };
    }

    if (current?.status === 'pending') {
      const authors = parseAuthors(current.authors);
      // A pending proposal always records its authors (constraint proposal_policy_recorded); fail closed anyway.
      if (!authors) throw new DomainError('NOT_EDITABLE', 422, 'Đề xuất thiếu thông tin người soạn nên không cập nhật được');
      const revision = current.revision + 1;
      await ctx.trx
        .updateTable('crove_kernel.proposal')
        .set({
          title: input.proposal.title,
          payload: JSON.stringify(input.proposal.payload),
          duplicate_of: input.proposal.duplicateOf,
          extraction_id: run.id,
          revision,
          authors: JSON.stringify(withReaders(authors)),
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', current.id)
        .execute();
      ctx.audit({ proposal_id: current.id, revision });
      await (upgraded
        ? ctx.activity('kernel.proposal', current.id, 'proposal.original_received', `Đã nhận hóa đơn gốc XML ${file.filename}; số liệu lấy từ hóa đơn gốc (bản ${revision})`.slice(0, 500))
        : ctx.activity('kernel.proposal', current.id, 'proposal.reextracted', `Đọc lại chứng từ (lần đọc ${run.version}, bản ${revision})`));
      return { extractionId: run.id, proposalId: current.id, duplicate: false };
    }

    // The first proposal of the file, or a new one after a rejected proposal or a voided purchase (the file was read
    // again on purpose). A rejection while the run was in flight is refused, so this rejection came before the request.
    const proposal = await ctx.trx
      .insertInto('crove_kernel.proposal')
      .values({
        org_id: ctx.orgId,
        kind: input.proposal.kind,
        command: input.proposal.command,
        title: input.proposal.title,
        payload: JSON.stringify(input.proposal.payload),
        source_file_id: input.fileId,
        extraction_id: run.id,
        duplicate_of: input.proposal.duplicateOf,
        // P12: who may approve this command right now; approval re-checks each one's role live.
        eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, input.proposal.command),
        authors: JSON.stringify(withReaders([])),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (current) ctx.audit({ proposal_id: proposal.id, replaces_proposal_id: current.id });
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.created', 'Tạo đề xuất từ chứng từ');
    await ctx.emit('kernel.proposal.created', { proposalId: proposal.id, kind: input.proposal.kind });
    return { extractionId: run.id, proposalId: proposal.id, duplicate: false };
  },
});

// A staged bank statement (#2142) is decided: imported (the finance module stored its lines in this same transaction) or
// rejected (skipped, nothing stored). A finished run never changes (extraction_guard), so the decision is a NEW run of the
// file, with the staged summary in its new state and no rows: it is the file's newest run, the one the Inbox shows and the
// one a second decision finds, so a statement is decided once; its audit row names the member who decided (a run inserted
// already finished has no requester). The staged run keeps its rows, like any run keeps its
// result. Run by finance.bank.statement_confirm and .statement_reject, as the member who decided; the finance module takes
// a lock on the file first, so two members cannot both decide it.
export const statementState = defineCommand({
  name: 'kernel.extraction.statement_state',
  input: z.object({
    fileId: zId,
    state: z.enum(['imported', 'rejected']),
    // What an import stored: the lines new to the account, the lines it already had, and the import.
    newLines: z.number().int().nonnegative().optional(),
    duplicateLines: z.number().int().nonnegative().optional(),
    importId: zId.optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: REEXTRACT_ROLES,
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới quyết định được sao kê');
    await lockFile(ctx, input.fileId, true);
    const run = await ctx.trx
      .selectFrom('crove_kernel.extraction')
      .select(['id', 'status', 'result', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .orderBy('version', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    const result = run?.result as { kind?: unknown; summary?: { state?: unknown } & Record<string, unknown> } | null | undefined;
    if (!run || run.status !== 'done' || result?.kind !== 'bank_statement' || result.summary?.state !== 'staged') {
      throw new DomainError('STATEMENT_NOT_STAGED', 409, 'Sao kê này đã được xử lý hoặc đã được đọc lại; hãy tải lại danh sách');
    }
    const summary = {
      ...result.summary,
      state: input.state,
      ...(input.newLines !== undefined ? { newLines: input.newLines } : {}),
      ...(input.duplicateLines !== undefined ? { duplicateLines: input.duplicateLines } : {}),
      ...(input.importId !== undefined ? { importId: input.importId } : {}),
    };
    await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        file_id: input.fileId,
        ...(run.legal_entity_id ? { legal_entity_id: run.legal_entity_id } : {}),
        method: 'unsupported',
        status: 'done',
        result: JSON.stringify({ kind: 'bank_statement', summary }),
        checks: '[]',
        completed_at: ctx.now,
      })
      .execute();
    ctx.audit({ state: input.state, ...(input.newLines !== undefined ? { new_lines: input.newLines } : {}) });
    await ctx.activity(
      'kernel.file',
      input.fileId,
      input.state === 'imported' ? 'statement.imported' : 'statement.rejected',
      input.state === 'imported' ? `Đã nhập sao kê: ${input.newLines ?? 0} dòng mới, ${input.duplicateLines ?? 0} dòng đã có` : 'Đã bỏ qua sao kê; không có dòng nào được nhập',
    );
    return { fileId: input.fileId, state: input.state };
  },
});

export const extractionCommands = [reextractFile, recordExtraction, statementState];
