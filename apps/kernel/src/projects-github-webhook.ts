// SPDX-License-Identifier: AGPL-3.0-only
// Public GitHub webhook HTTP intake handlers (App global HMAC intake and PAT per-hook intake; #5158, ADR-0060).
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'kysely';
import {
  MAX_GITHUB_WEBHOOK_BYTES,
  extractUnverifiedInstallationId,
  isAllowedGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from '@ludy/github';
import { entitledTo, type Runtime } from '@ludy/kernel-runtime';
import type { SignBilling } from './sign-link.ts';

export const GITHUB_WEBHOOK_PATH = '/api/projects/github/webhook';
export const GITHUB_PAT_WEBHOOK_PATH = '/api/projects/github/webhook/:hookKey';
export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
export const GITHUB_EVENT_HEADER = 'x-github-event';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';
export const GITHUB_HOOK_KEY_LENGTH = 32;
export const GITHUB_WEBHOOK_ADDRESS_LIMIT_PER_MINUTE = 300;
export const GITHUB_PAT_HOOK_BUDGET_PER_MINUTE = 60;
export { MAX_GITHUB_WEBHOOK_BYTES };

const HOOK_KEY_RE = new RegExp(`^[A-Za-z0-9_-]{${GITHUB_HOOK_KEY_LENGTH}}$`);
const INSTALLATION_ID_RE = /^[1-9][0-9]{0,18}$/;

const hasControlChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isCleanHeader = (value: string | undefined, maxLen: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= maxLen && !hasControlChar(value);

export const isGithubHookKey = (hookKey: string): boolean => HOOK_KEY_RE.test(hookKey);

export const githubHookKeyHash = (hookKey: string): string =>
  createHash('sha256').update(hookKey, 'utf8').digest('hex');

export const githubOAuthStateDigest = (nonce: string, projectId: string): string =>
  `sha256:${createHmac('sha256', projectId.toLowerCase()).update(nonce, 'utf8').digest('hex')}`;

export interface GithubAppWebhookConfig {
  readonly appWebhookSecret: string;
  readonly appWebhookSecretPrevious?: string | undefined;
}

export interface GithubWebhookBudget {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export interface GithubAppWebhookRequest {
  readonly signature256: string | undefined;
  readonly eventType: string | undefined;
  readonly deliveryId: string | undefined;
  readonly body: Uint8Array;
}

export type GithubAppWebhookOutcome =
  | { readonly status: 202; readonly queued: true }
  | { readonly status: 200; readonly ignored: true }
  | { readonly status: 400; readonly code: 'WEBHOOK_MALFORMED' }
  | { readonly status: 401; readonly code: 'WEBHOOK_UNAUTHORIZED' }
  | { readonly status: 503; readonly code: 'GITHUB_WEBHOOK_BUSY' };

export async function acceptGithubAppWebhook(
  runtime: Runtime,
  cfg: GithubAppWebhookConfig,
  request: GithubAppWebhookRequest,
): Promise<GithubAppWebhookOutcome> {
  if (
    request.body.byteLength === 0 ||
    request.body.byteLength > MAX_GITHUB_WEBHOOK_BYTES ||
    !isCleanHeader(request.signature256, 128)
  ) {
    return { status: 401, code: 'WEBHOOK_UNAUTHORIZED' };
  }

  const secrets = [
    cfg.appWebhookSecret,
    ...(cfg.appWebhookSecretPrevious ? [cfg.appWebhookSecretPrevious] : []),
  ].filter((s) => s.length > 0);
  if (!verifyGithubWebhookSignature(request.body, request.signature256, secrets)) {
    return { status: 401, code: 'WEBHOOK_UNAUTHORIZED' };
  }

  const eventType = request.eventType?.trim();
  if (!eventType || !isCleanHeader(eventType, 64)) {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }
  if (!isAllowedGithubWebhookEvent(eventType)) {
    // GitHub App setup emits ping / unsupported events: acknowledge verified deliveries cleanly without queueing.
    return { status: 200, ignored: true };
  }
  if (!isCleanHeader(request.deliveryId, 128)) {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }

  const installationIdRaw = extractUnverifiedInstallationId(request.body);
  const installationId =
    installationIdRaw !== null && Number.isSafeInteger(installationIdRaw) && INSTALLATION_ID_RE.test(String(installationIdRaw))
      ? String(installationIdRaw)
      : null;

  const outcome = await runtime.orgless(async (db) => {
    try {
      const { rows } = await sql<{ seq: string }>`
        SELECT ludy_projects.github_webhook_pending_enqueue(
          ${request.deliveryId},
          ${eventType},
          ${request.signature256},
          ${installationId === null ? sql`NULL::bigint` : sql`${installationId}::bigint`},
          ${Buffer.from(request.body)}
        ) AS seq`.execute(db);
      return rows[0]?.seq ? ('accepted' as const) : ('busy' as const);
    } catch (error) {
      if (error instanceof Error && error.message.includes('GITHUB_WEBHOOK_BACKLOG')) {
        return 'busy' as const;
      }
      throw error;
    }
  });

  if (outcome === 'busy') return { status: 503, code: 'GITHUB_WEBHOOK_BUSY' };
  return { status: 202, queued: true };
}

export interface GithubPatHookRequest {
  readonly hookKey: string;
  readonly signature256: string | undefined;
  readonly eventType: string | undefined;
  readonly deliveryId: string | undefined;
  readonly body: Uint8Array;
}

export type GithubPatHookOutcome =
  | { readonly status: 202; readonly queued: boolean }
  | { readonly status: 200; readonly ignored: true }
  | { readonly status: 400; readonly code: 'WEBHOOK_MALFORMED' }
  | { readonly status: 404 }
  | { readonly status: 429; readonly retryAfterSeconds: number }
  | { readonly status: 503; readonly code: 'GITHUB_WEBHOOK_BUSY' };

export async function acceptGithubPatHook(
  runtime: Runtime,
  request: GithubPatHookRequest,
  budget: GithubWebhookBudget,
  billing: SignBilling = { entitlements: async () => ['full'] },
): Promise<GithubPatHookOutcome> {
  if (!isGithubHookKey(request.hookKey)) return { status: 404 };
  const keyHash = githubHookKeyHash(request.hookKey);

  const found = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ hook_id: string; org_id: string; generation: number; stopped: boolean }>`
      SELECT hook_id, org_id, generation, stopped
      FROM ludy_projects.github_webhook_hook_find(${keyHash})`.execute(db);
    return rows[0] ?? null;
  });
  if (!found) return { status: 404 };

  // Check per-org billing entitlement (ADR-0053): disabled/unentitled org returns opaque 404 identical to missing hookKey.
  const entitlements = await billing.entitlements(found.org_id);
  if (!entitledTo(entitlements, 'projects')) return { status: 404 };
  const entitled = await runtime.appOn(found.org_id, 'projects', { fresh: true });
  if (!entitled) return { status: 404 };

  const turn = budget.take(found.hook_id);
  if (!turn.allowed) {
    return { status: 429, retryAfterSeconds: turn.retryAfterSeconds };
  }
  if (found.stopped) {
    // An auto-stopped hook accepts and discards (stores nothing) once app/entitlement checks pass, so GitHub stops retrying
    // without leaking hook existence when Projects is off or unentitled.
    return { status: 202, queued: false };
  }

  const eventType = request.eventType?.trim();
  if (!eventType || !isCleanHeader(eventType, 64)) {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }
  if (!isAllowedGithubWebhookEvent(eventType)) {
    return { status: 200, ignored: true };
  }
  if (
    request.body.byteLength === 0 ||
    request.body.byteLength > MAX_GITHUB_WEBHOOK_BYTES ||
    !isCleanHeader(request.deliveryId, 128) ||
    !isCleanHeader(request.signature256, 128)
  ) {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }

  const put = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ put: string }>`
      SELECT ludy_projects.github_webhook_hook_put(
        ${found.hook_id}::uuid,
        ${keyHash},
        ${found.generation}::int,
        ${request.deliveryId},
        ${eventType},
        ${request.signature256},
        ${Buffer.from(request.body)}
      ) AS put`.execute(db);
    return rows[0]?.put ?? 'gone';
  });

  if (put === 'accepted') return { status: 202, queued: true };
  if (put === 'duplicate') return { status: 202, queued: false };
  if (put === 'busy') return { status: 503, code: 'GITHUB_WEBHOOK_BUSY' };
  return { status: 404 };
}
