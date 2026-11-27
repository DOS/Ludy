// SPDX-License-Identifier: AGPL-3.0-only
// Worker webhook intake drain (egress 'none') and GitHub API hydration worker ('provider:github') (#5158, ADR-0060).
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import {
  GithubError,
  extractBranchTaskKeys,
  extractLudyTaskIdsFromText,
  extractTaskKeyMentions,
  parseGithubWebhookPayload,
  verifyGithubWebhookSignature,
  type GithubClient,
  type ParsedIssueWebhookEvent,
  type ParsedPullRequestWebhookEvent,
  type ParsedPushWebhookEvent,
} from '@ludy/github';
import type {
  GithubApplyInboundEventResult,
  GithubBindingGetResult,
  GithubOutboundContextResult,
  GithubRecordOutboundResult,
  GithubTaskLinksQueryResult,
} from '@ludy/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { jobKey } from './job-keys.ts';
import { QUEUES } from './jobs-schema.ts';

export const PROJECTS_GITHUB_WEBHOOK_SWEEP_CRON = '*/10 * * * *';
export const PROJECTS_GITHUB_WEBHOOK_SWEEP_EXPIRE_SECONDS = 300;
export const PROJECTS_GITHUB_HYDRATE_RETRY_LIMIT = 3;
export const PROJECTS_GITHUB_OUTBOUND_SWEEP_CRON = '* * * * *';
export const PROJECTS_GITHUB_OUTBOUND_SWEEP_EXPIRE_SECONDS = 55;
export const PROJECTS_GITHUB_OUTBOUND_RETRY_LIMIT = 3;

const WEBHOOK_CLAIM_BATCH = 50;
const WEBHOOK_LEASE_SECONDS = 120;
const SYSTEM = { type: 'system' as const, component: 'projects.github' };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

interface BindingRow {
  org_id: string;
  project_id: string;
  binding_id: string;
  channel_connection_id: string;
  task_key_prefix: string | null;
  auto_link_mentions: boolean;
  auto_link_branch: boolean;
  inbound_in_progress_on_pr: boolean;
  inbound_done_on_merge: boolean;
  inbound_col_in_progress: string | null;
  inbound_col_in_review: string | null;
  inbound_col_done: string | null;
}

interface PatNoticeRow {
  org_id: string | null;
  reject_token: string | null;
  connection_id: string | null;
  delivery_id: string | null;
  event_type: string | null;
  signature_256: string | null;
  body: Buffer | null;
  generation: number | null;
}

interface PendingRow {
  seq: string;
  delivery_id: string;
  event_type: string;
  signature_256: string;
  installation_id: string | null;
  body: Buffer | null;
  attempts: number;
  dropped: boolean;
  reason: string | null;
}

export type ProjectsGithubHydrateJob =
  | {
      readonly mode: 'link_refresh';
      readonly orgId: string;
      readonly projectId: string;
      readonly taskId: string;
      readonly linkId: string;
      readonly kind: 'issue' | 'pull_request';
      readonly externalNumber: number;
    }
  | {
      readonly mode: 'branch_pr';
      readonly orgId: string;
      readonly projectId: string;
      readonly channelConnectionId: string;
      readonly repoFullName: string;
      readonly branchName: string;
      readonly deliveryId: string;
      readonly taskNumbers: readonly number[];
      readonly taskIds: readonly string[];
    };

export function projectsGithubHydrateJobOptions(job: ProjectsGithubHydrateJob) {
  const key =
    job.mode === 'link_refresh'
      ? `link:${job.projectId}:${job.linkId}`
      : `branch:${job.projectId}:${job.repoFullName}:${job.branchName}:${job.deliveryId}`;
  return {
    singletonKey: jobKey(job.orgId, QUEUES.projectsGithubHydrate, key),
    retryLimit: PROJECTS_GITHUB_HYDRATE_RETRY_LIMIT,
    retryDelay: 20,
    retryBackoff: true,
  };
}

export async function sweepGithubWebhooks(workerDb: Db): Promise<number> {
  const { rows } = await sql<{ swept: number }>`SELECT ludy_projects.github_webhook_sweep() AS swept`.execute(workerDb);
  return Number(rows[0]?.swept ?? 0);
}

export async function hasGithubWebhookWork(workerDb: Db): Promise<boolean> {
  const { rows } = await sql<{ ready: boolean }>`SELECT ludy_projects.github_webhook_has_work() AS ready`.execute(workerDb);
  return rows[0]?.ready === true;
}

