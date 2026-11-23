// SPDX-License-Identifier: AGPL-3.0-only
// In-person host signing ceremony command (Slice 4d, #3820, docs/plan/esign.md):
// starts a short-lived (<= 2h) single-use face-to-face signing session on /-/sign?in_person=1#<token>
// for an active unsigned signer/approver whose routing turn is current, recording host_user_id and
// appending in_person_session_started onto the hash-chained ludy_sign.signing_event ledger.
import { sql } from 'kysely';
import {
  SIGN_IN_PERSON_DEFAULT_TTL_MINUTES,
  SIGN_IN_PERSON_MAX_TTL_MINUTES,
  SIGN_PAGE_PATH,
  zSignSignerStartInPersonInput,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { assertCanAccessEnvelopeRow } from './hr-visibility.ts';
import { assertCanAccessMeetingMinutesEnvelopeRow } from './meeting-visibility.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';
import {
  SIGNING_EVENT_WRITE,
  SIGNING_OTP_INVALIDATE_WRITE,
  SIGNING_TOKEN_WRITE,
  SIGN_WRITERS,
  actorLabelOfCtx,
  userIdOf,
} from './shared.ts';

const envelopeTarget = (input: { envelopeId: string }) => ({ type: 'sign.envelope', id: input.envelopeId });

export const signerStartInPerson = defineCommand({
  name: 'sign.signer.start_in_person',
  input: zSignSignerStartInPersonInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  // Returns raw single-use in-person signing token once; disallow idempotency replay storage so plaintext tokens are never persisted.
  noIdempotency: true,
  target: envelopeTarget,
  writes: [SIGNING_TOKEN_WRITE, SIGNING_OTP_INVALIDATE_WRITE, SIGNING_EVENT_WRITE],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'expires_at', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, row);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, row);

    if (row.status !== 'sent' && row.status !== 'in_progress') {
      throw new DomainError(
        'SIGN_ENVELOPE_NOT_ACTIVE',
        409,
        'In-person signing can only be started while envelope is sent or in progress',
      );
    }
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope has expired');
    }

    const signer = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['id', 'signer_role', 'status', 'routing_order'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', '=', input.signerId)
      .forUpdate()
      .executeTakeFirst();
    if (!signer) {
      throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
    }
    if (signer.signer_role === 'cc') {
      throw new DomainError('SIGN_INVALID_SIGNER', 422, 'In-person signing cannot be started for CC recipients');
    }
    if (signer.status !== 'pending' && signer.status !== 'viewed') {
      throw new DomainError('SIGN_SIGNER_NOT_DUE', 409, 'Signer is not currently awaiting signature');
    }

    const ttlMinutes = Math.min(
      SIGN_IN_PERSON_MAX_TTL_MINUTES,
      Math.max(5, input.expiresInMinutes ?? SIGN_IN_PERSON_DEFAULT_TTL_MINUTES),
    );
    const baseNowMs = ctx.now.getTime();
    const requestedExpiry = new Date(baseNowMs + ttlMinutes * 60_000);
    const expiresAt =
      row.expires_at && new Date(row.expires_at).getTime() < requestedExpiry.getTime()
        ? new Date(row.expires_at)
        : requestedExpiry;
    if (expiresAt.getTime() <= baseNowMs) {
      throw new DomainError('SIGN_ENVELOPE_EXPIRED', 409, 'Envelope has expired');
    }

    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const { rows: minted } = await sql<{ id: string }>`
      SELECT ludy_sign.mint_in_person_signing_token(
        ${row.id}::uuid,
        ${signer.id}::uuid,
        ${tokenHash},
        ${expiresAt}::timestamptz
      ) AS id
    `.execute(ctx.trx);
    const tokenId = minted[0]?.id;
    if (!tokenId) {
      throw new Error('mint_in_person_signing_token returned no id');
    }

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      signerId: signer.id,
      hostUserId: userId,
      eventType: 'in_person_session_started',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOfCtx(ctx),
      documentSha256: row.source_sha256,
      payloadJson: {
        tokenId,
        hostUserId: userId,
        routingOrder: signer.routing_order,
        expiresAt: expiresAt.toISOString(),
      },
      occurredAt: ctx.now,
    });
    ctx.audit({ envelopeId: row.id, signerId: signer.id, tokenId, inPerson: true });

    return {
      envelopeId: row.id,
      signerId: signer.id,
      hostUserId: userId,
      tokenId,
      token: rawToken,
      ceremonyPath: `${SIGN_PAGE_PATH}?in_person=1#${rawToken}`,
      expiresAt: expiresAt.toISOString(),
    };
  },
});

export const signInPersonCommands = [signerStartInPerson];
