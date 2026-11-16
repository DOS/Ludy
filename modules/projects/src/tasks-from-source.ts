// SPDX-License-Identifier: AGPL-3.0-only
// Server commands and queries for Vy proposing project tasks from a note, meeting, or conversation (#2608, ADR-0048, ADR-0049).
// Sources are read in the caller's own Runtime user context and RLS rules, never logged or audited in clear text.
// Confirmed batches run atomically through kernel.task.create_from_source (always tainted: true).
import { z } from 'zod';
import {
  zId,
  zProjectTaskSourceType,
  zProjectTasksFromSourceConfirmInput,
  type ConversationDetail,
  type MeetingDetail,
  type MeetingResults,
  type Note,
  type Notes,
  type ProjectSeat,
  type ProjectTaskSourceType,
  type ProjectTasksFromSourceConfirmResult,
  type ProjectTasksFromSourceStatus,
  type Transcript,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import {
  WRITERS,
  assertNotArchived,
  checkProjectsVyAccess,
  createAndAttachConfirmedTasks,
  loadProject,
  queryProjectSeats,
  userOf,
} from './tasks-from-note.ts';

export type SourceQueryResponse<T> = { status: 'ok'; value: T } | { status: 'not_installed' };
export type SourceQueryFn = <T>(name: string, input: Record<string, unknown>) => Promise<SourceQueryResponse<T>>;

export interface ReadableTasksSource {
  sourceType: ProjectTaskSourceType;
  sourceId: string;
  sourceTitle: string;
  sourceBody: string;
  segments: Array<{ text: string; anchorAt: string | null }>;
  sourceCanLink: boolean;
  isPrivate: boolean;
  noteMineAndLive: boolean;
  revision: number;
  // ISO instant representing when the source occurred (meetings/conversations), used to ground relative deadlines.
  anchorAt: string | null;
}

export function formatMeetingTaskSource(parts: {
  meeting: MeetingDetail;
  results: MeetingResults | null;
  notes: Notes | null;
  transcript: Transcript | null;
}): { sourceTitle: string; sourceBody: string } {
  const sourceTitle = parts.meeting.title.trim();
  const sections: string[] = [];

  if (parts.results) {
    const draftHasContent =
      parts.results.draft !== null &&
      (parts.results.draft.summary.trim().length > 0 || parts.results.draft.decisions.length > 0);
    const primary = draftHasContent ? parts.results.draft : parts.results.published;
    if (primary) {
      if (primary.summary.trim().length > 0) {
        sections.push(`Summary:\n${primary.summary.trim()}`);
      }
      const decisions = primary.decisions.map((d) => d.trim()).filter((d) => d.length > 0);
      if (decisions.length > 0) {
        sections.push(`Decisions:\n${decisions.map((d) => `- ${d}`).join('\n')}`);
      }
    }

    const draftItems = parts.results.items.filter((i) => i.stage === 'draft');
    const items = draftItems.length > 0 ? draftItems : parts.results.items;
    const itemLines = items
      .map((item) => {
        const title = item.title.trim();
        if (!title) return '';
        const who = item.who.trim();
        const whenDate = item.whenDate?.trim() ?? '';
        const when = item.when.trim();
        const extras = [
          who,
          ...(whenDate ? [whenDate] : []),
          ...(when && when !== whenDate ? [when] : []),
        ].filter((v) => v.length > 0);
        return extras.length > 0 ? `- ${title} (${extras.join(', ')})` : `- ${title}`;
      })
      .filter((line) => line.length > 0);
    if (itemLines.length > 0) {
      sections.push(`Action items:\n${itemLines.join('\n')}`);
    }
  }

  const notesBody = parts.notes?.body.trim() ?? '';
  if (notesBody.length > 0) {
    sections.push(`Notes:\n${notesBody}`);
  }

  // Fallback to transcript segments only when no summary, decisions, action items, or recorder notes exist.
  if (sections.length === 0 && parts.transcript && parts.transcript.segments.length > 0) {
    const lines = parts.transcript.segments
      .map((seg) => {
        const text = seg.text.trim();
        if (!text) return '';
        const speaker = seg.speakerLabel.trim();
        return speaker ? `${speaker}: ${text}` : text;
      })
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      sections.push(`Transcript:\n${lines.join('\n')}`);
    }
  }

  return { sourceTitle, sourceBody: sections.join('\n\n') };
}

