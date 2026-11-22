// SPDX-License-Identifier: AGPL-3.0-only
// Vietnam CA provider connection management, #62 legal gate, and reconcile_only PAdES signing request commands/queries (#3554).
// Credentials are sealed at the HTTP RPC edge with CredentialBroker and never read or returned here; only the worker opens
// stored ciphertext via crove_sign.ca_connection_secret_get.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_CA_CONNECTION_STATUSES,
  SIGN_CA_PROVIDERS,
  SIGN_CA_SUBFILTERS,
  SIGN_CA_TEST_STATES,
  type MemberRole,
  type SignCaConnectionStatus,
  type SignCaProvider,
  type SignCaRequestStatus,
  type SignCaSubFilter,
  type SignCaTestState,
} from '@ludy/db';
import { kernelManifest } from '@ludy/kernel';
import {
  tableWrite,
  zId,
  type SignCaConnectionRecord,
  type SignCaSettingsResult,
  type SignCaSigningRequestRecord,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { assertCanAccessEnvelopeRow } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import { assertCanAccessMeetingMinutesEnvelopeRow } from './meeting-visibility.ts';
import { SIGNING_EVENT_WRITE } from './shared.ts';

const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const MAX_CA_POLL_ATTEMPTS = 24;
const CA_POLL_BACKOFF_SECONDS = [15, 30, 60, 120, 300] as const;
const IN_FLIGHT_GUARD_MS = 30_000;

let signLiveCaEnabled = false;
let signCaBrokerAvailable = false;

export function setSignLiveCaEnabled(enabled: boolean): void {
  signLiveCaEnabled = enabled;
}

export function isSignLiveCaEnabled(): boolean {
  return signLiveCaEnabled;
}

export function setSignCaBrokerAvailable(available: boolean): void {
  signCaBrokerAvailable = available;
}

export function isSignCaBrokerAvailable(): boolean {
  return signCaBrokerAvailable;
}

export function assertSignCaProviderAllowed(provider: SignCaProvider): void {
  if (provider !== 'sandbox' && !signLiveCaEnabled) {
    throw new DomainError(
      'SIGN_LIVE_CA_GATED',
      422,
      'Live public CA providers require legal sign-off (#62) before activation',
    );
  }
}

function assertUser(ctx: QueryContext): void {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this query');
  }
}

function assertHumanManager(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only human workspace owners and admins can manage CA settings');
  }
  return ctx.actor.userId;
}

function assertSystem(ctx: CommandContext | QueryContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only system workers can run this action');
  }
}

function actorLabelOf(ctx: CommandContext): string {
  if (ctx.actor.type === 'user') return `user:${ctx.actor.userId}`;
  if (ctx.actor.type === 'system') return `system:${ctx.actor.component}`;
  return `actor:${ctx.actor.type}`;
}

const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

