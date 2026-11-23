// SPDX-License-Identifier: AGPL-3.0-only
// In-memory unit tests for eSign Slice 5b outbound HMAC webhook secret sealing, sweep, and delivery worker (#4440).
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  signWebhookBody,
  type SignHookDeliveryRow,
  type SignHookTargetRow,
  type SignWebhookPayload,
} from '@ludy/kernel-contract';
import { CredentialVault, parseVaultKey, type Runtime } from '@ludy/kernel-runtime';
import { WAKE_RETRY_LIMIT, wakeSignature } from '../src/mcp-wake.ts';
import {
  SIGN_WEBHOOK_PROVIDER,
  makeSignWebhookSecret,
  runSignHookDelivery,
} from '../src/sign-hook.ts';

const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

const ORG = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11';
const WEBHOOK = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12';
const DELIVERY = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a13';
const ENVELOPE = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a14';

const COMPLETED_PAYLOAD: SignWebhookPayload = {
  eventId: DELIVERY,
  eventType: 'sign.envelope.completed',
  occurredAt: '2026-11-22T09:00:00.000Z',
  orgId: ORG,
  envelopeId: ENVELOPE,
  status: 'completed',
  completedAt: '2026-11-22T08:59:58.000Z',
  certificateCode: 'CS-2026-4440',
  sealedSha256: 'b'.repeat(64),
};

interface Seen {
  method?: string | undefined;
  url?: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startReceiver(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, seen };
}

const localEgress = {
  httpsOnly: false,
  anyPort: true,
  resolve: async () => [{ address: '127.0.0.1', family: 4 as const }],
  allowed: (addr: string) => addr === '127.0.0.1',
};

function sealSecret(secret: string, webhookId = WEBHOOK) {
  const sealed = vault.seal(secret, {
    orgId: ORG,
    provider: SIGN_WEBHOOK_PROVIDER,
    externalAccountId: webhookId,
  });
  return { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') };
}

function stubRuntime(options: {
  appOn?: boolean;
  delivery: SignHookDeliveryRow | null;
  target: SignHookTargetRow | null;
}) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const queried: string[] = [];
  const runtime = {
    appOn: async () => options.appOn ?? true,
    query: async (name: string) => {
      queried.push(name);
      if (name === 'sign.hook.delivery') return options.delivery;
      if (name === 'sign.hook.target') return options.target;
      return null;
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      return {};
    },
  } as unknown as Runtime;
  return { runtime, executed, queried };
}

