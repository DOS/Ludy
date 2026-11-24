// SPDX-License-Identifier: AGPL-3.0-only
// Which events wait while their app is off, and the plan of one relay batch (ADR-0053, slice c C3b), without a database. The classing test reads the relay's event
// types from worker.ts: an event of an app that is not classed here fails it, so a new consumer must say whether its events wait.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEVER_HELD_EVENTS, SELF_RECOVERING_EVENTS, heldAppOf, planHolds } from '../src/outbox-hold.ts';
import { KERNEL_NOTIFYING_EVENTS } from '@ludy/kernel';
import { FINANCE_NOTIFYING_EVENTS } from '@ludy/mod-finance';
import { CHAT_ALERTING_EVENTS, NOTIFYING_EVENTS } from '@ludy/mod-social';
import { KEEPING_EVENT_COMMANDS } from '../src/worker.ts';

// The kernel's own events the relay names, each consumed by a kernel job or command (conversations, sign-out, export, agents), or by a kernel step with an app's beside it that
// is not parked (`kernel.channel.connected`: a bank connection starts the bank feed's sync, which has its daily sync, and Social's channel handling finds its own rows;
// `kernel.channel.expired`: Social's notification, a kernel notification of the same event). A new kernel event must be added here, or to the parked ones in heldAppOf when an
// app's job consumes it (as the two file events are Finance's extraction).
const KERNEL_OWN = new Set([
  'kernel.agent.wakeup_requested',
  'kernel.channel.chat_queued',
  'kernel.channel.connected',
  'kernel.channel.expired',
  // The kernel's notifications and agent proposals (KERNEL_NOTIFYING_EVENTS and the proposal commands): the kernel's own consumers.
  'kernel.file.read_failed',
  'kernel.task.created',
  'kernel.task.assigned',
  'kernel.task.rerouted',
  'kernel.personal_data.notified',
  'kernel.proposal.original_flagged',
  'kernel.agent.proposal_requested',
  'kernel.agent.proposal_approved',
  // A Projects event the kernel's notification dispatch consumes (in KERNEL_NOTIFYING_EVENTS).
  'projects.weekly_status.sent',
  'kernel.conversation.attachment_queued',
  'kernel.conversation.draft_queued',
  'kernel.conversation.hide_queued',
  'kernel.conversation.reply_queued',
  'kernel.conversation.sync_queued',
  'kernel.member.removed',
  // Sign's own recovery runs on it (the worker's relay step for a switch-on).
  'kernel.org.apps_changed',
  'kernel.member.role_changed',
  'kernel.org.export_requested',
  'kernel.proposal.created',
  'kernel.session.revoked',
]);
// The public acts a person asked for at the time, dropped when the app is off.
const TIME_BOUND = new Set(['social.comment.retry_requested', 'social.thread.retry_requested', 'social.variant.edit_requested']);
const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const row = (org_id: string, type: string, n = 1) => ({ org_id, type, event_id: `01900000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}` });

