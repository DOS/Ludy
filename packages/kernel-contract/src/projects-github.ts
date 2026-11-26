// SPDX-License-Identifier: AGPL-3.0-only
// Shared contracts, validation schemas, and URL/key helpers for Projects GitHub Integration (#5158, ADR-0060).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const GITHUB_PROVIDERS = ['github_app', 'github_pat'] as const;
export type GithubProviderId = (typeof GITHUB_PROVIDERS)[number];
export const isGithubProviderId = (provider: string): provider is GithubProviderId =>
  (GITHUB_PROVIDERS as readonly string[]).includes(provider);

export const GITHUB_REPOS_PER_PROJECT_MAX = 5;
export const GITHUB_TASK_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;
export const GITHUB_REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/([1-9][0-9]{0,8})(?:[?#].*)?$/;

export const GITHUB_LINK_KINDS = ['issue', 'pull_request'] as const;
export type GithubLinkKind = (typeof GITHUB_LINK_KINDS)[number];
export const zGithubLinkKind = z.enum(GITHUB_LINK_KINDS);

export const GITHUB_EXTERNAL_STATES = ['open', 'closed', 'merged', 'draft'] as const;
export type GithubExternalState = (typeof GITHUB_EXTERNAL_STATES)[number];
export const zGithubExternalState = z.enum(GITHUB_EXTERNAL_STATES);

export const GITHUB_LINK_SOURCES = ['manual', 'mention', 'branch'] as const;
export type GithubLinkSource = (typeof GITHUB_LINK_SOURCES)[number];
export const zGithubLinkSource = z.enum(GITHUB_LINK_SOURCES);

export const GITHUB_SYNC_STATUSES = ['queued', 'applied', 'skipped', 'deferred', 'failed'] as const;
export type GithubSyncStatus = (typeof GITHUB_SYNC_STATUSES)[number];
export const zGithubSyncStatus = z.enum(GITHUB_SYNC_STATUSES);

export const GITHUB_HOOK_STANDINGS = ['active', 'stopped', 'none'] as const;
export type GithubHookStanding = (typeof GITHUB_HOOK_STANDINGS)[number];
export const zGithubHookStanding = z.enum(GITHUB_HOOK_STANDINGS);

export function formatProjectTaskKey(
  prefix: string | null | undefined,
  taskNumber: number | null | undefined,
): string | null {
  if (!prefix || typeof taskNumber !== 'number' || !Number.isInteger(taskNumber) || taskNumber <= 0) {
    return null;
  }
  return `${prefix}-${taskNumber}`;
}

export interface ParsedGithubItemUrl {
  readonly repoFullName: string;
  readonly kind: GithubLinkKind;
  readonly externalNumber: number;
  readonly canonicalUrl: string;
}

export function parseGithubItemUrl(rawUrl: string): ParsedGithubItemUrl | null {
  const match = GITHUB_ITEM_URL_PATTERN.exec(rawUrl.trim());
  if (!match) return null;
  const owner = match[1] ?? '';
  const repo = match[2] ?? '';
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  const segment = match[3] === 'issues' ? 'issues' : 'pull';
  const kind: GithubLinkKind = segment === 'issues' ? 'issue' : 'pull_request';
  const externalNumber = Number(match[4]);
  if (!Number.isInteger(externalNumber) || externalNumber < 1) return null;
  const repoFullName = `${owner}/${repo}`;
  return {
    repoFullName,
    kind,
    externalNumber,
    canonicalUrl: `https://github.com/${repoFullName}/${segment}/${externalNumber}`,
  };
}

export const zGithubAvailableRepo = z.object({
  githubRepoId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repoFullName: z.string().regex(GITHUB_REPO_FULL_NAME_PATTERN),
  defaultBranch: z.string().min(1).max(200),
  privateRepo: z.boolean(),
});
export type GithubAvailableRepo = z.infer<typeof zGithubAvailableRepo>;

export const zGithubProjectRepoView = z.object({
  id: zId,
  githubRepoId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repoFullName: z.string().regex(GITHUB_REPO_FULL_NAME_PATTERN),
  defaultBranch: z.string(),
  webhookConfigured: z.boolean(),
  lastEventAt: z.string().nullable(),
  createdAt: z.string(),
});
export type GithubProjectRepoView = z.infer<typeof zGithubProjectRepoView>;

export const zGithubProjectBindingView = z.object({
  id: zId,
  projectId: zId,
  channelConnectionId: zId,
  provider: z.enum(GITHUB_PROVIDERS),
  connectionDisplayName: z.string(),
  connectionStatus: z.string(),
  externalAccountId: z.string(),
  githubEnabled: z.boolean(),
  taskKeyPrefix: z.string().nullable(),
  nextTaskNumber: z.number().int().positive(),
  autoSyncInbound: z.boolean(),
  autoLinkMentions: z.boolean(),
  autoLinkBranch: z.boolean(),
  inboundInProgressOnPr: z.boolean(),
  inboundDoneOnMerge: z.boolean(),
  outboundCloseIssueOnDone: z.boolean(),
  inboundColInProgress: zId.nullable(),
  inboundColInReview: zId.nullable(),
  inboundColDone: zId.nullable(),
  pausedReason: z.string().nullable(),
  pausedAt: z.string().nullable(),
  hookStanding: zGithubHookStanding,
  hookLastSeenAt: z.string().nullable(),
  repos: z.array(zGithubProjectRepoView),
  updatedAt: z.string(),
});
export type GithubProjectBindingView = z.infer<typeof zGithubProjectBindingView>;

export const zGithubBindingGetInput = z.strictObject({
  projectId: zId,
});

export const zGithubBindingGetResult = z.object({
  brokerConfigured: z.boolean(),
  appConfigured: z.boolean(),
  appSlug: z.string().nullable(),
  binding: zGithubProjectBindingView.nullable(),
});
export type GithubBindingGetResult = z.infer<typeof zGithubBindingGetResult>;

export const zGithubBindingSaveInput = z.strictObject({
  projectId: zId,
  channelConnectionId: zId,
  githubEnabled: z.boolean(),
  taskKeyPrefix: z.string().regex(GITHUB_TASK_PREFIX_PATTERN).nullable().optional(),
  backfillTaskNumbers: z.boolean().optional(),
  autoSyncInbound: z.boolean().optional(),
  autoLinkMentions: z.boolean().optional(),
  autoLinkBranch: z.boolean().optional(),
  inboundInProgressOnPr: z.boolean().optional(),
  inboundDoneOnMerge: z.boolean().optional(),
  inboundColInProgress: zId.nullable().optional(),
  inboundColInReview: zId.nullable().optional(),
  inboundColDone: zId.nullable().optional(),
});
export type GithubBindingSaveInput = z.infer<typeof zGithubBindingSaveInput>;

export const zGithubBindingSaveResult = z.object({
  binding: zGithubProjectBindingView,
  backfilledCount: z.number().int().nonnegative(),
});
export type GithubBindingSaveResult = z.infer<typeof zGithubBindingSaveResult>;

export const zGithubRepoBindInput = z.strictObject({
  projectId: zId,
  githubRepoId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repoFullName: z.string().regex(GITHUB_REPO_FULL_NAME_PATTERN),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
  webhookConfigured: z.boolean().optional(),
});
export type GithubRepoBindInput = z.infer<typeof zGithubRepoBindInput>;

export const zGithubRepoUnbindInput = z.strictObject({
  projectId: zId,
  repoId: zId,
});
export type GithubRepoUnbindInput = z.infer<typeof zGithubRepoUnbindInput>;

export const zGithubHookSetInput = z.strictObject({
  connectionId: zId,
  hookKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GithubHookSetInput = z.infer<typeof zGithubHookSetInput>;

export const zGithubHookSetResult = z.object({
  hookId: zId,
  created: z.boolean(),
  generation: z.number().int().positive(),
});
export type GithubHookSetResult = z.infer<typeof zGithubHookSetResult>;

export const zGithubHookStatusInput = z.strictObject({
  connectionId: zId,
});

export const zGithubHookStatusResult = z.object({
  hookId: zId.nullable(),
  configured: z.boolean(),
  standing: zGithubHookStanding,
  lastSeenAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  rotatedAt: z.string().nullable(),
});
export type GithubHookStatusResult = z.infer<typeof zGithubHookStatusResult>;

export const zGithubTaskLinkView = z.object({
  id: zId,
  projectId: zId,
  taskId: zId,
  repoFullName: z.string(),
  kind: zGithubLinkKind,
  externalNumber: z.number().int().positive(),
  externalUrl: z.string(),
  externalTitle: z.string(),
  externalState: zGithubExternalState,
  branchName: z.string().nullable(),
  authorLogin: z.string().nullable(),
  linkSource: zGithubLinkSource,
  closesTask: z.boolean(),
  hydrating: z.boolean(),
  tainted: z.literal(true),
  lastSyncedAt: z.string(),
  createdAt: z.string(),
});
export type GithubTaskLinkView = z.infer<typeof zGithubTaskLinkView>;

export const zGithubTaskLinksQueryInput = z.strictObject({
  projectId: zId,
  taskId: zId,
});

export const zGithubTaskLinksQueryResult = z.object({
  githubEnabled: z.boolean(),
  taskKey: z.string().nullable(),
  links: z.array(zGithubTaskLinkView),
});
export type GithubTaskLinksQueryResult = z.infer<typeof zGithubTaskLinksQueryResult>;

export const zGithubTaskLinkAddInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  repoFullName: z.string().regex(GITHUB_REPO_FULL_NAME_PATTERN),
  kind: zGithubLinkKind,
  externalNumber: z.number().int().positive(),
  externalUrl: z.string().regex(GITHUB_ITEM_URL_PATTERN).max(500),
  externalTitle: z.string().trim().min(1).max(300),
  externalState: zGithubExternalState,
  branchName: z.string().trim().min(1).max(255).nullable().optional(),
  authorLogin: z.string().trim().min(1).max(120).nullable().optional(),
  linkSource: zGithubLinkSource.optional(),
  closesTask: z.boolean().optional(),
  hydrating: z.boolean().optional(),
});
export type GithubTaskLinkAddInput = z.infer<typeof zGithubTaskLinkAddInput>;

export const zGithubTaskLinkRemoveInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  linkId: zId,
});

