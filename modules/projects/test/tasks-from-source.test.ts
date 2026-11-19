// SPDX-License-Identifier: AGPL-3.0-only
// Pure formatting and caller-scoped query isolation unit tests for @crove/mod-projects tasks-from-source (#2608).
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, MeetingDetail, MeetingResults, Notes, Transcript } from '@crove/kernel-contract';
import {
  formatConversationTaskSource,
  formatMeetingTaskSource,
  readTasksFromSourceData,
  type SourceQueryFn,
} from '../src/tasks-from-source.ts';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function baseMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: MEETING_ID,
    title: 'Họp giao ban tuần',
    language: 'vi',
    visibility: 'attendees',
    status: 'ready',
    recorderUserId: USER_ID,
    startedAt: '2026-11-16T02:00:00.000Z',
    endedAt: '2026-11-16T03:00:00.000Z',
    lengthSeconds: 3600,
    keepVideo: false,
    liveNotes: false,
    summaryTemplate: 'general',
    minutesTemplate: null,
    audioRetentionDate: '2026-12-16',
    textRetentionDate: null,
    hasAudio: true,
    hasVideo: false,
    readersCount: 2,
    createdAt: '2026-11-16T02:00:00.000Z',
    updatedAt: '2026-11-16T03:00:00.000Z',
    consentMethod: 'told_at_start',
    consentConfirmedBy: USER_ID,
    consentConfirmedAt: '2026-11-16T02:00:00.000Z',
    consentNoticeVersion: 'v1',
    recordingStopReason: null,
    platformTranscriptCut: false,
    readers: [USER_ID],
    videoRetentionDate: null,
    isRecorder: true,
    ...overrides,
  };
}

function emptyResults(overrides: Partial<MeetingResults> = {}): MeetingResults {
  return {
    meetingId: MEETING_ID,
    isRecorder: true,
    draft: null,
    published: null,
    items: [],
    ...overrides,
  };
}

