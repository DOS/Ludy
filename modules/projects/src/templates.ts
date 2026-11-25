// SPDX-License-Identifier: AGPL-3.0-only
// Project templates (#2607, #4908): 5 built-in starter templates plus custom org templates.
import { z } from 'zod';
import {
  DEFAULT_TIME_ZONE,
  PROJECT_LIST_LIMIT,
  PROJECT_TASK_TITLE_MAX,
  PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX,
  PROJECT_TEMPLATE_TASK_DUE_OFFSET_MAX,
  PROJECT_TEMPLATE_TASKS_MAX,
  auditValue,
  spreadKeys,
  tableWrite,
  todoDueInstant,
  zonedDate,
  zProjectCreateFromTemplateInput,
  zProjectTemplateArchiveInput,
  zProjectTemplateCreateInput,
  zProjectTemplateListInput,
  zProjectTemplateTaskItem,
  type BuiltinProjectTemplateKey,
  type ProjectCreateFromTemplateResult,
  type ProjectStatus,
  type ProjectTemplateArchiveResult,
  type ProjectTemplateCreateResult,
  type ProjectTemplateListResult,
  type ProjectTemplateSummary,
  type ProjectTemplateTaskItem,
  type ProjectVisibility,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { insertProjectColumns, resolveTaskColumnId, type DefaultColumnSpec } from './columns.ts';
import { projectsManifest } from './manifest.ts';
import { addLocalDays, daysBetweenLocalDates } from './recurring.ts';
import {
  READERS,
  WRITERS,
  assertCanManage,
  assertCanSetPrivateVisibility,
  assertOrgMembers,
  descriptionOf,
  loadProject,
  resolveCreateMemberIds,
  userOf,
  type ProjectRow,
} from './shared.ts';

const TABLES = projectsManifest.tables;
const PROJECT = TABLES.ludy_projects.project;

interface StarterLocalizedTemplate {
  key: BuiltinProjectTemplateKey;
  defaultColumns?: ReadonlyArray<DefaultColumnSpec>;
  vi: { name: string; description: string; tasks: ProjectTemplateTaskItem[] };
  en: { name: string; description: string; tasks: ProjectTemplateTaskItem[] };
}

const STARTER_TEMPLATES: readonly StarterLocalizedTemplate[] = [
  {
    key: 'software-project',
    defaultColumns: [
      { taskStatus: 'todo', color: 'neutral', vi: 'Cần làm (Backlog)', en: 'Backlog' },
      { taskStatus: 'in_progress', color: 'primary', vi: 'Đang phát triển', en: 'In progress' },
      { taskStatus: 'waiting', color: 'warning', vi: 'Đang chờ / Bị chặn', en: 'Blocked / Waiting' },
      { taskStatus: 'in_review', color: 'proposal', vi: 'Kiểm thử / Review', en: 'QA / In review' },
      { taskStatus: 'done', color: 'success', vi: 'Đã xong', en: 'Done' },
    ],
    vi: {
      name: 'Dự án phần mềm',
      description: 'Quy trình phát triển phần mềm theo sprint: chốt phạm vi, thiết kế, lập trình, kiểm thử QA và phát hành.',
      tasks: [
        {
          title: 'Chốt phạm vi sprint và ưu tiên backlog',
          description: 'Rà soát mục tiêu, chia nhỏ đầu việc và thống nhất tiêu chí hoàn thành trước khi bắt đầu.',
          dueOffsetDays: 1,
        },
        {
          title: 'Viết tài liệu thiết kế kỹ thuật và giao diện',
          description: 'Chốt luồng xử lý, cấu trúc dữ liệu, API và bản nháp màn hình liên quan.',
          dueOffsetDays: 3,
        },
        {
          title: 'Phát triển tính năng và viết kiểm thử đơn vị',
          description: 'Triển khai mã nguồn theo phạm vi đã chốt kèm bài kiểm thử tự động.',
          dueOffsetDays: 7,
        },
        {
          title: 'Rà soát mã nguồn và kiểm thử QA trên môi trường thử',
          description: 'Chạy kiểm thử tích hợp, kiểm tra lỗi biên và xác nhận lại toàn bộ tiêu chí.',
          dueOffsetDays: 9,
        },
        {
          title: 'Kiểm tra danh sách phát hành và triển khai',
          description: 'Rà soát thay đổi cấu hình, sao lưu cần thiết, phát hành và theo dõi sau khi lên.',
          dueOffsetDays: 10,
        },
      ],
    },
    en: {
      name: 'Software project',
      description: 'Sprint-ready software delivery template from backlog scoping and design spec to QA and release.',
      tasks: [
        {
          title: 'Scope sprint backlog and acceptance criteria',
          description: 'Review priorities, break down work items, and align on definition of done before kickoff.',
          dueOffsetDays: 1,
        },
        {
          title: 'Draft technical design and UI specification',
          description: 'Document data flow, API contracts, edge cases, and screen states.',
          dueOffsetDays: 3,
        },
        {
          title: 'Implement core changes and unit tests',
          description: 'Build the scoped feature increment with automated test coverage.',
          dueOffsetDays: 7,
        },
        {
          title: 'Run code review and QA verification',
          description: 'Verify integration tests, staging checks, and regression criteria.',
          dueOffsetDays: 9,
        },
        {
          title: 'Complete release checklist and ship',
          description: 'Verify rollout checks, deploy to production, and monitor post-release health.',
          dueOffsetDays: 10,
        },
      ],
    },
  },
  {
    key: 'marketing-project',
    vi: {
      name: 'Dự án Marketing',
      description: 'Quy trình triển khai chiến dịch marketing từ bản tóm tắt, sáng tạo nội dung đến đo lường và tổng kết.',
      tasks: [
        {
          title: 'Lập bản tóm tắt chiến dịch và chân dung khách hàng',
          description: 'Xác định mục tiêu, thông điệp cốt lõi, tệp khách hàng mục tiêu và ngân sách dự kiến.',
          dueOffsetDays: 1,
        },
        {
          title: 'Sản xuất nội dung, hình ảnh và tài liệu truyền thông',
          description: 'Hoàn thiện bài viết, thiết kế hình ảnh, video và trang đích cho từng kênh.',
          dueOffsetDays: 4,
        },
        {
          title: 'Kiểm tra kênh phân phối và phát hành chiến dịch',
          description: 'Thiết lập lịch đăng bài, đường dẫn theo dõi và chạy chiến dịch trên các kênh đã chọn.',
          dueOffsetDays: 6,
        },
        {
          title: 'Theo dõi chỉ số và tối ưu hiệu suất hàng ngày',
          description: 'Giám sát lượt tiếp cận, chi phí chuyển đổi và điều chỉnh nội dung hoặc ngân sách kịp thời.',
          dueOffsetDays: 10,
        },
        {
          title: 'Tổng kết kết quả chiến dịch và rút kinh nghiệm',
          description: 'Đối chiếu KPI thực tế với mục tiêu, tổng hợp bài học và lưu lại tài sản dùng lại.',
          dueOffsetDays: 14,
        },
      ],
    },
    en: {
      name: 'Marketing project',
      description: 'End-to-end marketing execution template from campaign brief and assets to launch tracking and review.',
      tasks: [
        {
          title: 'Finalize campaign brief and target audience',
          description: 'Define campaign goals, core positioning, audience segments, and planned budget.',
          dueOffsetDays: 1,
        },
        {
          title: 'Produce creative assets and campaign copy',
          description: 'Prepare ad copy, visuals, landing page updates, and review approvals.',
          dueOffsetDays: 4,
        },
        {
          title: 'Launch across distribution channels',
          description: 'Verify tracking links, schedule posts, and publish campaigns on target channels.',
          dueOffsetDays: 6,
        },
        {
          title: 'Monitor channel metrics and optimize performance',
          description: 'Track reach, conversion rates, and spend pacing to tune underperforming creatives.',
          dueOffsetDays: 10,
        },
        {
          title: 'Run post-campaign performance review',
          description: 'Compare final KPIs against goals, document learnings, and archive reusable assets.',
          dueOffsetDays: 14,
        },
      ],
    },
  },
  {
    key: 'monthly-close',
    vi: {
      name: 'Khóa sổ cuối tháng',
      description: 'Quy trình khóa sổ, đối chiếu ngân hàng và rà soát tờ khai thuế hàng tháng.',
      tasks: [
        {
          title: 'Đối chiếu sổ phụ ngân hàng và tiền mặt',
          description: 'Kiểm tra số dư cuối kỳ trên sao kê ngân hàng khớp với sổ tiền mặt và tiền gửi.',
          dueOffsetDays: 1,
        },
        {
          title: 'Rà soát hóa đơn đầu vào và công nợ phải trả',
          dueOffsetDays: 3,
        },
        {
          title: 'Chốt doanh thu và xuất đủ hóa đơn bán hàng',
          dueOffsetDays: 4,
        },
        {
          title: 'Lập bảng lương và kiểm tra bảo hiểm xã hội',
          dueOffsetDays: 5,
        },
        {
          title: 'Kiểm tra tờ khai thuế GTGT/TNCN và khóa kỳ kế toán',
          dueOffsetDays: 7,
        },
      ],
    },
    en: {
      name: 'Monthly book close',
      description: 'Monthly closing, bank reconciliation, and tax filing checklist for SMEs.',
      tasks: [
        {
          title: 'Reconcile bank statements and petty cash',
          description: 'Verify closing balances on bank statements against cash and bank ledgers.',
          dueOffsetDays: 1,
        },
        {
          title: 'Review supplier invoices and accounts payable',
          dueOffsetDays: 3,
        },
        {
          title: 'Confirm monthly revenue and sales invoices',
          dueOffsetDays: 4,
        },
        {
          title: 'Prepare payroll and social insurance schedule',
          dueOffsetDays: 5,
        },
        {
          title: 'Review VAT/PIT filings and lock accounting period',
          dueOffsetDays: 7,
        },
      ],
    },
  },
  {
    key: 'client-onboarding',
    vi: {
      name: 'Tiếp nhận khách hàng mới',
      description: 'Các bước từ hợp đồng đã ký đến bàn giao và lịch báo cáo tuần đầu tiên.',
      tasks: [
        {
          title: 'Kiểm tra hợp đồng đã ký và thông tin xuất hóa đơn',
          dueOffsetDays: 0,
        },
        {
          title: 'Thu thập tài liệu, quyền truy cập và đầu mối liên hệ',
          dueOffsetDays: 2,
        },
        {
          title: 'Họp khởi động và chốt mốc bàn giao',
          dueOffsetDays: 4,
        },
        {
          title: 'Thiết lập không gian làm việc và lịch theo dõi định kỳ',
          dueOffsetDays: 5,
        },
        {
          title: 'Gửi tóm tắt tuần đầu tiên cho khách hàng',
          dueOffsetDays: 7,
        },
      ],
    },
    en: {
      name: 'Client onboarding',
      description: 'End-to-end checklist from signed contract to kickoff for a new client.',
      tasks: [
        {
          title: 'Verify signed contract and billing tax details',
          dueOffsetDays: 0,
        },
        {
          title: 'Collect source documents, access, and primary contacts',
          dueOffsetDays: 2,
        },
        {
          title: 'Hold kickoff call and confirm delivery milestones',
          dueOffsetDays: 4,
        },
        {
          title: 'Set up workspace folder and recurring check-in schedule',
          dueOffsetDays: 5,
        },
        {
          title: 'Send first-week status recap to client',
          dueOffsetDays: 7,
        },
      ],
    },
  },
  {
    key: 'campaign-launch',
    vi: {
      name: 'Triển khai chiến dịch',
      description: 'Chuẩn bị thông điệp, nội dung, ngân sách, lịch phát hành và tổng kết kết quả.',
      tasks: [
        {
          title: 'Chốt thông điệp chính và tệp khách hàng mục tiêu',
          dueOffsetDays: 1,
        },
        {
          title: 'Chuẩn bị bài viết, hình ảnh và ưu đãi kèm theo',
          dueOffsetDays: 3,
        },
        {
          title: 'Rà soát chi phí dự kiến và kênh phân phối',
          dueOffsetDays: 5,
        },
        {
          title: 'Lên lịch phát hành và kiểm tra đường dẫn đích',
          dueOffsetDays: 6,
        },
        {
          title: 'Tổng kết kết quả sau 7 ngày chạy chiến dịch',
          dueOffsetDays: 14,
        },
      ],
    },
    en: {
      name: 'Campaign launch',
      description: 'Prepare creative, channel schedule, budget checks, and wrap-up for a campaign.',
      tasks: [
        {
          title: 'Finalize core message and target audience',
          dueOffsetDays: 1,
        },
        {
          title: 'Draft copy, creatives, and promotional offer',
          dueOffsetDays: 3,
        },
        {
          title: 'Review planned spend and distribution channels',
          dueOffsetDays: 5,
        },
        {
          title: 'Schedule launch posts and verify landing links',
          dueOffsetDays: 6,
        },
        {
          title: 'Summarize 7-day post-launch performance',
          dueOffsetDays: 14,
        },
      ],
    },
  },
];

export function starterProjectTemplates(language: 'vi' | 'en' = 'vi'): ProjectTemplateSummary[] {
  return STARTER_TEMPLATES.map((entry) => {
    const localized = language === 'en' ? entry.en : entry.vi;
    return {
      id: entry.key,
      source: 'builtin',
      builtinKey: entry.key,
      name: localized.name,
      description: localized.description,
      status: 'active',
      tasks: localized.tasks.map((t) => ({ ...t })),
      taskCount: localized.tasks.length,
      ...(entry.defaultColumns
        ? {
            defaultColumns: entry.defaultColumns.map((col) => ({
              name: language === 'en' ? col.en : col.vi,
              taskStatus: col.taskStatus,
              color: col.color,
            })),
          }
        : {}),
      canManage: false,
      createdAt: null,
      updatedAt: null,
    };
  });
}

function normalizeTemplateTask(item: ProjectTemplateTaskItem): ProjectTemplateTaskItem {
  const title = item.title.trim().slice(0, PROJECT_TASK_TITLE_MAX);
  const rawDesc = item.description?.trim();
  const description = rawDesc ? rawDesc.slice(0, PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX) : undefined;
  const dueOffsetDays =
    item.dueOffsetDays !== undefined && item.dueOffsetDays !== null
      ? Math.max(0, Math.min(PROJECT_TEMPLATE_TASK_DUE_OFFSET_MAX, Math.trunc(item.dueOffsetDays)))
      : undefined;
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
    ...(item.tainted === true ? { tainted: true } : {}),
  };
}

