// SPDX-License-Identifier: AGPL-3.0-only
// The minutes webhook's body builder, secret, delivery job and sweep (meetings integrations A6, issue #3164), without a database: a stand-in for the runtime answers the job's reads and
// records its writes, and a local server stands in for the receiver. The signing is the wake-up's (mcp-wake.ts postSigned), so the headers and the signature are pinned here the same way.
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meetingHookBody, meetingHookEvent, type MeetingHookDeliveryRow, type MeetingHookTargetRow } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { WAKE_RETRY_LIMIT, wakeSignature } from '../src/mcp-wake.ts';
import { runMeetingHookDelivery } from '../src/meeting-hook.ts';
import { MEETING_HOOK_PROVIDER, makeHookSecret } from '../src/meeting-hook-setup.ts';
import { runMeetingHookSweep } from '../src/meeting-hook-sweep.ts';

const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

const ORG = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11';
const USER = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a13';
const HOOK = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12';
const ID = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';
const MEETING = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a14';
const RESULT = {
  id: ID,
  type: 'meeting.result_published',
  created_at: '2026-11-14T03:00:00.000Z',
  org: ORG,
  data: { meeting_id: MEETING, published_at: '2026-11-14T03:00:00.000Z', started_at: '2026-11-10T03:00:00.000Z', length_seconds: 1800, title: 'Họp giao ban', summary: 'Chốt kế hoạch.', decisions: ['Tăng ngân sách'], action_items: [{ text: 'Gửi báo giá', owner: 'Lan', due: '2026-11-20' }] },
};
const PING = { id: ID, type: 'ping', created_at: '2026-11-14T03:00:00.000Z', org: ORG, data: {} };

describe('the body builder', () => {
  it('keeps what fits, in the order a receiver reads it, and the exact bytes are stable', () => {
    expect(meetingHookEvent(RESULT)).toEqual(RESULT);
    expect(Object.keys(meetingHookEvent(RESULT))).toEqual(['id', 'type', 'created_at', 'org', 'data']);
    expect(meetingHookBody(PING)).toBe(`{"id":"${ID}","type":"ping","created_at":"2026-11-14T03:00:00.000Z","org":"${ORG}","data":{}}`);
  });

  it('writes every level in the pinned key order whatever order the input has', () => {
    const scrambled = {
      data: {
        action_items: [{ due: '2026-11-20', owner: 'Lan', text: 'Gửi báo giá' }],
        decisions: ['Tăng ngân sách'],
        summary: 'Chốt kế hoạch.',
        title: 'Họp giao ban',
        length_seconds: 1800,
        started_at: '2026-11-10T03:00:00.000Z',
        published_at: '2026-11-14T03:00:00.000Z',
        meeting_id: MEETING,
      },
      org: ORG,
      created_at: '2026-11-14T03:00:00.000Z',
      type: 'meeting.result_published',
      id: ID,
    };
    expect(meetingHookBody(scrambled)).toBe(
      `{"id":"${ID}","type":"meeting.result_published","created_at":"2026-11-14T03:00:00.000Z","org":"${ORG}","data":{"meeting_id":"${MEETING}","published_at":"2026-11-14T03:00:00.000Z","started_at":"2026-11-10T03:00:00.000Z","length_seconds":1800,"title":"Họp giao ban","summary":"Chốt kế hoạch.","decisions":["Tăng ngân sách"],"action_items":[{"text":"Gửi báo giá","owner":"Lan","due":"2026-11-20"}]}}`,
    );
  });

  it('refuses a transcript, audio, video, an attendee contact, or any key it does not know, at any level', () => {
    const data = RESULT.data;
    for (const bad of [
      { ...RESULT, transcript: 'x' },
      { ...RESULT, data: { ...data, transcript: 'x' } },
      { ...RESULT, data: { ...data, segments: [] } },
      { ...RESULT, data: { ...data, audio_url: 'https://x.test/a.mp3' } },
      { ...RESULT, data: { ...data, attendees: [{ email: 'a@b.test' }] } },
      { ...RESULT, data: { ...data, action_items: [{ text: 'Việc', owner: null, due: null, email: 'a@b.test' }] } },
      { ...RESULT, data: { ...data, summary: 'a'.repeat(8001) } },
      { ...RESULT, data: { ...data, decisions: Array.from({ length: 51 }, () => 'x') } },
      { ...RESULT, data: { ...data, meeting_id: 'not-an-id' } },
      { ...PING, data: { text: 'hi' } },
      { ...PING, type: 'note.created' },
    ]) {
      expect(() => meetingHookEvent(bad), JSON.stringify(bad).slice(0, 80)).toThrow();
    }
  });
});

