// SPDX-License-Identifier: AGPL-3.0-only
// Hash-chained signing audit ledger for crove_sign.signing_event (#3323, ADR-0013). Every mutation on an envelope or
// signer appends an event whose SHA-256 hash commits deterministically to the canonical event record and prev_event_hash.
import { createHash } from 'node:crypto';
import type { Database, SignActorType } from '@ludy/db';
import type { Kysely } from 'kysely';

export const SIGN_EVENT_TYPES = [
  'envelope_created',
  'document_inspected',
  'document_inspect_failed',
  'envelope_updated',
  'envelope_shared_summary_updated',
  'signer_added',
  'signer_removed',
  'signers_reordered',
  'fields_set',
  'envelope_sent',
  'link_created',
  'signer_reminded',
  'signer_pre_expiry_reminded',
  'signer_corrected',
  'signer_delegated',
  'signer_viewed',
  'signer_otp_verified',
  'signer_signed',
  'signer_declined',
  'envelope_decline_acknowledged',
  'envelope_completed',
  'envelope_voided',
  'envelope_expired',
  'envelope_sealed',
  'envelope_seal_failed',
  'ca_requested',
  'ca_completed',
  'ca_failed',
] as const;
export type SignEventType = (typeof SIGN_EVENT_TYPES)[number];

export interface SigningEventHashInput {
  orgId: string;
  envelopeId: string;
  signerId: string | null;
  seq: number;
  eventType: string;
  actorType: SignActorType;
  actorId: string | null;
  actorLabel: string;
  ipHash: string | null;
  userAgent: string | null;
  documentSha256: string;
  prevEventHash: string | null;
  payloadJson: unknown;
  occurredAt: Date | string;
}

export interface SigningEventChainRow {
  id: string;
  org_id: string;
  envelope_id: string;
  signer_id: string | null;
  seq: number;
  event_type: string;
  actor_type: SignActorType;
  actor_id: string | null;
  actor_label: string;
  ip_hash: string | null;
  user_agent: string | null;
  document_sha256: string;
  prev_event_hash: string | null;
  event_hash: string;
  payload_json: unknown;
  occurred_at: Date | string;
}

export interface AppendSigningEventInput {
  orgId: string;
  envelopeId: string;
  signerId?: string | null;
  eventType: string;
  actorType: SignActorType;
  actorId?: string | null;
  actorLabel: string;
  documentSha256: string;
  payloadJson?: Record<string, unknown>;
  ipHash?: string | null;
  userAgent?: string | null;
  occurredAt: Date;
}

export interface AppendedSigningEvent {
  id: string;
  seq: number;
  prevEventHash: string | null;
  eventHash: string;
  occurredAt: string;
}

export interface VerifyEventChainResult {
  valid: boolean;
  count: number;
  tipHash: string | null;
  brokenSeq: number | null;
  reason: string | null;
}

