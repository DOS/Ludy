// Connecting a channel or GitHub App through a provider's OAuth dialog (Social plan S6, #5158 ADR-0060).
// Callback / Setup URL on the web app: <APP_URL|PUBLIC_URL>/channels/oauth/<provider>/callback
// (for GitHub App: <APP_URL|PUBLIC_URL>/channels/oauth/github_app/callback).
// The provider returns the browser to that single org-agnostic address, so the screen starting the attempt remembers
// which org (and optional project setup options) it belongs to under the random state.
import { takeMigratedItem, writeMigratedItem } from './storage-migrate.ts';

const PREFIX = 'ludy.oauth.';
const LEGACY_PREFIX = 'crove.oauth.';
const MAX_AGE_MS = 15 * 60 * 1000;

export interface GithubOAuthAttempt {
  slug: string;
  projectId: string;
  taskKeyPrefix: string | null;
  backfillTaskNumbers: boolean;
}

interface Pending {
  slug: string;
  at: number;
  projectId?: string;
  taskKeyPrefix?: string | null;
  backfillTaskNumbers?: boolean;
}

export function rememberOAuthAttempt(state: string, slug: string): void {
  try {
    writeMigratedItem(sessionStorage, PREFIX + state, LEGACY_PREFIX + state, JSON.stringify({ slug, at: Date.now() } satisfies Pending));
  } catch {
    // Storage off (private mode): the callback screen then asks to start again.
  }
}

export function rememberGithubOAuthAttempt(state: string, details: GithubOAuthAttempt): void {
  try {
    writeMigratedItem(
      sessionStorage,
      PREFIX + state,
      LEGACY_PREFIX + state,
      JSON.stringify({
        slug: details.slug,
        projectId: details.projectId,
        taskKeyPrefix: details.taskKeyPrefix,
        backfillTaskNumbers: details.backfillTaskNumbers,
        at: Date.now(),
      } satisfies Pending),
    );
  } catch {
    // Storage off (private mode): the callback screen then asks to start again.
  }
}

// The org slug of the attempt, once: the entry is removed as it is read, and an entry older than the attempt's
// lifetime is ignored.
export function takeOAuthAttempt(state: string): string | null {
  try {
    const raw = takeMigratedItem(sessionStorage, PREFIX + state, LEGACY_PREFIX + state);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<Pending>;
    if (typeof pending.slug !== 'string' || typeof pending.at !== 'number' || Date.now() - pending.at > MAX_AGE_MS) return null;
    return pending.slug;
  } catch {
    return null;
  }
}

export function takeGithubOAuthAttempt(state: string): GithubOAuthAttempt | null {
  try {
    const raw = takeMigratedItem(sessionStorage, PREFIX + state, LEGACY_PREFIX + state);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<Pending>;
    if (
      typeof pending.slug !== 'string' ||
      typeof pending.projectId !== 'string' ||
      typeof pending.at !== 'number' ||
      Date.now() - pending.at > MAX_AGE_MS
    ) {
      return null;
    }
    return {
      slug: pending.slug,
      projectId: pending.projectId,
      taskKeyPrefix: typeof pending.taskKeyPrefix === 'string' ? pending.taskKeyPrefix : null,
      backfillTaskNumbers: pending.backfillTaskNumbers === true,
    };
  } catch {
    return null;
  }
}
