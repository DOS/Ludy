// SPDX-License-Identifier: AGPL-3.0-only
// Which events wait while their app is off, and the plan of one relay batch (ADR-0053, slice c C3b), without a database. The classing test reads the relay's event
// types from worker.ts: an event of an app that is not classed here fails it, so a new consumer must say whether its events wait.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEVER_HELD_EVENTS, heldAppOf, planHolds } from '../src/outbox-hold.ts';
import { KEEPING_EVENT_COMMANDS } from '../src/worker.ts';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const row = (org_id: string, type: string, n = 1) => ({ org_id, type, event_id: `01900000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}` });

describe('which events wait', () => {
  it('parks the events of Finance, Social, CRM and Ads, and the file events whose consumer is Finance', () => {
    expect(heldAppOf('social.post.submitted')).toBe('social');
    expect(heldAppOf('social.comment.retry_requested')).toBe('social');
    expect(heldAppOf('crm.booking.requested')).toBe('crm');
    expect(heldAppOf('finance.archive_requested')).toBe('finance');
    expect(heldAppOf('ads.launch.queued')).toBe('ads');
    expect(heldAppOf('kernel.file.ingested')).toBe('finance');
    expect(heldAppOf('kernel.file.reextract_requested')).toBe('finance');
  });

  it('never parks the keeping events, a takedown, a kernel event or a Meetings event (bound to its time)', () => {
    for (const type of Object.keys(KEEPING_EVENT_COMMANDS)) expect(heldAppOf(type), type).toBeNull();
    for (const type of NEVER_HELD_EVENTS) expect(heldAppOf(type), type).toBeNull();
    expect(heldAppOf('social.variant.remove_requested')).toBeNull();
    expect(heldAppOf('kernel.conversation.reply_queued')).toBeNull();
    expect(heldAppOf('kernel.org.export_requested')).toBeNull();
    expect(heldAppOf('meetings.transcript.requested')).toBeNull();
    expect(heldAppOf('meetings.live_notes.requested')).toBeNull();
  });

  it('classes every event type the relay names in worker.ts, so a new app consumer must say whether its events wait', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const types = [...new Set([...source.matchAll(/row\.type === '([a-z_.]+)'/g)].map((m) => m[1] as string))];
    expect(types.length).toBeGreaterThan(30);
    const unclassed: string[] = [];
    for (const type of types) {
      const app = heldAppOf(type);
      if (app !== null) continue;
      // Not parked: the keeping and never-held events, Meetings' time-bound ones, and the kernel's own.
      if (NEVER_HELD_EVENTS.has(type) || type.startsWith('meetings.') || type.startsWith('kernel.')) continue;
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
    const rows = [row(ORG_A, 'social.post.submitted', 1), row(ORG_A, 'social.comment.retry_requested', 2), row(ORG_B, 'social.post.submitted', 3), row(ORG_A, 'finance.archive_requested', 4), row(ORG_A, 'kernel.org.export_requested', 5), row(ORG_A, 'ads.pause.queued', 6)];
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
});
