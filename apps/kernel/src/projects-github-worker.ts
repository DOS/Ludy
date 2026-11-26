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
  GithubTaskLinksQueryResult,
} from '@ludy/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { jobKey } from './job-keys.ts';
import { QUEUES } from './jobs-schema.ts';

export const PROJECTS_GITHUB_WEBHOOK_SWEEP_CRON = '*/10 * * * *';
export const PROJECTS_GITHUB_WEBHOOK_SWEEP_EXPIRE_SECONDS = 300;
export const PROJECTS_GITHUB_HYDRATE_RETRY_LIMIT = 3;

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

    if (sendHydrate && parsed.branchName && (matchedNumbers.length > 0 || matchedTaskIds.length > 0)) {
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
          await sql`
            SELECT ludy_projects.github_app_installation_handle(${parsed.installationId}::bigint, ${parsed.action}, NULL::bigint[])`.execute(deps.workerDb);
          await sql`SELECT ludy_projects.github_webhook_pending_done(${row.seq}::bigint)`.execute(deps.workerDb);
          appProcessed += 1;
          continue;
        }

        if (parsed.eventType === 'installation_repositories') {
          if (parsed.action === 'removed' && parsed.removedRepoIds.length > 0) {
            await sql`
              SELECT ludy_projects.github_app_installation_handle(
                ${parsed.installationId}::bigint,
                'removed',
                ${sql`ARRAY[${sql.join(parsed.removedRepoIds.map((id) => sql`${id}::bigint`))}]::bigint[]`}
              )`.execute(deps.workerDb);
          }
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
            FROM ludy_projects.github_app_org_bindings(${installId}::bigint, ${parsed.repoFullName})`.execute(deps.workerDb);
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
        if (!parsed || parsed.eventType === 'installation' || parsed.eventType === 'installation_repositories') {
          patDropped += 1;
          continue;
        }

        const { rows: bindings } = await sql<BindingRow>`
          SELECT org_id, project_id, binding_id, channel_connection_id, task_key_prefix,
                 auto_link_mentions, auto_link_branch, inbound_in_progress_on_pr, inbound_done_on_merge,
                 inbound_col_in_progress, inbound_col_in_review, inbound_col_done
          FROM ludy_projects.github_pat_org_bindings(${row.connection_id}::uuid, ${parsed.repoFullName})`.execute(deps.workerDb);
        for (const binding of bindings) {
          await applyParsedEventToBinding(deps, binding, row.delivery_id, row.event_type, parsed, deps.sendHydrate);
        }
        patOk += 1;
      }

      for (const refused of refusedHooks) {
        await sql`
          SELECT ludy_projects.github_webhook_hook_reject(${refused.rejectToken}::uuid, ${refused.generation}::int)`.execute(deps.workerDb);
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

  let auth: { kind: 'github_pat'; token: string } | { kind: 'github_app'; installationId: string };
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>(
      'kernel.channel.credential',
      { connectionId: binding.channelConnectionId },
      { actor: SYSTEM, orgId: job.orgId },
    );
    const opened = deps.broker.open(
      { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
      { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
    );
    const decoded = JSON.parse(opened) as { accessToken?: unknown; installationId?: unknown };
    if (sealed.provider === 'github_app' && typeof decoded.installationId === 'string') {
      auth = { kind: 'github_app', installationId: decoded.installationId };
    } else if (sealed.provider === 'github_pat' && typeof decoded.accessToken === 'string') {
      auth = { kind: 'github_pat', token: decoded.accessToken };
    } else {
      return 'skipped';
    }
  } catch {
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
