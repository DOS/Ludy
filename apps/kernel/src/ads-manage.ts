// SPDX-License-Identifier: AGPL-3.0-only
// The management of a live launch at the ad platform (ADR-0043 points 4 and 5, issue #3835, ads W4), run by the worker as the system. A person's change (pause, resume, archive,
// a lower or raised daily budget, a shorter or longer schedule) is a row of the changes table and the event `ads.manage.queued`; this job makes the one platform call it
// stands for. A resume, a raise and an extension are approved like a launch, and `ads.manage.begin` re-checks the stop conditions and, for those, the caps under the org's
// lock before EVERY call. The job is handed the managers of this deployment: a frozen view of each provider with a status change, the ad set's budget and end time and a read,
// and not one call more (`AdManager`), apart from the launch job's writers and the activation job's activators.
//
// One platform call is three things, in this order, each in its own transaction:
// 1. `ads.manage.begin` decides the call and inserts its row in the kernel's `external_call` ledger as `started` (key `ads.manage:<change>:apply`), COMMITTED before the
//    platform is called. A row it finds again is read, never called blind: it says `reconcile` once the row is old enough to be lost.
// 2. The call: the job opens the sealed token with the credential broker (here and nowhere else) and changes the one object begin named; or, for a `reconcile`, reads the
//    object and takes "it is as asked" as the answer.
// 3. `ads.manage.record` settles the row and the change (`applied`; `failed`; or the row `ambiguous` when the answer cannot be told).
// A change that stays unclear (three unclear calls or an hour) is settled later by the sweep's read (#3898, `settle: true`): begin hands out the object to read when nothing newer of its
// family has overtaken the change and its last call is old enough, the job reads it through the same view and the same token, and record settles it as applied (the object shows the
// change) or failed (it is as it was), or leaves it unclear when the read cannot be made. No call is made and no ledger row is begun: it never changes what the platform runs.
// The secret lives in one function's scope and is never logged, never put in an error, never sent to a command.
import { AdPlatformError, type AdManager, type ManagedRead } from '@crove/ad-platform';
import { sameAmount, sameInstant, type ManageBegin, type ManageRecorded, type ManageResult } from '@crove/mod-ads';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { recordAfterCall } from './record-after-call.ts';

const SYSTEM = { type: 'system' as const, component: 'ads.manage' };
const CALL_TIMEOUT_MS = 90_000;
// The longest a begun change may wait between `ads.manage.begin` (which re-checked that the launch is live, the switches and the caps) and the platform call. The wind-down of a
// stopped launch waits for a manage call begun less than ACTIVATION_IN_FLIGHT_SECONDS (360) ago, so a call is sent at most this long plus CALL_TIMEOUT_MS (150 seconds) after its
// begin, always inside that wait: a resume, a raise or an extension can never reach the platform after the launch was wound down. A begin that waited longer is never called and records nothing (the row
// stays as begin left it, and a later begin reads the object first).
export const BEGIN_TO_CALL_MS = 60_000;

export interface AdsManageJob {
  orgId: string;
  changeId: string;
  // A change that ended unclear, to settle by reading its object (#3898): the job reads and settles it, and calls nothing.
  settle?: boolean;
}

export interface AdsManageDeps {
  runtime: Runtime;
  // Without one that can open a token (no credential key) nothing is begun.
  broker: CredentialBroker;
  managers: Readonly<Record<string, AdManager>>;
  // The clock the bound above is read with (milliseconds, monotonic: an NTP step cannot shorten it); the real one unless a test sets it.
  now?: () => number;
}

