// SPDX-License-Identifier: AGPL-3.0-only
// The worker's stopgap for an app that is off for an org (ADR-0053, slice c step C1), without a database: a relay step whose runtime call is refused with
// MODULE_OFF is dropped with a line that carries the event id, type and app and never the payload (instead of rolling back the whole claimed batch, which
// wedged the relay for every org); a keeping event is never dropped; every command a keeping event reaches declares runsWhenOff; and the publish sweep queues
// nothing for an org whose Social is off.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { KEEPING_EVENT_COMMANDS, relayStep, sweepSocialPublishing } from '../src/worker.ts';

const ROW = { org_id: '01900000-0000-7000-8000-000000000001', event_id: '01900000-0000-7000-8000-0000000000e1', type: 'ads.campaign.draft_queued' };
const off = (module: string) => new DomainError('MODULE_OFF', 404, `Ứng dụng ${module} đã được tắt cho công ty này`, { module });

describe('a relay step of an app that is off', () => {
  it('is dropped with a line of ids and codes, so the batch is not rolled back', async () => {
    const lines: string[] = [];
    const step = relayStep(ROW, async () => {
      throw off('ads');
    }, (line) => lines.push(line));
    await expect(step({ send: async () => null })).resolves.toBeNull();
    expect(lines).toEqual([`[relay] event 01900000 (ads.campaign.draft_queued) dropped: ads is off for org 01900000`]);
  });

  it('runs and returns what a step answers, and rethrows every other error, so a real failure still rolls the batch back', async () => {
    const lines: string[] = [];
    await expect(relayStep(ROW, async () => 'sent', (l) => lines.push(l))({ send: async () => null })).resolves.toBe('sent');
    const failing = relayStep(ROW, async () => {
      throw new DomainError('FORBIDDEN', 403, 'no');
    }, (l) => lines.push(l));
    await expect(failing({ send: async () => null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(relayStep(ROW, async () => {
      throw new Error('boom');
    }, (l) => lines.push(l))({ send: async () => null })).rejects.toThrow('boom');
    expect(lines).toEqual([]);
  });

  it('never drops a keeping event: a refusal there is a defect that stays loud', async () => {
    for (const type of Object.keys(KEEPING_EVENT_COMMANDS)) {
      const step = relayStep({ ...ROW, type }, async () => {
        throw off('ads');
      }, () => {});
      await expect(step({ send: async () => null }), type).rejects.toMatchObject({ code: 'MODULE_OFF' });
    }
  });

  it('keeps ads.pause.queued and the member revocations on commands that declare runsWhenOff, so they never meet the drop', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
    const { commands, queries } = moduleDefinitions(config);
    const keeping = new Map<string, string | undefined>([...commands, ...queries].map((d) => [d.name, (d as { runsWhenOff?: string }).runsWhenOff]));
    expect(Object.keys(KEEPING_EVENT_COMMANDS).sort()).toEqual(['ads.pause.queued', 'kernel.member.removed', 'kernel.member.role_changed']);
    for (const [type, names] of Object.entries(KEEPING_EVENT_COMMANDS)) {
      for (const name of names) expect(keeping.get(name), `${type} -> ${name}`).toBeTypeOf('string');
    }
  });
});

describe('the Social publish sweep', () => {
  // The part of a kysely database a raw `sql` query touches: its executor, which answers with the rows.
  const dbWith = (rows: unknown[]) => ({ getExecutor: () => ({ transformQuery: (n: unknown) => n, compileQuery: () => ({ query: {}, sql: '', parameters: [] }), executeQuery: async () => ({ rows }) }) }) as never;

  it('queues a job for each due variant of an org whose Social is on, and none for one whose Social is off, asking once per org', async () => {
    const A = '01900000-0000-7000-8000-00000000000a';
    const B = '01900000-0000-7000-8000-00000000000b';
    const rows = [
      { org_id: A, variant_id: 'v1', provider: 'bluesky' },
      { org_id: B, variant_id: 'v2', provider: 'bluesky' },
      { org_id: B, variant_id: 'v3', provider: 'bluesky' },
    ];
    const sent: Array<{ data: { orgId: string; variantId: string } }> = [];
    const boss = { send: async (_queue: string, data: { orgId: string; variantId: string }) => void sent.push({ data }) } as never;
    const asked: string[] = [];
    const queued = await sweepSocialPublishing(boss, dbWith(rows), new Set(['bluesky']), async (orgId) => {
      asked.push(orgId);
      return orgId === A;
    });
    expect(queued).toBe(1);
    expect(sent.map((s) => s.data.variantId)).toEqual(['v1']);
    expect(asked.sort()).toEqual([A, B]);
  });

  it('queues the variants anyway when the check cannot answer (a database blip never stops publishing)', async () => {
    const rows = [{ org_id: '01900000-0000-7000-8000-00000000000a', variant_id: 'v1', provider: 'bluesky' }];
    const sent: unknown[] = [];
    const boss = { send: async (...args: unknown[]) => void sent.push(args) } as never;
    expect(await sweepSocialPublishing(boss, dbWith(rows), new Set(['bluesky']), async () => {
      throw new Error('connection lost');
    })).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
