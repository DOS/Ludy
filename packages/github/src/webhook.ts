// SPDX-License-Identifier: AGPL-3.0-only
// GitHub webhook HMAC-SHA256 verification, mention/branch task-key extraction, and strict payload parsing (#5158, ADR-0060).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalGithubItemUrl,
  normalizeRepoFullName,
  sanitizeBranchName,
  sanitizeGithubLogin,
  sanitizeGithubMultilineSnippet,
  sanitizeGithubText,
} from './sanitize.ts';

export const GITHUB_ALLOWED_WEBHOOK_EVENTS = [
  'issues',
  'pull_request',
  'push',
  'installation',
  'installation_repositories',
] as const;

export type GithubAllowedWebhookEvent = (typeof GITHUB_ALLOWED_WEBHOOK_EVENTS)[number];

export const MAX_GITHUB_WEBHOOK_BYTES = 262_144;

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,7}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LUDY_URL_RE = /(?:\/projects\/([0-9a-f-]{36})[^\s)"'<>]*)?[?&]task=([0-9a-f-]{36})/gi;

export function isAllowedGithubWebhookEvent(eventType: string): eventType is GithubAllowedWebhookEvent {
  return (GITHUB_ALLOWED_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}

// Constant-time HMAC-SHA256 verification over exact raw request bytes across one or more active secrets.
export function verifyGithubWebhookSignature(
  rawBody: Uint8Array | Buffer | string,
  signature256Header: string | undefined,
  secrets: readonly string[],
): boolean {
  if (!signature256Header) return false;
  const match = SIGNATURE_RE.exec(signature256Header.trim());
  if (!match) return false;
  const expectedBytes = Buffer.from(match[1] ?? '', 'hex');
  if (expectedBytes.length !== 32) return false;

  const payload = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const digest = createHmac('sha256', secret).update(payload).digest();
    if (digest.length === expectedBytes.length && timingSafeEqual(digest, expectedBytes)) {
      matched = true;
    }
  }
  return matched;
}

export interface ExtractedTaskKeyMention {
  readonly taskNumber: number;
  readonly closesTask: boolean;
  readonly linkSource: 'mention';
}

export function extractTaskKeyMentions(text: string, prefix: string): ExtractedTaskKeyMention[] {
  const cleanPrefix = prefix.trim().toUpperCase();
  if (!PREFIX_RE.test(cleanPrefix) || !text) return [];
  const snippet = text.slice(0, 16_384);
  const byNumber = new Map<number, boolean>();

  const closingRe = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:#\\/?|\\/)?(${cleanPrefix})-([1-9]\\d{0,7})(?![A-Za-z0-9_])`,
    'gi',
  );
  for (const m of snippet.matchAll(closingRe)) {
    const n = Number(m[2]);
    if (Number.isInteger(n) && n > 0 && n <= 2_147_483_647) {
      byNumber.set(n, true);
      if (byNumber.size >= 50) break;
    }
  }

  const refRe = new RegExp(
    `(?:^|[\\s/(\\[#])(?:#\\/?)?(${cleanPrefix})-([1-9]\\d{0,7})(?=$|[\\s\\])/.,:;!?])`,
    'g',
  );
  for (const m of snippet.matchAll(refRe)) {
    const n = Number(m[2]);
    if (Number.isInteger(n) && n > 0 && n <= 2_147_483_647) {
      if (!byNumber.has(n)) {
        if (byNumber.size >= 50) break;
        byNumber.set(n, false);
      }
    }
  }

  return [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([taskNumber, closesTask]) => ({
      taskNumber,
      closesTask,
      linkSource: 'mention' as const,
    }));
}

