// SPDX-License-Identifier: AGPL-3.0-only
// What the state job is given of an ad platform (issue #3301, plan docs/plan/ads-write.md sections 4, 9 and 10 W2 step 3): one call, the read of the states of the objects a
// launch made, and nothing else. The platform reports each object's own status (`effective_status`: in review, active, paused, disapproved, with issues) and, for an ad
// that was refused, why. Ludy shows that and never acts on it: it is a READ, so the view has no way to create, change, pause, activate, archive, verify or revoke anything,
// not even by a cast. Like the other narrowed views (pausers.ts, activators.ts) it is a new, frozen object built from a source adapter's single read method.
//
// What the platform says is tainted. The view lets through only what fits what the database stores: a status of upper-case words and underscores (at most 40 characters) and a
// reason that is a short CODE (lower-case letters, digits and underscores, at most 60), never a sentence the platform wrote. The adapter maps the platform's feedback to such a
// code; anything that does not fit is a failed read of that object (`BAD_STATE`), never stored.
import { AdPlatformError, type AdPlatformErrorKind } from './index.ts';

// The levels that have a status of their own to read. A creative has none at the level of an ad: it delivers once an ad that uses it is on.
export const STATE_LEVELS = ['campaign', 'ad_set', 'ad'] as const;
export type StateLevel = (typeof STATE_LEVELS)[number];

export interface StateTarget {
  level: StateLevel;
  id: string;
}

// The most objects one read is asked about: a launch has at most a campaign, an ad set and three ads.
export const STATE_READ_MAX = 12;

const STATUS = /^[A-Z_]{1,40}$/;
const REASON = /^[a-z0-9_]{1,60}$/;

// What the platform says of one object: its status and a reason code, or that it no longer has it (deleted at the platform and gone from its answers).
export type ObjectState = { id: string; level: StateLevel; found: true; status: string; reason: string | null } | { id: string; level: StateLevel; found: false };

export interface StateFailure {
  id: string;
  level: StateLevel;
  kind: AdPlatformErrorKind;
  code: string | null;
}

export interface StateReadResult {
  // The objects the platform answered for, in the order asked.
  states: readonly ObjectState[];
  // The objects it could not be asked about or whose answer cannot be used: each with the kind and a code, never a message.
  failed: readonly StateFailure[];
  // The token was refused (`token_expired`): nothing more can be read with it.
  tokenRefused: boolean;
  // The platform's own time to wait, when it named one.
  retryAt: Date | null;
}

// What an adapter implements: one object, one read. `null` is "the platform has no such object" (as opposed to a failure).
export interface AdObjectStateSource {
  // A failure is an `AdPlatformError`.
  readState(secret: string, object: StateTarget): Promise<{ status: string; reason: string | null } | null>;
}

export interface AdStateReader {
  // Reads each object once, in the order given, and stops early when the token is refused or the platform asks to wait (the rest are reported as failed with that kind).
  // Never throws a platform error: each is in the result.
  readStates(secret: string, objects: readonly StateTarget[]): Promise<StateReadResult>;
}

const codeOf = (error: unknown): { kind: AdPlatformErrorKind; code: string | null } =>
  error instanceof AdPlatformError ? { kind: error.kind, code: error.code && /^[A-Za-z0-9_.]{1,64}$/.test(error.code) ? error.code : null } : { kind: 'unknown', code: 'ADAPTER_ERROR' };

// The procedure over the one call it needs. Exported for the view builder and its tests.
export async function readStatesWith(source: AdObjectStateSource, secret: string, objects: readonly StateTarget[]): Promise<StateReadResult> {
  const states: ObjectState[] = [];
  const failed: StateFailure[] = [];
  let tokenRefused = false;
  let retryAt: Date | null = null;
  let stopped: AdPlatformErrorKind | null = null;
  const seen = new Set<string>();
  for (const object of objects.slice(0, STATE_READ_MAX)) {
    if (!(STATE_LEVELS as readonly string[]).includes(object.level)) {
      failed.push({ id: object.id, level: object.level, kind: 'bad_request', code: 'LEVEL_NOT_READABLE' });
      continue;
    }
    // One read per object, whatever the caller listed.
    if (seen.has(`${object.level}:${object.id}`)) continue;
    seen.add(`${object.level}:${object.id}`);
    if (stopped) {
      failed.push({ id: object.id, level: object.level, kind: stopped, code: null });
      continue;
    }
    try {
      const answer = await source.readState(secret, { level: object.level, id: object.id });
      if (answer === null) {
        states.push({ id: object.id, level: object.level, found: false });
      } else if (!STATUS.test(answer.status) || (answer.reason !== null && !REASON.test(answer.reason))) {
        failed.push({ id: object.id, level: object.level, kind: 'unknown', code: 'BAD_STATE' });
      } else {
        states.push({ id: object.id, level: object.level, found: true, status: answer.status, reason: answer.reason });
      }
    } catch (error) {
      const why = codeOf(error);
      failed.push({ id: object.id, level: object.level, ...why });
      // A refused token refuses every other call, and a platform that asks to wait is not asked again now.
      if (why.kind === 'token_expired' || why.kind === 'rate_limited') {
        stopped = why.kind;
        if (why.kind === 'token_expired') tokenRefused = true;
        if (error instanceof AdPlatformError && error.retryAt && (!retryAt || error.retryAt > retryAt)) retryAt = error.retryAt;
      }
    }
  }
  return { states, failed, tokenRefused, retryAt };
}

// The frozen view a state job is given of a source: `readStates` and not one call more. The deployment's map of these, by provider, is built next to the launch writers
// (launch-writers.ts, `adStateReaders`).
export function stateReaderOf(source: AdObjectStateSource): AdStateReader {
  return Object.freeze({ readStates: (secret: string, objects: readonly StateTarget[]) => readStatesWith(source, secret, objects) });
}
