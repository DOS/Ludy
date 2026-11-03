// SPDX-License-Identifier: AGPL-3.0-only
// The launch of an approved campaign at the ad platform (ADR-0043 points 2 to 5, issue #2296, W2-3), run by the worker as the system. An approved plan leaves a
// ledger row (W2-2) and an event; this job runs it: it creates the plan's campaign, ad set and, for each text variant, a creative and an ad at the platform, every
// object PAUSED, and records each platform id. NOTHING IN THIS FILE UN-PAUSES AN OBJECT: a launch ends as objects created and paused (the step `paused`), and the
// activation is W2-4's, behind the caps re-check and the stop conditions. The job is handed the launch writers of this deployment: a frozen view of the writer of
// each provider with the calls of a launch and not one more (`LaunchWriter`), so it cannot revoke a token, change a status or delete anything.
//
// One platform call is three things, in this order, each in its own transaction (the same shape as Social's publish):
// 1. `ads.launch.begin` decides the next call: it re-checks every stop condition, re-reads the caps under the org's lock before the first call, and inserts the
//    call's row in the kernel's `external_call` ledger as `started` (key `ads.launch:<launch>:<attempt>:<step>`), COMMITTED before the platform is called. A row
//    it finds again is never called a second time blind: it says `reconcile` once the row is old enough to be lost, and `none` while a call may still be in flight.
// 2. The call: the job opens the sealed token with the credential broker (here and nowhere else), verifies once that it reaches the account before the first
//    create, resolves the names of the plan's regions and interests to the platform's ids before the ad set, and creates the object; or, for a `reconcile`, asks
//    the platform for the objects that carry the launch's tag and takes the one with exactly the expected name.
// 3. `ads.launch.record` settles the row (`succeeded` with the platform's id and the object's row in the same transaction; `failed`; or `ambiguous` when the answer
//    cannot be told: a timeout, a lost answer, a worker that died). A reconcile that finds nothing re-arms the row for one more call, which the job makes at once.
//
// Whatever dies where, no object is created twice: a worker that dies after the platform answered and before the record leaves a `started` row, which the next run
// reconciles by the tag and finds. The secret lives in one function's scope and is never logged, never put in an error, never sent to a command: the commands see
// ids, codes the platform answered and the objects' own ids.
import { AdPlatformError, type AdTargeting, type AdTargetingResolution, type LaunchWriter } from '@crove/ad-platform';
import { LAUNCH_STEP_PAUSED, type LaunchBegin, type LaunchRecorded, type LaunchResult, type LaunchWriterCaps } from '@crove/mod-ads';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'ads.launch' };

// The calls one run makes at most: a plan has at most eight objects, and a reconcile that finds nothing is followed by its call within the same step.
export const ADS_LAUNCH_MAX_STEPS = 12;
// One platform call (or one resolution of names, which is a few reads) may take this long before it is given up on as unclear; the writer's own requests are
// limited to twenty seconds each and aborted, so no request outlives its call.
const CALL_TIMEOUT_MS = 90_000;

export interface AdsLaunchJob {
  orgId: string;
  launchId: string;
}

export interface AdsLaunchDeps {
  runtime: Runtime;
  // Without one that can open a token (no credential key) nothing is begun.
  broker: CredentialBroker;
  writers: Readonly<Record<string, LaunchWriter>>;
}

