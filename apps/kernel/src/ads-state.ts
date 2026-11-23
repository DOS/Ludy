// SPDX-License-Identifier: AGPL-3.0-only
// The read of the platform's object states into the launches of an ad account (issue #3301, plan docs/plan/ads-write.md sections 4, 9 and 10 W2 step 3), run by the worker as the
// system after the account's hourly sync (and so on every refresh a person asks for): a launch creates its objects paused and switches them on, the platform reviews them, and
// this job asks what it says of each (`effective_status`, and the reason a review gave) and records it for the screen. It is a READ: the job is given the narrowed `AdStateReader`
// of its provider, which has `readStates` and no other call, so what it holds cannot create, change, pause, activate or revoke anything, and what it records is display fields
// of the launch's own objects (ads.object.sync_state), never a cap, a commitment or the launch's status.
//
// One run is three things, in this order: `ads.object.sync_target` (a query) names the launches that still have objects to read and the write connection they were made through;
// the job opens that connection's sealed token with the credential broker (here and nowhere else); and for each launch it reads the objects and hands the answer, with every failure,
// to `ads.object.sync_state`. A platform that is down, a token that was refused, a rate limit or an object that is gone leaves the last known state and is recorded as a failed read
// of the launch: the sync of the account, and the launch, are never failed by it, and the run itself never throws. The secret lives in one function's scope and is never logged,
// never put in an error, never sent to a command.
import type { AdStateReader, StateReadResult, StateTarget } from '@ludy/ad-platform';
import type { ObjectSynced, StateSyncTarget } from '@ludy/mod-ads';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'ads.state' };
// A launch's objects are a handful of one-object reads; the whole read is given up on after this long, and the launch keeps its last known state.
export const READ_TIMEOUT_MS = 120_000;

export interface AdsStateJob {
  orgId: string;
  // The read connection of the account, which the account's sync is queued by (the target query finds the write connection from it).
  connectionId: string;
}

export interface AdsStateDeps {
  runtime: Runtime;
  // Without one that can open a token (no credential key) nothing is read.
  broker: CredentialBroker;
  readers: Readonly<Record<string, AdStateReader>>;
  // The deadline of one launch's read, in milliseconds (the tests' own).
  timeoutMs?: number;
}

export interface AdsStateResult {
  // The launches whose objects were read, and the objects whose status or reason changed.
  launches: number;
  changed: number;
  // The launches whose read failed in whole or in part.
  failed: number;
  // Why it ended early, or 'done'.
  ended: string;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

class Timeout extends Error {}

// Runs one read with a deadline: when it passes, the read is told to stop (its signal aborts, so the view makes no further request) and this gives up waiting.
function timed<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout('timeout'));
    }, timeoutMs);
    run(controller.signal).then(
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

type Failed = StateReadResult['failed'][number];
// Every object of a launch as a failed read, for a read that could not be made at all.
const allFailed = (objects: readonly StateTarget[], kind: Failed['kind'], code: string): Failed[] => objects.map((o) => ({ id: o.id, level: o.level, kind, code }));

export async function runAdsStateSync(deps: AdsStateDeps, job: AdsStateJob): Promise<AdsStateResult> {
  const result: AdsStateResult = { launches: 0, changed: 0, failed: 0, ended: 'done' };
  // A worker that cannot open a token (no credential key) reads nothing.
  if (deps.broker.id === 'none') return { ...result, ended: 'no_broker' };
  const options = { actor: SYSTEM, orgId: job.orgId };
  let target: StateSyncTarget | null;
  try {
    target = await deps.runtime.query<StateSyncTarget | null>('ads.object.sync_target', { connectionId: job.connectionId }, options);
  } catch (error) {
    return { ...result, ended: error instanceof DomainError ? error.code.slice(0, 64) : 'TARGET_ERROR' };
  }
  if (!target) return { ...result, ended: 'nothing' };
  const reader = Object.hasOwn(deps.readers, target.provider) ? deps.readers[target.provider] : undefined;
  if (!reader) return { ...result, ended: 'no_reader' };

  const record = async (launchId: string, read: Pick<StateReadResult, 'states' | 'failed'>): Promise<boolean> => {
    try {
      const done = await deps.runtime.execute<ObjectSynced>(
        'ads.object.sync_state',
        { launchId, states: read.states.map((s) => (s.found ? { id: s.id, level: s.level, found: true, status: s.status, reason: s.reason } : { id: s.id, level: s.level, found: false })), failed: read.failed.map((f) => ({ id: f.id, level: f.level, kind: f.kind, code: f.code })) },
        options,
      );
      result.changed += done.changed ?? 0;
      return true;
    } catch {
      // A command that refused (the app is off, the launch went) leaves the last known state; nothing of the platform's answer is logged.
      return false;
    }
  };

  // The token: opened here, for this run, from the write connection's own sealed copy. A connection that is no longer active, or whose connector may no longer use it, refuses
  // (the kernel's credential query holds both): every launch then records a failed read.
  let secret: string | null = null;
  let credentialCode = '';
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.writeConnectionId }, options);
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    credentialCode = error instanceof DomainError ? error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64) : 'CREDENTIAL_UNREADABLE';
  }

  for (const launch of target.launches) {
    result.launches += 1;
    const asked: StateTarget[] = launch.objects.map((o) => ({ level: o.level, id: o.id }));
    if (secret === null) {
      result.failed += 1;
      await record(launch.launchId, { states: [], failed: allFailed(asked, 'permission', credentialCode) });
      continue;
    }
    let read: StateReadResult;
    try {
      read = await timed((signal) => reader.readStates(secret as string, asked, signal), deps.timeoutMs ?? READ_TIMEOUT_MS);
    } catch (error) {
      read = { states: [], failed: allFailed(asked, 'transient', error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR'), tokenRefused: false, retryAt: null };
    }
    if (read.failed.length > 0) result.failed += 1;
    await record(launch.launchId, read);
    // A refused token refuses every other launch's read, and a platform that asked to wait is not asked again now: the rest are left to the next run.
    const limited = read.retryAt !== null || read.failed.some((f) => f.kind === 'rate_limited');
    if (read.tokenRefused || limited) {
      result.ended = read.tokenRefused ? 'token_refused' : 'rate_limited';
      break;
    }
  }
  return result;
}