function conversationContactName(detail: ConversationDetail): string {
  const c = detail.conversation.contact;
  return c.displayName?.trim() || c.partyName?.trim() || c.address?.trim() || c.idTail;
}

function conversationTitleOf(detail: ConversationDetail): string {
  return (
    detail.conversation.subject?.trim() ||
    detail.conversation.contact.displayName?.trim() ||
    detail.conversation.contact.partyName?.trim() ||
    detail.conversation.channel.displayName.trim()
  );
}

function conversationTaskSourceParts(detail: ConversationDetail): {
  sourceTitle: string;
  sourceBody: string;
  segments: Array<{ text: string; anchorAt: string | null }>;
} {
  const sourceTitle = conversationTitleOf(detail);
  const contactName = conversationContactName(detail);
  const sections: string[] = [];
  const segments: Array<{ text: string; anchorAt: string | null }> = [];

  const msgEntries = detail.messages
    .filter((m) => !m.removed && m.body.trim().length > 0)
    .map((m) => {
      const speaker =
        m.authorName?.trim() ||
        (m.direction === 'in' ? contactName || 'Customer' : 'Team');
      return { text: `${speaker}: ${m.body.trim()}`, anchorAt: m.sentAt };
    });
  if (msgEntries.length > 0) {
    sections.push(msgEntries.map((e) => e.text).join('\n'));
    segments.push(...msgEntries);
  }

  const noteEntries = detail.notes
    .filter((n) => n.body.trim().length > 0)
    .map((n) => ({ text: `[Internal note] ${n.body.trim()}`, anchorAt: n.createdAt }));
  if (noteEntries.length > 0) {
    sections.push(noteEntries.map((e) => e.text).join('\n'));
    segments.push(...noteEntries);
  }

  return { sourceTitle, sourceBody: sections.join('\n\n'), segments };
}

export function formatConversationTaskSource(detail: ConversationDetail): { sourceTitle: string; sourceBody: string } {
  const { sourceTitle, sourceBody } = conversationTaskSourceParts(detail);
  return { sourceTitle, sourceBody };
}

export function ctxQueryFn(ctx: QueryContext): SourceQueryFn {
  return async <T>(name: string, input: Record<string, unknown>): Promise<SourceQueryResponse<T>> => {
    if (name.startsWith('notes.') && !ctx.installed('notes')) return { status: 'not_installed' };
    if (name.startsWith('meetings.') && !ctx.installed('meetings')) return { status: 'not_installed' };
    return await ctx.query<T>(name, input);
  };
}

function latestConversationAnchorAt(detail: ConversationDetail): string | null {
  const candidates: string[] = [];
  for (const m of detail.messages) {
    if (!m.removed && m.body.trim().length > 0) candidates.push(m.sentAt);
  }
  for (const n of detail.notes) {
    if (n.body.trim().length > 0) candidates.push(n.createdAt);
  }
  if (candidates.length === 0 && detail.conversation.lastMessageAt) {
    candidates.push(detail.conversation.lastMessageAt);
  }
  let bestIso: string | null = null;
  let bestMs = -Infinity;
  for (const iso of candidates) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestIso;
}