describe('formatMeetingTaskSource & formatConversationTaskSource (#2608)', () => {
  it('formats summary, decisions, action items, and recorder notes without leaking meeting ISO timestamps', () => {
    const out = formatMeetingTaskSource({
      meeting: baseMeeting(),
      results: emptyResults({
        draft: {
          id: 'res-1',
          feature: 'meetings.summary',
          stage: 'draft',
          summary: 'Thống nhất lịch ra mắt module mới.',
          decisions: ['Chốt giá gói SME'],
          tainted: true,
        },
        items: [
          {
            id: 'item-1',
            stage: 'draft',
            status: 'suggested',
            title: 'Gửi hợp đồng cho khách',
            who: 'Lan',
            whoUserId: USER_ID,
            when: 'thứ Sáu',
            whenDate: null,
            transcriptSeconds: 42,
            flags: [],
            tainted: true,
            taskId: null,
            positions: [],
            clean: false,
            suggestion: null,
          },
          {
            id: 'item-2',
            stage: 'draft',
            status: 'suggested',
            title: 'Chốt biên bản bàn giao',
            who: 'Minh',
            whoUserId: USER_ID,
            when: '',
            whenDate: '2026-11-20',
            transcriptSeconds: null,
            flags: [],
            tainted: true,
            taskId: null,
            positions: [],
            clean: false,
            suggestion: null,
          },
        ],
      }),
      notes: { meetingId: MEETING_ID, body: 'Ghi chú riêng của người ghi', updatedAt: '2026-11-16T03:00:00.000Z' },
      transcript: null,
    });

    expect(out.sourceTitle).toBe('Họp giao ban tuần');
    expect(out.sourceBody).toContain('Summary:\nThống nhất lịch ra mắt module mới.');
    expect(out.sourceBody).toContain('Decisions:\n- Chốt giá gói SME');
    expect(out.sourceBody).toContain('- Gửi hợp đồng cho khách (Lan, thứ Sáu)');
    expect(out.sourceBody).toContain('- Chốt biên bản bàn giao (Minh, 2026-11-20)');
    expect(out.sourceBody).toContain('Notes:\nGhi chú riêng của người ghi');
    // Crucial: startedAt / endedAt ISO timestamps must NOT appear in sourceBody so dueOn date grounding stays unspoiled.
    expect(out.sourceBody).not.toContain('2026-11-16');
  });

  it('uses transcript only as fallback when summary, decisions, items, and notes are all empty', () => {
    const transcript: Transcript = {
      meetingId: MEETING_ID,
      isRecorder: false,
      stage: 'published',
      segments: [
        { id: 's1', startSeconds: 10, endSeconds: 20, speakerLabel: 'Lan', text: 'Gọi khách A ngày mai.', stage: 'published', corrected: false, source: 'ludy' },
      ],
    };
    const out = formatMeetingTaskSource({
      meeting: baseMeeting({ isRecorder: false }),
      results: emptyResults({ isRecorder: false }),
      notes: null,
      transcript,
    });
    expect(out.sourceBody).toBe('Transcript:\nLan: Gọi khách A ngày mai.');
  });

  it('formats conversation messages and internal notes chronologically without sentAt timestamps', () => {
    const detail: ConversationDetail = {
      conversation: {
        id: CONV_ID,
        kind: 'direct',
        status: 'new',
        channel: { connectionId: 'ch-1', provider: 'zalo', displayName: 'Zalo OA' },
        postId: null,
        contact: { identityId: 'id-1', displayName: 'Anh Nam', idTail: '4512', partyId: null, partyName: null, address: null },
        assigneeUserId: null,
        lastSeq: 2,
        lastMessageAt: '2026-11-16T08:00:00.000Z',
        lastInboundAt: '2026-11-16T07:50:00.000Z',
        replyWindowUntil: null,
        preview: 'Gửi giúp anh báo giá',
        unread: false,
        composing: [],
        intent: null,
        subject: 'Yêu cầu báo giá Q4',
      },
      messages: [
        {
          id: 'm1',
          seq: 1,
          direction: 'in',
          authorKind: 'contact',
          authorUserId: null,
          authorName: 'Anh Nam',
          authorTail: null,
          body: 'Gửi giúp anh báo giá mới.',
          attachments: [],
          sentAt: '2026-11-16T07:50:00.000Z',
          sendState: null,
          sendErrorCode: null,
          hidden: false,
          hideRequest: null,
          hideErrorCode: null,
          removed: false,
        },
        {
          id: 'm2',
          seq: 2,
          direction: 'in',
          authorKind: 'contact',
          authorUserId: null,
          authorName: 'Anh Nam',
          authorTail: null,
          body: 'Deleted spam',
          attachments: [],
          sentAt: '2026-11-16T07:55:00.000Z',
          sendState: null,
          sendErrorCode: null,
          hidden: false,
          hideRequest: null,
          hideErrorCode: null,
          removed: true,
        },
      ],
      notes: [
        { id: 'n1', authorUserId: USER_ID, body: 'Ưu tiên gửi bản PDF trước 20/11', createdAt: '2026-11-16T08:00:00.000Z' },
      ],
      parentId: null,
      reply: { allowed: true, reason: null },
      gap: null,
      draft: null,
      suggestions: [],
      others: [],
    };

    const out = formatConversationTaskSource(detail);
    expect(out.sourceTitle).toBe('Yêu cầu báo giá Q4');
    expect(out.sourceBody).toContain('Anh Nam: Gửi giúp anh báo giá mới.');
    expect(out.sourceBody).not.toContain('Deleted spam');
    expect(out.sourceBody).toContain('[Internal note] Ưu tiên gửi bản PDF trước 20/11');
    expect(out.sourceBody).not.toContain('2026-11-16');
  });
});

