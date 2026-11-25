// SPDX-License-Identifier: AGPL-3.0-only
// What a deal is given after a meeting linked to it, once the recorder confirmed Vy's proposal (#4766, docs/plan/crm.md, docs/plan/meetings.md section 15). The command is the CRM line's write path
// for it; the meetings command `meetings.deal_update.confirm` is the only caller (it has no route of its own): it has re-read the minutes and the link and checked both texts, and this command
// checks what only the CRM knows (the deal exists, is open and is the caller's to touch). Three things, in one transaction:
//   - the next step as a human task (kernel.task.create_from_source, tainted, its source the meeting, due on the day the minutes wrote or none): the same command the projects module uses to turn a
//     meeting into tasks, so the task shows where every task shows and needs no table of the CRM's own;
//   - the note as a line of the contact's timeline (kind crm.deal.meeting_update), which the personal-data erase and the org purge already cover;
//   - the stale-deal reminder (no activity, past close) closed (closeNextSteps; a quote reminder stays), so the daily rule does not raise one on top of a step a person just confirmed.
// Who may do it is who may edit a deal (crm.deal.update): owner, admin and member, any deal they read. The audit row holds ids, flags and counts, never a text.
import { DEAL_UPDATE_ACTIVITY_KIND, zDealMeetingUpdateApply, zDealUpdateConfirmed, type DealUpdateConfirmed } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { closeNextSteps } from './next-steps.ts';

interface LinkRead {
  kind: string;
  targetId: string;
}

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

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

    let taskId: string | null = null;
    if (input.nextStep !== null) {
      const created = await ctx.run<{ taskId: string }>('kernel.task.create_from_source', {
        sourceType: 'meetings.meeting',
        sourceId: input.meetingId,
        title: input.nextStep.text,
        positionId: null,
        due: input.due,
      });
      taskId = created.taskId;
    }
    if (input.note !== null) {
      await ctx.activity('kernel.party', deal.party_id, DEAL_UPDATE_ACTIVITY_KIND, `Sau cuộc họp, cơ hội "${deal.title}": ${input.note}`);
    }
    const remindersClosed = await closeNextSteps(ctx, deal.id, 'deal_edited', ['no_activity', 'past_close']);
    ctx.audit({ dealId: deal.id, meetingId: input.meetingId, taskId, noteSaved: input.note !== null, remindersClosed });
    return zDealUpdateConfirmed.parse({ dealId: deal.id, taskId, noteSaved: input.note !== null, remindersClosed });
  },
});

export const dealMeetingUpdateCommands = [dealMeetingUpdateApply];
