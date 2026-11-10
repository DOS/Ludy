// SPDX-License-Identifier: AGPL-3.0-only
// The storage of the embedded OAuth 2.1 authorization server (ADR-0032 item 7, ADR-0051 decision 2, issue #2975): the adapter `oidc-provider`
// asks for, over crove_kernel.oauth_record.
//
// A record's key is stored only as its SHA-256, whatever its model, so an authorization code, a refresh token or a session id is never in the
// database in clear. The provider's payload (the PKCE challenge, the scopes, the account) is stored as it is: it holds none of those secrets,
// because the secret is the key. The table is definer-only and org-less; the six functions below are the only way in, and only the API login
// may call them.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import type { Db } from '@crove/db';
import { toDomainError } from '@crove/kernel-runtime';

// How long a record lives when the provider names no end: a registered client that never obtains a grant is gone after 30 days
// (crove_kernel.mcp_grant_approve lifts it to 400 days when a person consents to it).
const DEFAULT_LIFETIME_SECONDS = 24 * 3600;

export const keyHash = (id: string): Buffer => createHash('sha256').update(id, 'utf8').digest();

// The models whose id IS a bearer secret (an authorization code, a refresh token, an access token, a registration token): the provider also puts that id in the
// payload as `jti`, which would store the secret in clear beside its hash. The payload keeps no `jti` for them; `find` puts the id back, as it is the key asked for.
// A session or an interaction id authorizes nothing but the interaction in progress (15 and 10 minutes), and the provider looks those up by uid too, so they keep theirs.
const SECRET_ID_MODELS: ReadonlySet<string> = new Set(['AccessToken', 'AuthorizationCode', 'RefreshToken', 'RegistrationAccessToken', 'InitialAccessToken', 'ClientCredentials', 'DeviceCode', 'BackchannelAuthenticationRequest', 'PushedAuthorizationRequest']);

type RunDb = <O>(fn: (db: Db) => Promise<O>) => Promise<O>;

interface Row {
  payload: AdapterPayload;
  consumed_at: Date | null;
}

// What the provider reads back: the payload with `consumed` (epoch seconds) when the record was consumed.
function withConsumed(row: Row | undefined): AdapterPayload | undefined {
  if (!row) return undefined;
  return row.consumed_at ? { ...row.payload, consumed: Math.floor(new Date(row.consumed_at).getTime() / 1000) } : row.payload;
}

class OauthAdapter implements Adapter {
  readonly #model: string;
  readonly #run: RunDb;

  constructor(model: string, run: RunDb) {
    this.#model = model;
    this.#run = run;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const lifetime = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : DEFAULT_LIFETIME_SECONDS;
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : null;
    const uid = typeof payload.uid === 'string' ? payload.uid : null;
    const { consumed: _consumed, ...rest } = payload;
    const stored = SECRET_ID_MODELS.has(this.#model) ? Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'jti')) : rest;
    try {
      await this.#run((db) =>
        sql`SELECT crove_kernel.oauth_record_upsert(${this.#model}::text, ${keyHash(id)}::bytea, ${JSON.stringify(stored)}::jsonb, ${grantId}::text, ${uid}::text,
          pg_catalog.clock_timestamp() + (${lifetime} * interval '1 second'))`.execute(db),
      );
    } catch (error) {
      throw toDomainError(error);
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const { rows } = await this.#run((db) => sql<Row>`SELECT payload, consumed_at FROM crove_kernel.oauth_record_find(${this.#model}::text, ${keyHash(id)}::bytea)`.execute(db));
    const found = withConsumed(rows[0]);
    return found && SECRET_ID_MODELS.has(this.#model) ? { ...found, jti: id } : found;
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const { rows } = await this.#run((db) => sql<Row>`SELECT payload, consumed_at FROM crove_kernel.oauth_record_find_by_uid(${this.#model}::text, ${uid}::text)`.execute(db));
    return withConsumed(rows[0]);
  }

  // Device flow is off: no record is found by a user code.
  async findByUserCode(): Promise<AdapterPayload | undefined> {
    return undefined;
  }

  // Consumed once: a second consumer (two requests racing with one code or refresh token) gets a refusal, so a chain never forks.
  async consume(id: string): Promise<void> {
    const { rows } = await this.#run((db) => sql<{ consumed: boolean }>`SELECT crove_kernel.oauth_record_consume(${this.#model}::text, ${keyHash(id)}::bytea) AS consumed`.execute(db));
    if (rows[0]?.consumed !== true) throw new errors.InvalidGrant('the grant was already used');
  }

  async destroy(id: string): Promise<void> {
    await this.#run((db) => sql`SELECT crove_kernel.oauth_record_destroy(${this.#model}::text, ${keyHash(id)}::bytea)`.execute(db));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.#run((db) => sql`SELECT crove_kernel.oauth_record_revoke_by_grant(${grantId}::text)`.execute(db));
  }
}

// The constructor the provider's `adapter` option takes: one adapter per model, all over the same table.
export function oauthAdapterFor(run: RunDb): new (model: string) => Adapter {
  return class extends OauthAdapter {
    constructor(model: string) {
      super(model, run);
    }
  };
}