describe('the secret', () => {
  it('is sealed for the org and the member only, shown once, and opens for nothing else', () => {
    const made = makeHookSecret(vault, ORG, USER);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.credential.hint).toMatch(/^whk_[0-9a-f]{8}$/);
    expect(JSON.stringify(made.credential)).not.toContain(made.secret);
    const sealed = { keyId: made.credential.keyId, envelope: Buffer.from(made.credential.envelope, 'base64') };
    expect(vault.open(sealed, { orgId: ORG, provider: MEETING_HOOK_PROVIDER, externalAccountId: USER })).toBe(made.secret);
    expect(() => vault.open(sealed, { orgId: ORG, provider: MEETING_HOOK_PROVIDER, externalAccountId: randomUUID() })).toThrow();
    expect(() => vault.open(sealed, { orgId: ORG, provider: 'mcp-wake', externalAccountId: USER })).toThrow();
  });

  it('says so when no key is configured, and makes nothing', () => {
    expect(() => makeHookSecret({ id: 'none', seal: () => { throw new Error('x'); }, open: () => { throw new Error('x'); } } as never, ORG, USER)).toThrow(/CREDENTIAL_KEY/);
  });
});

function stubRuntime(options: { delivery: MeetingHookDeliveryRow | null; target: MeetingHookTargetRow | null }) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const runtime = {
    query: async (name: string) => (name === 'meetings.hook.delivery' ? options.delivery : name === 'meetings.hook.target' ? options.target : null),
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      return {};
    },
  } as unknown as Runtime;
  return { runtime, executed };
}

interface Seen {
  method?: string | undefined;
  url?: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}
async function receiver(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      answer(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, seen };
}

const seal = (secret: string, userId = USER) => {
  const sealed = vault.seal(secret, { orgId: ORG, provider: MEETING_HOOK_PROVIDER, externalAccountId: userId });
  return { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') };
};
const localEgress = { httpsOnly: false, anyPort: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], allowed: (a: string) => a === '127.0.0.1' };
const delivery = (over: Partial<MeetingHookDeliveryRow> = {}): MeetingHookDeliveryRow => ({ id: ID, hookId: HOOK, type: 'meeting.result_published', body: RESULT, status: 'queued', attempts: 0, ...over });
const target = (port: number, secret: string, previous: string | null = null): MeetingHookTargetRow => ({
  userId: USER,
  url: `http://hooks.example.test:${port}/minutes?k=1`,
  sealed: seal(secret),
  previous: previous ? seal(previous) : null,
});
const first = { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT };
const job = { orgId: ORG, id: ID };

