// How the Inbox shows a file: being read, read into a proposal (or a likely duplicate), failed, or, for a ZIP archive
// (#314), opened into files of its own. Shared by files.recent and files.batch.
import { sql } from 'kysely';
import { z } from 'zod';
import { ARCHIVE_ENTRY_REASONS, zId, zStatementSummary, type FileStatus } from '@crove/kernel-contract';
import type { QueryContext } from '@crove/kernel-runtime';
import { EDITOR_ROLES } from './approval.ts';
import { MAX_EXTRACTION_VERSIONS, REEXTRACT_STALE_MINUTES, STALE_RUN_ERROR, voidedProposals } from './extraction.ts';
import { isArchiveType } from './files.ts';

// What a document kept for the org's next daily budget (#675) shows as its error.
export const WAITING_FOR_BUDGET = 'Tổ chức đã dùng hết hạn mức đọc chứng từ trong 24 giờ; tệp được giữ lại và sẽ được đọc khi có hạn mức mới';

// What kernel.file.archive.record keeps in the archive's extraction result, one item per entry.
export const zStoredArchiveEntry = z.object({
  name: z.string(),
  outcome: z.enum(['stored', 'duplicate', 'rejected']),
  reason: z.enum(ARCHIVE_ENTRY_REASONS).nullable(),
  fileId: zId.nullable(),
});
export type StoredArchiveEntry = z.infer<typeof zStoredArchiveEntry>;

// The summary a bank statement read from a file keeps in its run's result (#2142), read defensively; the run's rows and
// the account number that named its account (the finance module's) stay out of what the Inbox is told.
type Statement = NonNullable<FileStatus['statement']>;
interface StatementContext {
  decisions: ReadonlyMap<string, NonNullable<Statement['decidedBy']>>;
  // The legal entity names the reader sees, by id, and the names of the members who uploaded files, by user id.
  entities: ReadonlyMap<string, string>;
  uploaders: ReadonlyMap<string, string>;
  // The sender address of the mail each emailed file came in, by file id (#2196), for a reader who may read mails.
  senders: ReadonlyMap<string, string>;
}
const NO_CONTEXT: StatementContext = { decisions: new Map(), entities: new Map(), uploaders: new Map(), senders: new Map() };

function statementOf(
  value: unknown,
  file: { id: string; source: string; createdBy: string | null; legalEntityId: string | null },
  known: StatementContext,
): Statement | null {
  const parsed = zStatementSummary.safeParse(value);
  if (!parsed.success) return null;
  const entityName = file.legalEntityId ? known.entities.get(file.legalEntityId) : undefined;
  return {
    ...parsed.data,
    decidedBy: parsed.data.state === 'staged' ? null : (known.decisions.get(file.id) ?? null),
    // A file's source is upload or email here: images and spreadsheets for other uses never carry a statement.
    origin:
      file.source === 'email'
        ? { channel: 'email', by: null, from: known.senders.get(file.id) ?? null }
        : { channel: 'upload', by: file.createdBy ? (known.uploaders.get(file.createdBy) ?? null) : null, from: null },
    entity: file.legalEntityId && entityName !== undefined ? { id: file.legalEntityId, name: entityName } : null,
  };
}