export const zGithubSyncLogQueryInput = z.strictObject({
  projectId: zId,
  limit: z.number().int().min(1).max(100).optional(),
});

export const zGithubSyncLogEntry = z.object({
  id: zId,
  direction: z.enum(['inbound', 'outbound']),
  deliveryId: z.string(),
  eventType: z.string(),
  repoFullName: z.string().nullable(),
  externalNumber: z.number().int().positive().nullable(),
  taskId: zId.nullable(),
  status: zGithubSyncStatus,
  errorCode: z.string().nullable(),
  summary: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
});
export type GithubSyncLogEntry = z.infer<typeof zGithubSyncLogEntry>;

export const zGithubSyncLogQueryResult = z.object({
  entries: z.array(zGithubSyncLogEntry),
});
export type GithubSyncLogQueryResult = z.infer<typeof zGithubSyncLogQueryResult>;

export const zGithubMatchedTaskInput = z.strictObject({
  taskId: zId.optional(),
  taskNumber: z.number().int().positive().optional(),
  linkSource: zGithubLinkSource,
  closesTask: z.boolean(),
});

export const zGithubApplyInboundEventInput = z.strictObject({
  projectId: zId,
  repoFullName: z.string().regex(GITHUB_REPO_FULL_NAME_PATTERN),
  eventKind: z.enum(['issue', 'pull_request', 'push']),
  action: z.string().min(1).max(40),
  externalNumber: z.number().int().positive().optional(),
  externalUrl: z.string().regex(GITHUB_ITEM_URL_PATTERN).max(500).optional(),
  externalTitle: z.string().trim().min(1).max(300).optional(),
  externalState: zGithubExternalState.optional(),
  branchName: z.string().trim().min(1).max(255).nullable().optional(),
  authorLogin: z.string().trim().min(1).max(120).nullable().optional(),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  remoteUpdatedAt: z.string().max(64).nullable().optional(),
  matches: z.array(zGithubMatchedTaskInput).max(50),
});
export type GithubApplyInboundEventInput = z.infer<typeof zGithubApplyInboundEventInput>;

