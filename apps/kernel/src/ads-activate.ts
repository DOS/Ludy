// SPDX-License-Identifier: AGPL-3.0-only
// The activation of an approved launch at the ad platform (ADR-0043 points 4 and 5, issue #2296, W2-4b), run by the worker as the system. The launch job (ads-launch.ts) leaves
// a launch as objects created and paused and writes the event `ads.activate.queued`; this job switches those objects on, one platform call at a time, each ad first, then the
// ad set, then the campaign LAST. It continues the launch's own approval (no second one): the database refuses the move of the launch to live unless the stamped approved
// proposal, the recorded objects, the settled activations, the switches and the flight all hold, and `ads.activate.begin` re-checks the stop conditions, the plan and the caps
// before EVERY call. The job is handed the activators of this deployment: a frozen view of each provider with `activate` and `readStatus` and not one call more
// (`AdActivator`), apart from the launch job's writers, so the view that creates cannot switch anything on.
//
// One platform call is three things, in this order, each in its own transaction:
// 1. `ads.activate.begin` decides the next call and inserts its row in the kernel's `external_call` ledger as `started` (key `ads.launch:<launch>:<attempt>:activate_<slot>`),
//    COMMITTED before the platform is called. A row it finds again is read, never called blind: it says `reconcile` once the row is old enough to be lost.
// 2. The call: the job opens the sealed token with the credential broker (here and nowhere else) and switches the one object on that begin named; or, for a `reconcile`,
//    reads the object's status and takes "active" as the answer.
// 3. `ads.activate.record` settles the row (`succeeded`; `failed`; or `ambiguous` when the answer cannot be told). When every object is on, the record moves the launch to live.
// The secret lives in one function's scope and is never logged, never put in an error, never sent to a command.
import { AdPlatformError, type AdActivator } from '@crove/ad-platform';
import type { ActivateBegin, ActivateRecorded, ActivateResult } from '@crove/mod-ads';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'ads.activate' };

// The calls one run makes at most: a plan has at most five objects that deliver (three ads, the ad set, the campaign), and a read that shows an object off is followed by
// its call within the same step.
export const ADS_ACTIVATE_MAX_STEPS = 10;
const CALL_TIMEOUT_MS = 90_000;

export interface AdsActivateJob {
  orgId: string;
  launchId: string;
}

export interface AdsActivateDeps {
  runtime: Runtime;
  // Without one that can open a token (no credential key) nothing is begun.
  broker: CredentialBroker;
  activators: Readonly<Record<string, AdActivator>>;
}

export interface AdsActivateRunResult {
  // The platform calls this run made (changes and reads).
  steps: number;
  // Why it ended: the reason begin gave, or what stopped the run.
  ended: string;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

class Timeout extends Error {}

function timed<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout('timeout')), CALL_TIMEOUT_MS);
    run().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('call failed'));
      },
    );
  });
}

// A code safe to record: the platform's own error code, or the class of a failure that is not the platform's (never a message, which a value could be in).
const safeCode = (code: string | undefined): string | null => (code && /^[A-Za-z0-9_.]{1,64}$/.test(code) ? code : null);
const codeOf = (error: unknown): string => {
  if (error instanceof AdPlatformError) return safeCode(error.code) ?? error.kind;
  if (error instanceof Timeout) return 'TIMEOUT';
  return 'ADAPTER_ERROR';
};

// What a failed platform call means for the record.
function failure(error: unknown): ActivateResult {
  if (error instanceof AdPlatformError) {
    if (error.kind === 'token_expired') return { kind: 'token', code: safeCode(error.code) };
    if (error.kind === 'bad_request' || error.kind === 'permission') return { kind: 'rejected', error: error.kind, code: safeCode(error.code) };
    return { kind: 'unknown', error: error.kind, code: safeCode(error.code) };
  }
  return { kind: 'unknown', error: 'unknown', code: codeOf(error) };
}

// One object from the work begin handed out. Returns whether the run goes on to the next object.
async function runStep(deps: AdsActivateDeps, job: AdsActivateJob, activator: AdActivator, work: Extract<ActivateBegin, { action: 'call' | 'reconcile' }>): Promise<{ next: boolean; ended: string }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const record = (phase: 'call' | 'reconcile', result: ActivateResult) =>
    deps.runtime.execute<ActivateRecorded>('ads.activate.record', { launchId: work.launchId, callKey: work.callKey, phase, result }, options);
  const ended = (recorded: ActivateRecorded, why: string) => ({
    next: recorded.recorded && recorded.next === 'continue',
    ended: recorded.recorded ? (recorded.state === 'live' ? 'live' : why) : (recorded.reason ?? 'stale'),
  });

  // The token: opened here, for this one call, from the write connection's own sealed copy. A connection that is no longer active, or whose connector may no longer use
  // it, refuses (the kernel's credential query holds both).
  let secret: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: work.connectionId }, options);
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    const code = error instanceof DomainError ? error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64) : 'CREDENTIAL_UNREADABLE';
    // A read that could not ask leaves the row unclear (the object may be on); a call that was not made ends the run.
    const result: ActivateResult = work.action === 'reconcile' ? { kind: 'unknowable', code } : { kind: 'blocked', code };
    return ended(await record(work.action, result), code);
  }

  const target = { level: work.level, id: work.objectId };
  if (work.action === 'reconcile') {
    let result: ActivateResult;
    try {
      const read = await timed(() => activator.readStatus(secret, target));
      // Active: it is on, recorded, never asked again. Paused: the call may be made again (begin re-checked everything and the record checks the stop conditions once
      // more). Anything else (archived, deleted, a status Ludy does not name) cannot be told apart from an object that was changed by someone else, so a person is told.
      result = read.status === 'active' ? { kind: 'found' } : read.status === 'paused' ? { kind: 'missing' } : { kind: 'unknowable', code: `STATUS_${read.status}`.toUpperCase() };
    } catch (error) {
      result = { kind: 'unknowable', code: codeOf(error) };
    }
    const recorded = await record('reconcile', result);
    if (!(result.kind === 'missing' && recorded.recorded && recorded.next === 'call')) return ended(recorded, result.kind);
  }

  let result: ActivateResult;
  try {
    await timed(() => activator.activate(secret, target));
    result = { kind: 'accepted' };
  } catch (error) {
    result = failure(error);
  }
  return ended(await record('call', result), result.kind);
}

export async function runAdsActivate(deps: AdsActivateDeps, job: AdsActivateJob): Promise<AdsActivateRunResult> {
  // A worker that cannot open a token (no credential key) begins nothing: a begin commits a call's row, and a call that cannot be made must not leave one.
  if (deps.broker.id === 'none') return { steps: 0, ended: 'no_broker' };
  const options = { actor: SYSTEM, orgId: job.orgId };
  const providers = Object.keys(deps.activators);
  let steps = 0;
  for (let n = 0; n < ADS_ACTIVATE_MAX_STEPS; n += 1) {
    const work = await deps.runtime.execute<ActivateBegin>('ads.activate.begin', { launchId: job.launchId, providers }, options);
    if (work.action === 'none') return { steps, ended: work.reason };
    const activator = Object.hasOwn(deps.activators, work.provider) ? deps.activators[work.provider] : undefined;
    if (!activator) return { steps, ended: 'no_activator' };
    steps += 1;
    const done = await runStep(deps, job, activator, work);
    if (!done.next) return { steps, ended: done.ended };
  }
  return { steps, ended: 'max_steps' };
}