// The names of the members with these user ids, for members of the org alone (member_profiles); a person who is gone has none.
async function memberNames(ctx: QueryContext, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
    SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${[...userIds]}::uuid[])`.execute(ctx.trx);
  for (const p of rows) names.set(p.user_id, p.display_name ?? p.email);
  return names;
}

// Who decided each statement (imported or skipped) and when, from the audit row of the decision (#2142), newest first per
// file; a person's name only while they are a member (member_profiles answers for members of the org alone). A decision
// whose audit row the reader cannot see, or whose actor is gone, shows no name.
async function statementDecisions(ctx: QueryContext, fileIds: readonly string[]): Promise<Map<string, NonNullable<NonNullable<FileStatus['statement']>['decidedBy']>>> {
  const out = new Map<string, NonNullable<NonNullable<FileStatus['statement']>['decidedBy']>>();
  if (fileIds.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('crove_kernel.audit_event')
    .select(['target_id', 'actor_id', 'occurred_at'])
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', 'kernel.extraction.statement_state')
    .where('outcome', '=', 'ok')
    .where('target_type', '=', 'kernel.file')
    .where('target_id', 'in', [...fileIds])
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const names = await memberNames(ctx, [...new Set(rows.flatMap((r) => (r.actor_id ? [r.actor_id] : [])))]);
  for (const r of rows) {
    if (!r.target_id || out.has(r.target_id)) continue;
    out.set(r.target_id, { name: r.actor_id ? (names.get(r.actor_id) ?? null) : null, at: new Date(r.occurred_at).toISOString() });
  }
  return out;
}

// The caller's context sees every legal entity (the wildcard in enter_context's le_scope); fetched once per statement.
export const seesEveryEntity = sql<boolean>`coalesce('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]), false)`;
// Who may read a forwarded mail and its sender, as kernel.inbound.recent: those who write posts, and only in a context
// that sees every legal entity, as a mail has no entity.
const MAIL_READER_ROLES: readonly string[] = ['owner', 'admin', 'member'];

// The sender address of the mail each file came in (#2196), by file id. Nothing for a reader who may not read mails (a
// viewer, a member limited to some legal entities, an agent), for a mail whose address was erased, and for a file with no
// mail: the card then says the sender is unknown.
async function senderAddresses(ctx: QueryContext, files: ReadonlyArray<{ fileId: string; messageId: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (files.length === 0 || ctx.actor.type !== 'user' || ctx.role === null || !MAIL_READER_ROLES.includes(ctx.role)) return out;
  const messages = await ctx.trx
    .selectFrom('crove_kernel.inbound_message')
    .select(['id', 'from_address'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...new Set(files.map((f) => f.messageId))])
    .where(seesEveryEntity)
    .execute();
  const address = new Map(messages.flatMap((m) => (m.from_address ? [[m.id, m.from_address] as const] : [])));
  for (const f of files) {
    const from = address.get(f.messageId);
    if (from) out.set(f.fileId, from);
  }
  return out;
}

const STATEMENT_STATUS = { staged: 'staged', imported: 'imported', rejected: 'dismissed' } as const;

export interface FileStatusRow {
  status: FileStatus;
  // How many entries an opened archive has; null for any other file, and for an archive not opened (yet, or at all).
  // The entries themselves are read apart and in slices (archiveEntries), so no listing loads them all.
  entryCount: number | null;
}

// staged: the files whose newest run is a bank statement waiting for a member (#2142), however old, newest first.
export type FileStatusFilter = { ids: readonly string[] } | { recent: number } | { staged: number };

export async function fileStatuses(ctx: QueryContext, filter: FileStatusFilter): Promise<FileStatusRow[]> {
  if ('ids' in filter && filter.ids.length === 0) return [];
  // Per file: its newest extraction run and its newest proposal (a file read again after a rejection has more
  // than one).
  let query = ctx.trx
    .selectFrom('crove_kernel.file as f')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('crove_kernel.extraction as x')
          .select([
            'x.status',
            'x.error',
            'x.version',
            'x.method',
            'x.created_at as run_at',
            'x.legal_entity_id as run_entity_id',
            // Only the size of an opened archive's entry list, from its own column (#432): neither the list nor an
            // invoice's result is loaded here.
            sql<number | null>`CASE WHEN x.method = 'archive' AND x.status = 'done' THEN x.entry_count END`.as('entry_count'),
            // What a bank statement read into bank lines recorded as its result (#2142): only the small summary of a run of
            // method 'unsupported' (the guard keeps an invoice's result from being read for every file).
            sql<unknown>`CASE WHEN x.method = 'unsupported' AND x.status = 'done' AND x.result ->> 'kind' = 'bank_statement' THEN x.result -> 'summary' END`.as('statement'),
            sql<boolean>`x.status = 'pending' AND x.created_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int)`.as(
              'in_flight',
            ),
          ])
          .whereRef('x.org_id', '=', 'f.org_id')
          .whereRef('x.file_id', '=', 'f.id')
          .orderBy('x.version', 'desc')
          .limit(1)
          .as('e'),
      (join) => join.onTrue(),
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('crove_kernel.proposal as q')
          .select([
            'q.id',
            'q.status',
            'q.duplicate_of',
            'q.decided_at',
            // The file the proposal's current revision was read from (#2269): not this one when the original XML of an invoice
            // first read from this PDF took the proposal's place.
            sql<string | null>`(SELECT xr.file_id FROM crove_kernel.extraction xr WHERE xr.org_id = q.org_id AND xr.id = q.extraction_id)`.as('read_from_file'),
          ])
          .whereRef('q.org_id', '=', 'f.org_id')
          // The proposals read from the file, and the one revised from its reading (the original of a PDF's invoice, #2269):
          // both files show the one proposal. So does the original attached to an executed proposal (#2320): its run names
          // the proposal it is the evidence of.
          .where(
            sql<boolean>`(q.source_file_id = f.id
              OR q.extraction_id IN (SELECT xe.id FROM crove_kernel.extraction xe WHERE xe.org_id = f.org_id AND xe.file_id = f.id)
              OR q.id IN (SELECT xo.original_of_proposal_id FROM crove_kernel.extraction xo WHERE xo.org_id = f.org_id AND xo.file_id = f.id AND xo.original_of_proposal_id IS NOT NULL))`,
          )
          .orderBy('q.created_at', 'desc')
          .orderBy('q.id', 'desc')
          .limit(1)
          .as('p'),
      (join) => join.onTrue(),
    )
    .select([
      'f.id',
      'f.filename',
      'f.content_type',
      'f.created_at',
      'f.source',
      'f.created_by',
      'f.inbound_message_id',
      'e.run_entity_id',
      'e.status as extraction_status',
      'e.error',
      'e.version',
      'e.method',
      'e.entry_count',
      'e.statement',
      'e.in_flight',
      'e.run_at',
      'p.id as proposal_id',
      'p.status as proposal_status',
      'p.duplicate_of',
      'p.decided_at',
      'p.read_from_file',
      // Kept for the org's next daily budget (#675): a deferral of the file that is not due yet.
      sql<boolean>`EXISTS (
        SELECT 1 FROM crove_kernel.usage_deferral d
        WHERE d.org_id = f.org_id AND d.subject_type = 'file' AND d.subject_id = f.id::text AND d.retry_at > pg_catalog.now()
      )`.as('waiting'),
    ])
    .where('f.org_id', '=', ctx.orgId)
    // Images of Social posts (#372) and import spreadsheets (#465) are not documents, unless the same bytes were also
    // uploaded as one and read.
    .where((eb) => eb.or([eb('f.source', 'not in', ['social', 'import']), eb('e.status', 'is not', null)]));
  if ('ids' in filter) query = query.where('f.id', 'in', [...filter.ids]);
  else if ('staged' in filter) query = query.where(sql<boolean>`(e.statement ->> 'state') = 'staged'`).orderBy('f.created_at', 'desc').limit(filter.staged);
  else query = query.orderBy('f.created_at', 'desc').limit(filter.recent);
  const rows = await query.execute();
  // An executed purchase whose document was voided by a reversal (#165) may be read again.
  const voided = await voidedProposals(
    ctx,
    rows.flatMap((r) => (r.proposal_id && r.proposal_status === 'executed' ? [r.proposal_id] : [])),
  );
  const editor = ctx.actor.type === 'user' && ctx.role !== null && EDITOR_ROLES.includes(ctx.role);
  const asStatement = (r: (typeof rows)[number]) => ({ id: r.id, source: r.source, createdBy: r.created_by, legalEntityId: r.run_entity_id });
  const statementRows = rows.filter((r) => statementOf(r.statement, asStatement(r), NO_CONTEXT) !== null);
  // The statements read from files that were decided: who decided each, from its audit row (#2142).
  const decisions = await statementDecisions(
    ctx,
    statementRows.flatMap((r) => {
      const state = statementOf(r.statement, asStatement(r), NO_CONTEXT)?.state;
      return state === 'imported' || state === 'rejected' ? [r.id] : [];
    }),
  );
  // Where each statement came from and which entity it is for (#2191): the uploaders' names, and the names of the entities
  // the reader sees (an entity hidden from the reader reads as none).
  const uploaders = await memberNames(ctx, [...new Set(statementRows.flatMap((r) => (r.source === 'upload' && r.created_by ? [r.created_by] : [])))]);
  const entityIds = [...new Set(statementRows.flatMap((r) => (r.run_entity_id ? [r.run_entity_id] : [])))];
  const entities = new Map<string, string>();
  if (entityIds.length > 0) {
    const found = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', entityIds).execute();
    for (const e of found) entities.set(e.id, e.name);
  }
  const known: StatementContext = { decisions, entities, uploaders, senders: await senderAddresses(ctx, statementRows.flatMap((r) => (r.source === 'email' && r.inbound_message_id ? [{ fileId: r.id, messageId: r.inbound_message_id }] : []))) };
  return rows.map((r) => {
    const archive = isArchiveType(r.content_type);
    const waiting = !r.extraction_status && r.waiting;
    const isVoided = r.proposal_status === 'executed' && r.proposal_id !== null && voided.has(r.proposal_id);
    // A reading started after the proposal was decided (a rejection, an expiry, a failed run, or a posting since voided)
    // that failed or was left behind (#2032): the file's latest outcome is that failure, shown with its re-read, not the
    // old decision. A re-read that failed before the decision, or one of a proposal still to be decided, keeps the
    // proposal, which still stands.
    const lastRunFailed = r.extraction_status === 'failed' || (r.extraction_status === 'pending' && !r.in_flight);
    const decided = ['rejected', 'expired', 'failed'].includes(r.proposal_status ?? '') || isVoided;
    const failedSinceDecision = lastRunFailed && decided && r.decided_at !== null && r.run_at !== null && r.run_at > r.decided_at;
    const statement = statementOf(r.statement, asStatement(r), known);
    const status: FileStatus['status'] = waiting
      ? 'waiting'
      : !r.extraction_status || r.in_flight
        ? 'processing'
        : r.method === 'archive'
          ? r.extraction_status === 'done'
            ? 'expanded'
            : 'failed'
          : statement
            ? STATEMENT_STATUS[statement.state]
            : r.proposal_id && !failedSinceDecision
              ? r.duplicate_of
                ? 'duplicate'
                : 'proposed'
              : 'failed';
    return {
      status: {
        id: r.id,
        filename: r.filename,
        contentType: r.content_type,
        status,
        error: waiting
          ? WAITING_FOR_BUDGET
          : r.extraction_status === 'failed'
            ? r.error
            : r.extraction_status === 'pending' && !r.in_flight
              ? STALE_RUN_ERROR
              : null,
        statement,
        proposalId: r.proposal_id,
        proposalStatus: r.proposal_status ?? null,
        voided: isVoided,
        version: r.version ?? null,
        // The same checks kernel.file.reextract makes; an archive is opened once and never read again.
        canReextract:
          editor &&
          // An archive is opened once; a ZIP read as a bank statement (#2142) may be read again.
          (!archive || r.method === 'unsupported') &&
          // A statement imported is stored once: reading it again would only find its lines already there. One waiting or
          // skipped may be read again (a corrected mapping, a second look).
          statement?.state !== 'imported' &&
          Boolean(r.extraction_status) &&
          !r.in_flight &&
          // Reading this file again is refused once the original of its invoice took its proposal's place (#2269): the
          // original is read again instead.
          !(r.proposal_status === 'pending' && r.read_from_file !== null && r.read_from_file !== r.id) &&
          (r.proposal_status !== 'executed' || isVoided) &&
          (r.version ?? 0) < MAX_EXTRACTION_VERSIONS,
        createdAt: r.created_at.toISOString(),
      },
      entryCount: r.entry_count === null || r.entry_count === undefined ? null : Number(r.entry_count),
    };
  });
}

// The first `limit` entries of each opened archive asked for, sliced in the database (jsonpath), so a response holds at
// most the sum of the limits. Archives of other orgs, or not opened, read as missing.
export async function archiveEntries(ctx: QueryContext, slices: ReadonlyArray<{ fileId: string; limit: number }>): Promise<Map<string, StoredArchiveEntry[]>> {
  const wanted = slices.filter((s) => s.limit > 0);
  if (wanted.length === 0) return new Map();
  const { rows } = await sql<{ file_id: string; entries: unknown }>`
    SELECT x.file_id, pg_catalog.jsonb_path_query_array(x.result, '$.entries[0 to $last]', pg_catalog.jsonb_build_object('last', s.n - 1)) AS entries
    FROM ROWS FROM (pg_catalog.unnest(${wanted.map((s) => s.fileId)}::uuid[]), pg_catalog.unnest(${wanted.map((s) => s.limit)}::int[])) AS s(file_id, n)
    JOIN crove_kernel.extraction x ON x.org_id = ${ctx.orgId}::uuid AND x.file_id = s.file_id AND x.method = 'archive' AND x.status = 'done'`.execute(ctx.trx);
  const out = new Map<string, StoredArchiveEntry[]>();
  for (const row of rows) {
    const parsed = z.array(zStoredArchiveEntry).safeParse(row.entries);
    if (parsed.success) out.set(row.file_id, parsed.data);
  }
  return out;
}