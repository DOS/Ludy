// The notes module's worker part (issue #1671, ADR-0037 §4): a member's removal queues the purge of their private notes
// 30 days later, with ids only; other events queue nothing; note attachment extraction deduplicates within 300s slots (#4213).
import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT } from '@ludy/mod-notes';
import { QUEUES } from '../src/jobs-schema.ts';
import {
  NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT,
  NOTE_ATTACHMENT_EXTRACT_SINGLETON_SECONDS,
  queueNoteAttachmentExtract,
  queueNotesMemberPurge,
  requestDueNoteAttachmentExtracts,
} from '../src/notes-worker.ts';

function fakeBoss(returnId: string | null = 'job') {
  const sent: Array<{ queue: string; data: unknown; options: Record<string, unknown> }> = [];
  const boss = {
    send: async (queue: string, data: unknown, options: Record<string, unknown>) => {
      sent.push({ queue, data, options });
      return returnId;
    },
  } as unknown as PgBoss;
  return { boss, sent };
}

describe('notes worker (#1671)', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const orgId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
  const row = { org_id: orgId, event_id: 'event-1', type: 'kernel.member.removed', payload: { userId: 'user-1', oldRole: 'member' } };

  it('queues the purge of a removed member 30 days later, with ids only', async () => {
    const { boss, sent } = fakeBoss();
    await queueNotesMemberPurge(boss, row, now);
    expect(sent).toEqual([
      {
        queue: QUEUES.notesMemberPurge,
        data: { orgId, userId: 'user-1', eventId: 'event-1' },
        options: expect.objectContaining({ singletonKey: `${orgId}:notes-member-purge:user-1:event-1`, startAfter: new Date('2026-12-01T00:00:00Z') }),
      },
    ]);
  });

  it('queues nothing for another event or a payload without a user', async () => {
    const { boss, sent } = fakeBoss();
    expect(queueNotesMemberPurge(boss, { ...row, type: 'kernel.member.role_changed' }, now)).toBeNull();
    expect(queueNotesMemberPurge(boss, { ...row, payload: {} }, now)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('queues note attachment extraction with a 300s singleton slot on the standard queue (#4213)', async () => {
    const { boss, sent } = fakeBoss();
    const attachmentId = '11111111-2222-4333-8444-555555555555';
    await queueNoteAttachmentExtract(boss, {
      org_id: orgId,
      event_id: 'event-extract-1',
      type: NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT,
      payload: { attachmentId },
    });
    expect(sent).toEqual([
      {
        queue: QUEUES.notesAttachmentExtract,
        data: { orgId, attachmentId },
        options: {
          singletonKey: `${orgId}:notes-attachment-extract:${attachmentId}`,
          singletonSeconds: NOTE_ATTACHMENT_EXTRACT_SINGLETON_SECONDS,
          retryLimit: NOTE_ATTACHMENT_EXTRACT_RETRY_LIMIT,
          retryDelay: 15,
          retryBackoff: true,
        },
      },
    ]);
    expect(NOTE_ATTACHMENT_EXTRACT_SINGLETON_SECONDS).toBe(300);

    expect(
      queueNoteAttachmentExtract(boss, {
        org_id: orgId,
        event_id: 'event-other',
        type: 'notes.note.created',
        payload: { attachmentId },
      }),
    ).toBeNull();
    expect(
      queueNoteAttachmentExtract(boss, {
        org_id: orgId,
        event_id: 'event-missing-id',
        type: NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT,
        payload: {},
      }),
    ).toBeNull();
  });

  it('counts only non-deduplicated jobs in requestDueNoteAttachmentExtracts (#4213)', async () => {
    let callCount = 0;
    const sent: Array<{ queue: string; data: unknown; options: Record<string, unknown> }> = [];
    const boss = {
      send: async (queue: string, data: unknown, options: Record<string, unknown>) => {
        sent.push({ queue, data, options });
        callCount += 1;
        return callCount === 1 ? null : 'job-2';
      },
    } as unknown as PgBoss;
    const runtime = { appOn: async () => true };
    const workerDb = {} as Parameters<typeof requestDueNoteAttachmentExtracts>[0]['workerDb'];
    // Patch executeQuery via a minimal Kysely executor shape on sql`...`.execute(workerDb).
    const fakeExecutor = {
      executeQuery: async () => ({
        rows: [
          { org_id: orgId, id: '11111111-2222-4333-8444-555555555551' },
          { org_id: orgId, id: '11111111-2222-4333-8444-555555555552' },
        ],
      }),
      compileQuery: (q: unknown) => q,
      transformQuery: (q: unknown) => q,
      withPlugins: () => fakeExecutor,
      withPlugin: () => fakeExecutor,
      withoutPlugins: () => fakeExecutor,
    };
    const dbWithExec = { getExecutor: () => fakeExecutor } as unknown as typeof workerDb;
    const count = await requestDueNoteAttachmentExtracts({ runtime: runtime as never, workerDb: dbWithExec, boss });
    expect(count).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.options.singletonSeconds).toBe(300);
    expect(sent[1]?.options.singletonSeconds).toBe(300);
  });
});
