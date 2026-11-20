// SPDX-License-Identifier: AGPL-3.0-only
// The check of a connection's vouchers against the firm's MISA catalogue, the worker's half (#4112, S3a of #4103; ADR-0025), run as the system for one connection when an owner or admin asked
// (finance.misa_amis_match.request_check). The access code is opened here and nowhere else (the API only seals it). The job finds the parties (by tax code) and items (by code) of the batch the person was
// looking at, reads the catalogue pages that hold them through the client of the connection's product (MISA AMIS Kế toán or MISA ASP, #4152), matches them in memory (modules/finance misa-amis-matching.ts) and records only what it found: for each party and item whether one active
// entry matched (and its code and id), none did, or several did. The catalogue pages live in this function's variables and nowhere else: no name, address or tax code of a catalogue entry is recorded, put in a
// job's output, an audit row or an error, or logged. The log carries the connection's first eight characters, the state and the adapter's error kind.
import { AmisError, type AmisClient, type AmisConnection } from '@crove/misa-amis';
import { MISA_AMIS_PREVIEW_LIMIT, type MisaAmisMatchResult } from '@crove/kernel-contract';
import { amisContextOf, loadAmisEntries, misaChannelProvider, type MisaAmisMatchTarget } from '@crove/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { matchCatalogue, TooLarge } from './misa-amis-catalogue.ts';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

export interface MisaAmisMatchJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
}

export interface MisaAmisMatchDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The client of each product, null where the deployment holds no ClientID for it: a connection of that product is left alone (the check stays requested).
  client: AmisClient | null;
  aspClient?: AmisClient | null;
}

type Failure = 'credentials' | 'unreachable' | 'invalid_response' | 'catalogue_too_large';
export type MisaAmisMatchOutcome =
  // The connection is left alone (gone, no longer active, or no check is waiting): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  // `superseded`: the record was dropped because the request was filed again while this run read the catalogue (a newer batch, or a confirmation that run could not have checked); the job runs again.
  | { state: 'done'; results: number; superseded?: true }
  | { state: 'failed'; failure: Failure; superseded?: true };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export async function runMisaAmisMatch(deps: MisaAmisMatchDeps, job: MisaAmisMatchJob): Promise<MisaAmisMatchOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MisaAmisMatchTarget>('finance.misa_amis_match.check_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  const client = target.product === 'asp' ? (deps.aspClient ?? null) : deps.client;
  if (!client) return { state: 'skipped', reason: 'product_off' };
  const fail = async (failure: Failure, kind: string) => {
    console.warn(`[misa-amis] match ${job.connectionId.slice(0, 8)}: failed (${failure}, ${kind})`);
    const written = await deps.runtime.execute<{ recorded?: boolean }>('finance.misa_amis_match.record_check', { connectionId: job.connectionId, requestedAt: target.requestedAt, state: 'failed', failure, results: [] }, options);
    return { state: 'failed', failure, ...(written?.recorded === false ? { superseded: true as const } : {}) } satisfies MisaAmisMatchOutcome;
  };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let accessCode: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    // Only an access code sealed for this connection's product is opened here: a channel connection of another provider (the other MISA product's included) is never read as one.
    if (sealed.provider !== misaChannelProvider(target.product)) return fail('credentials', 'other_provider');
    accessCode = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: target.channelConnectionId, reason: 'owner_left' }, options);
      return fail('credentials', error.code.toLowerCase());
    }
    throw error;
  }
  const connection: AmisConnection = { accessCode, orgCompanyCode: target.orgCompanyCode };

  // What to look up: the tax codes of the batch's parties and the item codes its lines are written with, found by the same path the preview and the push use.
  const query = <T>(name: string, input: unknown): Promise<T> => deps.runtime.query<T>(name, input, options);
  const { wanted } = await loadAmisEntries(query, target.ask, amisContextOf(target.ask), MISA_AMIS_PREVIEW_LIMIT + 1);

  let results: MisaAmisMatchResult[];
  try {
    // A party a person already confirmed by name is checked (its code still in the catalogue), not asked again.
    const confirmedIds = new Set(target.confirmed.map((c) => c.partyId));
    const found = await matchCatalogue(client, connection, { taxCodes: wanted.taxCodes, itemCodes: wanted.itemCodes, ...(target.product === 'asp' ? { unitNames: wanted.unitNames, stockCodes: wanted.stockCodes } : {}), names: wanted.names.filter((n) => !confirmedIds.has(n.partyId)), confirmed: target.confirmed });
    // Only the verdicts that change something are recorded: a confirmed name that still holds is a row that stays, so it is not a result (and does not count toward the results a record may hold).
    results = found.filter((r) => !(r.kind === 'party_name' && r.state === 'confirmed'));
  } catch (error) {
    if (error instanceof TooLarge) return fail('catalogue_too_large', 'too_large');
    // Only the adapter's own kind is kept: its message and whatever else a failure carries are neither stored nor logged.
    const kind = error instanceof AmisError ? error.kind : 'unreachable';
    const code = error instanceof AmisError ? error.code : null;
    // InvalidAPPID is the deployment's own ClientID being unknown to MISA: nothing the customer can fix with a new access code, so it is not told as one.
    const failure: Failure = kind === 'credentials' && code !== 'InvalidAPPID' ? 'credentials' : kind === 'invalid_response' ? 'invalid_response' : 'unreachable';
    return fail(failure, `${kind}${code ? `, ${code}` : ''}`);
  }
  const written = await deps.runtime.execute<{ recorded?: boolean }>('finance.misa_amis_match.record_check', { connectionId: job.connectionId, requestedAt: target.requestedAt, state: 'done', failure: null, results }, options);
  console.log(`[misa-amis] match ${job.connectionId.slice(0, 8)}: done (${results.length})`);
  return { state: 'done', results: results.length, ...(written?.recorded === false ? { superseded: true as const } : {}) };
}