export interface AdsLaunchResult {
  // The platform calls this run made (creates and reconciles).
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
function failure(error: unknown): LaunchResult {
  if (error instanceof AdPlatformError) {
    if (error.kind === 'token_expired') return { kind: 'token', code: safeCode(error.code) };
    if (error.kind === 'bad_request' || error.kind === 'permission') return { kind: 'rejected', error: error.kind, code: safeCode(error.code) };
    return { kind: 'unknown', error: error.kind, code: safeCode(error.code) };
  }
  return { kind: 'unknown', error: 'unknown', code: codeOf(error) };
}

// What a failed check before the call means: no call was made, so a refusal ends the run (blocked) and an answer that cannot be told is left to the reconcile.
function beforeCall(error: unknown): LaunchResult {
  if (error instanceof AdPlatformError) {
    if (error.kind === 'token_expired') return { kind: 'token', code: safeCode(error.code) };
    if (error.kind === 'bad_request' || error.kind === 'permission') return { kind: 'blocked', code: safeCode(error.code) ?? error.kind };
    return { kind: 'unknown', error: error.kind, code: safeCode(error.code) };
  }
  return { kind: 'unknown', error: 'unknown', code: codeOf(error) };
}

const capsOf = (writers: Readonly<Record<string, LaunchWriter>>): LaunchWriterCaps[] =>
  Object.entries(writers).map(([provider, writer]) => ({ provider, objectives: [...writer.capabilities.objectives], currencies: writer.capabilities.currencies ? [...writer.capabilities.currencies] : null, media: writer.capabilities.media }));

// One step of a launch from the work begin handed out. Returns whether the run goes on to the next step.
async function runStep(deps: AdsLaunchDeps, job: AdsLaunchJob, writer: LaunchWriter, work: Extract<LaunchBegin, { action: 'call' | 'reconcile' }>): Promise<{ next: boolean; ended: string }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const record = (phase: 'call' | 'reconcile', result: LaunchResult) =>
    deps.runtime.execute<LaunchRecorded>('ads.launch.record', { launchId: work.launchId, callKey: work.callKey, phase, result }, options);
  // The last create recorded ends the run as `paused` (objects created, paused), whatever the result of that step was called.
  const ended = (recorded: LaunchRecorded, why: string) => ({
    next: recorded.recorded && recorded.next === 'continue',
    ended: recorded.recorded ? (recorded.step === LAUNCH_STEP_PAUSED ? LAUNCH_STEP_PAUSED : why) : (recorded.reason ?? 'stale'),
  });

