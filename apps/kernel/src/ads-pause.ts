// SPDX-License-Identifier: AGPL-3.0-only
// The pause of what a stopped launch made at the ad platform (ADR-0043 points 4 and 7a, issue #2296, W2-4a), run by the worker as the system. A stop (a person's, the
// switch-off, the kill switch, an account switched off or disconnected) moves a launch that has started to `stopped` and writes the event `ads.pause.queued`; this job
// finds the objects that carry the launch's tag at the platform, takes the ones Ludy recorded, and sets all of them PAUSED. NOTHING IN THIS FILE UN-PAUSES, creates,
// archives or revokes: the job is given the narrowed `AdPauser` of its provider, which has `pauseLaunch` and no other call.
//
// One run is three things, in this order, each in its own transaction:
// 1. `ads.pause.begin` claims the launch (a lease, the run counted) and says what there is to pause: the objects recorded for it, and a row in the kernel's
//    `external_call` ledger for the run (`ads.pause:<launch>:<try>`); it finishes the launch at once when nothing was ever made, and leaves a launch whose connection a
//    switch-off closed to the revoke sweep, which pauses with the sealed copy of its token before it revokes.
// 2. The call: the job opens the sealed token with the credential broker (here, from the write connection's own copy, and nowhere else) and hands it to the pauser.
// 3. `ads.pause.record` records what came of it: the objects the tag found and Ludy had not recorded are recorded now; the launch is wound down when every level was
//    listed in full and every object was paused, or is due again, or Ludy gives up and the person is told to pause by hand at the platform.
// The platform is never called inside a command, so a platform that is down cannot stop a stop; the secret lives in this function's scope and is never logged, never put in
// an error, and never sent to a command.
import type { AdPauser } from '@crove/ad-platform';
import type { PauseBegin, PauseRecorded, PauseResultInput } from '@crove/mod-ads';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { pauseWork } from './ads-pause-run.ts';

const SYSTEM = { type: 'system' as const, component: 'ads.pause' };

export interface AdsPauseJob {
  orgId: string;
  launchId: string;
}

export interface AdsPauseDeps {
  runtime: Runtime;
  // Without one that can open a token (no credential key) nothing is begun.
  broker: CredentialBroker;
  pausers: Readonly<Record<string, AdPauser>>;
}

export interface AdsPauseResult {
  // Whether the pause was tried at the platform in this run.
  ran: boolean;
  // Why it ended: the reason begin gave, or where the launch's wind-down stands after the run.
  ended: string;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export async function runAdsPause(deps: AdsPauseDeps, job: AdsPauseJob): Promise<AdsPauseResult> {
  // A worker that cannot open a token (no credential key) begins nothing: a begin counts a run, and a run that cannot be made must not use up the ten.
  if (deps.broker.id === 'none') return { ran: false, ended: 'no_broker' };
  const options = { actor: SYSTEM, orgId: job.orgId };
  const work = await deps.runtime.execute<PauseBegin>('ads.pause.begin', { launchId: job.launchId, via: 'connection' }, options);
  if (work.action === 'none') return { ran: false, ended: work.reason };
  const record = (result: PauseResultInput) => deps.runtime.execute<PauseRecorded>('ads.pause.record', { launchId: work.launchId, callKey: work.callKey, via: 'connection', result }, options);
  const pauser = work.provider && Object.hasOwn(deps.pausers, work.provider) ? deps.pausers[work.provider] : undefined;
  if (!pauser || !work.connectionId) {
    await record({ kind: 'blocked', code: 'no_pauser' });
    return { ran: false, ended: 'no_pauser' };
  }
  // The token: opened here, for this one run, from the write connection's own sealed copy. A connection that is no longer active, or whose connector may no longer use
  // it, refuses (the kernel's credential query holds both).
  let secret: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: work.connectionId }, options);
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    const code = error instanceof DomainError ? error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64) : 'CREDENTIAL_UNREADABLE';
    await record({ kind: 'blocked', code });
    return { ran: false, ended: code };
  }
  const recorded = await record(await pauseWork(pauser, secret, work));
  return { ran: true, ended: recorded.recorded ? (recorded.state ?? 'recorded') : (recorded.reason ?? 'stale') };
}
