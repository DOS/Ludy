// SPDX-License-Identifier: AGPL-3.0-only
// What a deal is given after a meeting linked to it, once the recorder confirmed Vy's proposal (#4766, docs/plan/crm.md, docs/plan/meetings.md section 15). The command is the CRM line's write path
// for it; the meetings command `meetings.deal_update.confirm` is the only caller (it has no route of its own): it has re-read the minutes and the link and checked both texts, and this command
// checks what only the CRM knows (the deal exists, is open and is the caller's to touch). Three things, in one transaction:
//   - the next step as a human task (kernel.task.create_from_source, tainted, its source the meeting, due on the day the minutes wrote or none): the same command the projects module uses to turn a
//     meeting into tasks, so the task shows where every task shows and needs no table of the CRM's own;
//   - the note as a comment of that task (kernel.task.comment, by the recorder): free text stays on its record and out of the timeline (activity summaries keep none, #1825); a note with no next step
//     gets a task of its own with fixed words for a title; the timeline gets one line of fixed words (kind crm.deal.meeting_update);
//   - the stale-deal reminder (no activity, past close) closed (closeNextSteps; a quote reminder stays), so the daily rule does not raise one on top of a step a person just confirmed.
// Who may do it is who may edit a deal (crm.deal.update): owner, admin and member, any deal they read. The audit row holds ids, flags and counts, never a text.
import { DEAL_UPDATE_ACTIVITY_KIND, zDealMeetingUpdateApply, zDealUpdateConfirmed, type DealUpdateConfirmed } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { closeNextSteps } from './next-steps.ts';

interface MeetingRead {
  isRecorder: boolean;
}
interface LinkRead {
  kind: string;
  targetId: string;
}

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// Fixed words: a note with no next step becomes a task with this title, and the contact's timeline gets this line (no deal title, no note: a summary there keeps no free text).
const NOTE_ONLY_TITLE = 'Ghi chú sau cuộc họp';
const ACTIVITY_SUMMARY = 'Cập nhật cơ hội sau cuộc họp';

export const dealMeetingUpdateApply = defineCommand({
  name: 'crm.deal.meeting_update.apply',
  input: zDealMeetingUpdateApply,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.deal', id: input.dealId }),
  handler: async (ctx, input): Promise<DealUpdateConfirmed> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    if (input.nextStep === null && input.note === null) throw new DomainError('DEAL_UPDATE_EMPTY', 422, 'Cần ít nhất một bước tiếp theo hoặc một ghi chú');
    // The deal as the caller reads it (row security), held shared so a close or a move waits for this transaction.
    const deal = await ctx.trx
      .selectFrom('ludy_crm.deal')
      .select(['id', 'party_id', 'title', 'closed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.dealId)
      .forShare()
      .executeTakeFirst();
    if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    if (deal.closed_at !== null) throw new DomainError('DEAL_CLOSED', 409, 'Cơ hội này đã đóng, không cần cập nhật bước tiếp theo nữa');

    // Only a meeting the caller reads and that is linked to this very deal may speak for it: the meetings command checked the recorder, this checks the pair for any other way in.
    const links = await ctx.query<LinkRead[]>('meetings.link.list', { meetingId: input.meetingId });
    if (links.status !== 'ok' || !links.value.some((l) => l.kind === 'deal' && l.targetId === deal.id)) {
      throw new DomainError('MEETING_NOT_LINKED', 409, 'Cuộc họp này không liên kết với cơ hội này');
    }

    // Only the recorder of that meeting speaks for it (the meetings command checks this too; the command is registered, so any other way in is checked here as well).
    const meeting = await ctx.query<MeetingRead>('meetings.meeting.get', { meetingId: input.meetingId });
    if (meeting.status !== 'ok' || !meeting.value.isRecorder) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người ghi cuộc họp mới cập nhật được cơ hội từ cuộc họp này');
    }

    // The next step is a human task (tainted, its source the meeting). A note alone becomes a task too, with fixed words for a title, so the note has a record to live on.
    const created = await ctx.run<{ taskId: string }>('kernel.task.create_from_source', {
      sourceType: 'meetings.meeting',
      sourceId: input.meetingId,
      title: input.nextStep === null ? NOTE_ONLY_TITLE : input.nextStep.text,
      positionId: null,
      due: input.nextStep === null ? null : input.due,
    });
    const taskId = created.taskId;
    // The note is free text a member confirmed: it stays on its record, a comment of the task, and out of the timeline (activity summaries keep no free text, #1825). The timeline gets a line of fixed words.
    const hasNote = input.note !== null;
    if (input.note !== null) await ctx.run('kernel.task.comment', { id: taskId, body: input.note });
    await ctx.activity('kernel.party', deal.party_id, DEAL_UPDATE_ACTIVITY_KIND, ACTIVITY_SUMMARY);
    const remindersClosed = await closeNextSteps(ctx, deal.id, 'deal_edited', ['no_activity', 'past_close']);
    ctx.audit({ dealId: deal.id, meetingId: input.meetingId, taskId, noteSaved: hasNote, remindersClosed });
    return zDealUpdateConfirmed.parse({ dealId: deal.id, taskId, noteSaved: hasNote, remindersClosed });
  },
});

export const dealMeetingUpdateCommands = [dealMeetingUpdateApply];