  // The token: opened here, for this one call, from the write connection's own sealed copy. A connection that is no longer active, or whose connector may no
  // longer use it, refuses (the kernel's credential query holds both).
  let secret: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: work.connectionId }, options);
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    const code = error instanceof DomainError ? error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64) : 'CREDENTIAL_UNREADABLE';
    // A reconcile that could not ask leaves the row unclear (the object may exist); a call that was not made ends the run.
    const result: LaunchResult = work.action === 'reconcile' ? { kind: 'unknowable', code } : { kind: 'blocked', code };
    return ended(await record(work.action, result), code);
  }

  if (work.action === 'reconcile') {
    let result: LaunchResult;
    try {
      const found = await timed(() => writer.findByTag(secret, work.account, work.level, work.tag));
      // By the tail of the name (the tag and what the object is: ASCII, so nothing a platform does to the plan's own text in a name can change it). Exactly one
      // object with this step's tail is the one; none at all is missing, and the call may be made again; anything else (two with this tail, or one with the tag and
      // a tail that is not a sibling's: a name the platform changed) cannot be told apart from it, so nothing is created and a person is told.
      const tailOf = (name: string): string | null => {
        const at = name.indexOf(work.tag);
        return at < 0 ? null : name.slice(at);
      };
      const mine = found.filter((o) => tailOf(o.name) === work.tail);
      const strange = found.filter((o) => {
        const tail = tailOf(o.name);
        return tail !== work.tail && (tail === null || !work.otherTails.includes(tail));
      });
      if (mine.length === 1 && strange.length === 0) result = { kind: 'found', externalId: (mine[0] as { id: string }).id };
      else if (mine.length === 0 && strange.length === 0) result = { kind: 'missing' };
      else result = { kind: 'unknowable', code: mine.length > 1 ? 'AMBIGUOUS_MATCH' : 'NAME_MISMATCH' };
    } catch (error) {
      result = { kind: 'unknowable', code: codeOf(error) };
    }
    const recorded = await record('reconcile', result);
    // Found: recorded, and the run goes on. Missing: the row is armed for one more call, made below. Anything else ends the run.
    if (!(result.kind === 'missing' && recorded.recorded && recorded.next === 'call')) return ended(recorded, result.kind);
  }

  // Before the first create: the token reaches the account and can run ads (changes nothing).
  if (work.verify) {
    try {
      const verified = await timed(() => writer.verify(secret, work.account));
      if (!verified.canRunAds) return ended(await record('call', { kind: 'blocked', code: 'cannot_run_ads' }), 'cannot_run_ads');
    } catch (error) {
      const result = beforeCall(error);
      return ended(await record('call', result), result.kind);
    }
  }

  const request = work.request;
  // The ad set needs the platform's ids of the plan's regions and interests (a read): a name it does not know stops the launch with the names listed.
  let targeting: AdTargeting | null = null;
  if (request.level === 'ad_set') {
    const names = request.targeting;
    let resolved: AdTargetingResolution = { regions: [], interests: [], unknown: [] };
    if (names.regions.length > 0 || names.interests.length > 0) {
      try {
        resolved = await timed(() => writer.resolveTargeting(secret, { regions: names.regions, interests: names.interests }));
      } catch (error) {
        const result = beforeCall(error);
        return ended(await record('call', result), result.kind);
      }
      if (resolved.unknown.length > 0) {
        return ended(await record('call', { kind: 'blocked', code: 'targeting_unknown', names: resolved.unknown.slice(0, 30).map((n) => n.slice(0, 100)) }), 'targeting_unknown');
      }
    }
    targeting = {
      countries: names.countries,
      regions: resolved.regions.map((r) => ({ key: r.key, name: r.name })),
      ageMin: names.ageMin,
      ageMax: names.ageMax,
      gender: names.gender,
      interests: resolved.interests.map((i) => ({ id: i.id, name: i.name })),
    };
  }

  let result: LaunchResult;
  try {
    const created = await timed(() => {
      if (request.level === 'campaign') return writer.createCampaign(secret, work.account, { name: request.name, objective: request.objective });
      if (request.level === 'ad_set') {
        return writer.createAdSet(secret, work.account, {
          name: request.name,
          campaignId: request.campaignId,
          objective: request.objective,
          dailyBudget: request.dailyBudget,
          startTime: request.startTime,
          endTime: request.endTime,
          targeting: targeting as AdTargeting,
          pageId: request.pageId,
        });
      }
      if (request.level === 'creative') {
        return writer.createCreative(secret, work.account, { name: request.name, pageId: request.pageId, linkUrl: request.linkUrl, headline: request.headline, primaryText: request.primaryText, callToAction: request.callToAction });
      }
      return writer.createAd(secret, work.account, { name: request.name, adSetId: request.adSetId, creativeId: request.creativeId });
    });
    result = { kind: 'accepted', externalId: created.id };
  } catch (error) {
    result = failure(error);
  }
  return ended(await record('call', result), result.kind);
}

export async function runAdsLaunch(deps: AdsLaunchDeps, job: AdsLaunchJob): Promise<AdsLaunchResult> {
  // A worker that cannot open a token (no credential key) begins nothing: a begin commits a call's row, and a call that cannot be made must not leave one.
  if (deps.broker.id === 'none') return { steps: 0, ended: 'no_broker' };
  const options = { actor: SYSTEM, orgId: job.orgId };
  const writers = capsOf(deps.writers);
  let steps = 0;
  for (let n = 0; n < ADS_LAUNCH_MAX_STEPS; n += 1) {
    const work = await deps.runtime.execute<LaunchBegin>('ads.launch.begin', { launchId: job.launchId, writers }, options);
    if (work.action === 'none') return { steps, ended: work.reason };
    const writer = Object.hasOwn(deps.writers, work.provider) ? deps.writers[work.provider] : undefined;
    if (!writer) return { steps, ended: 'no_writer' };
    steps += 1;
    const done = await runStep(deps, job, writer, work);
    if (!done.next) return { steps, ended: done.ended };
  }
  return { steps, ended: 'max_steps' };
}