export function extractBranchTaskKeys(branchName: string, prefix: string): number[] {
  const cleanPrefix = prefix.trim().toUpperCase();
  if (!PREFIX_RE.test(cleanPrefix) || !branchName) return [];
  const snippet = branchName.slice(0, 300);
  const branchRe = new RegExp(
    `(?:^|[^A-Za-z0-9])(${cleanPrefix})-([1-9]\\d{0,7})(?=$|[^A-Za-z0-9])`,
    'gi',
  );
  const found = new Set<number>();
  for (const m of snippet.matchAll(branchRe)) {
    const n = Number(m[2]);
    if (Number.isInteger(n) && n > 0 && n <= 2_147_483_647) {
      found.add(n);
      if (found.size >= 20) break;
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function extractLudyTaskIdsFromText(text: string, expectedProjectId: string): string[] {
  if (!text || !UUID_RE.test(expectedProjectId)) return [];
  const snippet = text.slice(0, 16_384);
  const expectedLower = expectedProjectId.toLowerCase();
  const out = new Set<string>();
  for (const m of snippet.matchAll(LUDY_URL_RE)) {
    const urlProjectId = m[1]?.toLowerCase();
    const taskId = m[2]?.toLowerCase();
    if (!taskId || !UUID_RE.test(taskId)) continue;
    if (urlProjectId && urlProjectId !== expectedLower) continue;
    out.add(taskId);
    if (out.size >= 20) break;
  }
  return [...out];
}

const zUser = z.object({
  login: z.string().max(120).optional(),
});

const zRepository = z.object({
  id: z.number().int().positive(),
  full_name: z.string().max(220),
  default_branch: z.string().max(255).optional(),
});

const zInstallationRef = z.object({
  id: z.number().int().positive(),
});

const zIssueWebhook = z.object({
  action: z.string().max(40),
  installation: zInstallationRef.optional(),
  repository: zRepository,
  sender: zUser.optional(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().max(65_536).nullable().optional(),
    state: z.enum(['open', 'closed']),
    html_url: z.string().max(500).optional(),
    updated_at: z.string().max(64).optional(),
    user: zUser.nullable().optional(),
  }),
});

const zPullRequestWebhook = z.object({
  action: z.string().max(40),
  installation: zInstallationRef.optional(),
  repository: zRepository,
  sender: zUser.optional(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().max(65_536).nullable().optional(),
    state: z.enum(['open', 'closed']),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    html_url: z.string().max(500).optional(),
    updated_at: z.string().max(64).optional(),
    user: zUser.nullable().optional(),
    head: z.object({
      ref: z.string().max(300),
    }),
  }),
});

const zPushCommit = z.object({
  id: z.string().max(64),
  message: z.string().max(4096),
  author: z.object({ username: z.string().max(120).optional() }).optional(),
});

const zPushWebhook = z.object({
  ref: z.string().max(300),
  deleted: z.boolean().optional(),
  installation: zInstallationRef.optional(),
  repository: zRepository,
  sender: zUser.optional(),
  commits: z.array(zPushCommit).max(50).optional(),
});

const zInstallationWebhook = z.object({
  action: z.string().max(40),
  installation: zInstallationRef,
  sender: zUser.optional(),
});

const zInstallationReposWebhook = z.object({
  action: z.string().max(40),
  installation: zInstallationRef,
  repositories_removed: z
    .array(z.object({ id: z.number().int().positive(), full_name: z.string().max(220) }))
    .max(200)
    .optional(),
});

export interface ParsedIssueWebhookEvent {
  readonly eventType: 'issues';
  readonly action: 'opened' | 'edited' | 'closed' | 'reopened' | 'other';
  readonly installationId: number | null;
  readonly githubRepoId: number;
  readonly repoFullName: string;
  readonly number: number;
  readonly title: string;
  readonly bodySnippet: string;
  readonly externalState: 'open' | 'closed';
  readonly externalUrl: string;
  readonly authorLogin: string | null;
  readonly updatedAt: string | null;
}

export interface ParsedPullRequestWebhookEvent {
  readonly eventType: 'pull_request';
  readonly action:
    | 'opened'
    | 'edited'
    | 'closed'
    | 'reopened'
    | 'ready_for_review'
    | 'converted_to_draft'
    | 'synchronize'
    | 'other';
  readonly installationId: number | null;
  readonly githubRepoId: number;
  readonly repoFullName: string;
  readonly number: number;
  readonly title: string;
  readonly bodySnippet: string;
  readonly externalState: 'open' | 'closed' | 'merged' | 'draft';
  readonly draft: boolean;
  readonly merged: boolean;
  readonly branchName: string | null;
  readonly externalUrl: string;
  readonly authorLogin: string | null;
  readonly updatedAt: string | null;
}

export interface ParsedPushWebhookEvent {
  readonly eventType: 'push';
  readonly installationId: number | null;
  readonly githubRepoId: number;
  readonly repoFullName: string;
  readonly branchName: string | null;
  readonly deleted: boolean;
  readonly commitMessages: readonly string[];
  readonly senderLogin: string | null;
}

export interface ParsedInstallationWebhookEvent {
  readonly eventType: 'installation';
  readonly action: 'deleted' | 'suspend' | 'unsuspend' | 'created' | 'other';
  readonly installationId: number;
}

export interface ParsedInstallationReposWebhookEvent {
  readonly eventType: 'installation_repositories';
  readonly action: 'added' | 'removed' | 'other';
  readonly installationId: number;
  readonly removedRepoIds: readonly number[];
}

export type ParsedGithubWebhookEvent =
  | ParsedIssueWebhookEvent
  | ParsedPullRequestWebhookEvent
  | ParsedPushWebhookEvent
  | ParsedInstallationWebhookEvent
  | ParsedInstallationReposWebhookEvent;

export function extractUnverifiedInstallationId(rawBody: Uint8Array | Buffer | string): number | null {
  try {
    const rawText = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    const parsed = JSON.parse(rawText) as { installation?: { id?: unknown } };
    const id = parsed?.installation?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function parseGithubWebhookPayload(
  eventType: string,
  rawBody: Uint8Array | Buffer | string,
): ParsedGithubWebhookEvent | null {
  let json: unknown;
  try {
    const rawText = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    json = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (eventType === 'issues') {
    const parsed = zIssueWebhook.safeParse(json);
    if (!parsed.success) return null;
    const d = parsed.data;
    const repo = normalizeRepoFullName(d.repository.full_name);
    if (!repo) return null;
    const externalUrl = canonicalGithubItemUrl(repo, 'issue', d.issue.number, d.issue.html_url);
    if (!externalUrl) return null;
    const action =
      d.action === 'opened' || d.action === 'edited' || d.action === 'closed' || d.action === 'reopened'
        ? d.action
        : 'other';
    return {
      eventType: 'issues',
      action,
      installationId: d.installation?.id ?? null,
      githubRepoId: d.repository.id,
      repoFullName: repo,
      number: d.issue.number,
      title: sanitizeGithubText(d.issue.title, 300) || `Issue #${d.issue.number}`,
      bodySnippet: sanitizeGithubMultilineSnippet(d.issue.body ?? '', 8192),
      externalState: d.issue.state,
      externalUrl,
      authorLogin: sanitizeGithubLogin(d.issue.user?.login ?? d.sender?.login),
      updatedAt: d.issue.updated_at ?? null,
    };
  }

  if (eventType === 'pull_request') {
    const parsed = zPullRequestWebhook.safeParse(json);
    if (!parsed.success) return null;
    const d = parsed.data;
    const repo = normalizeRepoFullName(d.repository.full_name);
    if (!repo) return null;
    const externalUrl = canonicalGithubItemUrl(repo, 'pull_request', d.pull_request.number, d.pull_request.html_url);
    if (!externalUrl) return null;
    const merged = Boolean(d.pull_request.merged);
    const draft = Boolean(d.pull_request.draft);
    const externalState: 'open' | 'closed' | 'merged' | 'draft' =
      d.pull_request.state === 'closed' ? (merged ? 'merged' : 'closed') : draft ? 'draft' : 'open';
    const action =
      d.action === 'opened' ||
      d.action === 'edited' ||
      d.action === 'closed' ||
      d.action === 'reopened' ||
      d.action === 'ready_for_review' ||
      d.action === 'converted_to_draft' ||
      d.action === 'synchronize'
        ? d.action
        : 'other';
    return {
      eventType: 'pull_request',
      action,
      installationId: d.installation?.id ?? null,
      githubRepoId: d.repository.id,
      repoFullName: repo,
      number: d.pull_request.number,
      title: sanitizeGithubText(d.pull_request.title, 300) || `PR #${d.pull_request.number}`,
      bodySnippet: sanitizeGithubMultilineSnippet(d.pull_request.body ?? '', 8192),
      externalState,
      draft,
      merged,
      branchName: sanitizeBranchName(d.pull_request.head.ref),
      externalUrl,
      authorLogin: sanitizeGithubLogin(d.pull_request.user?.login ?? d.sender?.login),
      updatedAt: d.pull_request.updated_at ?? null,
    };
  }

  if (eventType === 'push') {
    const parsed = zPushWebhook.safeParse(json);
    if (!parsed.success) return null;
    const d = parsed.data;
    const repo = normalizeRepoFullName(d.repository.full_name);
    if (!repo) return null;
    const refBranch = d.ref.startsWith('refs/heads/') ? d.ref.slice('refs/heads/'.length) : d.ref;
    return {
      eventType: 'push',
      installationId: d.installation?.id ?? null,
      githubRepoId: d.repository.id,
      repoFullName: repo,
      branchName: sanitizeBranchName(refBranch),
      deleted: Boolean(d.deleted),
      commitMessages: (d.commits ?? []).slice(0, 20).map((c) => sanitizeGithubText(c.message, 400)),
      senderLogin: sanitizeGithubLogin(d.sender?.login),
    };
  }

  if (eventType === 'installation') {
    const parsed = zInstallationWebhook.safeParse(json);
    if (!parsed.success) return null;
    const a = parsed.data.action;
    const action = a === 'deleted' || a === 'suspend' || a === 'unsuspend' || a === 'created' ? a : 'other';
    return {
      eventType: 'installation',
      action,
      installationId: parsed.data.installation.id,
    };
  }

  if (eventType === 'installation_repositories') {
    const parsed = zInstallationReposWebhook.safeParse(json);
    if (!parsed.success) return null;
    const a = parsed.data.action;
    const action = a === 'added' || a === 'removed' ? a : 'other';
    return {
      eventType: 'installation_repositories',
      action,
      installationId: parsed.data.installation.id,
      removedRepoIds: (parsed.data.repositories_removed ?? []).map((r) => r.id),
    };
  }

  return null;
}