/** Reads a caller-accessible note, meeting, or conversation via user-scoped queries without escalating privileges. */
export async function readTasksFromSourceData(
  queryFn: SourceQueryFn,
  params: { sourceType: ProjectTaskSourceType; sourceId: string; includeContent: boolean },
): Promise<ReadableTasksSource> {
  if (params.sourceType === 'notes.note') {
    const noteRes = await queryFn<Note>('notes.note.get', { noteId: params.sourceId });
    if (noteRes.status === 'not_installed') {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng notes chưa được bật cho công ty này', { module: 'notes' });
    }
    const note = noteRes.value;
    if (note.deletedAt !== null) {
      throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
    }
    if (params.includeContent && `${note.title}\n${note.body}`.trim().length === 0) {
      throw new DomainError('SOURCE_EMPTY', 422, 'Ghi chú chưa có nội dung để đề xuất việc');
    }
    const mineLive = note.mine && note.deletedAt === null;
    return {
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceTitle: note.title,
      sourceBody: note.body,
      segments: note.body.trim().length > 0 ? [{ text: note.body, anchorAt: null }] : [],
      sourceCanLink: mineLive,
      isPrivate: note.visibility !== 'org',
      noteMineAndLive: mineLive,
      revision: note.revision,
      anchorAt: null,
    };
  }

  if (params.sourceType === 'meetings.meeting') {
    const meetingRes = await queryFn<MeetingDetail>('meetings.meeting.get', { meetingId: params.sourceId });
    if (meetingRes.status === 'not_installed') {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng meetings chưa được bật cho công ty này', { module: 'meetings' });
    }
    const meeting = meetingRes.value;
    const anchorAt = meeting.startedAt ?? meeting.endedAt ?? meeting.createdAt;
    if (!params.includeContent) {
      return {
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        sourceTitle: meeting.title,
        sourceBody: '',
        segments: [],
        sourceCanLink: true,
        isPrivate: meeting.visibility !== 'org',
        noteMineAndLive: false,
        revision: 0,
        anchorAt,
      };
    }

    const resultRes = await queryFn<MeetingResults>('meetings.result.get', { meetingId: params.sourceId });
    if (resultRes.status === 'not_installed') {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng meetings chưa được bật cho công ty này', { module: 'meetings' });
    }
    // Recorder rough notes are restricted exclusively to recorder_user_id (meetings.notes.get enforces FORBIDDEN otherwise).
    let notes: Notes | null = null;
    if (meeting.isRecorder) {
      const notesRes = await queryFn<Notes>('meetings.notes.get', { meetingId: params.sourceId });
      if (notesRes.status === 'ok') notes = notesRes.value;
    }

    let formatted = formatMeetingTaskSource({ meeting, results: resultRes.value, notes, transcript: null });
    if (formatted.sourceBody.trim().length === 0) {
      const transcriptRes = await queryFn<Transcript>('meetings.transcript.get', { meetingId: params.sourceId });
      if (transcriptRes.status === 'ok') {
        formatted = formatMeetingTaskSource({ meeting, results: resultRes.value, notes, transcript: transcriptRes.value });
      }
    }
    if (formatted.sourceBody.trim().length === 0) {
      throw new DomainError('SOURCE_EMPTY', 422, 'Cuộc họp chưa có tóm tắt, ghi chú hoặc bản chép lời để đề xuất việc');
    }

    return {
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceTitle: formatted.sourceTitle,
      sourceBody: formatted.sourceBody,
      segments: [{ text: formatted.sourceBody, anchorAt }],
      sourceCanLink: true,
      isPrivate: meeting.visibility !== 'org',
      noteMineAndLive: false,
      revision: 0,
      anchorAt,
    };
  }

  const convRes = await queryFn<ConversationDetail>('kernel.conversation.get', { conversationId: params.sourceId });
  if (convRes.status === 'not_installed') {
    throw new DomainError('CONVERSATION_NOT_FOUND', 404, 'Không tìm thấy hội thoại này');
  }
  const detail = convRes.value;
  const anchorAt = latestConversationAnchorAt(detail);
  if (!params.includeContent) {
    return {
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceTitle: conversationTitleOf(detail),
      sourceBody: '',
      segments: [],
      sourceCanLink: true,
      isPrivate: detail.conversation.kind !== 'comment_thread',
      noteMineAndLive: false,
      revision: 0,
      anchorAt,
    };
  }

  const formatted = conversationTaskSourceParts(detail);
  if (formatted.sourceBody.trim().length === 0) {
    throw new DomainError('SOURCE_EMPTY', 422, 'Hội thoại chưa có tin nhắn hoặc ghi chú nội bộ để đề xuất việc');
  }
  return {
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    sourceTitle: formatted.sourceTitle,
    sourceBody: formatted.sourceBody,
    segments: formatted.segments,
    sourceCanLink: true,
    isPrivate: detail.conversation.kind !== 'comment_thread',
    noteMineAndLive: false,
    revision: 0,
    anchorAt,
  };
}