interface RawCaConnectionJson {
  id: string;
  provider: SignCaProvider;
  label: string;
  certRef: string;
  status: SignCaConnectionStatus;
  lastTestState: SignCaTestState | null;
  lastTestedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeConnectionRecord(raw: RawCaConnectionJson): SignCaConnectionRecord {
  return {
    id: raw.id,
    provider: raw.provider,
    label: raw.label,
    certRef: raw.certRef,
    status: raw.status,
    lastTestState: raw.lastTestState ?? null,
    lastTestedAt: isoOrNull(raw.lastTestedAt),
    createdBy: raw.createdBy ?? null,
    createdAt: new Date(raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updatedAt).toISOString(),
  };
}

interface RequestRowShape {
  id: string;
  envelope_id: string;
  signer_id: string | null;
  ca_connection_id: string;
  provider: SignCaProvider;
  digest_sha256: string;
  cert_ref: string;
  external_tx_id: string | null;
  status: SignCaRequestStatus;
  retry_safety: 'reconcile_only';
  challenge_code: string | null;
  error_code: string | null;
  sub_filter: SignCaSubFilter | null;
  pades_file_id: string | null;
  pades_sha256: string | null;
  poll_attempts: number;
  next_poll_at: Date | string | null;
  signed_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRequestRecord(row: RequestRowShape): SignCaSigningRequestRecord {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    signerId: row.signer_id,
    caConnectionId: row.ca_connection_id,
    provider: row.provider,
    digestSha256: row.digest_sha256,
    certRef: row.cert_ref,
    externalTxId: row.external_tx_id,
    status: row.status,
    retrySafety: 'reconcile_only',
    challengeCode: row.challenge_code,
    errorCode: row.error_code,
    subFilter: row.sub_filter,
    padesFileId: row.pades_file_id,
    padesSha256: row.pades_sha256,
    pollAttempts: row.poll_attempts,
    nextPollAt: isoOrNull(row.next_poll_at),
    signedAt: isoOrNull(row.signed_at),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function nextPollDate(now: Date, attempts: number): Date {
  const idx = Math.min(Math.max(attempts - 1, 0), CA_POLL_BACKOFF_SECONDS.length - 1);
  const delaySec = CA_POLL_BACKOFF_SECONDS[idx] ?? 300;
  return new Date(now.getTime() + delaySec * 1000);
}

const initiateCallKey = (idempotencyKey: string) => `sign:ca:initiate:${idempotencyKey}`;
const pollCallKey = (idempotencyKey: string, attempt: number) => `sign:ca:poll:${idempotencyKey}:${attempt}`;

async function readOrgConnections(trx: QueryContext['trx']): Promise<SignCaConnectionRecord[]> {
  const { rows } = await sql<{ items: RawCaConnectionJson[] | null }>`
    SELECT crove_sign.ca_connection_list() AS items
  `.execute(trx);
  const rawItems = Array.isArray(rows[0]?.items) ? rows[0].items : [];
  return rawItems.map(normalizeConnectionRecord);
}

export const caSettingsGet = defineQuery({
  name: 'sign.ca.settings',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<SignCaSettingsResult> => {
    assertUser(ctx);
    const connections = await readOrgConnections(ctx.trx);
    return {
      liveCaEnabled: signLiveCaEnabled,
      brokerAvailable: signCaBrokerAvailable,
      connections,
    };
  },
});

export const caConnectionLookupId = defineQuery({
  name: 'sign.ca.connection.lookup_id',
  input: z.strictObject({ provider: z.enum(SIGN_CA_PROVIDERS) }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string | null }> => {
    assertUser(ctx);
    const { rows } = await sql<{ id: string | null }>`
      SELECT crove_sign.ca_connection_lookup_id(${input.provider}::text) AS id
    `.execute(ctx.trx);
    return { id: rows[0]?.id ?? null };
  },
});

export const caRequestsByEnvelope = defineQuery({
  name: 'sign.ca.requests.by_envelope',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input): Promise<{ items: SignCaSigningRequestRecord[] }> => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select(['id', 'source_kind', 'source_id', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);
    const rows = await ctx.trx
      .selectFrom('crove_sign.ca_signing_request')
      .select([
        'id',
        'envelope_id',
        'signer_id',
        'ca_connection_id',
        'provider',
        'digest_sha256',
        'cert_ref',
        'external_tx_id',
        'status',
        'retry_safety',
        'challenge_code',
        'error_code',
        'sub_filter',
        'pades_file_id',
        'pades_sha256',
        'poll_attempts',
        'next_poll_at',
        'signed_at',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    return { items: rows.map(mapRequestRecord) };
  },
});

const CA_CONNECTION_SAVE_WRITES = [
  tableWrite(signManifest.tables, 'crove_sign', 'ca_connection', [
    'org_id',
    'id',
    'provider',
    'label',
    'cert_ref',
    'status',
    'key_id',
    'secret_envelope',
    'last_test_state',
    'last_tested_at',
    'created_by',
    'created_at',
    'updated_at',
  ]),
];

export const caConnectionSave = defineCommand({
  name: 'sign.ca.connection.save',
  input: z.strictObject({
    id: zId.optional(),
    provider: z.enum(SIGN_CA_PROVIDERS),
    label: z.string().trim().min(1).max(200),
    certRef: z.string().trim().min(1).max(300).default('sandbox-default'),
    status: z.enum(SIGN_CA_CONNECTION_STATUSES).default('active'),
    keyId: z.string().min(1).max(128),
    secretEnvelope: z.string().min(1).max(16384),
  }),
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: CA_CONNECTION_SAVE_WRITES,
  handler: async (ctx, input): Promise<SignCaConnectionRecord> => {
    assertHumanManager(ctx);
    assertSignCaProviderAllowed(input.provider);

    const { rows } = await sql<{ row: RawCaConnectionJson }>`
      SELECT crove_sign.ca_connection_upsert(
        ${input.id ?? null}::uuid,
        ${input.provider}::text,
        ${input.label}::text,
        ${input.certRef}::text,
        ${input.status}::text,
        ${input.keyId}::text,
        ${input.secretEnvelope}::text
      ) AS row
    `.execute(ctx.trx);

    const record = normalizeConnectionRecord(rows[0]!.row);
    ctx.audit({
      connectionId: record.id,
      provider: record.provider,
      status: record.status,
    });
    return record;
  },
});

export const caConnectionDisable = defineCommand({
  name: 'sign.ca.connection.disable',
  input: z.strictObject({ connectionId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'sign.ca_connection', id: input.connectionId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_connection', [
      'status',
      'key_id',
      'secret_envelope',
      'last_test_state',
      'last_tested_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignCaConnectionRecord> => {
    assertHumanManager(ctx);
    try {
      const { rows } = await sql<{ row: RawCaConnectionJson }>`
        SELECT crove_sign.ca_connection_disable(${input.connectionId}::uuid) AS row
      `.execute(ctx.trx);
      const record = normalizeConnectionRecord(rows[0]!.row);
      ctx.audit({
        connectionId: record.id,
        provider: record.provider,
        status: 'disabled',
      });
      return record;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P0002') {
        throw new DomainError('SIGN_CA_CONNECTION_NOT_FOUND', 404, 'CA connection not found');
      }
      throw error;
    }
  },
});

export const caConnectionRecordTest = defineCommand({
  name: 'sign.ca.connection.record_test',
  input: z.strictObject({
    connectionId: zId,
    state: z.enum(SIGN_CA_TEST_STATES),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'sign.ca_connection', id: input.connectionId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_connection', [
      'last_test_state',
      'last_tested_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignCaConnectionRecord> => {
    assertHumanManager(ctx);
    const connections = await readOrgConnections(ctx.trx);
    const existing = connections.find((c) => c.id === input.connectionId);
    if (!existing) {
      throw new DomainError('SIGN_CA_CONNECTION_NOT_FOUND', 404, 'CA connection not found');
    }
    assertSignCaProviderAllowed(existing.provider);

    const { rows } = await sql<{ row: RawCaConnectionJson }>`
      SELECT crove_sign.ca_connection_record_test(
        ${input.connectionId}::uuid,
        ${input.state}::text
      ) AS row
    `.execute(ctx.trx);
    const record = normalizeConnectionRecord(rows[0]!.row);
    ctx.audit({
      connectionId: record.id,
      provider: record.provider,
      lastTestState: record.lastTestState,
    });
    return record;
  },
});

export const caRequestInitiate = defineCommand({
  name: 'sign.ca.request.initiate',
  input: z.strictObject({
    envelopeId: zId,
    caConnectionId: zId.optional(),
    signerId: zId.optional(),
  }),
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'sign.envelope', id: input.envelopeId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_signing_request', [
      'org_id',
      'envelope_id',
      'signer_id',
      'ca_connection_id',
      'provider',
      'idempotency_key',
      'digest_sha256',
      'cert_ref',
      'status',
      'retry_safety',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input): Promise<SignCaSigningRequestRecord> => {
    const userId = assertHumanManager(ctx);
    const env = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'source_kind',
        'source_id',
        'created_by',
        'seal_status',
        'sealed_file_id',
        'sealed_sha256',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .forUpdate()
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);
    if (env.status !== 'completed' || env.seal_status !== 'sealed' || !env.sealed_file_id || !env.sealed_sha256) {
      throw new DomainError(
        'SIGN_ENVELOPE_NOT_SEALED',
        409,
        'Envelope must be completed and SHA-256 sealed before applying a CA PAdES signature',
      );
    }

    if (input.signerId) {
      const signer = await ctx.trx
        .selectFrom('crove_sign.signer')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .where('id', '=', input.signerId)
        .executeTakeFirst();
      if (!signer) {
        throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
      }
    }

    const connections = await readOrgConnections(ctx.trx);
    const activeConnections = connections.filter((c) => c.status === 'active');
    const chosen = input.caConnectionId
      ? connections.find((c) => c.id === input.caConnectionId)
      : (activeConnections.find((c) => c.provider !== 'sandbox') ?? activeConnections[0]);

    if (!chosen || chosen.status !== 'active') {
      throw new DomainError(
        'SIGN_CA_NOT_CONFIGURED',
        422,
        'Configure and enable an active CA connection in CA Settings first',
      );
    }

    assertSignCaProviderAllowed(chosen.provider);

    const existing = await ctx.trx
      .selectFrom('crove_sign.ca_signing_request')
      .select([
        'id',
        'envelope_id',
        'signer_id',
        'ca_connection_id',
        'provider',
        'digest_sha256',
        'cert_ref',
        'external_tx_id',
        'status',
        'retry_safety',
        'challenge_code',
        'error_code',
        'sub_filter',
        'pades_file_id',
        'pades_sha256',
        'poll_attempts',
        'next_poll_at',
        'signed_at',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('ca_connection_id', '=', chosen.id)
      .where('status', 'in', ['pending', 'signed'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (existing) {
      if (existing.status === 'pending' || existing.pades_file_id === null) {
        await ctx.emit('sign.ca.sign_queued', { requestId: existing.id, envelopeId: env.id });
      }
      ctx.audit({
        requestId: existing.id,
        envelopeId: env.id,
        provider: existing.provider,
        alreadyExists: true,
      });
      return mapRequestRecord(existing);
    }

    const inserted = await ctx.trx
      .insertInto('crove_sign.ca_signing_request')
      .values({
        org_id: ctx.orgId,
        envelope_id: env.id,
        signer_id: input.signerId ?? null,
        ca_connection_id: chosen.id,
        provider: chosen.provider,
        idempotency_key: randomUUID(),
        digest_sha256: env.sealed_sha256,
        cert_ref: chosen.certRef,
        status: 'pending',
        retry_safety: 'reconcile_only',
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning([
        'id',
        'envelope_id',
        'signer_id',
        'ca_connection_id',
        'provider',
        'digest_sha256',
        'cert_ref',
        'external_tx_id',
        'status',
        'retry_safety',
        'challenge_code',
        'error_code',
        'sub_filter',
        'pades_file_id',
        'pades_sha256',
        'poll_attempts',
        'next_poll_at',
        'signed_at',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: env.id,
      signerId: input.signerId ?? null,
      eventType: 'ca_requested',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOf(ctx),
      documentSha256: env.sealed_sha256,
      payloadJson: {
        requestId: inserted.id,
        provider: chosen.provider,
        certRef: chosen.certRef,
      },
      occurredAt: ctx.now,
    });

    await ctx.emit('sign.ca.sign_queued', { requestId: inserted.id, envelopeId: env.id });
    ctx.audit({
      requestId: inserted.id,
      envelopeId: env.id,
      provider: chosen.provider,
    });
    return mapRequestRecord(inserted);
  },
});

export type SignCaJobBeginResult =
  | { action: 'none'; reason: string }
  | {
      action: 'prepare' | 'initiate' | 'ask' | 'poll' | 'embed';
      requestId: string;
      requestCreatedAtIso: string;
      envelopeId: string;
      envelopeTitle: string;
      caConnectionId: string;
      provider: SignCaProvider;
      idempotencyKey: string;
      callKey: string;
      digestSha256: string;
      certRef: string;
      externalTxId: string | null;
      pollAttempts: number;
      sealedFileId: string;
      sealedStorageKey: string;
      sealedGeneration: string;
      sealedSha256: string;
    };

export const caRequestJobBegin = defineCommand({
  name: 'sign.ca.request.job_begin',
  input: z.strictObject({
    requestId: zId,
    prepareOnly: z.boolean().optional(),
    byteRangeDigestSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'sign.ca_signing_request', id: input.requestId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_signing_request', ['digest_sha256', 'updated_at']),
    tableWrite(kernelManifest.tables, 'ludy_kernel', 'external_call', [
      'org_id',
      'key',
      'module',
      'target',
      'step',
      'retry_safety',
      'request_hash',
      'state',
      'calls',
      'started_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignCaJobBeginResult> => {
    assertSystem(ctx);
    const req = await ctx.trx
      .selectFrom('crove_sign.ca_signing_request')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) {
      ctx.audit({ requestId: input.requestId, action: 'none', skipReason: 'not_found' });
      return { action: 'none', reason: 'not_found' };
    }

    if (req.status === 'signed' && req.pades_file_id !== null) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: 'already_completed' });
      return { action: 'none', reason: 'already_completed' };
    }
    if (req.status !== 'pending' && !(req.status === 'signed' && req.pades_file_id === null)) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: `terminal_${req.status}` });
      return { action: 'none', reason: `terminal_${req.status}` };
    }
    if (req.provider !== 'sandbox' && !signLiveCaEnabled) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: 'live_ca_gated' });
      return { action: 'none', reason: 'live_ca_gated' };
    }
    if (req.next_poll_at && req.next_poll_at.getTime() > ctx.now.getTime()) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: 'not_due_yet' });
      return { action: 'none', reason: 'not_due_yet' };
    }