describe('readTasksFromSourceData query routing (#2608)', () => {
  it('only queries meetings.notes.get when meeting.isRecorder is true and skips transcript.get when summary exists', async () => {
    const called: string[] = [];
    const readerQueries: SourceQueryFn = async <T>(name: string) => {
      called.push(name);
      if (name === 'meetings.meeting.get') return { status: 'ok', value: baseMeeting({ isRecorder: false }) as T };
      if (name === 'meetings.result.get') {
        return {
          status: 'ok',
          value: emptyResults({
            isRecorder: false,
            published: { id: 'r1', feature: 'meetings.summary', stage: 'published', summary: 'Đã thống nhất kế hoạch', decisions: [], tainted: false },
          }) as T,
        };
      }
      throw new Error(`unexpected query: ${name}`);
    };

    const res = await readTasksFromSourceData(readerQueries, {
      sourceType: 'meetings.meeting',
      sourceId: MEETING_ID,
      includeContent: true,
    });
    expect(called).toEqual(['meetings.meeting.get', 'meetings.result.get']);
    expect(res.sourceBody).toContain('Đã thống nhất kế hoạch');
    expect(res.isPrivate).toBe(true);
    expect(res.anchorAt).toBe('2026-11-16T02:00:00.000Z');
  });

  it('derives conversation anchorAt from latest non-removed message or note timestamp', async () => {
    const convFn: SourceQueryFn = async <T>(name: string) => {
      expect(name).toBe('kernel.conversation.get');
      return {
        status: 'ok',
        value: {
          conversation: {
            id: CONV_ID,
            kind: 'comment_thread',
            status: 'new',
            channel: { connectionId: 'ch-1', provider: 'facebook', displayName: 'Page A' },
            postId: null,
            contact: { identityId: 'id-1', displayName: 'Lan', idTail: '1234', partyId: null, partyName: null, address: null },
            assigneeUserId: null,
            lastSeq: 1,
            lastMessageAt: '2026-11-16T09:00:00.000Z',
            lastInboundAt: '2026-11-16T09:00:00.000Z',
            replyWindowUntil: null,
            preview: 'Gửi báo giá ngày mai',
            unread: false,
            composing: [],
            intent: null,
            subject: null,
          },
          messages: [
            {
              id: 'm1',
              seq: 1,
              direction: 'in',
              authorKind: 'contact',
              authorUserId: null,
              authorName: 'Lan',
              authorTail: null,
              body: 'Gửi báo giá ngày mai',
              attachments: [],
              sentAt: '2026-11-10T09:00:00.000Z',
              sendState: null,
              sendErrorCode: null,
              hidden: false,
              hideRequest: null,
              hideErrorCode: null,
              removed: false,
            },
          ],
          notes: [],
          parentId: null,
          reply: { allowed: true, reason: null },
          gap: null,
          draft: null,
          suggestions: [],
          others: [],
        } as ConversationDetail as T,
      };
    };
    const res = await readTasksFromSourceData(convFn, {
      sourceType: 'kernel.conversation',
      sourceId: CONV_ID,
      includeContent: true,
    });
    expect(res.anchorAt).toBe('2026-11-10T09:00:00.000Z');
    expect(res.segments).toEqual([{ text: 'Lan: Gửi báo giá ngày mai', anchorAt: '2026-11-10T09:00:00.000Z' }]);
  });

  it('rejects disabled meetings module with MODULE_OFF and empty meeting with SOURCE_EMPTY', async () => {
    const offFn: SourceQueryFn = async () => ({ status: 'not_installed' });
    await expect(
      readTasksFromSourceData(offFn, { sourceType: 'meetings.meeting', sourceId: MEETING_ID, includeContent: true }),
    ).rejects.toMatchObject({ code: 'MODULE_OFF', status: 404 });

    const emptyFn: SourceQueryFn = async <T>(name: string) => {
      if (name === 'meetings.meeting.get') return { status: 'ok', value: baseMeeting() as T };
      if (name === 'meetings.result.get') return { status: 'ok', value: emptyResults() as T };
      if (name === 'meetings.notes.get') return { status: 'ok', value: { meetingId: MEETING_ID, body: '', updatedAt: null } as Notes as T };
      return { status: 'ok', value: { meetingId: MEETING_ID, isRecorder: true, stage: 'none', segments: [] } as Transcript as T };
    };
    await expect(
      readTasksFromSourceData(emptyFn, { sourceType: 'meetings.meeting', sourceId: MEETING_ID, includeContent: true }),
    ).rejects.toMatchObject({ code: 'SOURCE_EMPTY', status: 422 });
  });
});