// Availability check for asking Vy to propose project tasks across notes, meetings, and conversations.
export const tasksFromSourceStatus = defineQuery({
  name: 'projects.tasks_from_source.status',
  input: z.strictObject({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: (ctx): Promise<ProjectTasksFromSourceStatus> => checkProjectsVyAccess(ctx, { requireNotes: false }),
});

// Active seats held exclusively by users who belong to the target project.
export const tasksFromSourceSeats = defineQuery({
  name: 'projects.tasks_from_source.seats',
  input: z.strictObject({ projectId: zId }),
  access: WRITERS,
  handler: (ctx, input): Promise<{ projectId: string; projectName: string; seats: ProjectSeat[] }> =>
    queryProjectSeats(ctx, input.projectId),
});

// Validates source readability + non-archived project and starts one member-scoped Vy run.
// Masks projectId in audit when source visibility is private/restricted (ADR-0037 §3).
export const tasksFromSourceStart = defineCommand({
  name: 'projects.tasks_from_source.start',
  input: z.strictObject({
    projectId: zId,
    sourceType: zProjectTaskSourceType,
    sourceId: zId,
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (
    ctx,
    input,
  ): Promise<{ runId: string; sourceRevision: number; sourceCanLink: boolean }> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(project);

    // Sensitive meeting reads (result/notes/transcript) must run via top-level Runtime.query so every read is audited;
    // inside this command we verify non-archived project + non-sensitive caller read access (meeting_read/retention RLS).
    const source = await readTasksFromSourceData(ctxQueryFn(ctx), {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      includeContent: input.sourceType !== 'meetings.meeting',
    });

    const started = await ctx.run<{ runId: string; resultId: string; expiresAt: string }>('kernel.member_vy.run.start', {
      feature: 'projects.tasks_from_source',
      subjectType: input.sourceType,
      subjectId: input.sourceId,
    });
    ctx.audit(
      source.isPrivate
        ? { sourceType: input.sourceType, sourceId: input.sourceId, target: 'private' as const, runId: started.runId }
        : { projectId: project.id, sourceType: input.sourceType, sourceId: input.sourceId, runId: started.runId },
    );
    return {
      runId: started.runId,
      sourceRevision: source.revision,
      sourceCanLink: source.sourceCanLink,
    };
  },
});

const SOURCE_ACTIVITY_NOUN: Record<ProjectTaskSourceType, string> = {
  'notes.note': 'ghi chú',
  'meetings.meeting': 'cuộc họp',
  'kernel.conversation': 'hội thoại',
};

// Batch-confirms edited tasks into the target project atomically: re-verifies writer role, caller source access,
// active project seats, creates tainted kernel tasks with source_ref, and attaches them to crove_projects.project_task.
export const tasksFromSourceConfirm = defineCommand({
  name: 'projects.tasks_from_source.confirm',
  input: zProjectTasksFromSourceConfirmInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTasksFromSourceConfirmResult> => {
    const userId = userOf(ctx.actor);
    const preview = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(preview);
    const source = await readTasksFromSourceData(ctxQueryFn(ctx), {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      includeContent: false,
    });

    const noun = SOURCE_ACTIVITY_NOUN[input.sourceType];
    const { project, createdIds } = await createAndAttachConfirmedTasks(ctx, userId, {
      projectId: input.projectId,
      timeZone: input.timeZone,
      items: input.items,
      via: input.sourceType,
      activityAction: 'projects.tasks_from_source.confirmed',
      activitySummary: (count) => `Thêm ${count} việc vào dự án từ ${noun}`,
      createTask: (item, due) =>
        ctx.run<{ taskId: string }>('kernel.task.create_from_source', {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          title: item.title,
          positionId: item.assigneePositionId,
          due,
        }),
    });

    let linkedCount = 0;
    if (input.sourceType === 'notes.note' && source.noteMineAndLive) {
      for (const taskId of createdIds) {
        const linked = await ctx.tryRun(
          'notes.link.add',
          { noteId: input.sourceId, targetType: 'kernel.task', targetId: taskId },
          { recover: (r) => r.code === 'NOTE_AUTHOR_ONLY' || r.code === 'NOTE_LINK_LIMIT' || r.code === 'NOTE_LINK_EXISTS' },
        );
        if (linked.status === 'ok') linkedCount++;
      }
    }

    ctx.audit({
      projectId: project.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      count: createdIds.length,
      linkedCount,
      taskIds: createdIds,
    });

    return {
      projectId: project.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdCount: createdIds.length,
      linkedCount,
      taskIds: createdIds,
    };
  },
});