export interface AdsManageRunResult {
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
function failure(error: unknown): ManageResult {
  if (error instanceof AdPlatformError) {
    if (error.kind === 'token_expired') return { kind: 'token', code: safeCode(error.code) };
    if (error.kind === 'bad_request' || error.kind === 'permission') return { kind: 'rejected', error: error.kind, code: safeCode(error.code) };
    return { kind: 'unknown', error: error.kind, code: safeCode(error.code) };
  }
  return { kind: 'unknown', error: 'unknown', code: codeOf(error) };
}

type Work = Extract<ManageBegin, { action: 'call' | 'reconcile' | 'settle' }>;

// Whether a read of the object shows the change is made: the status is the one asked for, the budget is the one asked for (as decimals), or the end time is the same instant.
function landed(work: Work, read: ManagedRead): boolean {
  if (work.toStatus !== null) return read.status === work.toStatus;
  if (work.toBudget !== null) return read.dailyBudget !== null && sameAmount(read.dailyBudget, work.toBudget);
  if (work.toEndTime !== null) return read.endTime !== null && sameInstant(read.endTime, work.toEndTime);
  return false;
}

// The one call of the change, by what the change is.
async function make(manager: AdManager, secret: string, work: Work): Promise<void> {
  const target = { level: work.level, id: work.objectId };
  if (work.toStatus !== null) return manager.changeStatus(secret, target, work.toStatus);
  if (work.toBudget !== null) return manager.setBudget(secret, target, work.account, work.toBudget);
  if (work.toEndTime !== null) return manager.setEndTime(secret, target, work.toEndTime);
  throw new AdPlatformError('bad_request', 'NOTHING_TO_CHANGE');
}

// The change from the work begin handed out. Returns why the run ended.
async function runChange(deps: AdsManageDeps, job: AdsManageJob, manager: AdManager, work: Work, beganAt: number): Promise<string> {
  const now = deps.now ?? (() => performance.now());
  const stale = () => now() - beganAt > BEGIN_TO_CALL_MS;
  const options = { actor: SYSTEM, orgId: job.orgId };
  const record = (phase: 'call' | 'reconcile' | 'settle', result: ManageResult) =>
    recordAfterCall('ads.manage.record', () => deps.runtime.execute<ManageRecorded>('ads.manage.record', { changeId: work.changeId, callKey: work.callKey, phase, result }, options));
  const ended = (recorded: ManageRecorded, why: string) => (recorded.recorded ? (recorded.state === 'applied' ? 'applied' : why) : (recorded.reason ?? 'stale'));

  // The token: opened here, for this one call, from the write connection's own sealed copy. A connection that is no longer active, or whose connector may no longer use it,
  // refuses (the kernel's credential query holds both).
  let secret: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: work.connectionId }, options);
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    const code = error instanceof DomainError ? error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64) : 'CREDENTIAL_UNREADABLE';
    // A begin that waited too long (a stalled worker) records nothing here either: the connection may have closed just after another worker took the row and made the call, and a
    // `blocked` from this one would then fail a change whose call landed. The row stays as begin left it, so a later begin reads the object before anything is sent.
    if (work.action === 'call' && stale()) return 'stale_begin';
    // A read that could not ask leaves the row unclear (the change may have landed); a call that was not made ends the change.
    const result: ManageResult = work.action === 'call' ? { kind: 'blocked', code } : { kind: 'unknowable', code };
    return ended(await record(work.action, result), code);
  }

  const target = { level: work.level, id: work.objectId };
  if (work.action === 'reconcile' || work.action === 'settle') {
    let result: ManageResult;
    try {
      const read = await timed(() => manager.read(secret, target, work.account));
      // Landed: recorded, never asked again. Not landed: the call may be made again (begin re-checked everything and the record checks the stop conditions once more).
      result = landed(work, read) ? { kind: 'found' } : { kind: 'missing' };
    } catch (error) {
      result = { kind: 'unknowable', code: codeOf(error) };
    }
    // The sweep's read of an unclear change (#3898): found settles it as applied, missing as failed, a read that could not be made leaves it unclear. Never a call, and the clock of
    // begin does not matter: a read changes nothing.
    if (work.action === 'settle') return ended(await record('settle', result), result.kind === 'missing' ? 'not_applied' : result.kind);
    const recorded = await record('reconcile', result);
    if (!(result.kind === 'missing' && recorded.recorded && recorded.next === 'call')) return ended(recorded, result.kind);
    // The read took too long since begin: no call now (the change stays queued, and a later begin reads it again before anything is sent).
    if (stale()) return 'stale_begin';
  }
  // A begin that waited too long (a stalled worker) is never called: the launch may have been stopped and wound down meanwhile.
  // Nothing is recorded for it (never `blocked`, which fails the change and releases what it holds): another worker may have taken the row meanwhile and sent the call, and a record
  // from this one would then undo what that one did. The row stays as begin left it, so a later begin reads the object before anything is sent.
  if (work.action === 'call' && stale()) return 'stale_begin';

  let result: ManageResult;
  try {
    await timed(() => make(manager, secret, work));
    result = { kind: 'accepted' };
  } catch (error) {
    result = failure(error);
  }
  return ended(await record('call', result), result.kind);
}

export async function runAdsManage(deps: AdsManageDeps, job: AdsManageJob): Promise<AdsManageRunResult> {
  // A worker that cannot open a token (no credential key) begins nothing: a begin commits a call's row, and a call that cannot be made must not leave one.
  if (deps.broker.id === 'none') return { steps: 0, ended: 'no_broker' };
  const options = { actor: SYSTEM, orgId: job.orgId };
  const providers = Object.keys(deps.managers);
  const beganAt = (deps.now ?? (() => performance.now()))();
  const work = await deps.runtime.execute<ManageBegin>('ads.manage.begin', { changeId: job.changeId, providers, ...(job.settle === true ? { settle: true } : {}) }, options);
  if (work.action === 'none') return { steps: 0, ended: work.reason };
  const manager = Object.hasOwn(deps.managers, work.provider) ? deps.managers[work.provider] : undefined;
  if (!manager) return { steps: 0, ended: 'no_manager' };
  return { steps: 1, ended: await runChange(deps, job, manager, work, beganAt) };
}