    const env = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'seal_status',
        'sealed_file_id',
        'sealed_storage_key',
        'sealed_generation',
        'sealed_sha256',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', req.envelope_id)
      .executeTakeFirst();

    if (
      !env ||
      env.status !== 'completed' ||
      env.seal_status !== 'sealed' ||
      !env.sealed_file_id ||
      !env.sealed_storage_key ||
      !env.sealed_generation ||
      !env.sealed_sha256
    ) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: 'envelope_not_sealed' });
      return { action: 'none', reason: 'envelope_not_sealed' };
    }

    const base = {
      requestId: req.id,
      requestCreatedAtIso: new Date(req.created_at).toISOString(),
      envelopeId: env.id,
      envelopeTitle: env.title,
      caConnectionId: req.ca_connection_id,
      provider: req.provider,
      idempotencyKey: req.idempotency_key,
      digestSha256: req.digest_sha256,
      certRef: req.cert_ref,
      externalTxId: req.external_tx_id,
      pollAttempts: req.poll_attempts,
      sealedFileId: env.sealed_file_id,
      sealedStorageKey: env.sealed_storage_key,
      sealedGeneration: env.sealed_generation,
      sealedSha256: env.sealed_sha256,
    };

    if (req.external_tx_id !== null && req.pades_file_id === null && (req.signed_at !== null || req.status === 'signed')) {
      const callKey = `sign:ca:cms:${req.idempotency_key}`;
      ctx.audit({ requestId: req.id, action: 'embed' });
      return { ...base, action: 'embed', callKey };
    }

    if (req.external_tx_id !== null) {
      const callKey = pollCallKey(req.idempotency_key, req.poll_attempts + 1);
      await ctx.trx
        .insertInto('ludy_kernel.external_call')
        .values({
          org_id: ctx.orgId,
          key: callKey,
          module: 'sign',
          target: req.provider,
          step: 'poll_status',
          retry_safety: 'safe',
          request_hash: `sha256:${req.digest_sha256}`,
          state: 'started',
          started_at: ctx.now,
          updated_at: ctx.now,
        })
        .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
        .execute();
      ctx.audit({ requestId: req.id, action: 'poll', pollAttempts: req.poll_attempts });
      return { ...base, action: 'poll', callKey };
    }

    // No external_tx_id stored yet: check external_call ledger before ever calling initiateSign (reconcile_only).
    const initKey = initiateCallKey(req.idempotency_key);
    const existingCall = await ctx.trx
      .selectFrom('ludy_kernel.external_call')
      .select(['state', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', initKey)
      .executeTakeFirst();

    if (!existingCall) {
      if (input.prepareOnly) {
        ctx.audit({ requestId: req.id, action: 'prepare' });
        return { ...base, action: 'prepare', callKey: initKey };
      }
      let effectiveDigest = req.digest_sha256;
      if (input.byteRangeDigestSha256 && input.byteRangeDigestSha256 !== req.digest_sha256) {
        effectiveDigest = input.byteRangeDigestSha256;
        await ctx.trx
          .updateTable('crove_sign.ca_signing_request')
          .set({
            digest_sha256: effectiveDigest,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', req.id)
          .execute();
      }
      await ctx.trx
        .insertInto('ludy_kernel.external_call')
        .values({
          org_id: ctx.orgId,
          key: initKey,
          module: 'sign',
          target: req.provider,
          step: 'initiate_sign',
          retry_safety: 'reconcile_only',
          request_hash: `sha256:${effectiveDigest}`,
          state: 'started',
          started_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
      ctx.audit({ requestId: req.id, action: 'initiate' });
      return { ...base, digestSha256: effectiveDigest, action: 'initiate', callKey: initKey };
    }

    if (existingCall.state === 'started' && ctx.now.getTime() - existingCall.updated_at.getTime() < IN_FLIGHT_GUARD_MS) {
      ctx.audit({ requestId: req.id, action: 'none', skipReason: 'in_flight' });
      return { action: 'none', reason: 'in_flight' };
    }

    // Previous initiate_sign left 'started' or 'ambiguous' without external_tx_id: reconcile via pollStatus(idempotencyKey) first!
    ctx.audit({ requestId: req.id, action: 'ask' });
    return { ...base, action: 'ask', callKey: initKey };
  },
});

const zCaJobRecordInput = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: zId,
    callKey: z.string().min(1).max(500),
    outcome: z.literal('pending'),
    externalTxId: z.string().trim().min(1).max(256),
    challengeCode: z.string().max(64).nullable().optional(),
  }),
  z.strictObject({
    requestId: zId,
    callKey: z.string().min(1).max(500),
    outcome: z.literal('signed_session'),
    externalTxId: z.string().trim().min(1).max(256),
    signedAtIso: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  z.strictObject({
    requestId: zId,
    callKey: z.string().min(1).max(500),
    outcome: z.literal('lost_answer'),
    errorCode: z.string().min(1).max(128),
  }),
  z.strictObject({
    requestId: zId,
    callKey: z.string().min(1).max(500),
    outcome: z.literal('transient_retry'),
    errorCode: z.string().min(1).max(128),
  }),
  z.strictObject({
    requestId: zId,
    callKey: z.string().min(1).max(500),
    outcome: z.literal('terminal_failure'),
    status: z.enum(['rejected', 'expired', 'failed']),
    errorCode: z.string().min(1).max(128),
    externalTxId: z.string().trim().min(1).max(256).nullable().optional(),
  }),
]);

export interface SignCaJobRecordResult {
  status: SignCaRequestStatus;
  nextPollAt: string | null;
  pollAttempts: number;
}

export const caRequestJobRecord = defineCommand({
  name: 'sign.ca.request.job_record',
  input: zCaJobRecordInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'sign.ca_signing_request', id: input.requestId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_signing_request', [
      'external_tx_id',
      'status',
      'challenge_code',
      'error_code',
      'poll_attempts',
      'next_poll_at',
      'signed_at',
      'updated_at',
    ]),
    tableWrite(kernelManifest.tables, 'ludy_kernel', 'external_call', [
      'state',
      'external_ref',
      'error_kind',
      'error_code',
      'finished_at',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input): Promise<SignCaJobRecordResult> => {
    assertSystem(ctx);
    const req = await ctx.trx
      .selectFrom('crove_sign.ca_signing_request')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) {
      throw new DomainError('SIGN_CA_REQUEST_NOT_FOUND', 404, 'CA signing request not found');
    }
    if (req.status !== 'pending') {
      ctx.audit({ requestId: req.id, status: req.status, idempotent: true });
      return { status: req.status, nextPollAt: isoOrNull(req.next_poll_at), pollAttempts: req.poll_attempts };
    }

    if (input.outcome === 'pending') {
      const nextAttempts = req.poll_attempts + 1;
      if (nextAttempts >= MAX_CA_POLL_ATTEMPTS) {
        await ctx.trx
          .updateTable('crove_sign.ca_signing_request')
          .set({
            external_tx_id: input.externalTxId,
            status: 'expired',
            error_code: 'POLL_DEADLINE_EXCEEDED',
            poll_attempts: nextAttempts,
            next_poll_at: null,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', req.id)
          .execute();
        await ctx.trx
          .updateTable('ludy_kernel.external_call')
          .set({
            state: 'failed',
            external_ref: input.externalTxId,
            error_kind: 'unknown',
            error_code: 'POLL_DEADLINE_EXCEEDED',
            finished_at: ctx.now,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('key', '=', input.callKey)
          .where('state', 'in', ['started', 'ambiguous'])
          .execute();
        await appendSigningEvent(ctx.trx, {
          orgId: ctx.orgId,
          envelopeId: req.envelope_id,
          signerId: req.signer_id,
          eventType: 'ca_failed',
          actorType: 'system',
          actorLabel: actorLabelOf(ctx),
          documentSha256: req.digest_sha256,
          payloadJson: { requestId: req.id, provider: req.provider, status: 'expired', errorCode: 'POLL_DEADLINE_EXCEEDED' },
          occurredAt: ctx.now,
        });
        ctx.audit({ requestId: req.id, status: 'expired', errorCode: 'POLL_DEADLINE_EXCEEDED' });
        return { status: 'expired', nextPollAt: null, pollAttempts: nextAttempts };
      }

      const nextPoll = nextPollDate(ctx.now, nextAttempts);
      await ctx.trx
        .updateTable('crove_sign.ca_signing_request')
        .set({
          external_tx_id: input.externalTxId,
          challenge_code: input.challengeCode ?? req.challenge_code,
          poll_attempts: nextAttempts,
          next_poll_at: nextPoll,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', req.id)
        .execute();
      await ctx.trx
        .updateTable('ludy_kernel.external_call')
        .set({
          state: 'succeeded',
          external_ref: input.externalTxId,
          finished_at: ctx.now,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', input.callKey)
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
      ctx.audit({ requestId: req.id, status: 'pending', pollAttempts: nextAttempts });
      return { status: 'pending', nextPollAt: nextPoll.toISOString(), pollAttempts: nextAttempts };
    }

    if (input.outcome === 'signed_session') {
      const signedAt = input.signedAtIso ? new Date(input.signedAtIso) : ctx.now;
      const embedRetryDue = new Date(ctx.now.getTime() + 30_000);
      await ctx.trx
        .updateTable('crove_sign.ca_signing_request')
        .set({
          external_tx_id: input.externalTxId,
          status: 'pending',
          error_code: null,
          signed_at: signedAt,
          next_poll_at: embedRetryDue,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', req.id)
        .execute();
      await ctx.trx
        .updateTable('ludy_kernel.external_call')
        .set({
          state: 'succeeded',
          external_ref: input.externalTxId,
          finished_at: ctx.now,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', input.callKey)
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
      ctx.audit({ requestId: req.id, status: 'pending', stage: 'session_confirmed' });
      return { status: 'pending', nextPollAt: embedRetryDue.toISOString(), pollAttempts: req.poll_attempts };
    }

    if (input.outcome === 'lost_answer' || input.outcome === 'transient_retry') {
      const nextAttempts = req.poll_attempts + 1;
      if (input.outcome === 'transient_retry' && nextAttempts >= MAX_CA_POLL_ATTEMPTS) {
        const failCode = input.errorCode || 'CA_MAX_RETRIES_EXCEEDED';
        await ctx.trx
          .updateTable('crove_sign.ca_signing_request')
          .set({
            status: 'failed',
            error_code: failCode,
            poll_attempts: nextAttempts,
            next_poll_at: null,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', req.id)
          .execute();
        await ctx.trx
          .updateTable('ludy_kernel.external_call')
          .set({
            state: 'failed',
            error_kind: 'transient',
            error_code: failCode,
            finished_at: ctx.now,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('key', '=', input.callKey)
          .where('state', 'in', ['started', 'ambiguous'])
          .execute();
        await appendSigningEvent(ctx.trx, {
          orgId: ctx.orgId,
          envelopeId: req.envelope_id,
          signerId: req.signer_id,
          eventType: 'ca_failed',
          actorType: 'system',
          actorLabel: actorLabelOf(ctx),
          documentSha256: req.digest_sha256,
          payloadJson: {
            requestId: req.id,
            provider: req.provider,
            status: 'failed',
            errorCode: failCode,
          },
          occurredAt: ctx.now,
        });
        ctx.audit({ requestId: req.id, status: 'failed', errorCode: failCode });
        return { status: 'failed', nextPollAt: null, pollAttempts: nextAttempts };
      }

      const nextPoll = nextPollDate(ctx.now, Math.min(nextAttempts, MAX_CA_POLL_ATTEMPTS));
      await ctx.trx
        .updateTable('crove_sign.ca_signing_request')
        .set({
          error_code: input.errorCode,
          poll_attempts: nextAttempts,
          next_poll_at: nextPoll,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', req.id)
        .execute();
      await ctx.trx
        .updateTable('ludy_kernel.external_call')
        .set({
          state: 'ambiguous',
          error_kind: 'transient',
          error_code: input.errorCode,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', input.callKey)
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
      ctx.audit({ requestId: req.id, status: 'pending', retryOutcome: input.outcome, errorCode: input.errorCode });
      return { status: 'pending', nextPollAt: nextPoll.toISOString(), pollAttempts: nextAttempts };
    }

    // terminal_failure
    await ctx.trx
      .updateTable('crove_sign.ca_signing_request')
      .set({
        ...(input.externalTxId ? { external_tx_id: input.externalTxId } : {}),
        status: input.status,
        error_code: input.errorCode,
        next_poll_at: null,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', req.id)
      .execute();
    await ctx.trx
      .updateTable('ludy_kernel.external_call')
      .set({
        state: 'failed',
        ...(input.externalTxId ? { external_ref: input.externalTxId } : {}),
        error_kind: input.status === 'rejected' ? 'permission' : 'bad_request',
        error_code: input.errorCode,
        finished_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', 'in', ['started', 'ambiguous'])
      .execute();
    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: req.envelope_id,
      signerId: req.signer_id,
      eventType: 'ca_failed',
      actorType: 'system',
      actorLabel: actorLabelOf(ctx),
      documentSha256: req.digest_sha256,
      payloadJson: {
        requestId: req.id,
        provider: req.provider,
        status: input.status,
        errorCode: input.errorCode,
      },
      occurredAt: ctx.now,
    });
    ctx.audit({ requestId: req.id, status: input.status, errorCode: input.errorCode });
    return { status: input.status, nextPollAt: null, pollAttempts: req.poll_attempts };
  },
});

export const caRequestJobComplete = defineCommand({
  name: 'sign.ca.request.job_complete',
  input: z.strictObject({
    requestId: zId,
    externalTxId: z.string().trim().min(1).max(256),
    subFilter: z.enum(SIGN_CA_SUBFILTERS),
    padesFileId: zId,
    padesStorageKey: z.string().min(1).max(512),
    padesGeneration: z.string().min(1).max(1028),
    padesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    signedAtIso: z.iso.datetime({ offset: true }).optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'sign.ca_signing_request', id: input.requestId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'ca_signing_request', [
      'external_tx_id',
      'status',
      'error_code',
      'sub_filter',
      'pades_file_id',
      'pades_storage_key',
      'pades_generation',
      'pades_sha256',
      'next_poll_at',
      'signed_at',
      'updated_at',
    ]),
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input): Promise<SignCaSigningRequestRecord> => {
    assertSystem(ctx);
    const req = await ctx.trx
      .selectFrom('crove_sign.ca_signing_request')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) {
      throw new DomainError('SIGN_CA_REQUEST_NOT_FOUND', 404, 'CA signing request not found');
    }
    if (req.status === 'signed' && req.pades_file_id !== null) {
      ctx.audit({ requestId: req.id, padesFileId: req.pades_file_id, idempotent: true });
      return mapRequestRecord(req);
    }

    const padesFile = await ctx.trx
      .selectFrom('ludy_kernel.file')
      .select(['id', 'content_type', 'source', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.padesFileId)
      .executeTakeFirst();
    if (
      !padesFile ||
      padesFile.content_type !== 'application/pdf' ||
      padesFile.source !== 'sign_sealed' ||
      padesFile.storage_key !== input.padesStorageKey ||
      padesFile.generation !== input.padesGeneration ||
      padesFile.sha256 !== input.padesSha256
    ) {
      throw new DomainError(
        'SIGN_CA_INVALID_PADES_FILE',
        422,
        'PAdES file record does not match verified sealed PDF metadata',
      );
    }

    const signedAt = input.signedAtIso ? new Date(input.signedAtIso) : (req.signed_at ?? ctx.now);
    const updated = await ctx.trx
      .updateTable('crove_sign.ca_signing_request')
      .set({
        external_tx_id: input.externalTxId,
        status: 'signed',
        error_code: null,
        sub_filter: input.subFilter,
        pades_file_id: input.padesFileId,
        pades_storage_key: input.padesStorageKey,
        pades_generation: input.padesGeneration,
        pades_sha256: input.padesSha256,
        next_poll_at: null,
        signed_at: signedAt,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', req.id)
      .returning([
        'id',
        'envelope_id',
        'signer_id',
        'ca_connection_id',
        'provider',
        'digest_sha256',
        'cert_ref',
        'external_tx_id',
        'status',
        'retry_safety',
        'challenge_code',
        'error_code',
        'sub_filter',
        'pades_file_id',
        'pades_sha256',
        'poll_attempts',
        'next_poll_at',
        'signed_at',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: req.envelope_id,
      signerId: req.signer_id,
      eventType: 'ca_completed',
      actorType: 'system',
      actorLabel: actorLabelOf(ctx),
      documentSha256: input.padesSha256,
      payloadJson: {
        requestId: req.id,
        provider: req.provider,
        externalTxId: input.externalTxId,
        subFilter: input.subFilter,
        padesFileId: input.padesFileId,
        baseSealedSha256: req.digest_sha256,
      },
      occurredAt: ctx.now,
    });

    ctx.audit({
      requestId: req.id,
      envelopeId: req.envelope_id,
      provider: req.provider,
      padesFileId: input.padesFileId,
    });
    return mapRequestRecord(updated);
  },
});

export interface SealedCaConnectionSecret {
  id: string;
  provider: SignCaProvider;
  certRef: string;
  keyId: string;
  secretEnvelope: string;
}

export const caConnectionSecretGet = defineQuery({
  name: 'sign.ca.connection.secret',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SealedCaConnectionSecret> => {
    assertSystem(ctx);
    try {
      const { rows } = await sql<{
        id: string;
        provider: SignCaProvider;
        cert_ref: string;
        key_id: string;
        secret_envelope: string;
      }>`
        SELECT id, provider, cert_ref, key_id, secret_envelope
        FROM crove_sign.ca_connection_secret_get(${input.connectionId}::uuid)
      `.execute(ctx.trx);
      const row = rows[0];
      if (!row) {
        throw new DomainError('SIGN_CA_CONNECTION_NOT_FOUND', 404, 'CA connection not found');
      }
      return {
        id: row.id,
        provider: row.provider,
        certRef: row.cert_ref,
        keyId: row.key_id,
        secretEnvelope: row.secret_envelope,
      };
    } catch (error: unknown) {
      const code = (error as { code?: string; message?: string } | null)?.code;
      const msg = (error as { message?: string } | null)?.message ?? '';
      if (code === 'P0002') {
        throw new DomainError('SIGN_CA_CONNECTION_NOT_FOUND', 404, 'CA connection not found');
      }
      if (msg.includes('CA_CONNECTION_DISABLED')) {
        throw new DomainError('SIGN_CA_CONNECTION_DISABLED', 409, 'CA connection is disabled');
      }
      if (msg.includes('CA_CONNECTION_OWNER_LEFT')) {
        throw new DomainError('SIGN_CA_CONNECTION_OWNER_LEFT', 403, 'CA connection owner is no longer an active admin');
      }
      throw error;
    }
  },
});

export const signCaQueries = [caSettingsGet, caConnectionLookupId, caRequestsByEnvelope, caConnectionSecretGet];

export const signCaCommands = [
  caConnectionSave,
  caConnectionDisable,
  caConnectionRecordTest,
  caRequestInitiate,
  caRequestJobBegin,
  caRequestJobRecord,
  caRequestJobComplete,
];