describe('one delivery', () => {
  it('posts the stored event once with the headers and the signature of the attempt, and records it as sent', async () => {
    const r = await receiver((_req, res) => res.writeHead(204).end());
    const secret = `whsec_${randomUUID()}`;
    const { runtime, executed } = stubRuntime({ delivery: delivery(), target: target(r.port, secret) });
    expect(await runMeetingHookDelivery({ runtime, broker: vault, now: () => 1_700_000_000_500, egress: localEgress }, job, first)).toBe('sent');
    expect(r.seen).toHaveLength(1);
    const got = r.seen[0] as Seen;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/minutes?k=1');
    expect(got.body).toBe(meetingHookBody(RESULT));
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['ludy-event-id']).toBe(ID);
    expect(got.headers['ludy-timestamp']).toBe('1700000000');
    expect(got.headers['ludy-signature']).toBe(wakeSignature(secret, '1700000000', got.body));
    expect(got.headers['user-agent']).toBe('Ludy-Webhook/1');
    expect(executed).toEqual([{ name: 'meetings.hook.record', input: { id: ID, outcome: 'sent', code: 204 } }]);
  });

  it('signs with both secrets while a rotation overlaps, the current one first', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end('ok'));
    const [now, before] = [`whsec_${randomUUID()}`, `whsec_${randomUUID()}`];
    const { runtime } = stubRuntime({ delivery: delivery(), target: target(r.port, now, before) });
    await runMeetingHookDelivery({ runtime, broker: vault, now: () => 1_700_000_000_000, egress: localEgress }, job, first);
    const text = meetingHookBody(RESULT);
    expect((r.seen[0] as Seen).headers['ludy-signature']).toBe(`${wakeSignature(now, '1700000000', text)},${wakeSignature(before, '1700000000', text)}`);
  });

  it('sends a test ping the same way', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const { runtime, executed } = stubRuntime({ delivery: delivery({ type: 'ping', body: PING }), target: target(r.port, 'whsec_x') });
    expect(await runMeetingHookDelivery({ runtime, broker: vault, egress: localEgress }, job, first)).toBe('sent');
    expect((r.seen[0] as Seen).body).toBe(meetingHookBody(PING));
    expect(executed[0]?.input).toMatchObject({ outcome: 'sent', code: 200 });
  });

  it('counts a failing answer as a retry and throws so the queue retries, and as the final failure on the last attempt without throwing', async () => {
    const r = await receiver((_req, res) => res.writeHead(503).end('busy'));
    const t = target(r.port, 'whsec_x');
    const a = stubRuntime({ delivery: delivery(), target: t });
    await expect(runMeetingHookDelivery({ runtime: a.runtime, broker: vault, egress: localEgress }, job, first)).rejects.toThrow(/not delivered/);
    expect(a.executed).toEqual([{ name: 'meetings.hook.record', input: { id: ID, outcome: 'retry', code: 503 } }]);
    const b = stubRuntime({ delivery: delivery(), target: t });
    expect(await runMeetingHookDelivery({ runtime: b.runtime, broker: vault, egress: localEgress }, job, { retryCount: WAKE_RETRY_LIMIT, retryLimit: WAKE_RETRY_LIMIT })).toBe('failed');
    expect(b.executed).toEqual([{ name: 'meetings.hook.record', input: { id: ID, outcome: 'failed', code: 503 } }]);
  });

  it('never follows a redirect: it is a failed attempt, and the place it points to is never asked', async () => {
    const elsewhere = await receiver((_req, res) => res.writeHead(200).end());
    const r = await receiver((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/other` }).end());
    const { runtime, executed } = stubRuntime({ delivery: delivery(), target: target(r.port, 'whsec_x') });
    await expect(runMeetingHookDelivery({ runtime, broker: vault, egress: localEgress }, job, first)).rejects.toThrow();
    expect(r.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
    expect(executed[0]?.input).toMatchObject({ outcome: 'retry', code: 302 });
  });

  it('counts an address the guard refuses, a plain http address and a dead connection as failed attempts without an answer code', async () => {
    const t = { userId: USER, url: 'https://inside.example.test/hook', sealed: seal('whsec_x'), previous: null };
    const refused = stubRuntime({ delivery: delivery(), target: t });
    await expect(runMeetingHookDelivery({ runtime: refused.runtime, broker: vault, egress: { resolve: async () => [{ address: '10.0.0.5', family: 4 }] } }, job, first)).rejects.toThrow();
    expect(refused.executed).toEqual([{ name: 'meetings.hook.record', input: { id: ID, outcome: 'retry' } }]);
    const plain = stubRuntime({ delivery: delivery(), target: { ...t, url: 'http://hooks.example.com/hook' } });
    await expect(runMeetingHookDelivery({ runtime: plain.runtime, broker: vault }, job, first)).rejects.toThrow();
    expect(plain.executed[0]?.input).toEqual({ id: ID, outcome: 'retry' });
  });

  it('counts a secret that no longer opens (sealed for another member) and a stored body that no longer fits as failed attempts, sending nothing', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const foreign = stubRuntime({ delivery: delivery(), target: { ...target(r.port, 'whsec_x'), sealed: seal('whsec_x', randomUUID()) } });
    await expect(runMeetingHookDelivery({ runtime: foreign.runtime, broker: vault, egress: localEgress }, job, first)).rejects.toThrow();
    const bad = stubRuntime({ delivery: delivery({ body: { ...RESULT, transcript: 'x' } as never }), target: target(r.port, 'whsec_x') });
    await expect(runMeetingHookDelivery({ runtime: bad.runtime, broker: vault, egress: localEgress }, job, first)).rejects.toThrow();
    const wiped = stubRuntime({ delivery: delivery({ body: null }), target: target(r.port, 'whsec_x') });
    await expect(runMeetingHookDelivery({ runtime: wiped.runtime, broker: vault, egress: localEgress }, job, first)).rejects.toThrow();
    expect(r.seen).toHaveLength(0);
  });

  it('sends nothing for a delivery that is gone or settled, and drops one whose hook no longer stands', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const gone = stubRuntime({ delivery: null, target: target(r.port, 'whsec_x') });
    expect(await runMeetingHookDelivery({ runtime: gone.runtime, broker: vault, egress: localEgress }, job, first)).toBe('skipped');
    const settled = stubRuntime({ delivery: delivery({ status: 'sent', body: null }), target: target(r.port, 'whsec_x') });
    expect(await runMeetingHookDelivery({ runtime: settled.runtime, broker: vault, egress: localEgress }, job, first)).toBe('skipped');
    const dropped = stubRuntime({ delivery: delivery(), target: null });
    expect(await runMeetingHookDelivery({ runtime: dropped.runtime, broker: vault, egress: localEgress }, job, first)).toBe('dropped');
    expect(dropped.executed).toEqual([{ name: 'meetings.hook.record', input: { id: ID, outcome: 'dropped' } }]);
    expect([...gone.executed, ...settled.executed]).toEqual([]);
    expect(r.seen).toHaveLength(0);
  });
});

describe('the sweep', () => {
  // The worker's read is a raw query on the worker pool; a stand-in answers it with the rows the database would.
  const sweepWith = (rows: Array<{ org_id: string; id: string; kind: 'send' | 'expire' }>, send: (j: { orgId: string; id: string }) => Promise<unknown>) => {
    const executed: Array<{ name: string; input: Record<string, unknown>; orgId: string }> = [];
    const runtime = {
      execute: async (name: string, input: Record<string, unknown>, ctx: { orgId: string }) => {
        executed.push({ name, input, orgId: ctx.orgId });
        return {};
      },
    } as unknown as Runtime;
    // The part of a kysely database a raw `sql` query touches: its executor, which answers with the rows.
    const workerDb = { getExecutor: () => ({ transformQuery: (n: unknown) => n, compileQuery: () => ({ query: {}, sql: '', parameters: [] }), executeQuery: async () => ({ rows }) }) } as never;
    return { executed, run: () => runMeetingHookSweep({ runtime, workerDb, send }) };
  };

  it('hands a waiting delivery to the queue, then marks it handed over; and fails one that waited too long', async () => {
    const send = vi.fn(async () => undefined);
    const other = randomUUID();
    const { executed, run } = sweepWith(
      [
        { org_id: ORG, id: ID, kind: 'send' },
        { org_id: other, id: randomUUID(), kind: 'expire' },
      ],
      send,
    );
    expect(await run()).toEqual({ handedOver: 1, expired: 1, failures: 0 });
    expect(send).toHaveBeenCalledWith({ orgId: ORG, id: ID });
    expect(executed.map((e) => [e.name, e.orgId, (e.input as { outcome?: string }).outcome ?? null])).toEqual([
      ['meetings.hook.queued', ORG, null],
      ['meetings.hook.record', other, 'expired'],
    ]);
  });

  it('leaves a delivery stored, to be handed over again, when the queue fails, and carries on with the others', async () => {
    const second = randomUUID();
    const send = vi.fn(async (j: { orgId: string; id: string }) => {
      if (j.id === ID) throw new Error('queue down');
    });
    const { executed, run } = sweepWith(
      [
        { org_id: ORG, id: ID, kind: 'send' },
        { org_id: ORG, id: second, kind: 'send' },
      ],
      send,
    );
    expect(await run()).toEqual({ handedOver: 1, expired: 0, failures: 1 });
    expect(executed).toEqual([{ name: 'meetings.hook.queued', input: { id: second }, orgId: ORG }]);
  });
});
