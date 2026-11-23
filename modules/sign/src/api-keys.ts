// SPDX-License-Identifier: AGPL-3.0-only
// Scoped organization API keys for /api/v1/sign/* external REST endpoints (#4441, eSign Slice 5c).
// Cleartext API key secrets are generated and SHA-256 hashed at the RPC edge BEFORE Runtime.execute(),
// so commands receive and persist only keyPrefix and keySha256 and need zero noIdempotency flags.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import {
  SIGN_API_KEY_SCOPES,
  tableWrite,
  zId,
  zSignApiKeyListInput,
  zSignApiKeyRevokeInput,
  zSignApiKeyScope,
  type SignApiKeyListResult,
  type SignApiKeyRecord,
  type SignApiKeyScope,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  hasFreshMfa,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { signManifest } from './manifest.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

function assertHumanManager(ctx: CommandContext | QueryContext): string {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp || ctx.actor.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Only human workspace owners and admins can manage eSign API keys');
  }
  return ctx.actor.userId;
}

// Creating a long-lived scoped org API key needs a fresh second factor when the caller holds MFA (ADR-0047 section 10).
function assertApiKeyStepUp(ctx: CommandContext, what: string): void {
  if (ctx.actor.type === 'user' && ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
    throw new DomainError(
      'STEP_UP_REQUIRED',
      403,
      `Fresh two-factor authentication (MFA within 5 minutes) is required to ${what}`,
    );
  }
}

const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

interface RawApiKeyJson {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeApiKeyRecord(raw: RawApiKeyJson): SignApiKeyRecord {
  const validScopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((s): s is SignApiKeyScope =>
        (SIGN_API_KEY_SCOPES as readonly string[]).includes(s),
      )
    : [];
  return {
    id: raw.id,
    name: raw.name,
    keyPrefix: raw.keyPrefix,
    scopes: validScopes,
    createdBy: raw.createdBy ?? null,
    expiresAt: isoOrNull(raw.expiresAt),
    revokedAt: isoOrNull(raw.revokedAt),
    lastUsedAt: isoOrNull(raw.lastUsedAt),
    createdAt: new Date(raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updatedAt).toISOString(),
  };
}

function mapApiKeySqlError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('SIGN_API_KEY_NOT_FOUND')) {
    throw new DomainError('SIGN_API_KEY_NOT_FOUND', 404, 'API key not found');
  }
  if (message.includes('SIGN_API_KEY_LIMIT_REACHED')) {
    throw new DomainError('SIGN_API_KEY_LIMIT_REACHED', 422, 'Maximum active API keys (50) reached for this workspace');
  }
  if (message.includes('SIGN_API_KEY_INVALID_EXPIRY')) {
    throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'API key expiry must be in the future');
  }
  if (message.includes('SIGN_FORBIDDEN')) {
    throw new DomainError('SIGN_FORBIDDEN', 403, 'Only workspace owners and admins can manage API keys');
  }
  throw error;
}

export const signApiKeyList = defineQuery({
  name: 'sign.api_key.list',
  input: zSignApiKeyListInput,
  access: MANAGERS,
  handler: async (ctx): Promise<SignApiKeyListResult> => {
    assertHumanManager(ctx);
    try {
      const { rows } = await sql<{ items: RawApiKeyJson[] }>`
        SELECT crove_sign.api_key_list() AS items
      `.execute(ctx.trx);
      const list = Array.isArray(rows[0]?.items) ? rows[0].items : [];
      return { items: list.map(normalizeApiKeyRecord) };
    } catch (error) {
      mapApiKeySqlError(error);
    }
  },
});

const zApiKeyCreateCommandInput = z.strictObject({
  id: zId.optional(),
  name: z.string().trim().min(1).max(120),
  keyPrefix: z.string().regex(/^ludy_sk_[A-Za-z0-9_-]{8,16}$/),
  keySha256: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(zSignApiKeyScope).min(1).max(2),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const signApiKeyCreate = defineCommand({
  name: 'sign.api_key.create',
  input: zApiKeyCreateCommandInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'api_key', [
      'org_id',
      'id',
      'name',
      'key_prefix',
      'key_sha256',
      'scopes',
      'created_by',
      'expires_at',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignApiKeyRecord> => {
    assertHumanManager(ctx);
    assertApiKeyStepUp(ctx, 'create eSign API keys');
    const dedupedScopes = [...new Set(input.scopes)].sort();
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const exp = new Date(input.expiresAt);
      if (Number.isNaN(exp.getTime()) || exp.getTime() <= ctx.now.getTime()) {
        throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'API key expiry must be in the future');
      }
    }
    try {
      const { rows } = await sql<{ row: RawApiKeyJson }>`
        SELECT crove_sign.api_key_insert(
          ${input.id ?? null}::uuid,
          ${input.name}::text,
          ${input.keyPrefix}::text,
          ${input.keySha256}::text,
          ${dedupedScopes}::text[],
          ${input.expiresAt ?? null}::timestamptz
        ) AS row
      `.execute(ctx.trx);
      const record = normalizeApiKeyRecord(rows[0]!.row);
      ctx.audit({
        apiKeyId: record.id,
        keyPrefix: record.keyPrefix,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
      });
      return record;
    } catch (error) {
      mapApiKeySqlError(error);
    }
  },
});

export const signApiKeyRevoke = defineCommand({
  name: 'sign.api_key.revoke',
  input: zSignApiKeyRevokeInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'sign.api_key', id: input.apiKeyId }),
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'api_key', [
      'revoked_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<SignApiKeyRecord> => {
    assertHumanManager(ctx);
    try {
      const { rows } = await sql<{ row: RawApiKeyJson }>`
        SELECT crove_sign.api_key_revoke(${input.apiKeyId}::uuid) AS row
      `.execute(ctx.trx);
      const record = normalizeApiKeyRecord(rows[0]!.row);
      ctx.audit({
        apiKeyId: record.id,
        keyPrefix: record.keyPrefix,
        revokedAt: record.revokedAt,
      });
      return record;
    } catch (error) {
      mapApiKeySqlError(error);
    }
  },
});

export const signApiKeyQueries = [signApiKeyList];
export const signApiKeyCommands = [signApiKeyCreate, signApiKeyRevoke];
