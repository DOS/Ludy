// SPDX-License-Identifier: AGPL-3.0-only
// What the pause worker is given of an ad platform's writer (ADR-0043 points 4 and 7a, issue #2296, W2-4a): one call, the one that pauses what a launch made, and
// nothing else. A launch that is stopped (a person's stop, the switch-off, the kill switch) leaves objects at the platform that Ludy created; this finds them and
// pauses them. It is a new, frozen object that calls the writer's methods through a closure, like the revoke worker's view (revokers.ts) and the launch job's
// (launch-writers.ts), so what a pause job holds cannot create, activate, archive, verify or revoke anything, not even by a cast: the only change of an object's
// status it can make is PAUSED, and it can make it only to an object the launch's tag finds or Ludy has recorded for the launch.
//
// The objects are found by the launch's tag as well as taken from what Ludy recorded, so an object whose create was in flight when the launch was stopped, or
// whose record was lost, is paused too. A level whose list cannot be read in full (the platform answered with more pages than the first, or failed) is reported
// as not listed: the caller keeps the launch unfinished and asks again, never "nothing more to pause".
import { AdPlatformError, type AdPlatformErrorKind } from './index.ts';
import type { AdFoundObject, AdObjectLevel, AdWriter, AdWriterAccount } from './writer.ts';

// The levels that have a status of their own to pause. A creative has none: it does not deliver until an ad that uses it is active.
export const PAUSE_LEVELS = ['campaign', 'ad_set', 'ad'] as const;
export type PauseLevel = (typeof PAUSE_LEVELS)[number];

export interface PauseLaunchInput {
  // The launch's tag (`ludy:` and ten characters): what its objects' names carry.
  tag: string;
  // The objects Ludy recorded for the launch: their names carry the tag (the database holds that), so they are paused whether or not the list shows them.
  known: ReadonlyArray<{ level: AdObjectLevel; id: string }>;
}

export interface PauseFailure {
  level: PauseLevel;
  id: string;
  kind: AdPlatformErrorKind;
  code: string | null;
}

export type PauseListing = { ok: true } | { ok: false; kind: AdPlatformErrorKind; code: string | null };

export interface PauseResult {
  // For each level that has a status: whether the platform's list of the objects that carry the tag was read in full.
  listed: Readonly<Record<PauseLevel, PauseListing>>;
  // Every object the tag found, each with the name it carries (the caller records the ones Ludy had not recorded).
  found: ReadonlyArray<AdFoundObject & { level: AdObjectLevel }>;
  // The objects the platform confirmed as paused, and the ones it refused or could not be asked about.
  paused: ReadonlyArray<{ level: PauseLevel; id: string }>;
  failed: readonly PauseFailure[];
  // The objects not tried because the run stopped early (the token was refused, or the platform asked to wait).
  notTried: number;
  // The token was refused (`token_expired`): nothing more can be paused with it.
  tokenRefused: boolean;
  // The platform's own time to wait, when it named one.
  retryAt: Date | null;
}

export interface AdPauser {
  // Finds the objects that carry the launch's tag, and pauses those and the recorded ones: campaign first, then the ad sets, then the ads (a paused campaign
  // stops everything under it at once). Never throws a platform error: each is in the result.
  pauseLaunch(secret: string, account: AdWriterAccount, input: PauseLaunchInput): Promise<PauseResult>;
}

const codeOf = (error: unknown): { kind: AdPlatformErrorKind; code: string | null } =>
  error instanceof AdPlatformError ? { kind: error.kind, code: error.code && /^[A-Za-z0-9_.]{1,64}$/.test(error.code) ? error.code : null } : { kind: 'unknown', code: 'ADAPTER_ERROR' };

// The procedure, over the two calls it needs. Exported for the view builder and its tests; nothing outside this package calls a writer's `setStatus`.
export async function pauseLaunchWith(writer: Pick<AdWriter, 'findByTag' | 'setStatus'>, secret: string, account: AdWriterAccount, input: PauseLaunchInput): Promise<PauseResult> {
  const listed = {} as Record<PauseLevel, PauseListing>;
  const found: Array<AdFoundObject & { level: AdObjectLevel }> = [];
  const targets = new Map<PauseLevel, Set<string>>(PAUSE_LEVELS.map((level) => [level, new Set<string>()]));
  for (const known of input.known) if ((PAUSE_LEVELS as readonly string[]).includes(known.level)) targets.get(known.level as PauseLevel)?.add(known.id);
  let tokenRefused = false;
  let retryAt: Date | null = null;
  for (const level of PAUSE_LEVELS) {
    if (tokenRefused) {
      listed[level] = { ok: false, kind: 'token_expired', code: null };
      continue;
    }
    try {
      const objects = await writer.findByTag(secret, account, level, input.tag);
      listed[level] = { ok: true };
      for (const object of objects) {
        found.push({ ...object, level });
        targets.get(level)?.add(object.id);
      }
    } catch (error) {
      const why = codeOf(error);
      listed[level] = { ok: false, ...why };
      if (why.kind === 'token_expired') tokenRefused = true;
      if (error instanceof AdPlatformError && error.retryAt && (!retryAt || error.retryAt > retryAt)) retryAt = error.retryAt;
    }
  }
  const paused: Array<{ level: PauseLevel; id: string }> = [];
  const failed: PauseFailure[] = [];
  let notTried = 0;
  let stopped = tokenRefused;
  for (const level of PAUSE_LEVELS) {
    for (const id of [...(targets.get(level) ?? [])].sort()) {
      if (stopped) {
        notTried += 1;
        continue;
      }
      try {
        await writer.setStatus(secret, { level, id }, 'paused');
        paused.push({ level, id });
      } catch (error) {
        const why = codeOf(error);
        failed.push({ level, id, ...why });
        // A refused token will refuse every other call, and a platform that asks to wait is not asked again now.
        if (why.kind === 'token_expired') tokenRefused = true;
        if (why.kind === 'token_expired' || why.kind === 'rate_limited') {
          stopped = true;
          if (error instanceof AdPlatformError && error.retryAt && (!retryAt || error.retryAt > retryAt)) retryAt = error.retryAt;
        }
      }
    }
  }
  return { listed, found, paused, failed, notTried, tokenRefused, retryAt };
}

// The view a pause job is given of a writer. The deployment's map of these, by provider, is built next to the launch writers (launch-writers.ts, `adPausers`).
export function pauserOf(writer: Pick<AdWriter, 'findByTag' | 'setStatus'>): AdPauser {
  return Object.freeze({ pauseLaunch: (secret: string, account: AdWriterAccount, input: PauseLaunchInput) => pauseLaunchWith(writer, secret, account, input) });
}
