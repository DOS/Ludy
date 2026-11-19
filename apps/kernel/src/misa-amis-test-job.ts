// SPDX-License-Identifier: AGPL-3.0-only
// The test of a MISA AMIS connection, the worker's half (#3885, S2b of #3854; ADR-0025), run as the system for one connection when an owner or admin asked (finance.misa_amis_connection.request_test).
// The access code is opened here and nowhere else (the API only seals it). The client asks AMIS for a token and then for the company's information: two reads that change nothing in AMIS.
// What is recorded is a state (works, wrong_credentials, unreachable) and a time, never AMIS's own text, a token, a header or the code; the log carries ids and a state too.
// The three states: "works", "AMIS refused the connection (the access code, or no accounting data connected in AMIS): check it or make a new code and connect again", and "no test could be made (AMIS did not
// answer, answered with an error of its own, or does not know this deployment's app): try again later, and tell the Ludy administrator if it stays".
import { AmisError, type AmisClient } from '@crove/misa-amis';
import type { MisaAmisTestState } from '@crove/kernel-contract';
import type { MisaAmisTestTarget } from '@crove/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

export interface MisaAmisTestJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
}

export interface MisaAmisTestDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  client: AmisClient;
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

export async function runMisaAmisTest(deps: MisaAmisTestDeps, job: MisaAmisTestJob): Promise<MisaAmisTestOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MisaAmisTestTarget>('finance.misa_amis_connection.test_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  const record = async (state: MisaAmisTestState) => {
    await deps.runtime.execute('finance.misa_amis_connection.record_test', { id: job.connectionId, state }, options);
    return { state } satisfies MisaAmisTestOutcome;
  };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let accessCode: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    accessCode = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: target.channelConnectionId, reason: 'owner_left' }, options);
      return record('wrong_credentials');
    }
    throw error;
  }

  try {
    await deps.client.companyInfo({ accessCode, orgCompanyCode: target.orgCompanyCode });
  } catch (error) {
    // Only the adapter's own kind is kept: its message and whatever else a failure carries are neither stored nor logged, and pg-boss never keeps them in the job's output.
    const kind = error instanceof AmisError ? error.kind : 'unreachable';
    const code = error instanceof AmisError ? error.code : null;
    // InvalidAPPID is the deployment's own ClientID being unknown to MISA: nothing the customer can fix with a new access code, so it is not told as one (an operator reads it in the log).
    const state: MisaAmisTestState = kind === 'credentials' && code !== 'InvalidAPPID' ? 'wrong_credentials' : 'unreachable';
    console.warn(`[misa-amis] ${job.connectionId.slice(0, 8)}: ${state} (${kind}${code ? `, ${code}` : ''})`);
    return record(state);
  }
  return record('works');
}