export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Deterministic canonical JSON serializer: sorts object keys recursively at every depth, normalizes Dates to UTC ISO
// strings, drops undefined object properties like JSON.stringify, and produces identical output after PG jsonb round-trip.
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number cannot be serialized in canonical JSON');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'bigint') throw new Error('BigInt is not supported in canonical JSON');
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return 'null';
      return canonicalJson(item);
    });
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined || typeof prop === 'function' || typeof prop === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(prop)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Unsupported value type in canonical JSON: ${typeof value}`);
}

export function parseEventPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function computeSigningEventHash(input: SigningEventHashInput): string {
  const canonicalPayload = canonicalJson({
    orgId: input.orgId,
    envelopeId: input.envelopeId,
    signerId: input.signerId,
    seq: input.seq,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    documentSha256: input.documentSha256,
    prevEventHash: input.prevEventHash,
    payloadJson: parseEventPayload(input.payloadJson),
    occurredAt: new Date(input.occurredAt).toISOString(),
  });
  return sha256Hex(canonicalPayload);
}

// Appends a signing event onto the envelope's hash chain. Locks the parent envelope FOR UPDATE so concurrent writers
// serialize seq numbers deterministically (lock order: envelope -> signing_event).
export async function appendSigningEvent(trx: Kysely<Database>, input: AppendSigningEventInput): Promise<AppendedSigningEvent> {
  await trx
    .selectFrom('crove_sign.envelope')
    .select('id')
    .where('org_id', '=', input.orgId)
    .where('id', '=', input.envelopeId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const latest = await trx
    .selectFrom('crove_sign.signing_event')
    .select(['seq', 'event_hash'])
    .where('org_id', '=', input.orgId)
    .where('envelope_id', '=', input.envelopeId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();

  const seq = latest ? latest.seq + 1 : 1;
  const prevEventHash = latest ? latest.event_hash : null;
  const occurredAtIso = input.occurredAt.toISOString();
  const payloadObj = input.payloadJson ?? {};

  const eventHash = computeSigningEventHash({
    orgId: input.orgId,
    envelopeId: input.envelopeId,
    signerId: input.signerId ?? null,
    seq,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel,
    ipHash: input.ipHash ?? null,
    userAgent: input.userAgent ?? null,
    documentSha256: input.documentSha256,
    prevEventHash,
    payloadJson: payloadObj,
    occurredAt: occurredAtIso,
  });

  const inserted = await trx
    .insertInto('crove_sign.signing_event')
    .values({
      org_id: input.orgId,
      envelope_id: input.envelopeId,
      signer_id: input.signerId ?? null,
      seq,
      event_type: input.eventType,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      actor_label: input.actorLabel,
      document_sha256: input.documentSha256,
      prev_event_hash: prevEventHash,
      event_hash: eventHash,
      payload_json: JSON.stringify(payloadObj),
      ip_hash: input.ipHash ?? null,
      user_agent: input.userAgent ?? null,
      occurred_at: occurredAtIso,
    })
    .returning(['id', 'seq', 'prev_event_hash', 'event_hash', 'occurred_at'])
    .executeTakeFirstOrThrow();

  return {
    id: inserted.id,
    seq: inserted.seq,
    prevEventHash: inserted.prev_event_hash,
    eventHash: inserted.event_hash,
    occurredAt: new Date(inserted.occurred_at).toISOString(),
  };
}

export function verifyEventChain(events: readonly SigningEventChainRow[]): VerifyEventChainResult {
  if (events.length === 0) {
    return { valid: true, count: 0, tipHash: null, brokenSeq: null, reason: null };
  }
  let expectedPrev: string | null = null;
  for (let idx = 0; idx < events.length; idx++) {
    const row = events[idx]!;
    const expectedSeq = idx + 1;
    if (row.seq !== expectedSeq) {
      return {
        valid: false,
        count: events.length,
        tipHash: events[events.length - 1]!.event_hash,
        brokenSeq: row.seq,
        reason: `Expected seq ${expectedSeq}, found ${row.seq}`,
      };
    }
    if (row.prev_event_hash !== expectedPrev) {
      return {
        valid: false,
        count: events.length,
        tipHash: events[events.length - 1]!.event_hash,
        brokenSeq: row.seq,
        reason: `Chain break at seq ${row.seq}: prev_event_hash mismatch`,
      };
    }
    const recomputed = computeSigningEventHash({
      orgId: row.org_id,
      envelopeId: row.envelope_id,
      signerId: row.signer_id,
      seq: row.seq,
      eventType: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorLabel: row.actor_label,
      ipHash: row.ip_hash,
      userAgent: row.user_agent,
      documentSha256: row.document_sha256,
      prevEventHash: row.prev_event_hash,
      payloadJson: row.payload_json,
      occurredAt: row.occurred_at,
    });
    if (row.event_hash !== recomputed) {
      return {
        valid: false,
        count: events.length,
        tipHash: events[events.length - 1]!.event_hash,
        brokenSeq: row.seq,
        reason: `Hash mismatch at seq ${row.seq}`,
      };
    }
    expectedPrev = row.event_hash;
  }
  return {
    valid: true,
    count: events.length,
    tipHash: events[events.length - 1]!.event_hash,
    brokenSeq: null,
    reason: null,
  };
}