describe('which events wait', () => {
  it('parks the events of Finance, Social, CRM, Ads and Notes, and the file events whose consumer is Finance', () => {
    expect(heldAppOf('social.post.submitted')).toBe('social');
    expect(heldAppOf('social.channel_option.requested')).toBe('social');
    expect(heldAppOf('crm.booking.requested')).toBe('crm');
    expect(heldAppOf('finance.archive_requested')).toBe('finance');
    expect(heldAppOf('ads.launch.queued')).toBe('ads');
    expect(heldAppOf('hr.recruiting.cv_extract_queued')).toBe('hr');
    expect(heldAppOf('notes.attachment.extract_queued')).toBe('notes');
    expect(heldAppOf('sign.kyc.inspect_queued')).toBe('sign');
    expect(SELF_RECOVERING_EVENTS.has('sign.docx_convert_queued')).toBe(true);
    expect(heldAppOf('sign.docx_convert_queued')).toBeNull();
    expect(SELF_RECOVERING_EVENTS.has('sign.envelope.document_inspect_queued')).toBe(true);
    expect(heldAppOf('sign.envelope.document_inspect_queued')).toBeNull();
    expect(heldAppOf('notes.todo.handed_over')).toBeNull();
    expect(heldAppOf('kernel.file.ingested')).toBe('finance');
    expect(heldAppOf('kernel.file.reextract_requested')).toBe('finance');
  });

  it('never parks the keeping events, a takedown, a kernel event, a Meetings event (bound to its time) or a public act a person asked for then', () => {
    for (const type of Object.keys(KEEPING_EVENT_COMMANDS)) expect(heldAppOf(type), type).toBeNull();
    for (const type of NEVER_HELD_EVENTS) expect(heldAppOf(type), type).toBeNull();
    expect(heldAppOf('social.variant.remove_requested')).toBeNull();
    // The notice of a failed planned takedown reaches the owners while Social is off (#3456), so it is not parked either.
    expect(heldAppOf('social.variant.remove_failed')).toBeNull();
    // The combined notice of late posts is only ever emitted while Social is on, so it keeps the app's own rule and waits if the app goes off before it is relayed.
    expect(heldAppOf('social.publishing.late_failed')).toBe('social');
    expect(heldAppOf('kernel.conversation.reply_queued')).toBeNull();
    expect(heldAppOf('kernel.org.export_requested')).toBeNull();
    expect(heldAppOf('meetings.transcript.requested')).toBeNull();
    expect(heldAppOf('meetings.live_notes.requested')).toBeNull();
    // A retry of a comment or a thread and an edit of a published post would act in public days late: dropped, not parked.
    for (const type of ['social.comment.retry_requested', 'social.thread.retry_requested', 'social.variant.edit_requested']) expect(heldAppOf(type), type).toBeNull();
  });

  it('classes every event type the relay names in worker.ts, so a new app consumer must say whether its events wait', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    // The event types the relay names in its steps, and the ones it routes through a table: the notifications (the kernel's, Finance's and Social's), the team chat alerts and the
    // agent proposal commands.
    const routes = [...KERNEL_NOTIFYING_EVENTS, ...FINANCE_NOTIFYING_EVENTS, ...NOTIFYING_EVENTS, ...CHAT_ALERTING_EVENTS, 'kernel.agent.proposal_requested', 'kernel.agent.proposal_approved'];
    expect(source).toContain("'kernel.agent.proposal_requested': 'kernel.agent.proposal.create'");
    const types = [...new Set([...[...source.matchAll(/row\.type === '([a-z_.]+)'/g)].map((m) => m[1] as string), ...routes])];
    expect(types.length).toBeGreaterThan(30);
    const unclassed: string[] = [];
    for (const type of types) {
      const app = heldAppOf(type);
      if (app !== null) continue;
      // Not parked: the keeping and never-held events, the time-bound public acts, Meetings' time-bound ones, and the kernel's own, which are listed.
      if (NEVER_HELD_EVENTS.has(type) || SELF_RECOVERING_EVENTS.has(type) || type.startsWith('meetings.') || TIME_BOUND.has(type) || KERNEL_OWN.has(type)) continue;
      unclassed.push(type);
    }
    expect(unclassed, 'an event of an app that is neither parked nor listed as never parked').toEqual([]);
    // The two file events are the kernel's only ones with an app's consumer.
    expect(types.filter((t) => t.startsWith('kernel.') && heldAppOf(t) !== null).sort()).toEqual(['kernel.file.ingested', 'kernel.file.reextract_requested']);
  });
});

describe('the plan of one relay batch', () => {
  it('parks the rows of an org whose app is off, queues the rest, and asks once per org and app, with every app this deployment runs', async () => {
    const asked: string[] = [];
    const appOn = async (org: string, app: string) => {
      asked.push(`${org.slice(-1)}:${app}`);
      return !(org === ORG_A && app === 'social');
    };
    const rows = [row(ORG_A, 'social.post.submitted', 1), row(ORG_A, 'social.channel_option.requested', 2), row(ORG_B, 'social.post.submitted', 3), row(ORG_A, 'finance.archive_requested', 4), row(ORG_A, 'kernel.org.export_requested', 5), row(ORG_A, 'ads.pause.queued', 6)];
    const plan = await planHolds(rows, appOn, () => true);
    expect(plan.held.map((h) => [h.row.event_id.slice(-2), h.app])).toEqual([['01', 'social'], ['02', 'social']]);
    expect(plan.rest.map((r) => r.event_id.slice(-2))).toEqual(['03', '04', '05', '06']);
    // Kernel and keeping events are never asked about.
    expect(asked.sort()).toEqual(['a:finance', 'a:social', 'b:social']);
  });

  it('queues an event of an app this deployment does not run, and any event when the read of the app fails', async () => {
    const rows = [row(ORG_A, 'social.post.submitted', 1)];
    expect((await planHolds(rows, async () => false, () => false)).held).toEqual([]);
    expect((await planHolds(rows, async () => { throw new Error('connection lost'); }, () => true)).held).toEqual([]);
  });

  it('wires the plan into the relay: parked rows get no step, and the drain loop counts the whole claim', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const claim = source.slice(source.indexOf('SELECT * FROM ludy_kernel.outbox_claim(100)'), source.indexOf('SELECT * FROM ludy_kernel.inbound_claim(100)'));
    expect(claim).toContain('const rows = plan.rest;');
    expect(claim).toContain('await holdEvents(trx, plan.held)');
    // The pre-plan list is used for the plan alone: a step built from it would queue a parked event too.
    expect([...claim.matchAll(/\bclaimed\b/g)].length).toBeLessThanOrEqual(3);
    expect(claim).not.toMatch(/claimed\.map/);
    expect(source).toContain('Math.max(sent, claimedCount) < 100');
  });
});
