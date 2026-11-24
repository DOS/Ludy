// SPDX-License-Identifier: AGPL-3.0-only
// The org setting "Ký biên bản họp" (Meetings, #4703, owner decision 2026-11-24): whether a recorder may send published minutes for eSign. Off by default. It lives on the org's tenant row
// (ludy_kernel.tenant.meeting_minutes_esign, beside the consent policy), and a guard trigger lets only meetings.minutes_esign.set, run by an owner or admin in the org's own context, change it.
// The server's refusal is in ludy_sign (assertCanCreateMeetingMinutesEnvelope, so sign.envelope.create and the template instantiate both pass through it); the minutes page only hides the
// handoff. No AI part: the core works with AI off, and a person still presses "Gửi ký" for every envelope.
import { zMeetingMinutesEsign, zMeetingMinutesEsignGet, type MeetingMinutesEsignState } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';

/** Whether the org lets minutes be sent for eSign; false for an org whose row cannot be read. */
export async function readMinutesEsign(trx: QueryContext['trx'], orgId: string): Promise<boolean> {
  const row = await trx.selectFrom('ludy_kernel.tenant').select(['meeting_minutes_esign']).where('org_id', '=', orgId).executeTakeFirst();
  return row?.meeting_minutes_esign === true;
}

// Every member reads it: the minutes page shows the "Gửi ký" handoff only while it is on.
export const meetingMinutesEsignGet = defineQuery({
  name: 'meetings.minutes_esign.get',
  input: zMeetingMinutesEsignGet,
  access: ['owner', 'admin', 'member'],
  handler: async (ctx): Promise<MeetingMinutesEsignState> => ({ enabled: await readMinutesEsign(ctx.trx, ctx.orgId) }),
});

// Only an owner or admin, only for envelopes made afterwards: turning it off stops new envelopes and touches none that exist. The database's guard trigger holds every other writer. The audit row holds
// the two values only.
export const meetingMinutesEsignSet = defineCommand({
  name: 'meetings.minutes_esign.set',
  input: zMeetingMinutesEsign,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input): Promise<MeetingMinutesEsignState> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
    const previous = await readMinutesEsign(ctx.trx, ctx.orgId);
    await ctx.trx.updateTable('ludy_kernel.tenant').set({ meeting_minutes_esign: input.enabled }).where('org_id', '=', ctx.orgId).execute();
    ctx.audit({ enabled: input.enabled, previous });
    return { enabled: input.enabled };
  },
});
