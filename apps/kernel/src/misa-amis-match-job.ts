// SPDX-License-Identifier: AGPL-3.0-only
// The check of a connection's vouchers against the firm's MISA catalogue, the worker's half (#4112, S3a of #4103; ADR-0025), run as the system for one connection when an owner or admin asked
// (finance.misa_amis_match.request_check). The access code is opened here and nowhere else (the API only seals it). The job finds the parties (by tax code) and items (by code) of the batch the person was
// looking at, reads the catalogue pages that hold them through the client, matches them in memory (modules/finance misa-amis-matching.ts) and records only what it found: for each party and item whether one active
// entry matched (and its code and id), none did, or several did. The catalogue pages live in this function's variables and nowhere else: no name, address or tax code of a catalogue entry is recorded, put in a
// job's output, an audit row or an error, or logged. The log carries the connection's first eight characters, the state and the adapter's error kind.
import { AMIS_DICTIONARIES, AmisError, type AmisClient, type AmisConnection } from '@crove/misa-amis';
import { MISA_AMIS_PREVIEW_LIMIT, type MisaAmisMatchResult } from '@crove/kernel-contract';
import {
  amisContextOf,
  catalogueItems,
  catalogueParties,
  loadAmisEntries,
  matchItems,
  matchParties,
  MISA_AMIS_CHANNEL_PROVIDER,
  type MisaAmisMatchTarget,
} from '@crove/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };
// A page of the catalogue, and how many pages one check reads: 20 000 entries of a kind. A catalogue that is longer is not read in part (a party past the cut would read as unknown): the check fails with
// `catalogue_too_large` and nothing is recorded as found.
const PAGE = 1000;
const MAX_PAGES = 20;

export interface MisaAmisMatchJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
}

export interface MisaAmisMatchDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  client: AmisClient;
}

type Failure = 'credentials' | 'unreachable' | 'invalid_response' | 'catalogue_too_large';
export type MisaAmisMatchOutcome =
  // The connection is left alone (gone, no longer active, or no check is waiting): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  | { state: 'done'; results: number }
  | { state: 'failed'; failure: Failure };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

class TooLarge extends Error {}

type Rows = Array<Readonly<Record<string, unknown>>>;
async function readCatalogue(client: AmisClient, connection: AmisConnection, dataType: typeof AMIS_DICTIONARIES.accountObject | typeof AMIS_DICTIONARIES.inventoryItem): Promise<Rows> {
  const all: Rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await client.dictionary(connection, { dataType, skip: page * PAGE, take: PAGE, lastSyncTime: null, branchId: null });
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
  throw new TooLarge();
}

export async function runMisaAmisMatch(deps: MisaAmisMatchDeps, job: MisaAmisMatchJob): Promise<MisaAmisMatchOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MisaAmisMatchTarget>('finance.misa_amis_match.check_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  const fail = async (failure: Failure, kind: string) => {
    console.warn(`[misa-amis] match ${job.connectionId.slice(0, 8)}: failed (${failure}, ${kind})`);
    await deps.runtime.execute('finance.misa_amis_match.record_check', { connectionId: job.connectionId, state: 'failed', failure, results: [] }, options);
    return { state: 'failed', failure } satisfies MisaAmisMatchOutcome;
  };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let accessCode: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    // Only an access code sealed for this connector is opened here: a channel connection of another provider is never read as one.
    if (sealed.provider !== MISA_AMIS_CHANNEL_PROVIDER) return fail('credentials', 'other_provider');
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

  const results: MisaAmisMatchResult[] = [];
  try {
    if (wanted.taxCodes.length > 0) results.push(...matchParties(wanted.taxCodes, catalogueParties(await readCatalogue(deps.client, connection, AMIS_DICTIONARIES.accountObject))));
    if (wanted.itemCodes.length > 0) results.push(...matchItems(wanted.itemCodes, catalogueItems(await readCatalogue(deps.client, connection, AMIS_DICTIONARIES.inventoryItem))));
  } catch (error) {
    if (error instanceof TooLarge) return fail('catalogue_too_large', 'too_large');
    // Only the adapter's own kind is kept: its message and whatever else a failure carries are neither stored nor logged.
    const kind = error instanceof AmisError ? error.kind : 'unreachable';
    const code = error instanceof AmisError ? error.code : null;
    // InvalidAPPID is the deployment's own ClientID being unknown to MISA: nothing the customer can fix with a new access code, so it is not told as one.
    const failure: Failure = kind === 'credentials' && code !== 'InvalidAPPID' ? 'credentials' : kind === 'invalid_response' ? 'invalid_response' : 'unreachable';
    return fail(failure, `${kind}${code ? `, ${code}` : ''}`);
  }
  await deps.runtime.execute('finance.misa_amis_match.record_check', { connectionId: job.connectionId, state: 'done', failure: null, results }, options);
  console.log(`[misa-amis] match ${job.connectionId.slice(0, 8)}: done (${results.length})`);
  return { state: 'done', results: results.length };
}