export async function hasGithubOutboundWork(workerDb: Db): Promise<boolean> {
  const { rows } = await sql<{ ready: boolean }>`SELECT ludy_projects.github_outbound_has_work() AS ready`.execute(workerDb);
  return rows[0]?.ready === true;
}

export interface ProjectsGithubOutboundJob {
  readonly orgId: string;
  readonly deliveryId: string;
}

export interface ProjectsGithubSweepJob {
  readonly mode: 'agent_task_transition';
  readonly orgId: string;
  readonly taskId: string;
  readonly previousStatus: string;
  readonly nextStatus: string;
}

export async function runGithubAgentTransitionEnqueue(
  deps: { readonly runtime: Runtime },
  job: ProjectsGithubSweepJob,
): Promise<number> {
  if (!(await deps.runtime.appOn(job.orgId, 'projects', { fresh: true }))) {
    return 0;
  }
  const res = await deps.runtime.execute<{ enqueued: number }>(
    'projects.github.outbound_enqueue_system',
    {
      taskId: job.taskId,
      previousStatus: job.previousStatus,
      nextStatus: job.nextStatus,
    },
    { actor: SYSTEM, orgId: job.orgId },
  );
  return res.enqueued;
}

export function projectsGithubOutboundJobOptions(job: ProjectsGithubOutboundJob) {
  return {
    singletonKey: jobKey(job.orgId, QUEUES.projectsGithubOutbound, job.deliveryId),
    retryLimit: PROJECTS_GITHUB_OUTBOUND_RETRY_LIMIT,
    retryDelay: 20,
    retryBackoff: true,
  };
}