function parseStoredTemplateTasks(raw: unknown): ProjectTemplateTaskItem[] {
  const parsed = z.array(zProjectTemplateTaskItem).safeParse(raw);
  return parsed.success ? parsed.data.map(normalizeTemplateTask) : [];
}

function clampOffsetDays(days: number): number {
  return Math.max(0, Math.min(PROJECT_TEMPLATE_TASK_DUE_OFFSET_MAX, days));
}

export const projectTemplateList = defineQuery({
  name: 'projects.template.list',
  input: zProjectTemplateListInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTemplateListResult> => {
    const userId = userOf(ctx.actor);
    const canWrite = ctx.role !== null && ctx.role !== 'viewer';
    const starters = starterProjectTemplates(input.language ?? 'vi');

    let q = ctx.trx
      .selectFrom('ludy_projects.project')
      .select(['id', 'name', 'description', 'owner_user_id', 'status', 'template_tasks', 'created_at', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('is_template', '=', true);

    if (!input.includeArchived) {
      q = q.where('status', '<>', 'archived');
    }

    const rows = await q
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(PROJECT_LIST_LIMIT)
      .execute();

    const custom: ProjectTemplateSummary[] = rows.map((r) => {
      const tasks = parseStoredTemplateTasks(r.template_tasks);
      const canManage =
        ctx.role === 'owner' ||
        ctx.role === 'admin' ||
        (ctx.role !== null && ctx.role !== 'viewer' && r.owner_user_id === userId);
      return {
        id: r.id,
        source: 'custom',
        builtinKey: null,
        name: r.name,
        description: r.description,
        status: r.status as ProjectStatus,
        tasks,
        taskCount: tasks.length,
        canManage,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    });

    return {
      templates: [...starters, ...custom],
      canWrite,
    };
  },
});

export const projectTemplateCreate = defineCommand({
  name: 'projects.template.create',
  input: zProjectTemplateCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'project', [
      'org_id',
      'name',
      'description',
      'owner_user_id',
      'status',
      'is_template',
      'template_tasks',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<ProjectTemplateCreateResult> => {
    const userId = userOf(ctx.actor);
    const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
    let items: ProjectTemplateTaskItem[] = [];

    if (input.sourceProjectId !== undefined) {
      const source = await loadProject(ctx.trx, ctx.orgId, input.sourceProjectId, 'share');
      if (source.visibility === 'private') {
        throw new DomainError(
          'PROJECT_PRIVATE_TEMPLATE_FORBIDDEN',
          422,
          'Dự án riêng tư không thể lưu thành mẫu dùng chung cho toàn công ty',
        );
      }
      // Query ludy_kernel.task directly in caller's ctx.trx so le_scope RLS hides out-of-entity tasks from snapshot.
      const rows = await ctx.trx
        .selectFrom('ludy_projects.project_task as pt')
        .innerJoin('ludy_kernel.task as t', (join) =>
          join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
        )
        .select(['t.id', 't.title', 't.description', 't.due', 't.tainted'])
        .where('pt.org_id', '=', ctx.orgId)
        .where('pt.project_id', '=', input.sourceProjectId)
        .where('t.status', '<>', 'cancelled')
        .orderBy('pt.sort_key', 'asc')
        .orderBy('t.due', 'asc')
        .orderBy('t.created_at', 'asc')
        .orderBy('t.id', 'asc')
        .limit(PROJECT_TEMPLATE_TASKS_MAX + 1)
        .execute();

      if (rows.length > PROJECT_TEMPLATE_TASKS_MAX) {
        throw new DomainError(
          'PROJECT_TEMPLATE_TOO_MANY_TASKS',
          422,
          `Mẫu dự án tối đa ${PROJECT_TEMPLATE_TASKS_MAX} công việc`,
        );
      }

      const localDates = rows.map((r) => (r.due === null ? null : zonedDate(tz, new Date(r.due).getTime())));
      const dated = localDates.filter((d): d is string => d !== null);
      const anchorDate = dated.length > 0 ? dated.reduce((min, cur) => (cur < min ? cur : min)) : null;

      items = rows.map((r, index) => {
        const dueDate = localDates[index];
        const dueOffsetDays =
          dueDate !== null && dueDate !== undefined && anchorDate !== null
            ? clampOffsetDays(daysBetweenLocalDates(dueDate, anchorDate))
            : undefined;
        return normalizeTemplateTask({
          title: r.title,
          description: r.description ?? undefined,
          ...(dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
          ...(r.tainted ? { tainted: true } : {}),
        });
      });
    } else {
      items = (input.tasks ?? []).map((item) => normalizeTemplateTask({ ...item, tainted: false }));
    }

    if (items.length > PROJECT_TEMPLATE_TASKS_MAX) {
      throw new DomainError(
        'PROJECT_TEMPLATE_TOO_MANY_TASKS',
        422,
        `Mẫu dự án tối đa ${PROJECT_TEMPLATE_TASKS_MAX} công việc`,
      );
    }

    const description = descriptionOf(input.description);
    const created = await ctx.trx
      .insertInto('ludy_projects.project')
      .values({
        org_id: ctx.orgId,
        name: input.name,
        description,
        owner_user_id: userId,
        status: 'active',
        is_template: true,
        template_tasks: JSON.stringify(items),
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    ctx.audit({
      templateId: created.id,
      name: auditValue(PROJECT, 'name', input.name),
      description: auditValue(PROJECT, 'description', description),
      taskCount: items.length,
      sourceProjectId: input.sourceProjectId ?? null,
    });
    await ctx.emit('projects.template.created', { templateId: created.id, taskCount: items.length });
    await ctx.activity('projects.project', created.id, 'projects.template.created', 'Tạo mẫu dự án');
    return { templateId: created.id, taskCount: items.length };
  },
});

export const projectTemplateArchive = defineCommand({
  name: 'projects.template.archive',
  input: zProjectTemplateArchiveInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'project', ['status', 'updated_at'])],
  target: (input) => ({ type: 'projects.project', id: input.templateId }),
  handler: async (ctx, input): Promise<ProjectTemplateArchiveResult> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_projects.project')
      .select([
        'id',
        'name',
        'description',
        'owner_user_id',
        'status',
        'visibility',
        'cycles_enabled',
        'cycle_duration_weeks',
        'points_enabled',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .where('is_template', '=', true)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      throw new DomainError('PROJECT_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu dự án này');
    }
    const projectRow: ProjectRow = {
      ...row,
      status: row.status as ProjectStatus,
      visibility: row.visibility as ProjectVisibility,
    };
    assertCanManage(ctx, projectRow, userId);

    if (projectRow.status !== 'archived') {
      await ctx.trx
        .updateTable('ludy_projects.project')
        .set({ status: 'archived', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', projectRow.id)
        .execute();
    }

    ctx.audit({ templateId: projectRow.id, status: 'archived' });
    await ctx.emit('projects.template.archived', { templateId: projectRow.id });
    await ctx.activity('projects.project', projectRow.id, 'projects.template.archived', 'Lưu trữ mẫu dự án');
    return { templateId: projectRow.id, status: 'archived' };
  },
});

export const projectCreateFromTemplate = defineCommand({
  name: 'projects.project.create_from_template',
  input: zProjectCreateFromTemplateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Calls kernel.task.create inside the same transaction for each template task, so omits writes (human-only).
  handler: async (ctx, input): Promise<ProjectCreateFromTemplateResult> => {
    const userId = userOf(ctx.actor);
    const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
    const language = input.language ?? 'vi';

    let templateName: string;
    let templateDescription: string | null;
    let templateItems: ProjectTemplateTaskItem[];
    let starterColumnSpecs: ReadonlyArray<DefaultColumnSpec> | undefined;

    if (input.builtinKey !== undefined) {
      const entry = STARTER_TEMPLATES.find((t) => t.key === input.builtinKey);
      const starter = starterProjectTemplates(language).find((t) => t.builtinKey === input.builtinKey);
      if (!starter || !entry) {
        throw new DomainError('PROJECT_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu dự án này');
      }
      templateName = starter.name;
      templateDescription = starter.description;
      templateItems = starter.tasks;
      starterColumnSpecs = entry.defaultColumns;
    } else {
      const row = await ctx.trx
        .selectFrom('ludy_projects.project')
        .select(['id', 'name', 'description', 'status', 'template_tasks'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.templateId!)
        .where('is_template', '=', true)
        .executeTakeFirst();
      if (!row) {
        throw new DomainError('PROJECT_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu dự án này');
      }
      if (row.status === 'archived') {
        throw new DomainError('PROJECT_TEMPLATE_ARCHIVED', 409, 'Mẫu dự án này đã được lưu trữ');
      }
      templateName = row.name;
      templateDescription = row.description;
      templateItems = parseStoredTemplateTasks(row.template_tasks);
    }

    const ownerUserId = input.ownerUserId ?? userId;
    const visibility = input.visibility ?? 'org';
    assertCanSetPrivateVisibility(ctx, ownerUserId, userId, visibility);
    const memberIds = resolveCreateMemberIds(visibility, input.memberUserIds, userId, ownerUserId);
    const checkIds = [...new Set([ownerUserId, ...memberIds])];
    const orgRoles = await assertOrgMembers(ctx.trx, ctx.orgId, checkIds);
    if (orgRoles.get(ownerUserId) === 'viewer') {
      throw new DomainError('PROJECT_OWNER_FORBIDDEN', 422, 'Người chỉ có quyền xem không thể phụ trách dự án');
    }

    const projectName = input.name ?? templateName;
    const projectDescription =
      input.description !== undefined ? descriptionOf(input.description) : descriptionOf(templateDescription);
    const startDate = input.startDate ?? zonedDate(tz, ctx.now.getTime());

    // Create kernel tasks before inserting project/project_task so position -> project lock order stays consistent.
    const taskIds: string[] = [];
    for (const item of templateItems) {
      const dueDate =
        item.dueOffsetDays !== undefined && item.dueOffsetDays !== null
          ? addLocalDays(startDate, item.dueOffsetDays)
          : null;
      const due = dueDate ? new Date(todoDueInstant(dueDate, '23:59', tz)).toISOString() : undefined;
      const { taskId } = await ctx.run<{ taskId: string }>('kernel.task.create_from_template', {
        templateId: input.templateId ?? null,
        title: item.title,
        description: item.description ?? null,
        due: due ?? null,
        tainted: item.tainted === true,
      });
      taskIds.push(taskId);
    }

    const created = await ctx.trx
      .insertInto('ludy_projects.project')
      .values({
        org_id: ctx.orgId,
        name: projectName,
        description: projectDescription,
        owner_user_id: ownerUserId,
        status: 'active',
        visibility,
        is_template: false,
        template_tasks: '[]',
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (memberIds.length > 0) {
      await ctx.trx
        .insertInto('ludy_projects.project_member')
        .values(
          memberIds.map((uid) => ({
            org_id: ctx.orgId,
            project_id: created.id,
            user_id: uid,
            created_at: ctx.now,
          })),
        )
        .execute();
    }

    const createdColumns =
      starterColumnSpecs && starterColumnSpecs.length > 0
        ? await insertProjectColumns(ctx, created.id, starterColumnSpecs, language)
        : [];
    const defaultTodoColumnId = resolveTaskColumnId(createdColumns, null, 'todo');

    if (taskIds.length > 0) {
      const keys = spreadKeys(taskIds.length);
      await ctx.trx
        .insertInto('ludy_projects.project_task')
        .values(
          taskIds.map((taskId, i) => ({
            org_id: ctx.orgId,
            project_id: created.id,
            task_id: taskId,
            column_id: defaultTodoColumnId,
            sort_key: keys[i] ?? null,
            added_by: userId,
            created_at: ctx.now,
          })),
        )
        .execute();
    }

    ctx.audit({
      projectId: created.id,
      name: auditValue(PROJECT, 'name', projectName),
      description: auditValue(PROJECT, 'description', projectDescription),
      templateId: input.templateId ?? null,
      builtinKey: input.builtinKey ?? null,
      visibility,
      taskCount: taskIds.length,
      ...(createdColumns.length > 0 ? { columnCount: createdColumns.length } : {}),
    });
    await ctx.emit('projects.project.created', { projectId: created.id, ownerUserId });
    await ctx.activity('projects.project', created.id, 'projects.project.created', 'Tạo dự án từ mẫu');
    return { projectId: created.id, taskIds };
  },
});
