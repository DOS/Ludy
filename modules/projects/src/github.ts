// SPDX-License-Identifier: AGPL-3.0-only
// Projects GitHub Integration commands, queries, and task-key allocation (#5158, ADR-0060).
import { sql } from 'kysely';
import type { BoardTaskStatus } from '@ludy/kernel-contract';
import {
  GITHUB_REPOS_PER_PROJECT_MAX,
  auditValue,
  formatProjectTaskKey,
  tableWrite,
  zGithubApplyInboundEventInput,
  zGithubBindingGetInput,
  zGithubBindingSaveInput,
  zGithubHookSetInput,
  zGithubHookStatusInput,
  zGithubInstallationSyncInput,
  zGithubIssueMatchRpcInput,
  zGithubLinkPrepareInput,
  zGithubOutboundContextQueryInput,
  zGithubOutboundEnqueueInput,
  zGithubPrSummaryRpcInput,
  zGithubRecordOutboundInput,
  zGithubRepoBindInput,
  zGithubRepoUnbindInput,
  zGithubSyncLogQueryInput,
  zGithubTaskLinkAddInput,
  zGithubTaskLinkRemoveInput,
  zGithubTaskLinksQueryInput,
  type GithubApplyInboundEventInput,
  type GithubApplyInboundEventResult,
  type GithubBindingGetResult,
  type GithubBindingSaveResult,
  type GithubHookSetResult,
  type GithubHookStanding,
  type GithubHookStatusResult,
  type GithubInstallationSyncResult,
  type GithubLinkPrepareResult,
  type GithubOutboundContextResult,
  type GithubProjectBindingView,
  type GithubProjectRepoView,
  type GithubRecordOutboundResult,
  type GithubSyncLogEntry,
  type GithubSyncLogQueryResult,
  type GithubTaskLinkView,
  type GithubTaskLinksQueryResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { loadProjectColumns, resolveTaskColumnId } from './columns.ts';
import { projectsManifest } from './manifest.ts';
import { assertNotArchived, loadProject, projectNotFound, taskNotFound, userOf, WRITERS } from './shared.ts';

const TABLES = projectsManifest.tables;
const GITHUB_TASK_LINK = TABLES.ludy_projects.github_task_link;

let githubBrokerAvailable = true;
let githubAppInfo: { configured: boolean; slug: string | null } = { configured: false, slug: null };

export function setProjectsGithubBrokerAvailable(available: boolean): void {
  githubBrokerAvailable = available;
}

export function setProjectsGithubAppInfo(info: { configured: boolean; slug: string | null }): void {
  githubAppInfo = { configured: info.configured, slug: info.slug };
}

const ADMINS = ['owner', 'admin'] as const;
const MEMBERS = ['owner', 'admin', 'member'] as const;
const READERS = ['owner', 'admin', 'member', 'viewer'] as const;

const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

function pgErrorOf(error: unknown): { code?: string; constraint?: string } | null {
  return error !== null && typeof error === 'object' ? (error as { code?: string; constraint?: string }) : null;
}

function toRepoView(row: {
  id: string;
  github_repo_id: string;
  repo_full_name: string;
  default_branch: string;
  webhook_configured: boolean;
  last_event_at: Date | string | null;
  created_at: Date | string;
}): GithubProjectRepoView {
  return {
    id: row.id,
    githubRepoId: row.github_repo_id,
    repoFullName: row.repo_full_name,
    defaultBranch: row.default_branch,
    webhookConfigured: row.webhook_configured,
    lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toLinkView(row: {
  id: string;
  project_id: string;
  task_id: string;
  repo_full_name: string;
  kind: 'issue' | 'pull_request';
  external_number: number;
  external_url: string;
  external_title: string;
  external_state: 'open' | 'closed' | 'merged' | 'draft';
  branch_name: string | null;
  author_login: string | null;
  link_source: 'manual' | 'mention' | 'branch';
  closes_task: boolean;
  hydrating: boolean;
  last_outbound_state: 'open' | 'closed' | null;
  last_outbound_at: Date | string | null;
  last_synced_at: Date | string;
  created_at: Date | string;
}): GithubTaskLinkView {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    repoFullName: row.repo_full_name,
    kind: row.kind,
    externalNumber: row.external_number,
    externalUrl: row.external_url,
    externalTitle: row.external_title,
    externalState: row.external_state,
    branchName: row.branch_name,
    authorLogin: row.author_login,
    linkSource: row.link_source,
    closesTask: row.closes_task,
    hydrating: row.hydrating,
    tainted: true,
    lastOutboundState: row.last_outbound_state ?? null,
    lastOutboundAt: row.last_outbound_at ? new Date(row.last_outbound_at).toISOString() : null,
    lastSyncedAt: new Date(row.last_synced_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadBindingView(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  revealExternalAccountId: boolean,
): Promise<GithubProjectBindingView | null> {
  const row = await trx
    .selectFrom('ludy_projects.github_project_binding as b')
    .innerJoin('ludy_kernel.channel_connection as c', (join) =>
      join.onRef('c.org_id', '=', 'b.org_id').onRef('c.id', '=', 'b.channel_connection_id'),
    )
    .select([
      'b.id',
      'b.project_id',
      'b.channel_connection_id',
      'c.provider',
      'c.display_name',
      'c.status as connection_status',
      'c.external_account_id',
      'b.github_enabled',
      'b.task_key_prefix',
      'b.next_task_number',
      'b.auto_sync_inbound',
      'b.auto_link_mentions',
      'b.auto_link_branch',
      'b.inbound_in_progress_on_pr',
      'b.inbound_done_on_merge',
      'b.outbound_close_issue_on_done',
      'b.inbound_col_in_progress',
      'b.inbound_col_in_review',
      'b.inbound_col_done',
      'b.paused_reason',
      'b.paused_at',
      'b.updated_at',
    ])
    .where('b.org_id', '=', orgId)
    .where('b.project_id', '=', projectId)
    .executeTakeFirst();

  if (!row) return null;

  const repoRows = await trx
    .selectFrom('ludy_projects.github_project_repo')
    .select(['id', 'github_repo_id', 'repo_full_name', 'default_branch', 'webhook_configured', 'last_event_at', 'created_at'])
    .where('org_id', '=', orgId)
    .where('binding_id', '=', row.id)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  let hookStanding: GithubHookStanding = 'none';
  let hookLastSeenAt: string | null = null;
  if (row.provider === 'github_pat') {
    const { rows: hookRows } = await sql<{
      standing: GithubHookStanding;
      last_seen_at: Date | string | null;
    }>`
      SELECT standing, last_seen_at
      FROM ludy_projects.github_webhook_hook_status(${row.channel_connection_id}::uuid)`.execute(trx);
    const hs = hookRows[0];
    if (hs) {
      hookStanding = hs.standing;
      hookLastSeenAt = hs.last_seen_at ? new Date(hs.last_seen_at).toISOString() : null;
    }
  }

  return {
    id: row.id,
    projectId: row.project_id,
    channelConnectionId: row.channel_connection_id,
    provider: row.provider === 'github_app' ? 'github_app' : 'github_pat',
    connectionDisplayName: row.display_name,
    connectionStatus: row.connection_status,
    externalAccountId: revealExternalAccountId ? row.external_account_id : null,
    githubEnabled: row.github_enabled,
    taskKeyPrefix: row.task_key_prefix,
    nextTaskNumber: row.next_task_number,
    autoSyncInbound: row.auto_sync_inbound,
    autoLinkMentions: row.auto_link_mentions,
    autoLinkBranch: row.auto_link_branch,
    inboundInProgressOnPr: row.inbound_in_progress_on_pr,
    inboundDoneOnMerge: row.inbound_done_on_merge,
    outboundCloseIssueOnDone: row.outbound_close_issue_on_done,
    inboundColInProgress: row.inbound_col_in_progress,
    inboundColInReview: row.inbound_col_in_review,
    inboundColDone: row.inbound_col_done,
    pausedReason: row.paused_reason,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    hookStanding,
    hookLastSeenAt,
    repos: repoRows.map(toRepoView),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// Allocates the next task_number only when a project has an active GitHub task_key_prefix.
// Caller MUST already hold FOR UPDATE lock on the parent project (preserving project -> binding -> project_task order).
export async function allocateProjectTaskNumber(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  now: Date,
): Promise<number | null> {
  const { rows } = await sql<{ allocated: number }>`
    UPDATE ludy_projects.github_project_binding
       SET next_task_number = next_task_number + 1,
           updated_at = ${now}
     WHERE org_id = ${orgId}::uuid
       AND project_id = ${projectId}::uuid
       AND github_enabled = true
       AND task_key_prefix IS NOT NULL
    RETURNING next_task_number - 1 AS allocated`.execute(trx);
  return rows[0]?.allocated ?? null;
}

export async function allocateProjectTaskNumbers(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  count: number,
  now: Date,
): Promise<Array<number | null>> {
  if (count <= 0) return [];
  const { rows } = await sql<{ end_num: number }>`
    UPDATE ludy_projects.github_project_binding
       SET next_task_number = next_task_number + ${count}::int,
           updated_at = ${now}
     WHERE org_id = ${orgId}::uuid
       AND project_id = ${projectId}::uuid
       AND github_enabled = true
       AND task_key_prefix IS NOT NULL
    RETURNING next_task_number AS end_num`.execute(trx);
  const endNum = rows[0]?.end_num;
  if (endNum === undefined) {
    return Array.from({ length: count }, () => null);
  }
  const start = endNum - count;
  return Array.from({ length: count }, (_, idx) => start + idx);
}

export const projectGithubBindingGet = defineQuery({
  name: 'projects.github.binding.get',
  input: zGithubBindingGetInput,
  access: READERS,
  handler: async (ctx, input): Promise<GithubBindingGetResult> => {
    let projectId: string;
    if (ctx.actor.type === 'system') {
      const row = await ctx.trx
        .selectFrom('ludy_projects.project')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.projectId)
        .executeTakeFirst();
      if (!row) throw projectNotFound();
      projectId = row.id;
    } else {
      userOf(ctx.actor);
      const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
      projectId = project.id;
    }
    const revealExternalAccountId = ctx.actor.type === 'system' || ctx.role === 'owner' || ctx.role === 'admin';
    const binding = await loadBindingView(ctx.trx, ctx.orgId, projectId, revealExternalAccountId);
    return {
      brokerConfigured: githubBrokerAvailable,
      appConfigured: githubAppInfo.configured,
      appSlug: githubAppInfo.slug,
      binding,
    };
  },
});

export const projectGithubBindingSave = defineCommand({
  name: 'projects.github.binding.save',
  input: zGithubBindingSaveInput,
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'github_project_binding', [
      'org_id',
      'project_id',
      'channel_connection_id',
      'github_enabled',
      'task_key_prefix',
      'next_task_number',
      'auto_sync_inbound',
      'auto_link_mentions',
      'auto_link_branch',
      'inbound_in_progress_on_pr',
      'inbound_done_on_merge',
      'outbound_close_issue_on_done',
      'inbound_col_in_progress',
      'inbound_col_in_review',
      'inbound_col_done',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    tableWrite(TABLES, 'ludy_projects', 'project_task', ['task_number']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<GithubBindingSaveResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const conn = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.channelConnectionId)
      .executeTakeFirst();
    if (!conn || conn.status !== 'active' || (conn.provider !== 'github_app' && conn.provider !== 'github_pat')) {
      throw new DomainError('GITHUB_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối GitHub đang hoạt động');
    }

    const colCheck = async (columnId: string | null | undefined, expected: BoardTaskStatus) => {
      if (columnId === undefined || columnId === null) return;
      const col = await ctx.trx
        .selectFrom('ludy_projects.project_column')
        .select(['id', 'task_status'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('id', '=', columnId)
        .executeTakeFirst();
      if (!col) throw new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
      if (col.task_status !== expected) {
        throw new DomainError('COLUMN_STATUS_MISMATCH', 400, 'Cột đích không khớp với trạng thái đồng bộ từ GitHub');
      }
    };
    await colCheck(input.inboundColInProgress, 'in_progress');
    await colCheck(input.inboundColInReview, 'in_review');
    await colCheck(input.inboundColDone, 'done');

    const existing = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();

    const nextPrefix = input.taskKeyPrefix !== undefined ? input.taskKeyPrefix : (existing?.task_key_prefix ?? null);
    let nextTaskNumber = existing?.next_task_number ?? 1;

    try {
      if (!existing) {
        await ctx.trx
          .insertInto('ludy_projects.github_project_binding')
          .values({
            org_id: ctx.orgId,
            project_id: project.id,
            channel_connection_id: conn.id,
            github_enabled: input.githubEnabled,
            task_key_prefix: nextPrefix,
            next_task_number: nextTaskNumber,
            auto_sync_inbound: input.autoSyncInbound ?? true,
            auto_link_mentions: input.autoLinkMentions ?? true,
            auto_link_branch: input.autoLinkBranch ?? true,
            inbound_in_progress_on_pr: input.inboundInProgressOnPr ?? true,
            inbound_done_on_merge: input.inboundDoneOnMerge ?? true,
            outbound_close_issue_on_done: input.outboundCloseIssueOnDone ?? false,
            inbound_col_in_progress: input.inboundColInProgress ?? null,
            inbound_col_in_review: input.inboundColInReview ?? null,
            inbound_col_done: input.inboundColDone ?? null,
            created_by: userId,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .execute();
      } else {
        await ctx.trx
          .updateTable('ludy_projects.github_project_binding')
          .set({
            channel_connection_id: conn.id,
            github_enabled: input.githubEnabled,
            task_key_prefix: nextPrefix,
            auto_sync_inbound: input.autoSyncInbound ?? existing.auto_sync_inbound,
            auto_link_mentions: input.autoLinkMentions ?? existing.auto_link_mentions,
            auto_link_branch: input.autoLinkBranch ?? existing.auto_link_branch,
            inbound_in_progress_on_pr: input.inboundInProgressOnPr ?? existing.inbound_in_progress_on_pr,
            inbound_done_on_merge: input.inboundDoneOnMerge ?? existing.inbound_done_on_merge,
            outbound_close_issue_on_done: input.outboundCloseIssueOnDone ?? existing.outbound_close_issue_on_done,
            inbound_col_in_progress:
              input.inboundColInProgress !== undefined ? input.inboundColInProgress : existing.inbound_col_in_progress,
            inbound_col_in_review:
              input.inboundColInReview !== undefined ? input.inboundColInReview : existing.inbound_col_in_review,
            inbound_col_done:
              input.inboundColDone !== undefined ? input.inboundColDone : existing.inbound_col_done,
            paused_reason: null,
            paused_at: null,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .execute();
      }
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg?.code === '23505' && pg.constraint === 'github_project_binding_prefix_uq') {
        throw new DomainError('GITHUB_TASK_PREFIX_TAKEN', 409, 'Mã tiền tố công việc này đã được dự án khác sử dụng');
      }
      throw error;
    }

    let backfilledCount = 0;
    if (input.githubEnabled && nextPrefix !== null && input.backfillTaskNumbers === true) {
      const missingTasks = await ctx.trx
        .selectFrom('ludy_projects.project_task')
        .select(['id'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('task_number', 'is', null)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      for (const item of missingTasks) {
        await ctx.trx
          .updateTable('ludy_projects.project_task')
          .set({ task_number: nextTaskNumber })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', item.id)
          .execute();
        nextTaskNumber++;
        backfilledCount++;
      }
      if (backfilledCount > 0) {
        await ctx.trx
          .updateTable('ludy_projects.github_project_binding')
          .set({ next_task_number: nextTaskNumber, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', project.id)
          .execute();
      }
    }

    const binding = await loadBindingView(ctx.trx, ctx.orgId, project.id, true);
    if (!binding) throw new DomainError('GITHUB_BINDING_NOT_FOUND', 404, 'Không tìm thấy cấu hình GitHub');
    ctx.audit({
      projectId: project.id,
      githubEnabled: binding.githubEnabled,
      taskKeyPrefix: binding.taskKeyPrefix,
      backfilledCount,
    });
    await ctx.emit('projects.github.binding_saved', { projectId: project.id, githubEnabled: binding.githubEnabled });
    return { binding, backfilledCount };
  },
});

export const projectGithubRepoBind = defineCommand({
  name: 'projects.github.repo.bind',
  input: zGithubRepoBindInput,
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'github_project_repo', [
      'org_id',
      'project_id',
      'binding_id',
      'github_repo_id',
      'repo_full_name',
      'default_branch',
      'webhook_configured',
      'created_by',
      'created_at',
    ]),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ binding: GithubProjectBindingView }> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const bindingRow = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (!bindingRow) {
      throw new DomainError('GITHUB_BINDING_NOT_FOUND', 404, 'Hãy kết nối GitHub trước khi gắn kho mã nguồn');
    }

    const existing = await ctx.trx
      .selectFrom('ludy_projects.github_project_repo')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('github_repo_id', '=', input.githubRepoId)
      .executeTakeFirst();

    if (existing) {
      await ctx.trx
        .updateTable('ludy_projects.github_project_repo')
        .set({
          repo_full_name: input.repoFullName,
          default_branch: input.defaultBranch ?? 'main',
          ...(input.webhookConfigured !== undefined ? { webhook_configured: input.webhookConfigured } : {}),
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      const bound = await ctx.trx
        .selectFrom('ludy_projects.github_project_repo')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .execute();
      if (bound.length >= GITHUB_REPOS_PER_PROJECT_MAX) {
        throw new DomainError(
          'GITHUB_REPO_LIMIT_REACHED',
          409,
          `Mỗi dự án chỉ gắn tối đa ${GITHUB_REPOS_PER_PROJECT_MAX} kho mã nguồn GitHub`,
        );
      }
      await ctx.trx
        .insertInto('ludy_projects.github_project_repo')
        .values({
          org_id: ctx.orgId,
          project_id: project.id,
          binding_id: bindingRow.id,
          github_repo_id: input.githubRepoId,
          repo_full_name: input.repoFullName,
          default_branch: input.defaultBranch ?? 'main',
          webhook_configured: input.webhookConfigured ?? false,
          created_by: userId,
          created_at: ctx.now,
        })
        .execute();
    }

    const view = await loadBindingView(ctx.trx, ctx.orgId, project.id, true);
    if (!view) throw new DomainError('GITHUB_BINDING_NOT_FOUND', 404, 'Không tìm thấy cấu hình GitHub');
    ctx.audit({ projectId: project.id, githubRepoId: input.githubRepoId });
    await ctx.emit('projects.github.repo_bound', { projectId: project.id });
    return { binding: view };
  },
});

export const projectGithubRepoUnbind = defineCommand({
  name: 'projects.github.repo.unbind',
  input: zGithubRepoUnbindInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'github_project_repo', ['org_id', 'project_id', 'id'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ binding: GithubProjectBindingView }> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    await ctx.trx
      .deleteFrom('ludy_projects.github_project_repo')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', input.repoId)
      .execute();

    const view = await loadBindingView(ctx.trx, ctx.orgId, project.id, true);
    if (!view) throw new DomainError('GITHUB_BINDING_NOT_FOUND', 404, 'Không tìm thấy cấu hình GitHub');
    ctx.audit({ projectId: project.id, repoId: input.repoId });
    return { binding: view };
  },
});

export const projectGithubHookSet = defineCommand({
  name: 'projects.github.hook_set',
  input: zGithubHookSetInput,
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<GithubHookSetResult> => {
    userOf(ctx.actor);
    const { rows } = await sql<{ hook_id: string; created: boolean; generation: number }>`
      SELECT hook_id, created, generation
        FROM ludy_projects.github_webhook_hook_set(${input.connectionId}::uuid, ${input.hookKeySha256})`.execute(ctx.trx);
    const row = rows[0];
    if (!row) throw new DomainError('GITHUB_HOOK_SET_FAILED', 500, 'Không lưu được webhook GitHub');
    ctx.audit({ connectionId: input.connectionId, hookId: row.hook_id, created: row.created, generation: row.generation });
    return { hookId: row.hook_id, created: row.created, generation: row.generation };
  },
});

export const projectGithubHookStatus = defineQuery({
  name: 'projects.github.hook_status',
  input: zGithubHookStatusInput,
  access: ADMINS,
  handler: async (ctx, input): Promise<GithubHookStatusResult> => {
    userOf(ctx.actor);
    const { rows } = await sql<{
      hook_id: string | null;
      configured: boolean;
      standing: GithubHookStanding;
      last_seen_at: Date | string | null;
      stopped_at: Date | string | null;
      rotated_at: Date | string | null;
    }>`
      SELECT hook_id, configured, standing, last_seen_at, stopped_at, rotated_at
        FROM ludy_projects.github_webhook_hook_status(${input.connectionId}::uuid)`.execute(ctx.trx);
    const row = rows[0];
    return {
      hookId: row?.hook_id ?? null,
      configured: Boolean(row?.configured),
      standing: row?.standing ?? 'none',
      lastSeenAt: row?.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
      stoppedAt: row?.stopped_at ? new Date(row.stopped_at).toISOString() : null,
      rotatedAt: row?.rotated_at ? new Date(row.rotated_at).toISOString() : null,
    };
  },
});

export const projectGithubTaskLinks = defineQuery({
  name: 'projects.github.task_links',
  input: zGithubTaskLinksQueryInput,
  access: READERS,
  handler: async (ctx, input): Promise<GithubTaskLinksQueryResult> => {
    let projectId: string;
    if (ctx.actor.type === 'system') {
      const row = await ctx.trx
        .selectFrom('ludy_projects.project')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.projectId)
        .executeTakeFirst();
      if (!row) throw projectNotFound();
      projectId = row.id;
    } else {
      userOf(ctx.actor);
      const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
      projectId = project.id;
    }
    const visibleTask = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['pt.task_id', 'pt.task_number'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', projectId)
      .where('pt.task_id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const binding = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .select(['github_enabled', 'task_key_prefix'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();

    if (!binding || !binding.github_enabled) {
      return { githubEnabled: false, taskKey: null, links: [] };
    }

    const links = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', projectId)
      .where('task_id', '=', input.taskId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    return {
      githubEnabled: true,
      taskKey: formatProjectTaskKey(binding.task_key_prefix, visibleTask.task_number),
      links: links.map(toLinkView),
    };
  },
});

async function resolveTaskLinkTarget(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  taskId: string,
  repoFullName: string,
  lockTask: boolean,
): Promise<{
  projectId: string;
  provider: 'github_app' | 'github_pat';
  externalAccountId: string;
  repoFullName: string;
}> {
  const project = await loadProject(trx, orgId, projectId, false);
  assertNotArchived(project);

  const taskQuery = trx
    .selectFrom('ludy_projects.project_task as pt')
    .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
    .select(['pt.task_id'])
    .where('pt.org_id', '=', orgId)
    .where('pt.project_id', '=', project.id)
    .where('pt.task_id', '=', taskId);
  const visibleTask = await (lockTask ? taskQuery.forUpdate() : taskQuery).executeTakeFirst();
  if (!visibleTask) throw taskNotFound();

  const binding = await trx
    .selectFrom('ludy_projects.github_project_binding as b')
    .innerJoin('ludy_kernel.channel_connection as c', (join) =>
      join.onRef('c.org_id', '=', 'b.org_id').onRef('c.id', '=', 'b.channel_connection_id'),
    )
    .select(['b.id', 'b.github_enabled', 'c.provider', 'c.external_account_id'])
    .where('b.org_id', '=', orgId)
    .where('b.project_id', '=', project.id)
    .executeTakeFirst();
  if (!binding || !binding.github_enabled) {
    throw new DomainError('GITHUB_DISABLED', 409, 'Dự án này chưa bật tích hợp GitHub');
  }

  const boundRepo = await trx
    .selectFrom('ludy_projects.github_project_repo')
    .select(['id', 'repo_full_name'])
    .where('org_id', '=', orgId)
    .where('project_id', '=', project.id)
    .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${repoFullName})`)
    .executeTakeFirst();
  if (!boundRepo) {
    throw new DomainError('GITHUB_REPO_NOT_BOUND', 403, 'Kho mã nguồn GitHub này chưa được gắn với dự án');
  }

  return {
    projectId: project.id,
    provider: binding.provider === 'github_app' ? 'github_app' : 'github_pat',
    externalAccountId: binding.external_account_id,
    repoFullName: boundRepo.repo_full_name,
  };
}

export const projectGithubLinkPrepare = defineQuery({
  name: 'projects.github.link.prepare',
  input: zGithubLinkPrepareInput,
  access: WRITERS,
  handler: async (ctx, input): Promise<GithubLinkPrepareResult> => {
    userOf(ctx.actor);
    const target = await resolveTaskLinkTarget(ctx.trx, ctx.orgId, input.projectId, input.taskId, input.repoFullName, false);
    return {
      provider: target.provider,
      externalAccountId: target.externalAccountId,
      repoFullName: target.repoFullName,
    };
  },
});

export const projectGithubTaskLinkAdd = defineCommand({
  name: 'projects.github.link.add',
  input: zGithubTaskLinkAddInput,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'github_task_link', [
      'org_id',
      'project_id',
      'task_id',
      'repo_full_name',
      'kind',
      'external_number',
      'external_url',
      'external_title',
      'external_state',
      'branch_name',
      'author_login',
      'link_source',
      'closes_task',
      'hydrating',
      'tainted',
      'last_synced_at',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ link: GithubTaskLinkView }> => {
    const userId = userOf(ctx.actor);
    const target = await resolveTaskLinkTarget(ctx.trx, ctx.orgId, input.projectId, input.taskId, input.repoFullName, true);

    const existing = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', target.projectId)
      .where('task_id', '=', input.taskId)
      .where('kind', '=', input.kind)
      .where('external_number', '=', input.externalNumber)
      .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${target.repoFullName})`)
      .executeTakeFirst();

    let savedRow;
    if (existing) {
      savedRow = await ctx.trx
        .updateTable('ludy_projects.github_task_link')
        .set({
          external_url: input.externalUrl,
          external_title: input.externalTitle,
          external_state: input.externalState,
          branch_name: input.branchName !== undefined ? input.branchName : existing.branch_name,
          author_login: input.authorLogin !== undefined ? input.authorLogin : existing.author_login,
          hydrating: input.hydrating ?? false,
          tainted: true,
          last_synced_at: ctx.now,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      savedRow = await ctx.trx
        .insertInto('ludy_projects.github_task_link')
        .values({
          org_id: ctx.orgId,
          project_id: target.projectId,
          task_id: input.taskId,
          repo_full_name: target.repoFullName,
          kind: input.kind,
          external_number: input.externalNumber,
          external_url: input.externalUrl,
          external_title: input.externalTitle,
          external_state: input.externalState,
          branch_name: input.branchName ?? null,
          author_login: input.authorLogin ?? null,
          link_source: input.linkSource ?? 'manual',
          closes_task: input.closesTask ?? true,
          hydrating: input.hydrating ?? false,
          tainted: true,
          last_outbound_state: null,
          last_outbound_at: null,
          last_synced_at: ctx.now,
          created_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    ctx.audit({
      projectId: target.projectId,
      taskId: input.taskId,
      kind: input.kind,
      externalNumber: input.externalNumber,
      externalTitle: auditValue(GITHUB_TASK_LINK, 'external_title', savedRow.external_title),
    });
    await ctx.emit('projects.github.link_added', {
      projectId: target.projectId,
      taskId: input.taskId,
      linkId: savedRow.id,
      kind: savedRow.kind,
      externalNumber: savedRow.external_number,
      hydrating: savedRow.hydrating,
    });
    return { link: toLinkView(savedRow) };
  },
});

export const projectGithubTaskLinkRemove = defineCommand({
  name: 'projects.github.link.remove',
  input: zGithubTaskLinkRemoveInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'github_task_link', ['org_id', 'project_id', 'id'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ removed: boolean }> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(project);

    const visibleTask = await ctx.trx
      .selectFrom('ludy_projects.project_task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const deleted = await ctx.trx
      .deleteFrom('ludy_projects.github_task_link')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .where('id', '=', input.linkId)
      .returning('id')
      .executeTakeFirst();

    const removed = deleted !== undefined;
    ctx.audit({ projectId: project.id, taskId: input.taskId, linkId: input.linkId, removed });
    return { removed };
  },
});

export const projectGithubSyncLog = defineQuery({
  name: 'projects.github.sync_log',
  input: zGithubSyncLogQueryInput,
  access: READERS,
  handler: async (ctx, input): Promise<GithubSyncLogQueryResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    const { rows } = await sql<{
      id: string;
      direction: 'inbound' | 'outbound';
      delivery_id: string;
      event_type: string;
      repo_full_name: string | null;
      external_number: number | null;
      task_id: string | null;
      status: GithubSyncLogEntry['status'];
      error_code: string | null;
      summary: string | null;
      received_at: Date | string;
      processed_at: Date | string | null;
    }>`
      SELECT id, direction, delivery_id, event_type, repo_full_name, external_number, task_id, status, error_code, summary, received_at, processed_at
        FROM ludy_projects.github_sync_delivery_list(${project.id}::uuid, ${input.limit ?? 30}::int)`.execute(ctx.trx);

    return {
      entries: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        deliveryId: r.delivery_id,
        eventType: r.event_type,
        repoFullName: r.repo_full_name,
        externalNumber: r.external_number,
        taskId: r.task_id,
        status: r.status,
        errorCode: r.error_code,
        summary: r.summary,
        receivedAt: new Date(r.received_at).toISOString(),
        processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : null,
      })),
    };
  },
});

export const projectGithubApplyInboundEvent = defineCommand({
  name: 'projects.github.apply_inbound_event',
  input: zGithubApplyInboundEventInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: projectTarget,
  handler: async (ctx, input): Promise<GithubApplyInboundEventResult> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới xử lý được sự kiện đồng bộ GitHub');
    }

    const project = await ctx.trx
      .selectFrom('ludy_projects.project')
      .select(['id', 'status', 'is_template'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.projectId)
      .forUpdate()
      .executeTakeFirst();
    if (!project || project.status === 'archived' || project.is_template) {
      return { linkedTaskIds: [], transitionedTaskIds: [], deferredTaskIds: [], status: 'skipped' };
    }

    const binding = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .executeTakeFirst();
    const isManualRefresh = input.matches.length > 0 && input.matches.every((m) => m.linkSource === 'manual');
    if (!binding || !binding.github_enabled || (!binding.auto_sync_inbound && !isManualRefresh) || binding.paused_at !== null) {
      return { linkedTaskIds: [], transitionedTaskIds: [], deferredTaskIds: [], status: 'skipped' };
    }

    // Resolve tasks matched from mentions/branch/URLs.
    const matchedTasks = new Map<string, { linkSource: 'manual' | 'mention' | 'branch'; closesTask: boolean }>();
    const taskNumbers = input.matches.map((m) => m.taskNumber).filter((n): n is number => typeof n === 'number');
    const explicitTaskIds = input.matches.map((m) => m.taskId).filter((id): id is string => typeof id === 'string');

    if (taskNumbers.length > 0) {
      const byNum = await ctx.trx
        .selectFrom('ludy_projects.project_task')
        .select(['task_id', 'task_number'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('task_number', 'in', taskNumbers)
        .execute();
      for (const row of byNum) {
        const spec = input.matches.find((m) => m.taskNumber === row.task_number);
        if (spec) {
          matchedTasks.set(row.task_id, { linkSource: spec.linkSource, closesTask: spec.closesTask });
        }
      }
    }

    if (explicitTaskIds.length > 0) {
      const byId = await ctx.trx
        .selectFrom('ludy_projects.project_task')
        .select(['task_id'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('task_id', 'in', explicitTaskIds)
        .execute();
      for (const row of byId) {
        const spec = input.matches.find((m) => m.taskId === row.task_id);
        if (spec && !matchedTasks.has(row.task_id)) {
          matchedTasks.set(row.task_id, { linkSource: spec.linkSource, closesTask: spec.closesTask });
        }
      }
    }

    const linkKind: 'issue' | 'pull_request' | null =
      input.eventKind === 'issue' ? 'issue' : input.eventKind === 'pull_request' ? 'pull_request' : null;
    const remoteTs = input.remoteUpdatedAt && !Number.isNaN(Date.parse(input.remoteUpdatedAt))
      ? new Date(input.remoteUpdatedAt)
      : null;

    const taskClosingEligibility = new Map<string, boolean>();
    const linkedTaskIds: string[] = [];

    if (linkKind && input.externalNumber !== undefined && input.externalUrl && input.externalTitle && input.externalState) {
      // Load existing links for this remote issue/PR so state changes update every linked task even without repeated mentions.
      const existingLinks = await ctx.trx
        .selectFrom('ludy_projects.github_task_link')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('kind', '=', linkKind)
        .where('external_number', '=', input.externalNumber)
        .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${input.repoFullName})`)
        .execute();

      const existingTaskSet = new Set(existingLinks.map((l) => l.task_id));
      const upgradedTaskIds = new Set<string>();

      // When a user pasted /issues/N for a PR in PAT mode, hydration resolves kind='pull_request':
      // upgrade the placeholder row in place (or drop it cleanly if a PR link already exists on the task).
      if (input.replaceLinkId && !existingLinks.some((l) => l.id === input.replaceLinkId)) {
        const placeholder = await ctx.trx
          .selectFrom('ludy_projects.github_task_link')
          .selectAll()
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', project.id)
          .where('id', '=', input.replaceLinkId)
          .executeTakeFirst();
        if (placeholder) {
          if (existingTaskSet.has(placeholder.task_id)) {
            await ctx.trx
              .deleteFrom('ludy_projects.github_task_link')
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', placeholder.id)
              .execute();
          } else {
            const incoming = matchedTasks.get(placeholder.task_id);
            const mergedCloses = placeholder.closes_task || Boolean(incoming?.closesTask);
            await ctx.trx
              .updateTable('ludy_projects.github_task_link')
              .set({
                kind: linkKind,
                external_number: input.externalNumber,
                external_url: input.externalUrl,
                external_title: input.externalTitle,
                external_state: input.externalState,
                branch_name: input.branchName !== undefined ? input.branchName : placeholder.branch_name,
                author_login: input.authorLogin !== undefined ? input.authorLogin : placeholder.author_login,
                closes_task: mergedCloses,
                hydrating: false,
                last_remote_event_at: remoteTs ?? placeholder.last_remote_event_at,
                last_synced_at: ctx.now,
                updated_at: ctx.now,
              })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', placeholder.id)
              .execute();
            upgradedTaskIds.add(placeholder.task_id);
            linkedTaskIds.push(placeholder.task_id);
            taskClosingEligibility.set(placeholder.task_id, mergedCloses);
          }
        }
      }

      let echoSkippedExistingCount = 0;
      for (const link of existingLinks) {
        const prevTs = link.last_remote_event_at ? new Date(link.last_remote_event_at) : null;
        if (isInboundIssueEchoLink(input, link, prevTs, remoteTs, isManualRefresh)) {
          echoSkippedExistingCount += 1;
          continue;
        }
        if (!link.hydrating && prevTs !== null && !Number.isNaN(prevTs.getTime()) && remoteTs !== null && remoteTs.getTime() < prevTs.getTime()) {
          continue;
        }
        const incoming = matchedTasks.get(link.task_id);
        const mergedCloses = link.closes_task || Boolean(incoming?.closesTask);
        await ctx.trx
          .updateTable('ludy_projects.github_task_link')
          .set({
            external_url: input.externalUrl,
            external_title: input.externalTitle,
            external_state: input.externalState,
            branch_name: input.branchName !== undefined ? input.branchName : link.branch_name,
            author_login: input.authorLogin !== undefined ? input.authorLogin : link.author_login,
            closes_task: mergedCloses,
            hydrating: false,
            last_remote_event_at: remoteTs ?? link.last_remote_event_at,
            last_synced_at: ctx.now,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', link.id)
          .execute();
        linkedTaskIds.push(link.task_id);
        taskClosingEligibility.set(link.task_id, mergedCloses);
      }

      for (const [taskId, spec] of matchedTasks.entries()) {
        if (existingTaskSet.has(taskId) || upgradedTaskIds.has(taskId)) continue;
        await ctx.trx
          .insertInto('ludy_projects.github_task_link')
          .values({
            org_id: ctx.orgId,
            project_id: project.id,
            task_id: taskId,
            repo_full_name: input.repoFullName,
            kind: linkKind,
            external_number: input.externalNumber,
            external_url: input.externalUrl,
            external_title: input.externalTitle,
            external_state: input.externalState,
            branch_name: input.branchName ?? null,
            author_login: input.authorLogin ?? null,
            link_source: spec.linkSource,
            closes_task: spec.closesTask,
            hydrating: false,
            tainted: true,
            last_remote_event_at: remoteTs,
            last_outbound_state: null,
            last_outbound_at: null,
            last_synced_at: ctx.now,
            created_by: null,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        linkedTaskIds.push(taskId);
        taskClosingEligibility.set(taskId, spec.closesTask);
      }

      // Layer 3 zero-write invariant: if an echoed issue webhook matched existing link(s) and updated nothing, skip even repo last_event_at.
      if (!isManualRefresh && (linkedTaskIds.length > 0 || echoSkippedExistingCount === 0)) {
        await ctx.trx
          .updateTable('ludy_projects.github_project_repo')
          .set({ last_event_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', project.id)
          .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${input.repoFullName})`)
          .execute();
      }
    } else if (!isManualRefresh) {
      await ctx.trx
        .updateTable('ludy_projects.github_project_repo')
        .set({ last_event_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${input.repoFullName})`)
        .execute();
    }

    if (linkedTaskIds.length === 0) {
      return { linkedTaskIds: [], transitionedTaskIds: [], deferredTaskIds: [], status: 'skipped' };
    }

    const targetTasks = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['t.id', 't.status', 'pt.column_id'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', project.id)
      .where('pt.task_id', 'in', [...new Set(linkedTaskIds)])
      .execute();

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, false);
    const transitionedTaskIds: string[] = [];
    const deferredTaskIds: string[] = [];

    if (binding.auto_sync_inbound) {
      for (const task of targetTasks) {
        let desiredStatus: BoardTaskStatus | null = null;
        let desiredColumnId: string | null = null;

        if (input.eventKind === 'pull_request') {
          if (input.action === 'closed' && input.merged && binding.inbound_done_on_merge) {
            if (taskClosingEligibility.get(task.id) === true && task.status !== 'done' && task.status !== 'cancelled') {
              desiredStatus = 'done';
              desiredColumnId = binding.inbound_col_done ?? resolveTaskColumnId(columns, null, 'done');
            }
          } else if (
            (input.action === 'opened' || input.action === 'reopened' || input.action === 'ready_for_review') &&
            !input.draft &&
            binding.inbound_in_progress_on_pr
          ) {
            if (input.action === 'ready_for_review' && binding.inbound_col_in_review && (task.status === 'todo' || task.status === 'in_progress')) {
              desiredStatus = 'in_review';
              desiredColumnId = binding.inbound_col_in_review;
            } else if (task.status === 'todo') {
              desiredStatus = 'in_progress';
              desiredColumnId = binding.inbound_col_in_progress ?? resolveTaskColumnId(columns, null, 'in_progress');
            }
          }
        } else if (input.eventKind === 'issue' && input.action === 'closed' && binding.inbound_done_on_merge) {
          if (task.status !== 'done' && task.status !== 'cancelled') {
            desiredStatus = 'done';
            desiredColumnId = binding.inbound_col_done ?? resolveTaskColumnId(columns, null, 'done');
          }
        }

        if (!desiredStatus) continue;

        const synced = await ctx.run<{ taskId: string; status: string; applied: boolean; deferred: boolean }>(
          'kernel.task.sync_external_status',
          { id: task.id, status: desiredStatus },
        );

        if (synced.deferred) {
          deferredTaskIds.push(task.id);
          continue;
        }

        if (synced.applied) {
          if (desiredColumnId !== null && desiredColumnId !== task.column_id) {
            await ctx.trx
              .updateTable('ludy_projects.project_task')
              .set({ column_id: desiredColumnId })
              .where('org_id', '=', ctx.orgId)
              .where('project_id', '=', project.id)
              .where('task_id', '=', task.id)
              .execute();
          }
          transitionedTaskIds.push(task.id);
          await ctx.emit('projects.github.task_synced', {
            projectId: project.id,
            taskId: task.id,
            status: desiredStatus,
          });
          await ctx.activity('projects.project', project.id, 'projects.github.task_synced', 'Cập nhật trạng thái từ GitHub');
        }
      }
    }

    const status = deferredTaskIds.length > 0 && transitionedTaskIds.length === 0 ? 'deferred' : 'applied';
    ctx.audit({
      projectId: project.id,
      externalNumber: input.externalNumber ?? null,
      linkedCount: linkedTaskIds.length,
      transitionedCount: transitionedTaskIds.length,
      deferredCount: deferredTaskIds.length,
    });

    return {
      linkedTaskIds: [...new Set(linkedTaskIds)],
      transitionedTaskIds,
      deferredTaskIds,
      status,
    };
  },
});

export const projectGithubInstallationSync = defineCommand({
  name: 'projects.github.installation_sync',
  input: zGithubInstallationSyncInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.channelConnectionId }),
  handler: async (ctx, input): Promise<GithubInstallationSyncResult> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới đồng bộ được cài đặt GitHub App');
    }

    const conn = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.channelConnectionId)
      .where('provider', '=', 'github_app')
      .executeTakeFirst();
    if (!conn) {
      return { updatedBindings: 0, deletedRepos: 0 };
    }

    const bindings = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .select(['id', 'project_id', 'paused_reason'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', conn.id)
      .orderBy('project_id', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const bindingIds = bindings.map((b) => b.id);
    let updatedBindings = 0;
    let deletedRepos = 0;

    if (input.action === 'suspend') {
      if (conn.status !== 'revoked' && bindingIds.length > 0) {
        const res = await ctx.trx
          .updateTable('ludy_projects.github_project_binding')
          .set({
            paused_reason: 'installation_suspended',
            paused_at: ctx.now,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', bindingIds)
          .executeTakeFirst();
        updatedBindings = Number(res.numUpdatedRows);
      }
    } else if (input.action === 'unsuspend') {
      if (conn.status === 'active' && bindingIds.length > 0) {
        const res = await ctx.trx
          .updateTable('ludy_projects.github_project_binding')
          .set({
            paused_reason: null,
            paused_at: null,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', bindingIds)
          .where('paused_reason', 'in', ['installation_suspended', 'app_suspended'])
          .executeTakeFirst();
        updatedBindings = Number(res.numUpdatedRows);
      }
    } else if (input.action === 'deleted') {
      if (bindingIds.length > 0) {
        const res = await ctx.trx
          .updateTable('ludy_projects.github_project_binding')
          .set({
            github_enabled: false,
            paused_reason: 'installation_deleted',
            paused_at: ctx.now,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', bindingIds)
          .executeTakeFirst();
        updatedBindings = Number(res.numUpdatedRows);

        const delRes = await ctx.trx
          .deleteFrom('ludy_projects.github_project_repo')
          .where('org_id', '=', ctx.orgId)
          .where('binding_id', 'in', bindingIds)
          .executeTakeFirst();
        deletedRepos = Number(delRes.numDeletedRows);
      }
    } else if (input.action === 'repositories_removed') {
      if (input.removedRepoIds && input.removedRepoIds.length > 0 && bindingIds.length > 0) {
        const delRes = await ctx.trx
          .deleteFrom('ludy_projects.github_project_repo')
          .where('org_id', '=', ctx.orgId)
          .where('binding_id', 'in', bindingIds)
          .where('github_repo_id', 'in', input.removedRepoIds)
          .executeTakeFirst();
        deletedRepos = Number(delRes.numDeletedRows);
      }
    }

    ctx.audit({
      channelConnectionId: conn.id,
      action: input.action,
      updatedBindings,
      deletedRepos,
    });
    if (updatedBindings > 0 || deletedRepos > 0) {
      await ctx.emit('projects.github.installation_synced', {
        channelConnectionId: conn.id,
        action: input.action,
        updatedBindings,
        deletedRepos,
      });
    }
    return { updatedBindings, deletedRepos };
  },
});

function isInboundIssueEchoLink(
  input: Pick<GithubApplyInboundEventInput, 'eventKind' | 'action' | 'externalState'>,
  link: { kind: string; hydrating: boolean; external_state: string },
  prevTs: Date | null,
  remoteTs: Date | null,
  isManualRefresh: boolean,
): boolean {
  if (isManualRefresh || link.hydrating || input.eventKind !== 'issue' || link.kind !== 'issue') {
    return false;
  }
  if (prevTs !== null && remoteTs !== null && !Number.isNaN(prevTs.getTime()) && remoteTs.getTime() <= prevTs.getTime()) {
    return true;
  }
  if ((input.action === 'closed' || input.action === 'reopened') && link.external_state === input.externalState) {
    return true;
  }
  return false;
}

async function loadProjectsAiFlags(
  trx: QueryContext['trx'],
  orgId: string,
): Promise<{ aiStopped: boolean; aiBudgetSpent: boolean }> {
  const { rows } = await sql<{ ai_stopped: boolean; budget_spent: boolean }>`
    SELECT
      (
        ludy_kernel.global_kill_switch_on('ai')
        OR EXISTS (
          SELECT 1 FROM ludy_kernel.kill_switch k
           WHERE k.org_id = ${orgId}::uuid
             AND k.released_at IS NULL
             AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = 'projects'))
        )
      ) AS ai_stopped,
      ludy_kernel.ai_budget_exhausted(${orgId}::uuid, 'projects', NULL::uuid) AS budget_spent`.execute(trx);
  return {
    aiStopped: rows[0]?.ai_stopped === true,
    aiBudgetSpent: rows[0]?.budget_spent === true,
  };
}

export interface ProjectGithubPrSummarySource {
  projectId: string;
  projectName: string;
  taskId: string;
  taskKey: string | null;
  taskTitle: string;
  taskTainted: boolean;
  githubEnabled: boolean;
  links: GithubTaskLinkView[];
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

export interface ProjectGithubIssueMatchSource {
  projectId: string;
  projectName: string;
  taskId: string;
  taskKey: string | null;
  taskTitle: string;
  taskDescription: string | null;
  taskTainted: boolean;
  githubEnabled: boolean;
  provider: 'github_app' | 'github_pat' | null;
  externalAccountId: string | null;
  repos: ReadonlyArray<{ repoFullName: string }>;
  existingLinkKeys: readonly string[];
  cachedIssues: ReadonlyArray<{
    repoFullName: string;
    externalNumber: number;
    externalUrl: string;
    externalTitle: string;
    authorLogin: string | null;
    updatedAt: string;
  }>;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

export const projectGithubOutboundContext = defineQuery({
  name: 'projects.github.outbound_context',
  input: zGithubOutboundContextQueryInput,
  access: READERS,
  handler: async (ctx, input): Promise<GithubOutboundContextResult> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới đọc được ngữ cảnh đồng bộ GitHub ra ngoài');
    }
    const project = await ctx.trx
      .selectFrom('ludy_projects.project')
      .select(['id', 'status', 'is_template'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.projectId)
      .executeTakeFirst();
    if (!project) {
      return { projectArchived: true, taskStatus: null, binding: null, repoBound: false, link: null };
    }
    const taskRow = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['t.status'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', project.id)
      .where('pt.task_id', '=', input.taskId)
      .executeTakeFirst();
    const binding = await loadBindingView(ctx.trx, ctx.orgId, project.id, true);
    const linkRow = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .where('id', '=', input.linkId)
      .executeTakeFirst();
    let repoBound = false;
    if (linkRow) {
      const boundRow = await ctx.trx
        .selectFrom('ludy_projects.github_project_repo')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where(sql<boolean>`pg_catalog.lower(repo_full_name) = pg_catalog.lower(${linkRow.repo_full_name})`)
        .executeTakeFirst();
      repoBound = Boolean(boundRow);
    }
    return {
      projectArchived: project.status === 'archived' || project.is_template,
      taskStatus: taskRow?.status ?? null,
      binding,
      repoBound,
      link: linkRow ? toLinkView(linkRow) : null,
    };
  },
});

const OUTBOUND_DELIVERY_ENQUEUE_WRITES = [
  tableWrite(TABLES, 'ludy_projects', 'github_sync_delivery', [
    'id',
    'org_id',
    'project_id',
    'direction',
    'delivery_id',
    'event_type',
    'repo_full_name',
    'external_number',
    'task_id',
    'link_id',
    'idempotency_key',
    'target_remote_state',
    'status',
    'summary',
    'received_at',
    'processed_at',
  ]),
] as const;

async function runOutboundEnqueueSql(
  trx: QueryContext['trx'],
  taskId: string,
  previousStatus: string,
  nextStatus: string,
  now: Date,
): Promise<{ enqueued: number }> {
  const { rows } = await sql<{ enqueued: number }>`
    SELECT ludy_projects.github_outbound_enqueue_for_task(
      ${taskId}::uuid,
      ${previousStatus},
      ${nextStatus},
      ${now}::timestamptz
    ) AS enqueued`.execute(trx);
  return { enqueued: Number(rows[0]?.enqueued ?? 0) };
}

export const projectGithubOutboundEnqueue = defineCommand({
  name: 'projects.github.outbound_enqueue',
  input: zGithubOutboundEnqueueInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  writes: [...OUTBOUND_DELIVERY_ENQUEUE_WRITES],
  target: (input) => ({ type: 'kernel.task', id: input.taskId }),
  handler: (ctx, input): Promise<{ enqueued: number }> =>
    runOutboundEnqueueSql(ctx.trx, input.taskId, input.previousStatus, input.nextStatus, ctx.now),
});

export const projectGithubOutboundEnqueueSystem = defineCommand({
  name: 'projects.github.outbound_enqueue_system',
  input: zGithubOutboundEnqueueInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [...OUTBOUND_DELIVERY_ENQUEUE_WRITES],
  target: (input) => ({ type: 'kernel.task', id: input.taskId }),
  handler: (ctx, input): Promise<{ enqueued: number }> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới xếp hàng đồng bộ GitHub từ tác tử');
    }
    return runOutboundEnqueueSql(ctx.trx, input.taskId, input.previousStatus, input.nextStatus, ctx.now);
  },
});

export const projectGithubRecordOutbound = defineCommand({
  name: 'projects.github.record_outbound',
  input: zGithubRecordOutboundInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'github_task_link', [
      'external_state',
      'external_title',
      'last_outbound_state',
      'last_outbound_at',
      'last_remote_event_at',
      'last_synced_at',
      'updated_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.github_task_link', id: input.linkId }),
  handler: async (ctx, input): Promise<GithubRecordOutboundResult> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới ghi nhận kết quả đồng bộ GitHub ra ngoài');
    }
    const existing = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', input.projectId)
      .where('task_id', '=', input.taskId)
      .where('id', '=', input.linkId)
      .where('kind', '=', 'issue')
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      return { updated: false, link: null };
    }

    const prevTs = existing.last_remote_event_at ? new Date(existing.last_remote_event_at) : null;
    const remoteTs =
      input.remoteUpdatedAt && !Number.isNaN(Date.parse(input.remoteUpdatedAt))
        ? new Date(input.remoteUpdatedAt)
        : null;
    const nextRemoteTs =
      remoteTs && prevTs && !Number.isNaN(prevTs.getTime())
        ? remoteTs.getTime() > prevTs.getTime()
          ? remoteTs
          : prevTs
        : remoteTs ?? (prevTs && !Number.isNaN(prevTs.getTime()) ? prevTs : ctx.now);

    const saved = await ctx.trx
      .updateTable('ludy_projects.github_task_link')
      .set({
        external_state: input.externalState,
        external_title: input.externalTitle ?? existing.external_title,
        last_outbound_state: input.externalState,
        last_outbound_at: ctx.now,
        last_remote_event_at: nextRemoteTs,
        last_synced_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      projectId: input.projectId,
      taskId: input.taskId,
      linkId: existing.id,
      externalNumber: existing.external_number,
      externalState: input.externalState,
    });
    await ctx.emit('projects.github.outbound_synced', {
      projectId: input.projectId,
      taskId: input.taskId,
      linkId: existing.id,
      externalState: input.externalState,
    });
    return { updated: true, link: toLinkView(saved) };
  },
});

export const projectGithubAiPrSummarySource = defineQuery({
  name: 'projects.github.ai_pr_summary_source',
  input: zGithubPrSummaryRpcInput.pick({ projectId: true, taskId: true }),
  access: READERS,
  handler: async (ctx, input): Promise<ProjectGithubPrSummarySource> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    const visibleTask = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['pt.task_id', 'pt.task_number', 't.title', 't.tainted'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', project.id)
      .where('pt.task_id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const binding = await ctx.trx
      .selectFrom('ludy_projects.github_project_binding')
      .select(['github_enabled', 'task_key_prefix'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .executeTakeFirst();

    const aiFlags = await loadProjectsAiFlags(ctx.trx, ctx.orgId);
    if (!binding || !binding.github_enabled) {
      return {
        projectId: project.id,
        projectName: project.name,
        taskId: visibleTask.task_id,
        taskKey: null,
        taskTitle: visibleTask.title,
        taskTainted: Boolean(visibleTask.tainted),
        githubEnabled: false,
        links: [],
        ...aiFlags,
      };
    }

    const links = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', visibleTask.task_id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(25)
      .execute();

    return {
      projectId: project.id,
      projectName: project.name,
      taskId: visibleTask.task_id,
      taskKey: formatProjectTaskKey(binding.task_key_prefix, visibleTask.task_number),
      taskTitle: visibleTask.title,
      taskTainted: Boolean(visibleTask.tainted),
      githubEnabled: true,
      links: links.map(toLinkView),
      ...aiFlags,
    };
  },
});

export const projectGithubAiIssueMatchSource = defineQuery({
  name: 'projects.github.ai_issue_match_source',
  input: zGithubIssueMatchRpcInput.pick({ projectId: true, taskId: true }),
  access: WRITERS,
  handler: async (ctx, input): Promise<ProjectGithubIssueMatchSource> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    const visibleTask = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['pt.task_id', 'pt.task_number', 't.title', 't.description', 't.tainted'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', project.id)
      .where('pt.task_id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const aiFlags = await loadProjectsAiFlags(ctx.trx, ctx.orgId);
    const binding = await loadBindingView(ctx.trx, ctx.orgId, project.id, true);
    if (!binding || !binding.githubEnabled) {
      return {
        projectId: project.id,
        projectName: project.name,
        taskId: visibleTask.task_id,
        taskKey: null,
        taskTitle: visibleTask.title,
        taskDescription: visibleTask.description,
        taskTainted: Boolean(visibleTask.tainted),
        githubEnabled: false,
        provider: null,
        externalAccountId: null,
        repos: [],
        existingLinkKeys: [],
        cachedIssues: [],
        ...aiFlags,
      };
    }

    const existingOnTask = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .select(['repo_full_name', 'kind', 'external_number'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', visibleTask.task_id)
      .execute();
    const existingKeys = existingOnTask
      .filter((l) => l.kind === 'issue')
      .map((l) => `${l.repo_full_name.toLowerCase()}#${l.external_number}`);

    const repoNamesLower = new Set(binding.repos.map((r) => r.repoFullName.toLowerCase()));
    const existingSet = new Set(existingKeys);

    const projectLinks = await ctx.trx
      .selectFrom('ludy_projects.github_task_link')
      .select(['repo_full_name', 'external_number', 'external_url', 'external_title', 'author_login', 'last_synced_at'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('kind', '=', 'issue')
      .where('external_state', '=', 'open')
      .orderBy('last_synced_at', 'desc')
      .limit(40)
      .execute();

    const seenCached = new Set<string>();
    const cachedIssues: ProjectGithubIssueMatchSource['cachedIssues'][number][] = [];
    for (const row of projectLinks) {
      const key = `${row.repo_full_name.toLowerCase()}#${row.external_number}`;
      if (!repoNamesLower.has(row.repo_full_name.toLowerCase()) || existingSet.has(key) || seenCached.has(key)) {
        continue;
      }
      seenCached.add(key);
      cachedIssues.push({
        repoFullName: row.repo_full_name,
        externalNumber: row.external_number,
        externalUrl: row.external_url,
        externalTitle: row.external_title,
        authorLogin: row.author_login,
        updatedAt: new Date(row.last_synced_at).toISOString(),
      });
    }

    return {
      projectId: project.id,
      projectName: project.name,
      taskId: visibleTask.task_id,
      taskKey: formatProjectTaskKey(binding.taskKeyPrefix, visibleTask.task_number),
      taskTitle: visibleTask.title,
      taskDescription: visibleTask.description,
      taskTainted: Boolean(visibleTask.tainted),
      githubEnabled: true,
      provider: binding.provider,
      externalAccountId: binding.externalAccountId,
      repos: binding.repos.map((r) => ({ repoFullName: r.repoFullName })),
      existingLinkKeys: existingKeys,
      cachedIssues,
      ...aiFlags,
    };
  },
});

export const projectGithubCommands = [
  projectGithubBindingSave,
  projectGithubRepoBind,
  projectGithubRepoUnbind,
  projectGithubHookSet,
  projectGithubTaskLinkAdd,
  projectGithubTaskLinkRemove,
  projectGithubApplyInboundEvent,
  projectGithubInstallationSync,
  projectGithubOutboundEnqueue,
  projectGithubOutboundEnqueueSystem,
  projectGithubRecordOutbound,
];

export const projectGithubQueries = [
  projectGithubBindingGet,
  projectGithubHookStatus,
  projectGithubLinkPrepare,
  projectGithubOutboundContext,
  projectGithubTaskLinks,
  projectGithubSyncLog,
  projectGithubAiPrSummarySource,
  projectGithubAiIssueMatchSource,
];