async function resolveGithubBindingAuth(
  deps: { readonly runtime: Runtime; readonly broker: CredentialBroker },
  orgId: string,
  channelConnectionId: string,
): Promise<{ kind: 'github_pat'; token: string } | { kind: 'github_app'; installationId: string } | null> {
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>(
      'kernel.channel.credential',
      { connectionId: channelConnectionId },
      { actor: SYSTEM, orgId },
    );
    const opened = deps.broker.open(
      { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
      { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
    );
    const decoded = JSON.parse(opened) as { accessToken?: unknown; installationId?: unknown };
    if (sealed.provider === 'github_app' && typeof decoded.installationId === 'string') {
      return { kind: 'github_app', installationId: decoded.installationId };
    }
    if (sealed.provider === 'github_pat' && typeof decoded.accessToken === 'string') {
      return { kind: 'github_pat', token: decoded.accessToken };
    }
    return null;
  } catch {
    return null;
  }
}

function collectMatchesForEvent(
  binding: BindingRow,
  parsed: ParsedIssueWebhookEvent | ParsedPullRequestWebhookEvent | ParsedPushWebhookEvent,
): Array<{ taskId?: string; taskNumber?: number; linkSource: 'manual' | 'mention' | 'branch'; closesTask: boolean }> {
  const byNumber = new Map<number, { linkSource: 'mention' | 'branch'; closesTask: boolean }>();
  const byTaskId = new Map<string, { linkSource: 'mention'; closesTask: boolean }>();

  const collectText = (text: string | null) => {
    if (!text) return;
    if (binding.auto_link_mentions && binding.task_key_prefix) {
      for (const m of extractTaskKeyMentions(text, binding.task_key_prefix)) {
        const existing = byNumber.get(m.taskNumber);
        byNumber.set(m.taskNumber, {
          linkSource: 'mention',
          closesTask: Boolean(existing?.closesTask || m.closesTask),
        });
      }
    }
    if (binding.auto_link_mentions) {
      for (const id of extractLudyTaskIdsFromText(text, binding.project_id)) {
        const existing = byTaskId.get(id);
        byTaskId.set(id, { linkSource: 'mention', closesTask: Boolean(existing?.closesTask) });
      }
    }
  };

  if (parsed.eventType === 'push') {
    for (const msg of parsed.commitMessages) collectText(msg);
    if (binding.auto_link_branch && binding.task_key_prefix && parsed.branchName) {
      for (const n of extractBranchTaskKeys(parsed.branchName, binding.task_key_prefix)) {
        if (!byNumber.has(n)) {
          byNumber.set(n, { linkSource: 'branch', closesTask: true });
        }
      }
    }
  } else {
    collectText(parsed.title);
    collectText(parsed.bodySnippet);
    if (
      parsed.eventType === 'pull_request' &&
      binding.auto_link_branch &&
      binding.task_key_prefix &&
      parsed.branchName
    ) {
      for (const n of extractBranchTaskKeys(parsed.branchName, binding.task_key_prefix)) {
        if (!byNumber.has(n)) {
          byNumber.set(n, { linkSource: 'branch', closesTask: true });
        }
      }
    }
  }

  return [
    ...[...byNumber.entries()].map(([taskNumber, spec]) => ({ taskNumber, linkSource: spec.linkSource, closesTask: spec.closesTask })),
    ...[...byTaskId.entries()].map(([taskId, spec]) => ({ taskId, linkSource: spec.linkSource, closesTask: spec.closesTask })),
  ];
}

async function applyParsedEventToBinding(
  deps: { runtime: Runtime; workerDb: Db },
  binding: BindingRow,
  deliveryId: string,
  eventType: string,
  parsed: ParsedIssueWebhookEvent | ParsedPullRequestWebhookEvent | ParsedPushWebhookEvent,
  sendHydrate?: ((job: ProjectsGithubHydrateJob) => Promise<unknown>) | undefined,
): Promise<void> {
  if (!(await deps.runtime.appOn(binding.org_id, 'projects', { fresh: true }))) return;

  const matches = collectMatchesForEvent(binding, parsed);

  if (parsed.eventType === 'push') {
    const { rows: beginRows } = await sql<{ id: string | null }>`
      SELECT ludy_projects.github_sync_delivery_begin(
        ${binding.org_id}::uuid,
        ${binding.project_id}::uuid,
        'inbound',
        ${deliveryId},
        ${eventType},
        ${parsed.repoFullName},
        NULL::integer
      ) AS id`.execute(deps.workerDb);
    const ledgerId = beginRows[0]?.id ?? null;
    if (!ledgerId) return;

    const matchedNumbers = matches
      .map((m) => m.taskNumber)
      .filter((n): n is number => typeof n === 'number');
    const matchedTaskIds = matches
      .map((m) => m.taskId)
      .filter((id): id is string => typeof id === 'string');

    if (sendHydrate && !parsed.deleted && parsed.branchName && (matchedNumbers.length > 0 || matchedTaskIds.length > 0)) {
      try {
        await sendHydrate({
          mode: 'branch_pr',
          orgId: binding.org_id,
          projectId: binding.project_id,
          channelConnectionId: binding.channel_connection_id,
          repoFullName: parsed.repoFullName,
          branchName: parsed.branchName,
          deliveryId,
          taskNumbers: matchedNumbers,
          taskIds: matchedTaskIds,
        });
      } catch (error) {
        await sql`
          SELECT ludy_projects.github_sync_delivery_finish(
            ${binding.org_id}::uuid,
            ${ledgerId}::uuid,
            'failed',
            NULL::uuid,
            'HYDRATE_ENQUEUE_FAILED',
            'Failed to queue branch PR check'
          )`.execute(deps.workerDb);
        throw error;
      }
      await sql`
        SELECT ludy_projects.github_sync_delivery_finish(
          ${binding.org_id}::uuid,
          ${ledgerId}::uuid,
          'queued',
          NULL::uuid,
          NULL::text,
          'Branch push queued PR check'
        )`.execute(deps.workerDb);
      return;
    }

    await sql`
      SELECT ludy_projects.github_sync_delivery_finish(
        ${binding.org_id}::uuid,
        ${ledgerId}::uuid,
        'skipped',
        NULL::uuid,
        NULL::text,
        'Push event carried no matching task key with open branch check'
      )`.execute(deps.workerDb);
    return;
  }

  const { rows: beginRows } = await sql<{ id: string | null }>`
    SELECT ludy_projects.github_sync_delivery_begin(
      ${binding.org_id}::uuid,
      ${binding.project_id}::uuid,
      'inbound',
      ${deliveryId},
      ${eventType},
      ${parsed.repoFullName},
      ${parsed.number}::int
    ) AS id`.execute(deps.workerDb);
  const ledgerId = beginRows[0]?.id ?? null;
  if (!ledgerId) return;

  try {
    const result = await deps.runtime.execute<GithubApplyInboundEventResult>(
      'projects.github.apply_inbound_event',
      {
        projectId: binding.project_id,
        repoFullName: parsed.repoFullName,
        eventKind: parsed.eventType === 'issues' ? 'issue' : 'pull_request',
        action: parsed.action,
        externalNumber: parsed.number,
        externalUrl: parsed.externalUrl,
        externalTitle: parsed.title,
        externalState: parsed.externalState,
        branchName: parsed.eventType === 'pull_request' ? parsed.branchName : null,
        authorLogin: parsed.authorLogin,
        merged: parsed.eventType === 'pull_request' ? parsed.merged : false,
        draft: parsed.eventType === 'pull_request' ? parsed.draft : false,
        remoteUpdatedAt: parsed.updatedAt,
        matches,
      },
      { actor: SYSTEM, orgId: binding.org_id },
    );
    const firstTaskId =
      result.transitionedTaskIds[0] ?? result.deferredTaskIds[0] ?? result.linkedTaskIds[0] ?? null;
    const summary =
      result.status === 'skipped'
        ? `No linked task for ${parsed.repoFullName}#${parsed.number}`
        : result.status === 'deferred'
          ? `Linked ${result.linkedTaskIds.length}; status deferred by active agent checkout`
          : `Linked ${result.linkedTaskIds.length}; transitioned ${result.transitionedTaskIds.length}`;
    await sql`
      SELECT ludy_projects.github_sync_delivery_finish(
        ${binding.org_id}::uuid,
        ${ledgerId}::uuid,
        ${result.status},
        ${firstTaskId === null ? sql`NULL::uuid` : sql`${firstTaskId}::uuid`},
        NULL::text,
        ${summary}
      )`.execute(deps.workerDb);
  } catch (error) {
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'ERROR';
    await sql`
      SELECT ludy_projects.github_sync_delivery_finish(
        ${binding.org_id}::uuid,
        ${ledgerId}::uuid,
        'failed',
        NULL::uuid,
        ${code.slice(0, 64)},
        'Inbound event processing failed'
      )`.execute(deps.workerDb).catch(() => {});
    throw error;
  }
}

export interface GithubWebhookWorkerDeps {
  readonly workerDb: Db;
  readonly runtime: Runtime;
  readonly broker?: CredentialBroker | undefined;
  readonly appWebhookSecrets?: readonly string[] | undefined;
  readonly sendHydrate?: ((job: ProjectsGithubHydrateJob) => Promise<unknown>) | undefined;
}

export async function processGithubWebhookBatch(
  deps: GithubWebhookWorkerDeps,
): Promise<{ swept: number; appProcessed: number; patOk: number; patRefused: number; patDropped: number }> {
  const swept = await sweepGithubWebhooks(deps.workerDb);
  let appProcessed = 0;
  let patOk = 0;
  let patRefused = 0;
  let patDropped = 0;

  const verifyAppHmac = deps.appWebhookSecrets !== undefined;
  const appSecrets = (deps.appWebhookSecrets ?? []).filter((s) => s.length > 0);
  if (!verifyAppHmac || appSecrets.length > 0) {
    for (;;) {
      const { rows } = await sql<PendingRow>`
        SELECT seq, delivery_id, event_type, signature_256, installation_id, body, attempts, dropped, reason
        FROM ludy_projects.github_webhook_pending_claim(${WEBHOOK_CLAIM_BATCH}::int, ${WEBHOOK_LEASE_SECONDS}::int)`.execute(deps.workerDb);
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row.dropped || !row.body) continue;
        const rawBytes = new Uint8Array(row.body);
        if (verifyAppHmac && !verifyGithubWebhookSignature(rawBytes, row.signature_256, appSecrets)) {
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          continue;
        }
        const parsed = parseGithubWebhookPayload(row.event_type, rawBytes);
        if (!parsed) {
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          continue;
        }

        if (parsed.eventType === 'installation') {
          if (parsed.action === 'suspend' || parsed.action === 'unsuspend' || parsed.action === 'deleted') {
            const installIdStr = String(parsed.installationId);
            const { rows: targets } = await sql<{ org_id: string; channel_connection_id: string }>`
              SELECT org_id, channel_connection_id
              FROM ludy_projects.github_app_installation_targets(${installIdStr})`.execute(deps.workerDb);
            for (const target of targets) {
              if (await deps.runtime.appOn(target.org_id, 'projects', { fresh: true })) {
                await deps.runtime.execute(
                  'projects.github.installation_sync',
                  {
                    channelConnectionId: target.channel_connection_id,
                    action: parsed.action,
                  },
                  { actor: SYSTEM, orgId: target.org_id },
                );
              }
              if (parsed.action === 'deleted') {
                await deps.runtime.execute(
                  'kernel.channel.revoke_by_platform',
                  { connectionId: target.channel_connection_id },
                  { actor: SYSTEM, orgId: target.org_id },
                );
              }
            }
          }
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          appProcessed += 1;
          continue;
        }

        if (parsed.eventType === 'installation_repositories') {
          if (parsed.action === 'removed' && parsed.removedRepoIds.length > 0) {
            const installIdStr = String(parsed.installationId);
            const removedRepoIds = parsed.removedRepoIds
              .filter((id) => Number.isSafeInteger(id) && id > 0)
              .map((id) => String(id));
            if (removedRepoIds.length > 0) {
              const { rows: targets } = await sql<{ org_id: string; channel_connection_id: string }>`
                SELECT org_id, channel_connection_id
                FROM ludy_projects.github_app_installation_targets(${installIdStr})`.execute(deps.workerDb);
              for (const target of targets) {
                if (!(await deps.runtime.appOn(target.org_id, 'projects', { fresh: true }))) {
                  continue;
                }
                await deps.runtime.execute(
                  'projects.github.installation_sync',
                  {
                    channelConnectionId: target.channel_connection_id,
                    action: 'repositories_removed',
                    removedRepoIds,
                  },
                  { actor: SYSTEM, orgId: target.org_id },
                );
              }
            }
          }
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          appProcessed += 1;
          continue;
        }

        if (!Number.isSafeInteger(parsed.githubRepoId) || parsed.githubRepoId <= 0) {
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          appProcessed += 1;
          continue;
        }

        const rowInstallId = row.installation_id ? Number(row.installation_id) : null;
        const installId = parsed.installationId ?? (rowInstallId && Number.isSafeInteger(rowInstallId) ? rowInstallId : null);
        if (installId) {
          const { rows: bindings } = await sql<BindingRow>`
            SELECT org_id, project_id, binding_id, channel_connection_id, task_key_prefix,
                   auto_link_mentions, auto_link_branch, inbound_in_progress_on_pr, inbound_done_on_merge,
                   inbound_col_in_progress, inbound_col_in_review, inbound_col_done
            FROM ludy_projects.github_app_org_bindings(${installId}::bigint, ${parsed.githubRepoId}::bigint)`.execute(deps.workerDb);
          for (const binding of bindings) {
            await applyParsedEventToBinding(deps, binding, row.delivery_id, row.event_type, parsed, deps.sendHydrate);
          }
        }
        await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
        appProcessed += 1;
      }

      if (rows.length < WEBHOOK_CLAIM_BATCH) break;
    }
  }

  const broker = deps.broker;
  if (broker && broker.id !== 'none') {
    for (;;) {
      const refusedHooks: Array<{ rejectToken: string; generation: number }> = [];
      const { rows: claimResult } = await sql<PatNoticeRow>`
        SELECT org_id, reject_token, connection_id, delivery_id, event_type, signature_256, body, generation
        FROM ludy_projects.github_webhook_hook_claim(${WEBHOOK_CLAIM_BATCH}::int)`.execute(deps.workerDb);
      if (claimResult.length === 0) break;

      const secretCache = new Map<string, string | null>();
      const patSecretOf = async (orgId: string, connectionId: string): Promise<string | null> => {
        const cacheKey = `${orgId}:${connectionId}`;
        if (secretCache.has(cacheKey)) return secretCache.get(cacheKey) ?? null;
        let webhookSecret: string | null = null;
        try {
          const sealed = await deps.runtime.query<SealedChannelCredential>(
            'kernel.channel.credential',
            { connectionId },
            { actor: SYSTEM, orgId },
          );
          const rawSecret = broker.open(
            { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
            { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
          );
          const parsedSecret = JSON.parse(rawSecret) as { webhookSecret?: unknown };
          if (typeof parsedSecret.webhookSecret === 'string' && parsedSecret.webhookSecret.length > 0) {
            webhookSecret = parsedSecret.webhookSecret;
          }
        } catch {
          webhookSecret = null;
        }
        secretCache.set(cacheKey, webhookSecret);
        return webhookSecret;
      };

      try {
        for (const row of claimResult) {
          if (
            !row.org_id ||
            !row.reject_token ||
            !row.connection_id ||
            !row.delivery_id ||
            !row.event_type ||
            !row.signature_256 ||
            !row.body ||
            row.generation === null
          ) {
            patDropped += 1;
            continue;
          }
          const webhookSecret = await patSecretOf(row.org_id, row.connection_id);
          if (!webhookSecret) {
            patDropped += 1;
            continue;
          }
          const rawBytes = new Uint8Array(row.body);
          if (!verifyGithubWebhookSignature(rawBytes, row.signature_256, [webhookSecret])) {
            refusedHooks.push({ rejectToken: row.reject_token, generation: Number(row.generation) });
            patRefused += 1;
            continue;
          }
          const parsed = parseGithubWebhookPayload(row.event_type, rawBytes);
          if (
            !parsed ||
            parsed.eventType === 'installation' ||
            parsed.eventType === 'installation_repositories' ||
            !Number.isSafeInteger(parsed.githubRepoId) ||
            parsed.githubRepoId <= 0
          ) {
            patDropped += 1;
            continue;
          }

          const { rows: bindings } = await sql<BindingRow>`
            SELECT org_id, project_id, binding_id, channel_connection_id, task_key_prefix,
                   auto_link_mentions, auto_link_branch, inbound_in_progress_on_pr, inbound_done_on_merge,
                   inbound_col_in_progress, inbound_col_in_review, inbound_col_done
            FROM ludy_projects.github_pat_org_bindings(${row.org_id}::uuid, ${row.connection_id}::uuid, ${parsed.githubRepoId}::bigint)`.execute(deps.workerDb);
          for (const binding of bindings) {
            await applyParsedEventToBinding(deps, binding, row.delivery_id, row.event_type, parsed, deps.sendHydrate);
          }
          patOk += 1;
        }
      } finally {
        for (const refused of refusedHooks) {
          await sql`
            SELECT ludy_projects.github_webhook_hook_reject(${refused.rejectToken}::uuid, ${refused.generation}::int)`.execute(deps.workerDb);
        }
      }

      if (claimResult.length < WEBHOOK_CLAIM_BATCH) break;
    }
  }

  return { swept, appProcessed, patOk, patRefused, patDropped };
}

export async function runGithubHydrateJob(
  deps: {
    readonly runtime: Runtime;
    readonly workerDb: Db;
    readonly broker: CredentialBroker;
    readonly github: GithubClient;
  },
  job: ProjectsGithubHydrateJob,
): Promise<'hydrated' | 'skipped'> {
  if (!(await deps.runtime.appOn(job.orgId, 'projects', { fresh: true }))) {
    return 'skipped';
  }

  const { binding } = await deps.runtime.query<GithubBindingGetResult>(
    'projects.github.binding.get',
    { projectId: job.projectId },
    { actor: SYSTEM, orgId: job.orgId },
  );
  if (
    !binding ||
    !binding.githubEnabled ||
    binding.pausedAt !== null ||
    binding.connectionStatus !== 'active' ||
    !binding.channelConnectionId
  ) {
    return 'skipped';
  }

  const auth = await resolveGithubBindingAuth(deps, job.orgId, binding.channelConnectionId);
  if (!auth) {
    return 'skipped';
  }

  try {
    if (job.mode === 'link_refresh') {
      const linksView = await deps.runtime.query<GithubTaskLinksQueryResult>(
        'projects.github.task_links',
        { projectId: job.projectId, taskId: job.taskId },
        { actor: SYSTEM, orgId: job.orgId },
      );
      const targetLink = linksView.links.find((l) => l.id === job.linkId);
      if (!targetLink) {
        return 'skipped';
      }
      const item = await deps.github.getIssueOrPr(auth, targetLink.repoFullName, targetLink.kind, targetLink.externalNumber);
      await deps.runtime.execute(
        'projects.github.apply_inbound_event',
        {
          projectId: job.projectId,
          repoFullName: item.repoFullName,
          eventKind: item.kind === 'issue' ? 'issue' : 'pull_request',
          action: 'edited',
          replaceLinkId: job.linkId,
          externalNumber: item.number,
          externalUrl: item.externalUrl,
          externalTitle: item.externalTitle,
          externalState: item.externalState,
          branchName: item.branchName,
          authorLogin: item.authorLogin,
          remoteUpdatedAt: item.updatedAt,
          matches: [{ taskId: job.taskId, linkSource: 'manual', closesTask: true }],
        },
        { actor: SYSTEM, orgId: job.orgId },
      );
      return 'hydrated';
    }

    const pr = await deps.github.findOpenPrForBranch(auth, job.repoFullName, job.branchName);
    if (!pr) return 'skipped';

    const matches = [
      ...job.taskNumbers.map((taskNumber) => ({ taskNumber, linkSource: 'branch' as const, closesTask: true })),
      ...job.taskIds.map((taskId) => ({ taskId, linkSource: 'branch' as const, closesTask: true })),
    ];
    await deps.runtime.execute(
      'projects.github.apply_inbound_event',
      {
        projectId: job.projectId,
        repoFullName: pr.repoFullName,
        eventKind: 'pull_request',
        action: 'opened',
        externalNumber: pr.number,
        externalUrl: pr.externalUrl,
        externalTitle: pr.externalTitle,
        externalState: pr.externalState,
        branchName: pr.branchName ?? job.branchName,
        authorLogin: pr.authorLogin,
        draft: pr.externalState === 'draft',
        merged: pr.externalState === 'merged',
        remoteUpdatedAt: pr.updatedAt,
        matches,
      },
      { actor: SYSTEM, orgId: job.orgId },
    );
    return 'hydrated';
  } catch (error) {
    if (error instanceof GithubError && error.kind === 'not_found') {
      return 'skipped';
    }
    throw error;
  }
}

interface OutboundSweepRow {
  id: string;
  org_id: string;
  project_id: string;
  task_id: string | null;
  link_id: string | null;
  repo_full_name: string | null;
  external_number: number | null;
  target_remote_state: string | null;
}

interface ClaimedOutboundRow {
  id: string;
  project_id: string;
  task_id: string | null;
  link_id: string | null;
  repo_full_name: string | null;
  external_number: number | null;
  target_remote_state: string | null;
  attempt_count: number;
}

export async function runGithubOutboundSweep(deps: {
  readonly workerDb: Db;
  readonly runtime: Runtime;
  readonly sendOutbound: (job: ProjectsGithubOutboundJob) => Promise<unknown>;
  readonly limit?: number | undefined;
}): Promise<{ handedOver: number; skippedOff: number }> {
  const batchLimit = deps.limit ?? 100;
  const { rows } = await sql<OutboundSweepRow>`
    SELECT id, org_id, project_id, task_id, link_id, repo_full_name, external_number, target_remote_state
      FROM ludy_projects.github_outbound_sweep(${batchLimit}::int)`.execute(deps.workerDb);

  const appOnByOrg = new Map<string, boolean>();
  let handedOver = 0;
  let skippedOff = 0;

  for (const row of rows) {
    let projectsOn = appOnByOrg.get(row.org_id);
    if (projectsOn === undefined) {
      projectsOn = await deps.runtime.appOn(row.org_id, 'projects', { fresh: true });
      appOnByOrg.set(row.org_id, projectsOn);
    }
    if (!projectsOn) {
      skippedOff += 1;
      continue;
    }
    await deps.sendOutbound({ orgId: row.org_id, deliveryId: row.id });
    handedOver += 1;
  }

  return { handedOver, skippedOff };
}

async function finishOutboundDelivery(
  workerDb: Db,
  orgId: string,
  deliveryId: string,
  status: 'applied' | 'skipped' | 'failed',
  taskId: string | null,
  errorCode: string | null,
  summary: string,
): Promise<void> {
  await sql`
    SELECT ludy_projects.github_sync_delivery_finish(
      ${orgId}::uuid,
      ${deliveryId}::uuid,
      ${status},
      ${taskId === null ? sql`NULL::uuid` : sql`${taskId}::uuid`},
      ${errorCode},
      ${summary}
    )`.execute(workerDb);
}

export async function runGithubOutboundJob(
  deps: {
    readonly runtime: Runtime;
    readonly workerDb: Db;
    readonly broker: CredentialBroker;
    readonly github: GithubClient;
  },
  job: ProjectsGithubOutboundJob,
  meta?: { readonly retryCount?: number | undefined; readonly retryLimit?: number | undefined },
): Promise<'applied' | 'skipped' | 'failed'> {
  // Enforce fresh app gate upfront before touching credentials, DB claims/mutations, or api.github.com (ADR-0053, #5159).
  if (!(await deps.runtime.appOn(job.orgId, 'projects', { fresh: true }))) {
    return 'skipped';
  }

  const { rows: claimRows } = await sql<ClaimedOutboundRow>`
    SELECT id, project_id, task_id, link_id, repo_full_name, external_number, target_remote_state, attempt_count
      FROM ludy_projects.github_outbound_delivery_claim(${job.orgId}::uuid, ${job.deliveryId}::uuid)`.execute(deps.workerDb);
  const claimed = claimRows[0];
  if (!claimed) {
    return 'skipped';
  }

  const targetState =
    claimed.target_remote_state === 'open' || claimed.target_remote_state === 'closed'
      ? claimed.target_remote_state
      : null;
  if (!claimed.task_id || !claimed.link_id || !targetState) {
    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      'skipped',
      claimed.task_id,
      'INVALID_TARGET',
      'Outbound delivery missing task, link, or target state',
    );
    return 'skipped';
  }

  const outCtx = await deps.runtime.query<GithubOutboundContextResult>(
    'projects.github.outbound_context',
    { projectId: claimed.project_id, taskId: claimed.task_id, linkId: claimed.link_id },
    { actor: SYSTEM, orgId: job.orgId },
  );

  if (
    outCtx.projectArchived ||
    !outCtx.binding ||
    !outCtx.binding.githubEnabled ||
    !outCtx.binding.outboundCloseIssueOnDone ||
    outCtx.binding.pausedAt !== null ||
    outCtx.binding.connectionStatus !== 'active' ||
    !outCtx.binding.channelConnectionId ||
    !outCtx.repoBound ||
    !outCtx.link ||
    outCtx.link.kind !== 'issue'
  ) {
    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      'skipped',
      claimed.task_id,
      'PRECONDITION_SKIPPED',
      'Opt-in outbound sync disabled, paused, unbound, or link is not an issue',
    );
    return 'skipped';
  }

  const taskMatchesTarget =
    (targetState === 'closed' && outCtx.taskStatus === 'done') ||
    (targetState === 'open' && outCtx.taskStatus !== null && outCtx.taskStatus !== 'done' && outCtx.taskStatus !== 'cancelled');
  if (!taskMatchesTarget) {
    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      'skipped',
      claimed.task_id,
      'TASK_STATE_CHANGED',
      'Task status changed before outbound delivery ran',
    );
    return 'skipped';
  }

  // Layer 2 check before credential open and PATCH: skip cleanly if remote link state already matches target.
  if (outCtx.link.externalState === targetState) {
    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      'skipped',
      claimed.task_id,
      null,
      `Issue ${outCtx.link.repoFullName}#${outCtx.link.externalNumber} already ${targetState}`,
    );
    return 'skipped';
  }

  const auth = await resolveGithubBindingAuth(deps, job.orgId, outCtx.binding.channelConnectionId);
  if (!auth) {
    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      'failed',
      claimed.task_id,
      'CREDENTIALS_UNAVAILABLE',
      'GitHub credentials could not be opened for outbound sync',
    );
    return 'failed';
  }

  const slashIdx = outCtx.link.repoFullName.indexOf('/');
  const owner = slashIdx > 0 ? outCtx.link.repoFullName.slice(0, slashIdx) : '';
  const repo = slashIdx > 0 ? outCtx.link.repoFullName.slice(slashIdx + 1) : '';

  try {
    const updatedItem = await deps.github.setIssueState({
      auth,
      owner,
      repo,
      issueNumber: outCtx.link.externalNumber,
      state: targetState,
      kind: 'issue',
    });

    const recorded = await deps.runtime.execute<GithubRecordOutboundResult>(
      'projects.github.record_outbound',
      {
        projectId: claimed.project_id,
        taskId: claimed.task_id,
        linkId: claimed.link_id,
        externalState: updatedItem.externalState === 'closed' ? 'closed' : 'open',
        externalTitle: updatedItem.externalTitle,
        remoteUpdatedAt: updatedItem.updatedAt,
      },
      { actor: SYSTEM, orgId: job.orgId },
    );

    await finishOutboundDelivery(
      deps.workerDb,
      job.orgId,
      claimed.id,
      recorded.updated ? 'applied' : 'skipped',
      claimed.task_id,
      null,
      `Set ${outCtx.link.repoFullName}#${outCtx.link.externalNumber} state=${targetState}`,
    );
    return recorded.updated ? 'applied' : 'skipped';
  } catch (error) {
    const isPermanentGithub =
      error instanceof GithubError &&
      (error.kind === 'not_found' || error.kind === 'forbidden' || error.kind === 'credentials' || error.kind === 'bad_request');
    const code =
      error instanceof GithubError
        ? `GITHUB_${error.kind.toUpperCase()}`
        : error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'ERROR';
    const retriesExhausted =
      claimed.attempt_count >= 5 ||
      (meta?.retryCount !== undefined && meta?.retryLimit !== undefined && meta.retryCount >= meta.retryLimit);

    if (isPermanentGithub || retriesExhausted) {
      await finishOutboundDelivery(
        deps.workerDb,
        job.orgId,
        claimed.id,
        'failed',
        claimed.task_id,
        code.slice(0, 64),
        'Outbound GitHub issue state sync failed',
      ).catch(() => {});
      if (isPermanentGithub) return 'failed';
    }
    throw error;
  }
}
