// SPDX-License-Identifier: AGPL-3.0-only
// Shared record link helpers for notes and private to-dos (notes.md §3.4, ADR-0037, ADR-0048, #2595).
import { NOTE_LINKS_MAX, type NoteLink, type NoteLinkTarget } from '@ludy/kernel-contract';
import { DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

// The query that opens a record another module owns (notes.md §3.4, #1672). No foreign key goes to another module's
// schema, so such a target is checked by running that module's own get query in the caller's context: its role check,
// its row policies and the caller's legal entities apply, as on the record's own screen.
// apps/kernel/test/notes-link-targets.test.ts checks that each is registered.
export const NOTE_TARGET_QUERIES = {
  'finance.purchase_document': 'finance.documents.get',
  'finance.journal_entry': 'finance.journal.get',
  'crm.booking': 'crm.booking.get',
  'projects.project': 'projects.project.get',
  'meetings.meeting': 'meetings.meeting.get',
} as const satisfies Record<Exclude<NoteLinkTarget, 'kernel.party' | 'kernel.file' | 'kernel.task'>, string>;

// What those queries answer for a record the caller cannot open: not there (or in a legal entity, or of a host, the
// caller cannot see), or not for the caller's role. Any other refusal, a misspelled query name included, is a bug and
// fails the read instead of showing every link as unavailable.
const UNREADABLE = new Set(['DOCUMENT_NOT_FOUND', 'ENTRY_NOT_FOUND', 'BOOKING_NOT_FOUND', 'PROJECT_NOT_FOUND', 'MEETING_NOT_FOUND', 'FORBIDDEN']);

const KERNEL_TABLES = {
  'kernel.party': 'crove_kernel.party',
  'kernel.file': 'crove_kernel.file',
  'kernel.task': 'crove_kernel.task',
} as const;

type LinkParent = { kind: 'note'; id: string } | { kind: 'todo'; id: string };

/** Whether the caller can open the linked target record in this org. */
export async function canOpen(ctx: QueryContext, targetType: NoteLinkTarget, targetId: string): Promise<boolean> {
  if (targetType in KERNEL_TABLES) {
    const table = KERNEL_TABLES[targetType as keyof typeof KERNEL_TABLES];
    const found = await ctx.trx.selectFrom(table).select('id').where('org_id', '=', ctx.orgId).where('id', '=', targetId).executeTakeFirst();
    return found !== undefined;
  }
  const moduleTarget = targetType as keyof typeof NOTE_TARGET_QUERIES;
  const queryInput = moduleTarget === 'meetings.meeting' ? { meetingId: targetId } : { id: targetId };
  try {
    const answer = await ctx.query(NOTE_TARGET_QUERIES[moduleTarget], queryInput);
    return answer.status === 'ok';
  } catch (error) {
    if (error instanceof DomainError && UNREADABLE.has(error.code)) return false;
    throw error;
  }
}

/** Validates the target, enforces per-item limit and uniqueness, and inserts a link row for a note or private to-do. */
export async function insertRecordLink(
  ctx: CommandContext,
  parent: LinkParent,
  userId: string,
  targetType: NoteLinkTarget,
  targetId: string,
): Promise<string> {
  const column = parent.kind === 'note' ? 'note_id' : 'todo_id';
  const { n } = await ctx.trx
    .selectFrom('crove_notes.link')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', ctx.orgId)
    .where(column, '=', parent.id)
    .executeTakeFirstOrThrow();
  if (Number(n) >= NOTE_LINKS_MAX) {
    const label = parent.kind === 'note' ? 'ghi chú' : 'việc';
    throw new DomainError('NOTE_LINK_LIMIT', 409, `Một ${label} gắn được tối đa ${NOTE_LINKS_MAX} bản ghi`, { max: NOTE_LINKS_MAX });
  }
  if (!(await canOpen(ctx, targetType, targetId))) {
    throw new DomainError('NOTE_LINK_TARGET_NOT_FOUND', 404, 'Không tìm thấy bản ghi để gắn liên kết');
  }
  const expectedConstraint = parent.kind === 'note' ? 'link_note_target_uq' : 'link_todo_target_uq';
  const link = await ctx.trx
    .insertInto('crove_notes.link')
    .values({
      org_id: ctx.orgId,
      note_id: parent.kind === 'note' ? parent.id : null,
      todo_id: parent.kind === 'todo' ? parent.id : null,
      target_type: targetType,
      target_id: targetId,
      party_id: targetType === 'kernel.party' ? targetId : null,
      file_id: targetType === 'kernel.file' ? targetId : null,
      task_id: targetType === 'kernel.task' ? targetId : null,
      created_by: userId,
      created_at: ctx.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .catch((error: unknown) => {
      const pg = error as { code?: string; constraint?: string } | null | undefined;
      if (pg?.code === '23505' && pg.constraint === expectedConstraint) {
        const label = parent.kind === 'note' ? 'Ghi chú' : 'Việc này';
        throw new DomainError('NOTE_LINK_EXISTS', 409, `${label} đã gắn với bản ghi này`);
      }
      throw error;
    });
  return link.id;
}

/** Loads and checks caller access for every record linked to a note or private to-do. */
export async function loadEnrichedLinks(ctx: QueryContext, parent: LinkParent): Promise<NoteLink[]> {
  const column = parent.kind === 'note' ? 'note_id' : 'todo_id';
  const rows = await ctx.trx
    .selectFrom('crove_notes.link')
    .select(['id', 'target_type', 'target_id', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where(column, '=', parent.id)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const shown: NoteLink[] = [];
  for (const l of rows) {
    shown.push({
      id: l.id,
      targetType: l.target_type,
      targetId: l.target_id,
      createdAt: new Date(l.created_at).toISOString(),
      available: await canOpen(ctx, l.target_type, l.target_id),
    });
  }
  return shown;
}