export const zGithubApplyInboundEventResult = z.object({
  linkedTaskIds: z.array(zId),
  transitionedTaskIds: z.array(zId),
  deferredTaskIds: z.array(zId),
  status: z.enum(['applied', 'skipped', 'deferred']),
});
export type GithubApplyInboundEventResult = z.infer<typeof zGithubApplyInboundEventResult>;

// RPC edge schemas (apps/kernel/src/rpc.ts): accept plaintext PAT / webhookSecret / installationId at edge only.
export const zGithubConnectPatRpcInput = z.strictObject({
  projectId: zId,
  accessToken: z.string().trim().min(10).max(500),
  webhookSecret: z.string().trim().min(8).max(500),
  displayName: z.string().trim().min(1).max(200).optional(),
  taskKeyPrefix: z.string().regex(GITHUB_TASK_PREFIX_PATTERN).nullable().optional(),
  backfillTaskNumbers: z.boolean().optional(),
  idempotencyKey: zId,
});

export const zGithubConnectPatRpcResult = z.object({
  connectionId: zId,
  binding: zGithubProjectBindingView,
  webhookUrl: z.string(),
  availableRepos: z.array(zGithubAvailableRepo),
  backfilledCount: z.number().int().nonnegative(),
});

export const zGithubConnectAppRpcInput = z.strictObject({
  projectId: zId,
  installationId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  taskKeyPrefix: z.string().regex(GITHUB_TASK_PREFIX_PATTERN).nullable().optional(),
  backfillTaskNumbers: z.boolean().optional(),
  idempotencyKey: zId,
});

export const zGithubConnectAppRpcResult = z.object({
  connectionId: zId,
  binding: zGithubProjectBindingView,
  availableRepos: z.array(zGithubAvailableRepo),
  backfilledCount: z.number().int().nonnegative(),
});

export const zGithubRotatePatHookRpcInput = z.strictObject({
  projectId: zId,
  webhookSecret: z.string().trim().min(8).max(500).optional(),
  idempotencyKey: zId.optional(),
});

export const zGithubRotatePatHookRpcResult = z.object({
  hookId: zId,
  webhookUrl: z.string(),
  standing: zGithubHookStanding,
});

export const zGithubListAvailableReposRpcInput = z.strictObject({
  projectId: zId,
  accessToken: z.string().trim().min(10).max(500).optional(),
});

export const zGithubListAvailableReposRpcResult = z.object({
  repos: z.array(zGithubAvailableRepo),
});

export const zGithubTaskLinkAddRpcInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  url: z.string().trim().min(12).max(500),
  idempotencyKey: zId,
});

export const zGithubTaskLinkAddRpcResult = z.object({
  link: zGithubTaskLinkView,
});
