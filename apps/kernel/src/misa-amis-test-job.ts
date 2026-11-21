// SPDX-License-Identifier: AGPL-3.0-only
// The test of a MISA connection (AMIS Kế toán or MISA ASP, #4111), the worker's half (#3885, S2b of #3854; ADR-0025), run as the system for one connection when an owner or admin asked (finance.misa_amis_connection.request_test).
// The access code is opened here and nowhere else (the API only seals it). For AMIS the client asks for a token and then for the company's information; ASP has no company-information call, so the
// test asks for a token and then for one row of the organization-unit catalogue (data_type 6, take 1): two reads that change nothing in MISA. Each product uses its own client and its own provider id.
// What is recorded is a state (works, wrong_credentials, unreachable) and a time, never AMIS's own text, a token, a header or the code; the log carries ids and a state too.
// The three states: "works", "AMIS refused the connection (the access code, or no accounting data connected in AMIS): check it or make a new code and connect again", and "no test could be made (AMIS did not
// answer, answered with an error of its own, or does not know this deployment's app): try again later, and tell the Ludy administrator if it stays".
import { AMIS_DICTIONARIES, AmisError, type AmisClient, type AmisConnection, type AmisRecord } from '@ludy/misa-amis';
import type { MisaAmisTestState } from '@ludy/kernel-contract';
import type { MisaAmisTestTarget } from '@ludy/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { misaChannelProvider } from '@ludy/mod-finance';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

export interface MisaAmisTestJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
}

export interface MisaAmisTestDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The client of each product, null where the deployment holds no ClientID for it: a connection of that product is left alone.
  client: AmisClient | null;
  aspClient?: AmisClient | null;
}

export type MisaAmisTestOutcome =
  // The connection is left alone (gone, or no longer active): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  | { state: MisaAmisTestState };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// MISA ASP's connection test (#4111): the dictionary call carries the token, and a token is asked for first; `companyInfo` would answer `unsupported` for ASP. The one row asked for is the organization unit
// (data_type 6, take 1), the branch every voucher needs; what it holds is not read here, only that MISA answered.
async function readOneBranch(client: AmisClient, connection: AmisConnection): Promise<AmisRecord[]> {
  return client.dictionary(connection, { dataType: AMIS_DICTIONARIES.organizationUnit, skip: 0, take: 1 }, { freshToken: true });
}

export async function runMisaAmisTest(deps: MisaAmisTestDeps, job: MisaAmisTestJob): Promise<MisaAmisTestOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MisaAmisTestTarget>('finance.misa_amis_connection.test_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  const client = target.product === 'asp' ? (deps.aspClient ?? null) : deps.client;
  if (!client) return { state: 'skipped', reason: 'product_off' };
  const record = async (state: MisaAmisTestState) => {
    await deps.runtime.execute('finance.misa_amis_connection.record_test', { id: job.connectionId, state }, options);
    return { state } satisfies MisaAmisTestOutcome;
  };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let accessCode: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    // Only an access code sealed for this connection's product is opened here: a channel connection of another provider (the other MISA product's included) is never read as one.
    if (sealed.provider !== misaChannelProvider(target.product)) {
      console.warn(`[misa-amis] ${job.connectionId.slice(0, 8)}: credential of another provider, not opened`);
      return record('wrong_credentials');
    }
    accessCode = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: target.channelConnectionId, reason: 'owner_left' }, options);
      return record('wrong_credentials');
    }
    throw error;
  }

  let info: Awaited<ReturnType<AmisClient['companyInfo']>> | AmisRecord[];
  try {
    // A fresh token each time: the client keeps one for half an hour, and a test that reused it would not send the access code, so a code revoked in AMIS could still read "works".
    // ASP has no `get_company_info`: its test is a token (a fresh one, by the same drop) and then one row of the organization-unit catalogue, a read that changes nothing.
    info =
      target.product === 'asp'
        ? await readOneBranch(client, { accessCode, orgCompanyCode: target.orgCompanyCode })
        : await client.companyInfo({ accessCode, orgCompanyCode: target.orgCompanyCode }, null, { freshToken: true });
  } catch (error) {
    // Only the adapter's own kind is kept: its message and whatever else a failure carries are neither stored nor logged, and pg-boss never keeps them in the job's output.
    const kind = error instanceof AmisError ? error.kind : 'unreachable';
    const code = error instanceof AmisError ? error.code : null;
    // InvalidAPPID is the deployment's own ClientID being unknown to MISA: nothing the customer can fix with a new access code, so it is not told as one (an operator reads it in the log).
    const state: MisaAmisTestState = kind === 'credentials' && code !== 'InvalidAPPID' ? 'wrong_credentials' : 'unreachable';
    console.warn(`[misa-amis] ${job.connectionId.slice(0, 8)}: ${state} (${kind}${code ? `, ${code}` : ''})`);
    return record(state);
  }
  // AMIS accepted the code but its answer is not the company object its document describes (that shape is unconfirmed until the sandbox check): not told as "works", and the log says why.
  if (info === null) {
    console.warn(`[misa-amis] ${job.connectionId.slice(0, 8)}: unreachable (invalid_response)`);
    return record('unreachable');
  }
  return record('works');
}