describe('sign-hook secret sealing & delivery (#4440)', () => {
  it('mints whsec_ secret + whk_ hint bound to (orgId, sign-webhook, webhookId) and never leaks clear secret into credential', () => {
    const made = makeSignWebhookSecret(vault, ORG, WEBHOOK);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.credential.secretHint).toMatch(/^whk_[0-9a-f]{8}$/);
    expect(JSON.stringify(made.credential)).not.toContain(made.secret);

    const opened = vault.open(
      {
        keyId: made.credential.keyId,
        envelope: Buffer.from(made.credential.secretEnvelope, 'base64'),
      },
      { orgId: ORG, provider: SIGN_WEBHOOK_PROVIDER, externalAccountId: WEBHOOK },
    );
    expect(opened).toBe(made.secret);

    expect(() =>
      vault.open(
        {
          keyId: made.credential.keyId,
          envelope: Buffer.from(made.credential.secretEnvelope, 'base64'),
        },
        { orgId: ORG, provider: SIGN_WEBHOOK_PROVIDER, externalAccountId: randomUUID() },
      ),
    ).toThrow();

    expect(() =>
      makeSignWebhookSecret(
        { id: 'none', seal: () => { throw new Error('x'); }, open: () => { throw new Error('x'); } } as never,
        ORG,
        WEBHOOK,
      ),
    ).toThrow(/CREDENTIAL_KEY/);
  });

  it('posts canonical JSON with event ID, timestamp, and dual v1 HMAC signature header during rotation overlap', async () => {
    const r = await startReceiver((_req, res) => res.writeHead(200).end('ok'));
    const currentSecret = `whsec_${randomUUID()}`;
    const prevSecret = `whsec_${randomUUID()}`;
    const { runtime, executed } = stubRuntime({
      delivery: {
        id: DELIVERY,
        webhookId: WEBHOOK,
        envelopeId: ENVELOPE,
        envelopeSourceKind: 'standalone',
        eventType: 'sign.envelope.completed',
        payload: COMPLETED_PAYLOAD,
        status: 'queued',
        attempts: 0,
      },
      target: {
        id: WEBHOOK,
        url: `http://hooks.example.test:${r.port}/sign`,
        sealed: sealSecret(currentSecret),
        previous: sealSecret(prevSecret),
      },
    });

    const outcome = await runSignHookDelivery(
      { runtime, broker: vault, now: () => 1_700_000_000_000, egress: localEgress },
      { orgId: ORG, id: DELIVERY },
      { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT },
    );
    expect(outcome).toBe('sent');
    expect(r.seen).toHaveLength(1);
    const req = r.seen[0]!;
    const expectedBody = signWebhookBody(COMPLETED_PAYLOAD);
    expect(req.body).toBe(expectedBody);
    expect(req.headers['ludy-event-id']).toBe(DELIVERY);
    expect(req.headers['ludy-timestamp']).toBe('1700000000');
    expect(req.headers['ludy-signature']).toBe(
      `${wakeSignature(currentSecret, '1700000000', expectedBody)},${wakeSignature(prevSecret, '1700000000', expectedBody)}`,
    );
    expect(executed).toEqual([{ name: 'sign.hook.record', input: { id: DELIVERY, outcome: 'sent', code: 200 } }]);
  });

  it('drops confidential hr_contract and meeting_minutes deliveries and orgs with sign disabled without hitting the network', async () => {
    const r = await startReceiver((_req, res) => res.writeHead(200).end('ok'));
    for (const sourceKind of ['hr_contract', 'meeting_minutes'] as const) {
      const { runtime, executed, queried } = stubRuntime({
        delivery: {
          id: DELIVERY,
          webhookId: WEBHOOK,
          envelopeId: ENVELOPE,
          envelopeSourceKind: sourceKind,
          eventType: 'sign.envelope.sent',
          payload: {
            eventId: DELIVERY,
            eventType: 'sign.envelope.sent',
            occurredAt: '2026-11-22T09:00:00.000Z',
            orgId: ORG,
            envelopeId: ENVELOPE,
            status: 'sent',
          },
          status: 'queued',
          attempts: 0,
        },
        target: {
          id: WEBHOOK,
          url: `http://hooks.example.test:${r.port}/sign`,
          sealed: sealSecret('whsec_never_opened'),
          previous: null,
        },
      });

      const res = await runSignHookDelivery(
        { runtime, broker: vault, egress: localEgress },
        { orgId: ORG, id: DELIVERY },
        { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT },
      );
      expect(res).toBe('dropped');
      expect(queried).not.toContain('sign.hook.target');
      expect(executed).toEqual([{ name: 'sign.hook.record', input: { id: DELIVERY, outcome: 'dropped' } }]);
    }

    const offStub = stubRuntime({ appOn: false, delivery: null, target: null });
    const offRes = await runSignHookDelivery(
      { runtime: offStub.runtime, broker: vault, egress: localEgress },
      { orgId: ORG, id: DELIVERY },
      { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT },
    );
    expect(offRes).toBe('dropped');
    expect(offStub.queried).toEqual([]);
    expect(r.seen).toHaveLength(0);
  });

  it('records retry and throws while retries remain, then records failed on the final attempt', async () => {
    const r = await startReceiver((_req, res) => res.writeHead(503).end('unavailable'));
    const secret = `whsec_${randomUUID()}`;
    const baseDelivery: SignHookDeliveryRow = {
      id: DELIVERY,
      webhookId: WEBHOOK,
      envelopeId: ENVELOPE,
      envelopeSourceKind: 'standalone',
      eventType: 'sign.envelope.completed',
      payload: COMPLETED_PAYLOAD,
      status: 'queued',
      attempts: 0,
    };
    const baseTarget: SignHookTargetRow = {
      id: WEBHOOK,
      url: `http://hooks.example.test:${r.port}/sign`,
      sealed: sealSecret(secret),
      previous: null,
    };

    const firstTry = stubRuntime({ delivery: baseDelivery, target: baseTarget });
    await expect(
      runSignHookDelivery(
        { runtime: firstTry.runtime, broker: vault, egress: localEgress },
        { orgId: ORG, id: DELIVERY },
        { retryCount: 0, retryLimit: WAKE_RETRY_LIMIT },
      ),
    ).rejects.toThrow(/not delivered/);
    expect(firstTry.executed).toEqual([
      { name: 'sign.hook.record', input: { id: DELIVERY, outcome: 'retry', code: 503 } },
    ]);

    const finalTry = stubRuntime({ delivery: baseDelivery, target: baseTarget });
    const finalOutcome = await runSignHookDelivery(
      { runtime: finalTry.runtime, broker: vault, egress: localEgress },
      { orgId: ORG, id: DELIVERY },
      { retryCount: WAKE_RETRY_LIMIT, retryLimit: WAKE_RETRY_LIMIT },
    );
    expect(finalOutcome).toBe('failed');
    expect(finalTry.executed).toEqual([
      { name: 'sign.hook.record', input: { id: DELIVERY, outcome: 'failed', code: 503 } },
    ]);
  });
});
