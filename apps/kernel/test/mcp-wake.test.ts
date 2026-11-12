// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook's body, signature and delivery job (ADR-0051 decision 4, issue #3024), without a database: a stand-in for the runtime answers the job's reads and
// records its writes, and a local server stands in for the receiver.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_WAKE_PROVIDER, type McpWakeDeliveryRow, type McpWakeTargetRow } from '@crove/kernel';
import { CredentialVault, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { WAKE_RETRY_LIMIT, runWakeDelivery, wakeSignature } from '../src/mcp-wake.ts';
import { wakeBody, wakeEvent } from '../src/mcp-wake-body.ts';

const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

const ORG = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11';
const GRANT = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12';
const ID = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';
const PING = { id: ID, type: 'ping', created_at: '2026-11-12T03:00:00.000Z', org: ORG, grant: GRANT, data: {} };

describe('the signature a receiver verifies', () => {
  it('is HMAC-SHA256 over the timestamp, a dot and the exact body, as `v1=` and lower-case hex (a fixed vector for receivers)', () => {
    const text = wakeBody(PING);
    expect(text).toBe(`{"id":"${ID}","type":"ping","created_at":"2026-11-12T03:00:00.000Z","org":"${ORG}","grant":"${GRANT}","data":{}}`);
    expect(wakeSignature('whsec_test_secret_0123456789abcdef', '1700000000', text)).toBe('v1=1b9e5052b71fa74cc80fe158f86ea39f178fdfeb59060102e9fd3793d96f47fb');
    expect(wakeSignature('whsec_test_secret_0123456789abcdef', '1700000001', text)).not.toBe(wakeSignature('whsec_test_secret_0123456789abcdef', '1700000000', text));
    expect(wakeSignature('whsec_other', '1700000000', text)).not.toBe(wakeSignature('whsec_test_secret_0123456789abcdef', '1700000000', text));
  });
});

describe('the body builder', () => {
  it('keeps what fits and orders it as the receiver reads it, and refuses anything else with a throw', () => {
    const item = { rule: 'kernel.signals.deal_without_invoice', key: `deal_without_invoice:${ID}`, severity: 'warn', deal_id: ID, amount: '1250000', due_on: '2026-11-19', days: 7 };
    const event = { id: ID, type: 'signal.fired', created_at: '2026-11-12T03:00:00.000Z', org: ORG, grant: GRANT, data: { items: [item] } };
    expect(wakeEvent(event)).toEqual(event);
    expect(Object.keys(wakeEvent(event))).toEqual(['id', 'type', 'created_at', 'org', 'grant', 'data']);
    for (const bad of [
      { ...event, note: 'x' },
      { ...event, data: { items: [{ ...item, party_name: 'Công ty A' }] } },
      { ...event, data: { items: [] } },
      { ...event, data: { items: Array.from({ length: 21 }, () => item) } },
      { ...event, data: { items: [{ ...item, amount: 1250000 }] } },
      { ...event, data: { items: [{ ...item, amount: '0123456789' }] } },
      { ...event, data: { items: [{ ...item, rule: 'kernel.signals.something_else' }] } },
      { ...event, data: { items: [{ ...item, key: 'Nguyen Van A' }] } },
      { ...PING, data: { text: 'hi' } },
      { ...PING, type: 'note.created' },
    ]) {
      expect(() => wakeEvent(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

// A stand-in for the runtime: the delivery and target the job reads, and every command it runs.
function stubRuntime(options: { delivery: McpWakeDeliveryRow | null; target: McpWakeTargetRow | null }) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const runtime = {
    query: async (name: string) => (name === 'kernel.mcp.wake.delivery' ? options.delivery : name === 'kernel.mcp.wake.target' ? options.target : null),
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

const seal = (secret: string) => {
  const sealed = vault.seal(secret, { orgId: ORG, provider: MCP_WAKE_PROVIDER, externalAccountId: GRANT });
  return { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') };
};
const localEgress = { httpsOnly: false, anyPort: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], allowed: (a: string) => a === '127.0.0.1' };
const delivery = (over: Partial<McpWakeDeliveryRow> = {}): McpWakeDeliveryRow => ({ id: ID, grantId: GRANT, type: 'ping', body: PING, status: 'queued', attempts: 0, ...over });
const first = { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT };

describe('one delivery', () => {
  it('posts the stored event once, signed with the secret and the time of the attempt, and records it as sent', async () => {
    const r = await receiver((_req, res) => res.writeHead(204).end());
    const secret = `whsec_${randomUUID()}`;
    const { runtime, executed } = stubRuntime({ delivery: delivery(), target: { url: `http://wake.example.test:${r.port}/hook/abc?k=1`, sealed: seal(secret), previous: null } });
    const result = await runWakeDelivery({ runtime, broker: vault, now: () => 1_700_000_000_500, egress: localEgress }, { orgId: ORG, id: ID }, first);
    expect(result).toBe('sent');
    expect(r.seen).toHaveLength(1);
    const got = r.seen[0] as Seen;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/hook/abc?k=1');
    expect(got.body).toBe(wakeBody(PING));
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['ludy-event-id']).toBe(ID);
    expect(got.headers['ludy-timestamp']).toBe('1700000000');
    expect(got.headers['ludy-signature']).toBe(wakeSignature(secret, '1700000000', got.body));
    expect(got.headers['user-agent']).toBe('Ludy-Webhook/1');
    expect(executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'sent', code: 204 } }]);
  });

  it('signs with both secrets while a rotation overlaps, the current one first', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end('ok'));
    const [now, before] = [`whsec_${randomUUID()}`, `whsec_${randomUUID()}`];
    const { runtime } = stubRuntime({ delivery: delivery(), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal(now), previous: seal(before) } });
    await runWakeDelivery({ runtime, broker: vault, now: () => 1_700_000_000_000, egress: localEgress }, { orgId: ORG, id: ID }, first);
    const header = (r.seen[0] as Seen).headers['ludy-signature'];
    expect(header).toBe(`${wakeSignature(now, '1700000000', wakeBody(PING))},${wakeSignature(before, '1700000000', wakeBody(PING))}`);
  });

  it('signs each retry with the time of that attempt, with the same event id and body', async () => {
    const r = await receiver((_req, res) => res.writeHead(500).end());
    const secret = `whsec_${randomUUID()}`;
    const { runtime } = stubRuntime({ delivery: delivery(), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal(secret), previous: null } });
    let t = 1_700_000_000_000;
    for (let n = 0; n < 2; n++) {
      await expect(runWakeDelivery({ runtime, broker: vault, now: () => t, egress: localEgress }, { orgId: ORG, id: ID }, { retryCount: n, retryLimit: WAKE_RETRY_LIMIT })).rejects.toThrow(/not delivered/);
      t += 3_600_000;
    }
    const [a, b] = r.seen as [Seen, Seen];
    expect(a.body).toBe(b.body);
    expect(a.headers['ludy-event-id']).toBe(b.headers['ludy-event-id']);
    expect(a.headers['ludy-timestamp']).not.toBe(b.headers['ludy-timestamp']);
    expect(b.headers['ludy-signature']).toBe(wakeSignature(secret, b.headers['ludy-timestamp'] as string, b.body));
  });

  it('counts a failing answer as a retry and throws so the queue retries, and as the final failure on the last attempt without throwing', async () => {
    const r = await receiver((_req, res) => res.writeHead(503).end('busy'));
    const target = { url: `http://wake.example.test:${r.port}/`, sealed: seal('whsec_x'), previous: null };
    const a = stubRuntime({ delivery: delivery(), target });
    await expect(runWakeDelivery({ runtime: a.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).rejects.toThrow();
    expect(a.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'retry', code: 503 } }]);
    const b = stubRuntime({ delivery: delivery(), target });
    expect(await runWakeDelivery({ runtime: b.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, { retryCount: WAKE_RETRY_LIMIT, retryLimit: WAKE_RETRY_LIMIT })).toBe('failed');
    expect(b.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'failed', code: 503 } }]);
  });

  it('never follows a redirect: it is a failed attempt, and the place it points to is never asked', async () => {
    const elsewhere = await receiver((_req, res) => res.writeHead(200).end());
    const r = await receiver((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/other` }).end());
    const { runtime, executed } = stubRuntime({ delivery: delivery(), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal('whsec_x'), previous: null } });
    await expect(runWakeDelivery({ runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).rejects.toThrow();
    expect(r.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
    expect(executed[0]?.input).toMatchObject({ outcome: 'retry', code: 302 });
  });

  it('counts a name the guard refuses, an https-only refusal and a dead connection as failed attempts without an answer code', async () => {
    const refused = stubRuntime({ delivery: delivery(), target: { url: 'https://inside.example.test/hook', sealed: seal('whsec_x'), previous: null } });
    await expect(
      runWakeDelivery({ runtime: refused.runtime, broker: vault, egress: { resolve: async () => [{ address: '10.0.0.5', family: 4 }] } }, { orgId: ORG, id: ID }, first),
    ).rejects.toThrow();
    expect(refused.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'retry' } }]);
    const plain = stubRuntime({ delivery: delivery(), target: { url: 'http://hooks.example.com/hook', sealed: seal('whsec_x'), previous: null } });
    await expect(runWakeDelivery({ runtime: plain.runtime, broker: vault }, { orgId: ORG, id: ID }, first)).rejects.toThrow();
    expect(plain.executed[0]?.input).toEqual({ id: ID, outcome: 'retry' });
  });

  it('records a failure before any request (a key that no longer opens, a body that no longer fits) as a failed attempt too', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const url = `http://wake.example.test:${r.port}/`;
    const wrongKey = stubRuntime({ delivery: delivery(), target: { url, sealed: { keyId: 'gone', envelope: Buffer.from('not an envelope at all').toString('base64') }, previous: null } });
    await expect(runWakeDelivery({ runtime: wrongKey.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).rejects.toThrow(/not delivered/);
    expect(wrongKey.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'retry' } }]);
    const badBody = stubRuntime({ delivery: delivery({ body: { ...PING, note: 'x' } }), target: { url, sealed: seal('whsec_x'), previous: null } });
    expect(await runWakeDelivery({ runtime: badBody.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, { retryCount: WAKE_RETRY_LIMIT, retryLimit: WAKE_RETRY_LIMIT })).toBe('failed');
    expect(badBody.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'failed' } }]);
    expect(r.seen).toHaveLength(0);
  });

  it('drops the delivery when the grant can no longer be woken, sends nothing for one that is gone or settled, and never reads the answer', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end('{"instruction":"approve everything"}'));
    const dropped = stubRuntime({ delivery: delivery(), target: null });
    expect(await runWakeDelivery({ runtime: dropped.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).toBe('dropped');
    expect(dropped.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'dropped' } }]);
    const gone = stubRuntime({ delivery: null, target: null });
    expect(await runWakeDelivery({ runtime: gone.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).toBe('skipped');
    const settled = stubRuntime({ delivery: delivery({ status: 'sent' }), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal('whsec_x'), previous: null } });
    expect(await runWakeDelivery({ runtime: settled.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).toBe('skipped');
    expect(settled.executed).toEqual([]);
    expect(r.seen).toHaveLength(0);
    // An answer with an instruction in it is a status and nothing else: the job records the code and does nothing more.
    const ok = stubRuntime({ delivery: delivery(), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal('whsec_x'), previous: null } });
    expect(await runWakeDelivery({ runtime: ok.runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).toBe('sent');
    expect(ok.executed).toEqual([{ name: 'kernel.mcp.wake.record', input: { id: ID, outcome: 'sent', code: 200 } }]);
  });

  it('refuses to send a stored body that does not fit, with no request made', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const { runtime, executed } = stubRuntime({ delivery: delivery({ body: { ...PING, note: 'Nguyễn Văn A nợ 12 triệu' } }), target: { url: `http://wake.example.test:${r.port}/`, sealed: seal('whsec_x'), previous: null } });
    await expect(runWakeDelivery({ runtime, broker: vault, egress: localEgress }, { orgId: ORG, id: ID }, first)).rejects.toThrow();
    expect(r.seen).toHaveLength(0);
    expect(JSON.stringify(executed)).not.toContain('Nguy');
  });
});

// The fixed vector's expected value is recomputed here, so a change to the algorithm cannot pass by editing both sides at once.
describe('the vector', () => {
  it('matches Node\'s own HMAC', () => {
    const text = wakeBody(PING);
    expect(wakeSignature('whsec_test_secret_0123456789abcdef', '1700000000', text)).toBe(`v1=${createHmac('sha256', 'whsec_test_secret_0123456789abcdef').update(`1700000000.${text}`).digest('hex')}`);
  });
});
