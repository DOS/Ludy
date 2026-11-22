// SPDX-License-Identifier: AGPL-3.0-only
// Outbound HMAC webhook secret sealing, minute sweep, and delivery worker for eSign Slice 5b (#4440).
//
// - Secret generation & sealing: makeSignWebhookSecret runs at the HTTP RPC edge before Runtime.execute(), minting a
//   32-byte random `whsec_<base64url>` secret and a public `whk_<8 hex>` hint, and sealing the secret through
//   CredentialBroker bound to (orgId, 'sign-webhook', webhookId). Plaintext secrets never enter Runtime.execute(),
//   the database, audit_event, outbox_event, or idempotency_key.
// - Two-stage delivery: runSignHookSweep (egress: 'none') reads queued/stale/expired rows via crove_sign.webhook_open,
//   skips orgs where eSign is switched off, and hands singleton jobs to sign-hook-deliver; runSignHookDelivery
//   (egress: ['tenant_url']) opens the active and grace-window secrets via ludy_worker-only definers, re-validates
//   the canonical payload through signWebhookBody, and calls postSigned from mcp-wake.ts.
// - Confidentiality boundary: envelopes with source_kind in ('hr_contract', 'meeting_minutes') are excluded at SQL
//   enqueue time and re-checked here as defense in depth before any secret is opened or any network call is made.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import {
  signWebhookBody,
  type SignHookDeliveryRow,
  type SignHookTargetRow,
  type SignWebhookSealedCredential,
} from '@ludy/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { postSigned, type WakeDeps, type WakeJob, type WakeResult } from './mcp-wake.ts';

export const SIGN_WEBHOOK_PROVIDER = 'sign-webhook';
export const SIGN_HOOK_SWEEP_CRON = '* * * * *';
export const SIGN_HOOK_SWEEP_EXPIRE_SECONDS = 120;

const PER_PASS = 200;
const ACTOR = { type: 'system' as const, component: 'sign.hook' };
const EXCLUDED_SOURCE_KINDS = new Set(['hr_contract', 'meeting_minutes']);

const codeOf = (error: unknown): string =>
  error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error';

export type SignHookJob = WakeJob;
export type SignHookDeps = WakeDeps & { runtime: Runtime };

export interface MadeSignWebhookSecret {
  secret: string;
  credential: SignWebhookSealedCredential;
}

export function makeSignWebhookSecret(
  broker: CredentialBroker,
  orgId: string,
  webhookId: string,
): MadeSignWebhookSecret {
  if (broker.id === 'none') {
    throw new DomainError(
      'BROKER_NOT_CONFIGURED',
      503,
      'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)',
    );
  }
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const sealed = broker.seal(secret, {
    orgId,
    provider: SIGN_WEBHOOK_PROVIDER,
    externalAccountId: webhookId,
  });
  return {
    secret,
    credential: {
      keyId: sealed.keyId,
      secretEnvelope: sealed.envelope.toString('base64'),
      secretHint: `whk_${randomBytes(4).toString('hex')}`,
    },
  };
}

export interface SignHookSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  send: (job: SignHookJob) => Promise<unknown>;
}

export async function runSignHookSweep(
  deps: SignHookSweepDeps,
): Promise<{ handedOver: number; expired: number; failures: number }> {
  const done = { handedOver: 0, expired: 0, failures: 0 };
  const open = await sql<{ org_id: string; id: string; kind: 'send' | 'expire' }>`
    SELECT org_id, id, kind FROM crove_sign.webhook_open(${PER_PASS}::int)
  `.execute(deps.workerDb);
  for (const row of open.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    try {
      if (row.kind === 'expire') {
        await deps.runtime.execute('sign.hook.record', { id: row.id, outcome: 'expired' }, ctx);
        done.expired += 1;
      } else {
        if (!(await deps.runtime.appOn(row.org_id, 'sign', { fresh: true }))) continue;
        await deps.send({ orgId: row.org_id, id: row.id });
        await deps.runtime.execute('sign.hook.queued', { id: row.id }, ctx);
        done.handedOver += 1;
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[sign-hook-sweep] delivery ${row.id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}

export async function runSignHookDelivery(
  deps: SignHookDeps,
  job: SignHookJob,
  attempt: { retryCount: number; retryLimit: number },
): Promise<WakeResult> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  // If eSign was switched off after the sweep queued this job, drop without running non-runsWhenOff queries.
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    await deps.runtime.execute('sign.hook.record', { id: job.id, outcome: 'dropped' }, ctx);
    return 'dropped';
  }

  const delivery = await deps.runtime.query<SignHookDeliveryRow | null>(
    'sign.hook.delivery',
    { id: job.id },
    ctx,
  );
  if (!delivery || delivery.status !== 'queued') return 'skipped';

  if (delivery.envelopeSourceKind !== null && EXCLUDED_SOURCE_KINDS.has(delivery.envelopeSourceKind)) {
    await deps.runtime.execute('sign.hook.record', { id: job.id, outcome: 'dropped' }, ctx);
    return 'dropped';
  }

  const target = await deps.runtime.query<SignHookTargetRow | null>(
    'sign.hook.target',
    { webhookId: delivery.webhookId },
    ctx,
  );
  if (!target) {
    await deps.runtime.execute('sign.hook.record', { id: job.id, outcome: 'dropped' }, ctx);
    return 'dropped';
  }

  let status: number | null = null;
  try {
    const binding = {
      orgId: job.orgId,
      provider: SIGN_WEBHOOK_PROVIDER,
      externalAccountId: target.id,
    };
    const open = (sealed: { keyId: string; envelope: string }) =>
      deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
    const secrets = [open(target.sealed), ...(target.previous ? [open(target.previous)] : [])];
    const message = signWebhookBody(delivery.payload);
    status = await postSigned(deps, { url: target.url, eventId: job.id, message, secrets });
  } catch (error) {
    console.warn(`[sign-hook] ${job.id.slice(0, 8)} not delivered`, codeOf(error));
  }

  if (status !== null && status >= 200 && status < 300) {
    await deps.runtime.execute('sign.hook.record', { id: job.id, outcome: 'sent', code: status }, ctx);
    return 'sent';
  }

  const last = attempt.retryCount >= attempt.retryLimit;
  await deps.runtime.execute(
    'sign.hook.record',
    {
      id: job.id,
      outcome: last ? 'failed' : 'retry',
      ...(status !== null && status >= 100 && status <= 599 ? { code: status } : {}),
    },
    ctx,
  );
  if (last) return 'failed';
  throw new Error(`sign webhook ${job.id.slice(0, 8)} not delivered (attempt ${attempt.retryCount + 1})`);
}
