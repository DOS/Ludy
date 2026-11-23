// The worker's notes commands (issue #1671, ADR-0037 §2 and §4): emptying the trash, removing a former member's
// private notes 30 days after they left, and a to-do's reminder (#1675). The system context reads no private note or
// to-do, so the first two go through definers that delete by rule and answer a count, never text; the definers refuse
// every login but the worker's and every context but the org's system context. The reminder gets ids and a time from
// the worker's claim (ludy_notes.todo_reminders_claim) and writes a notification that holds none of the to-do's text.
import { sql } from 'kysely';
import { z } from 'zod';
import { notifyMembers, uploaderEntity } from '@ludy/kernel';
import { auditValue, NOTE_ATTACHMENT_EXTRACTED_TEXT_MAX, NOTE_TRASH_DAYS, zId } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { notesManifest } from './manifest.ts';

function assertSystem(ctx: Pick<CommandContext | QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
}

// The notes the daily sweep removes: in the trash for NOTE_TRASH_DAYS.
export const trashCutoff = (now: Date): Date => new Date(now.getTime() - NOTE_TRASH_DAYS * 86_400_000);

export const trashEmpty = defineCommand({
  name: 'notes.trash.empty',
  runsWhenOff: 'empties the notes trash after its retention period while the app is off',
  input: z.strictObject({}),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx): Promise<{ removed: number }> => {
    assertSystem(ctx);
    const before = trashCutoff(ctx.now);
    const { rows } = await sql<{ n: string }>`SELECT ludy_notes.trash_empty(${before}::timestamptz) AS n`.execute(ctx.trx);
    const removed = Number(rows[0]?.n ?? 0);
    ctx.audit({ before: before.toISOString(), removed });
    return { removed };
  },
});

// Queued by the worker 30 days after kernel.member.removed (apps/kernel/src/notes-worker.ts), with that event's id, or
// run by the daily sweep without one for a removal that queued no job (#1733). The definer removes nothing when the
// user is a member of the org again, or was removed from it less than 30 days ago by the audit trail, whatever the
// caller says. A later removal of the same user (added back, then removed again) has a job of its own 30 days after
// it, so this one leaves the notes to it: outbox event ids are UUIDv7, ordered by time, and that later event is
// younger than 30 days, so still in the outbox (#997).
export const memberItemsPurge = defineCommand({
  name: 'notes.member_items.purge',
  runsWhenOff: 'purges a leaving member\'s private notes after the grace period while the app is off',
  input: z.strictObject({ userId: zId, eventId: zId.optional() }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx, input): Promise<{ removed: number }> => {
    assertSystem(ctx);
    if (input.eventId !== undefined) {
      const later = await ctx.trx
        .selectFrom('ludy_kernel.outbox_event')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('type', '=', 'kernel.member.removed')
        .where('id', '>', input.eventId)
        .where(sql<string>`payload ->> 'userId'`, '=', input.userId)
        .executeTakeFirst();
      if (later) {
        ctx.audit({ userId: input.userId, eventId: input.eventId, removed: 0, laterEventId: later.id });
        return { removed: 0 };
      }
    }
    const { rows } = await sql<{ n: string }>`SELECT ludy_notes.member_items_purge(${input.userId}::uuid) AS n`.execute(ctx.trx);
    const removed = Number(rows[0]?.n ?? 0);
    ctx.audit({ userId: input.userId, eventId: input.eventId ?? null, removed });
    return { removed };
  },
});

// The notification kind of a to-do's reminder; members turn it off like any kind (#671).
export const TODO_DUE = 'notes.todo_due';

// One reminder the worker claimed: a notification for the to-do's owner, once per to-do and reminder time (a replayed
// job writes nothing), with the to-do's id as its subject and no text (notes.md §3.6: "Bạn có 1 việc đến hạn"; the app
// shows the title only when the owner opens it). The owner comes from ludy_notes.todo_reminder_owner, never from the
// input, and only while the to-do still waits for this reminder: one completed, deleted or given another time after the
// claim sends nothing. The owner gets nothing either once they left the org or turned the kind off.
export const todoRemind = defineCommand({
  name: 'notes.todo.remind',
  input: z.strictObject({ todoId: zId, remindAt: z.iso.datetime({ offset: true }) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: number }> => {
    assertSystem(ctx);
    const remindAt = new Date(input.remindAt).toISOString();
    const { rows } = await sql<{ owner: string | null }>`SELECT ludy_notes.todo_reminder_owner(${input.todoId}::uuid, ${remindAt}::timestamptz) AS owner`.execute(ctx.trx);
    const owner = rows[0]?.owner ?? null;
    if (owner === null) {
      ctx.audit({ todoId: input.todoId, remindAt, sent: 0, current: false });
      return { sent: 0 };
    }
    const sent = await notifyMembers(ctx, {
      kind: TODO_DUE,
      users: [owner],
      key: `todo_due:${input.todoId}:${remindAt}`,
      subject: { type: 'notes.todo', id: input.todoId },
      // Under an entity the owner sees (the notification's le_scope policy, #1280), by the rule enter_context's le_scope
      // and a member's own upload follow.
      legalEntityId: await uploaderEntity(ctx, owner),
    });
    ctx.audit({ todoId: input.todoId, remindAt, sent });
    return { sent };
  },
});

export interface NoteAttachmentExtractSource {
  id: string;
  storageKey: string;
  contentType: string;
}

export const attachmentExtractSource = defineQuery({
  name: 'notes.attachment.extract_source',
  input: z.strictObject({ attachmentId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<NoteAttachmentExtractSource | null> => {
    assertSystem(ctx);
    const { rows } = await sql<{ org_id: string; id: string; storage_key: string; content_type: string }>`
      SELECT org_id, id, storage_key, content_type
        FROM ludy_notes.attachment_for_extract(${input.attachmentId}::uuid)
    `.execute(ctx.trx);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      storageKey: row.storage_key,
      contentType: row.content_type,
    };
  },
});

export const attachmentExtractRecord = defineCommand({
  name: 'notes.attachment.extract_record',
  input: z.strictObject({
    attachmentId: zId,
    status: z.enum(['done', 'skipped', 'failed']),
    extractedText: z.string().max(NOTE_ATTACHMENT_EXTRACTED_TEXT_MAX).nullable(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'notes.attachment', id: input.attachmentId }),
  handler: async (ctx, input): Promise<{ updated: boolean }> => {
    assertSystem(ctx);
    const { rows } = await sql<{ updated: boolean }>`
      SELECT ludy_notes.attachment_record_extract(
        ${input.attachmentId}::uuid,
        ${input.status}::text,
        ${input.extractedText}::text
      ) AS updated
    `.execute(ctx.trx);
    const updated = rows[0]?.updated === true;
    ctx.audit({
      attachmentId: input.attachmentId,
      status: input.status,
      extractedText: auditValue(notesManifest.tables.ludy_notes.attachment, 'extracted_text', input.extractedText),
      updated,
    });
    return { updated };
  },
});

export const systemCommands = [trashEmpty, memberItemsPurge, todoRemind, attachmentExtractRecord];
export const systemQueries = [attachmentExtractSource];
