// SPDX-License-Identifier: AGPL-3.0-only
// Runtime.execute() command and query handlers for eSign Slice 2a (#3526):
// reusable templates, Approver/CC template roles, one-click envelope instantiation, and direct signing link management.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_DIRECT_PAGE_PATH,
  SIGN_MAX_PAGES,
  zId,
  zSignTemplateArchiveInput,
  zSignTemplateCreateInput,
  zSignTemplateDirectLinkRotateInput,
  zSignTemplateDirectLinkSetInput,
  zSignTemplateFieldsSetInput,
  zSignTemplateInstantiateInput,
  zSignTemplateListInput,
  zSignTemplateRolesSetInput,
  zSignSharedSummary,
  zSignTemplateUpdateInput,
  type zSignTemplateDirectLinkDetail,
  type zSignTemplateDirectLinkSummary,
} from '@crove/kernel-contract';
import { tableWrite } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { appendSigningEvent } from './events.ts';
import { assertCanAccessEnvelopeRow, assertCanCreateEnvelopeForSource } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import { generateRawSigningToken, hashSigningToken } from './sealing.ts';
import {
  MAIL_MESSAGE_WRITE,
  SIGNING_EVENT_WRITE,
  SIGNING_OTP_INVALIDATE_WRITE,
  SIGNING_TOKEN_WRITE,
  SIGN_READERS,
  SIGN_WRITERS,
  actorLabelOfCtx,
  assertSystemCommand,
  assertSystemQuery,
  assertUserQuery,
  formatSignMicroNorm,
  normalizeNormalizedFieldBoxes,
  parseDetectedTags,
  parsePageDimensions,
  parseSharedSummary,
  requireSignSourceFile,
  sanitizeSharedSummaryForWrite,
  sendDraftEnvelope,
  toSignMicroNorm,
  userIdOf,
  zSignInspectDetectedTags,
  zSignInspectPageDimensions,
  type IssuedSigningLink,
} from './shared.ts';

const templateTarget = (input: { templateId: string }) => ({ type: 'sign.template', id: input.templateId });

const TEMPLATE_DIRECT_LINK_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'template_direct_link', [
  'org_id',
  'template_id',
  'token_sha256',
  'enabled',
  'require_email_otp',
  'max_uses',
  'uses_count',
  'expires_at',
  'revoked_at',
  'revoked_by',
  'last_rotated_at',
  'created_by',
  'created_at',
  'updated_at',
]);

type DirectLinkDetail = z.infer<typeof zSignTemplateDirectLinkDetail>;
type DirectLinkSummary = z.infer<typeof zSignTemplateDirectLinkSummary>;

interface DirectLinkMutationSqlResult {
  id: string | null;
  enabled: boolean;
  requireEmailOtp: boolean;
  maxUses: number | null;
  usesCount: number;
  expiresAt: string | null;
  minted: boolean;
  revokedCount: number;
  lastRotatedAt: string | null;
}

function parseDirectLinkJson(raw: unknown): DirectLinkDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.enabled !== 'boolean') return null;
  return {
    id: obj.id,
    enabled: obj.enabled,
    requireEmailOtp: Boolean(obj.requireEmailOtp),
    maxUses: typeof obj.maxUses === 'number' ? obj.maxUses : null,
    usesCount: typeof obj.usesCount === 'number' ? obj.usesCount : 0,
    expiresAt: typeof obj.expiresAt === 'string' ? obj.expiresAt : null,
    lastRotatedAt: typeof obj.lastRotatedAt === 'string' ? obj.lastRotatedAt : null,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date(String(obj.createdAt)).toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date(String(obj.updatedAt)).toISOString(),
  };
}

function toDirectLinkSummary(detail: DirectLinkDetail | null): DirectLinkSummary | null {
  if (!detail) return null;
  return {
    enabled: detail.enabled,
    requireEmailOtp: detail.requireEmailOtp,
    maxUses: detail.maxUses ?? null,
    usesCount: detail.usesCount ?? 0,
    expiresAt: detail.expiresAt ?? null,
    lastRotatedAt: detail.lastRotatedAt,
  };
}

async function lockTemplate(ctx: CommandContext, templateId: string) {
  const row = await ctx.trx
    .selectFrom('crove_sign.template')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', templateId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DomainError('SIGN_TEMPLATE_NOT_FOUND', 404, 'Template not found');
  return row;
}

function assertTemplateEditable(status: string): void {
  if (status === 'archived') {
    throw new DomainError('SIGN_TEMPLATE_ARCHIVED', 409, 'Archived templates cannot be modified');
  }
}

async function findPassedInspectForFile(
  ctx: CommandContext,
  file: { id: string; storage_key: string; generation: string; sha256: string },
): Promise<{ pageCount: number; pageDimensionsJson: unknown; detectedTagsJson: unknown } | null> {
  const existingTpl = await ctx.trx
    .selectFrom('crove_sign.template')
    .select(['page_count', 'page_dimensions_json', 'detected_tags_json'])
    .where('org_id', '=', ctx.orgId)
    .where('source_file_id', '=', file.id)
    .where('source_storage_key', '=', file.storage_key)
    .where('source_generation', '=', file.generation)
    .where('source_sha256', '=', file.sha256)
    .where('inspect_status', '=', 'passed')
    .where('page_count', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (existingTpl && existingTpl.page_count !== null) {
    return {
      pageCount: existingTpl.page_count,
      pageDimensionsJson: existingTpl.page_dimensions_json,
      detectedTagsJson: existingTpl.detected_tags_json,
    };
  }

  const existingEnv = await ctx.trx
    .selectFrom('crove_sign.envelope')
    .select(['page_count', 'page_dimensions_json', 'detected_tags_json'])
    .where('org_id', '=', ctx.orgId)
    .where('source_file_id', '=', file.id)
    .where('source_storage_key', '=', file.storage_key)
    .where('source_generation', '=', file.generation)
    .where('source_sha256', '=', file.sha256)
    .where('inspect_status', '=', 'passed')
    .where('page_count', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (existingEnv && existingEnv.page_count !== null) {
    return {
      pageCount: existingEnv.page_count,
      pageDimensionsJson: existingEnv.page_dimensions_json,
      detectedTagsJson: existingEnv.detected_tags_json,
    };
  }
  return null;
}

async function loadTemplateRoles(ctx: CommandContext, templateId: string) {
  return ctx.trx
    .selectFrom('crove_sign.template_role')
    .select(['id', 'role_key', 'signer_role', 'role_label', 'routing_order', 'delivery_mode', 'require_email_otp', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where('template_id', '=', templateId)
    .orderBy('routing_order', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

async function assertDirectLinkEligible(ctx: CommandContext, templateId: string) {
  const row = await lockTemplate(ctx, templateId);
  if (row.status !== 'active') {
    throw new DomainError('SIGN_TEMPLATE_NOT_ACTIVE', 409, 'Direct signing links require an active template');
  }
  if (row.inspect_status !== 'passed' || row.page_count === null) {
    throw new DomainError('SIGN_TEMPLATE_NOT_INSPECTED', 409, 'Source PDF must pass inspection before enabling a direct signing link');
  }
  const roles = await loadTemplateRoles(ctx, templateId);
  const activeRoles = roles.filter((r) => r.signer_role !== 'cc');
  if (activeRoles.length !== 1) {
    throw new DomainError(
      'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED',
      422,
      'Direct signing links require exactly one active non-CC signer or approver role',
    );
  }
  return row;
}

export const templateList = defineQuery({
  name: 'sign.template.list',
  input: zSignTemplateListInput,
  access: SIGN_READERS,
  handler: async (ctx, input) => {
    assertUserQuery(ctx);
    let q = ctx.trx
      .selectFrom('crove_sign.template as t')
      .select([
        't.id',
        't.title',
        't.description',
        't.routing_mode',
        't.subject',
        't.message',
        't.expires_in_hours',
        't.status',
        't.inspect_status',
        't.inspect_error',
        't.page_count',
        't.version',
        't.archived_at',
        't.created_at',
        't.updated_at',
        sql<unknown>`crove_sign.template_direct_link_state(t.id)`.as('direct_link_state'),
      ])
      .where('t.org_id', '=', ctx.orgId);

    if (input.status) q = q.where('t.status', '=', input.status);
    if (input.query) {
      const escaped = input.query.replace(/[\\%_]/g, '\\$&');
      q = q.where('t.title', 'ilike', `%${escaped}%`);
    }

    const rows = await q.orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(input.limit).execute();
    if (rows.length === 0) return { items: [] };

    const ids = rows.map((r) => r.id);
    const roleRows = await ctx.trx
      .selectFrom('crove_sign.template_role')
      .select(['template_id', 'signer_role'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', 'in', ids)
      .execute();

    const fieldRows = await ctx.trx
      .selectFrom('crove_sign.template_field')
      .select(['template_id'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', 'in', ids)
      .execute();

    const roleCountByTpl = new Map<string, { total: number; nonCc: number }>();
    for (const r of roleRows) {
      const cur = roleCountByTpl.get(r.template_id) ?? { total: 0, nonCc: 0 };
      cur.total += 1;
      if (r.signer_role !== 'cc') cur.nonCc += 1;
      roleCountByTpl.set(r.template_id, cur);
    }
    const fieldCountByTpl = new Map<string, number>();
    for (const f of fieldRows) {
      fieldCountByTpl.set(f.template_id, (fieldCountByTpl.get(f.template_id) ?? 0) + 1);
    }

    return {
      items: rows.map((r) => {
        const counts = roleCountByTpl.get(r.id) ?? { total: 0, nonCc: 0 };
        const link = parseDirectLinkJson(r.direct_link_state);
        return {
          id: r.id,
          title: r.title,
          description: r.description,
          routingMode: r.routing_mode,
          subject: r.subject,
          message: r.message,
          expiresInHours: r.expires_in_hours,
          status: r.status,
          inspectStatus: r.inspect_status,
          inspectError: r.inspect_error,
          pageCount: r.page_count,
          roleCount: counts.total,
          nonCcRoleCount: counts.nonCc,
          fieldCount: fieldCountByTpl.get(r.id) ?? 0,
          directLink: toDirectLinkSummary(link),
          version: r.version,
          archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        };
      }),
    };
  },
});

export const templateGet = defineQuery({
  name: 'sign.template.get',
  input: z.strictObject({ templateId: zId }),
  access: SIGN_READERS,
  handler: async (ctx, input) => {
    assertUserQuery(ctx);
    const tpl = await ctx.trx
      .selectFrom('crove_sign.template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .executeTakeFirst();
    if (!tpl) throw new DomainError('SIGN_TEMPLATE_NOT_FOUND', 404, 'Template not found');

    const roles = await ctx.trx
      .selectFrom('crove_sign.template_role')
      .select(['id', 'role_key', 'signer_role', 'role_label', 'routing_order', 'delivery_mode', 'require_email_otp', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', tpl.id)
      .orderBy('routing_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const roleKeyById = new Map(roles.map((r) => [r.id, r.role_key]));

    const fields = await ctx.trx
      .selectFrom('crove_sign.template_field')
      .select([
        'id',
        'template_role_id',
        'field_type',
        'page_number',
        'x_norm',
        'y_norm',
        'w_norm',
        'h_norm',
        'label',
        'required',
        'font_size_pt',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', tpl.id)
      .orderBy('page_number', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const { rows: linkRows } = await sql<{ state: unknown }>`
      SELECT crove_sign.template_direct_link_state(${tpl.id}::uuid) AS state
    `.execute(ctx.trx);
    const directLink = parseDirectLinkJson(linkRows[0]?.state ?? null);

    return {
      template: {
        id: tpl.id,
        title: tpl.title,
        description: tpl.description,
        routingMode: tpl.routing_mode,
        allowDelegation: tpl.allow_delegation,
        subject: tpl.subject,
        message: tpl.message,
        expiresInHours: tpl.expires_in_hours,
        status: tpl.status,
        inspectStatus: tpl.inspect_status,
        inspectError: tpl.inspect_error,
        sourceFileId: tpl.source_file_id,
        sourceSha256: tpl.source_sha256,
        pageCount: tpl.page_count,
        pageDimensions: parsePageDimensions(tpl.page_dimensions_json),
        detectedTags: parseDetectedTags(tpl.detected_tags_json, tpl.page_count),
        shareSummaryWithSigners: Boolean(tpl.share_summary_with_signers),
        sharedSummary: parseSharedSummary(tpl.shared_summary_json, tpl.page_count),
        version: tpl.version,
        archivedAt: tpl.archived_at ? new Date(tpl.archived_at).toISOString() : null,
        createdBy: tpl.created_by,
        createdAt: new Date(tpl.created_at).toISOString(),
        updatedAt: new Date(tpl.updated_at).toISOString(),
      },
      roles: roles.map((r) => ({
        id: r.id,
        roleKey: r.role_key,
        signerRole: r.signer_role,
        roleLabel: r.role_label,
        routingOrder: r.routing_order,
        deliveryMode: r.delivery_mode,
        requireEmailOtp: r.require_email_otp,
      })),
      fields: fields.map((f) => ({
        id: f.id,
        templateRoleId: f.template_role_id,
        roleKey: roleKeyById.get(f.template_role_id) ?? 'r1',
        fieldType: f.field_type,
        pageNumber: f.page_number,
        xNorm: Number(f.x_norm),
        yNorm: Number(f.y_norm),
        wNorm: Number(f.w_norm),
        hNorm: Number(f.h_norm),
        label: f.label,
        required: f.required,
        fontSizePt: f.font_size_pt,
      })),
      directLink,
    };
  },
});

export interface SignTemplateInspectJobData {
  id: string;
  status: string;
  inspectStatus: string;
  sourceStorageKey: string;
  sourceGeneration: string;
  sourceSha256: string;
}

export const templateInspectJobData = defineQuery({
  name: 'sign.template.inspect_job_data',
  input: z.strictObject({ templateId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SignTemplateInspectJobData | null> => {
    assertSystemQuery(ctx);
    const row = await ctx.trx
      .selectFrom('crove_sign.template')
      .select(['id', 'status', 'inspect_status', 'source_storage_key', 'source_generation', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      inspectStatus: row.inspect_status,
      sourceStorageKey: row.source_storage_key,
      sourceGeneration: row.source_generation,
      sourceSha256: row.source_sha256,
    };
  },
});

export const templateCreate = defineCommand({
  name: 'sign.template.create',
  input: zSignTemplateCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template', [
      'org_id',
      'title',
      'description',
      'routing_mode',
      'allow_delegation',
      'subject',
      'message',
      'expires_in_hours',
      'source_file_id',
      'source_storage_key',
      'source_generation',
      'source_sha256',
      'inspect_status',
      'page_count',
      'page_dimensions_json',
      'detected_tags_json',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'template_role', [
      'org_id',
      'template_id',
      'role_key',
      'signer_role',
      'role_label',
      'routing_order',
      'delivery_mode',
      'require_email_otp',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'template_field', [
      'org_id',
      'template_id',
      'template_role_id',
      'field_type',
      'page_number',
      'x_norm',
      'y_norm',
      'w_norm',
      'h_norm',
      'label',
      'required',
      'font_size_pt',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);

    let sourceMeta: {
      sourceFileId: string;
      sourceStorageKey: string;
      sourceGeneration: string;
      sourceSha256: string;
      routingMode: 'parallel' | 'sequential';
      allowDelegation: boolean;
      subject: string | null;
      message: string | null;
      inspectStatus: 'pending' | 'passed';
      pageCount: number | null;
      pageDimensionsJson: unknown;
      detectedTagsJson: unknown;
      sourceEnvelopeId: string | null;
    };

    if (input.sourceEnvelopeId) {
      const env = await ctx.trx
        .selectFrom('crove_sign.envelope')
        .select([
          'id',
          'source_kind',
          'created_by',
          'routing_mode',
          'allow_delegation',
          'subject',
          'message',
          'source_file_id',
          'source_storage_key',
          'source_generation',
          'source_sha256',
          'inspect_status',
          'page_count',
          'page_dimensions_json',
          'detected_tags_json',
        ])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.sourceEnvelopeId)
        .forShare()
        .executeTakeFirst();
      if (!env) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Source envelope not found');
      assertCanAccessEnvelopeRow(ctx, env, 'Source envelope not found');
      if (env.source_kind === 'hr_contract') {
        throw new DomainError(
          'SIGN_FORBIDDEN',
          403,
          'Confidential HR contract envelopes cannot be converted into organization-wide templates',
        );
      }
      if (env.inspect_status === 'failed') {
        throw new DomainError('SIGN_INSPECT_FAILED', 409, 'Source envelope PDF inspection failed');
      }
      const passed = env.inspect_status === 'passed' && env.page_count !== null;
      const reused = passed
        ? {
            pageCount: env.page_count!,
            pageDimensionsJson: env.page_dimensions_json,
            detectedTagsJson: env.detected_tags_json,
          }
        : await findPassedInspectForFile(ctx, {
            id: env.source_file_id,
            storage_key: env.source_storage_key,
            generation: env.source_generation,
            sha256: env.source_sha256,
          });
      sourceMeta = {
        sourceFileId: env.source_file_id,
        sourceStorageKey: env.source_storage_key,
        sourceGeneration: env.source_generation,
        sourceSha256: env.source_sha256,
        routingMode: input.routingMode ?? env.routing_mode,
        allowDelegation: input.allowDelegation ?? env.allow_delegation,
        subject: input.subject !== undefined ? input.subject : env.subject,
        message: input.message !== undefined ? input.message : env.message,
        inspectStatus: reused ? 'passed' : 'pending',
        pageCount: reused ? reused.pageCount : null,
        pageDimensionsJson: reused ? reused.pageDimensionsJson : null,
        detectedTagsJson: reused ? reused.detectedTagsJson : null,
        sourceEnvelopeId: env.id,
      };
    } else {
      const file = await requireSignSourceFile(ctx, input.sourceFileId!);
      const existingHrEnv = await ctx.trx
        .selectFrom('crove_sign.envelope')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('source_kind', '=', 'hr_contract')
        .where('source_file_id', '=', file.id)
        .limit(1)
        .executeTakeFirst();
      if (existingHrEnv) {
        throw new DomainError(
          'SIGN_FORBIDDEN',
          403,
          'Confidential HR contract documents cannot be converted into organization-wide templates',
        );
      }
      const reused = await findPassedInspectForFile(ctx, file);
      sourceMeta = {
        sourceFileId: file.id,
        sourceStorageKey: file.storage_key,
        sourceGeneration: file.generation,
        sourceSha256: file.sha256,
        routingMode: input.routingMode ?? 'parallel',
        allowDelegation: input.allowDelegation ?? false,
        subject: input.subject ?? null,
        message: input.message ?? null,
        inspectStatus: reused ? 'passed' : 'pending',
        pageCount: reused ? reused.pageCount : null,
        pageDimensionsJson: reused ? reused.pageDimensionsJson : null,
        detectedTagsJson: reused ? reused.detectedTagsJson : null,
        sourceEnvelopeId: null,
      };
    }

    const desiredStatus = input.status ?? 'draft';
    if (desiredStatus === 'active' && sourceMeta.inspectStatus !== 'passed') {
      throw new DomainError('SIGN_TEMPLATE_NOT_INSPECTED', 409, 'Source PDF must pass inspection before template becomes active');
    }

    const tpl = await ctx.trx
      .insertInto('crove_sign.template')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        description: input.description ?? null,
        routing_mode: sourceMeta.routingMode,
        allow_delegation: sourceMeta.allowDelegation,
        subject: sourceMeta.subject,
        message: sourceMeta.message,
        expires_in_hours: input.expiresInHours ?? null,
        source_file_id: sourceMeta.sourceFileId,
        source_storage_key: sourceMeta.sourceStorageKey,
        source_generation: sourceMeta.sourceGeneration,
        source_sha256: sourceMeta.sourceSha256,
        inspect_status: sourceMeta.inspectStatus,
        page_count: sourceMeta.pageCount,
        page_dimensions_json:
          sourceMeta.pageDimensionsJson === null || sourceMeta.pageDimensionsJson === undefined
            ? null
            : JSON.stringify(sourceMeta.pageDimensionsJson),
        detected_tags_json:
          sourceMeta.detectedTagsJson === null || sourceMeta.detectedTagsJson === undefined
            ? null
            : typeof sourceMeta.detectedTagsJson === 'string'
              ? sourceMeta.detectedTagsJson
              : JSON.stringify(sourceMeta.detectedTagsJson),
        status: desiredStatus,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'status', 'inspect_status', 'version'])
      .executeTakeFirstOrThrow();

    if (sourceMeta.sourceEnvelopeId && input.copyRolesAndFields !== false) {
      const envSigners = await ctx.trx
        .selectFrom('crove_sign.signer')
        .select([
          'id',
          'role_key',
          'signer_role',
          'role_label',
          'routing_order',
          'delivery_mode',
          'require_email_otp',
          'created_at',
        ])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', sourceMeta.sourceEnvelopeId)
        .orderBy('routing_order', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .forShare()
        .execute();

      const signerToTemplateRoleId = new Map<string, string>();
      if (envSigners.length > 0) {
        const usedRoleKeys = new Set<string>(
          envSigners.flatMap((s) => (s.role_key ? [s.role_key] : [])),
        );
        let fallbackIdx = 1;
        const allocateFallbackKey = (): string => {
          while (usedRoleKeys.has(`r${fallbackIdx}`)) {
            fallbackIdx += 1;
          }
          const key = `r${fallbackIdx}`;
          usedRoleKeys.add(key);
          fallbackIdx += 1;
          return key;
        };
        const assignedKeys = new Set<string>();
        const insertedRoles = await ctx.trx
          .insertInto('crove_sign.template_role')
          .values(
            envSigners.map((s) => {
              const roleKey =
                s.role_key && !assignedKeys.has(s.role_key) ? s.role_key : allocateFallbackKey();
              assignedKeys.add(roleKey);
              return {
                org_id: ctx.orgId,
                template_id: tpl.id,
                role_key: roleKey,
                signer_role: s.signer_role,
                role_label: s.role_label,
                routing_order: s.routing_order,
                delivery_mode: s.delivery_mode,
                require_email_otp: s.require_email_otp,
                created_at: ctx.now,
                updated_at: ctx.now,
              };
            }),
          )
          .returning(['id'])
          .execute();
        envSigners.forEach((s, idx) => {
          const inserted = insertedRoles[idx];
          if (inserted) signerToTemplateRoleId.set(s.id, inserted.id);
        });

        const envFields = await ctx.trx
          .selectFrom('crove_sign.field')
          .select(['signer_id', 'field_type', 'page_number', 'x_norm', 'y_norm', 'w_norm', 'h_norm', 'label', 'required', 'font_size_pt'])
          .where('org_id', '=', ctx.orgId)
          .where('envelope_id', '=', sourceMeta.sourceEnvelopeId)
          .orderBy('page_number', 'asc')
          .orderBy('id', 'asc')
          .forShare()
          .execute();

        const clonedFields = envFields.flatMap((f) => {
          const roleId = signerToTemplateRoleId.get(f.signer_id);
          if (!roleId) return [];
          return [
            {
              org_id: ctx.orgId,
              template_id: tpl.id,
              template_role_id: roleId,
              field_type: f.field_type,
              page_number: f.page_number,
              x_norm: String(f.x_norm),
              y_norm: String(f.y_norm),
              w_norm: String(f.w_norm),
              h_norm: String(f.h_norm),
              label: f.label,
              required: f.required,
              font_size_pt: f.font_size_pt,
              created_at: ctx.now,
              updated_at: ctx.now,
            },
          ];
        });
        if (clonedFields.length > 0) {
          await ctx.trx.insertInto('crove_sign.template_field').values(clonedFields).execute();
        }
      }
    }

    if (tpl.inspect_status === 'pending') {
      await ctx.emit('sign.template.inspect_queued', { templateId: tpl.id });
    }
    ctx.audit({ templateId: tpl.id, inspectStatus: tpl.inspect_status, status: tpl.status });
    return {
      templateId: tpl.id,
      status: tpl.status,
      inspectStatus: tpl.inspect_status,
      version: tpl.version,
    };
  },
});

const zTemplateInspectComplete = z.discriminatedUnion('outcome', [
  z.strictObject({
    templateId: zId,
    outcome: z.literal('passed'),
    pageCount: z.number().int().min(1).max(SIGN_MAX_PAGES),
    pageDimensions: zSignInspectPageDimensions,
    detectedTags: zSignInspectDetectedTags,
  }),
  z.strictObject({
    templateId: zId,
    outcome: z.literal('failed'),
    error: z.string().trim().min(1).max(500),
  }),
]);

export const templateInspectComplete = defineCommand({
  name: 'sign.template.inspect_complete',
  input: zTemplateInspectComplete,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template', [
      'inspect_status',
      'inspect_error',
      'page_count',
      'page_dimensions_json',
      'detected_tags_json',
      'version',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    assertSystemCommand(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    if (row.status === 'archived' || row.inspect_status !== 'pending') {
      return {
        templateId: row.id,
        inspectStatus: row.inspect_status,
        pageCount: row.page_count,
        version: row.version,
      };
    }

    const nextVersion = row.version + 1;
    if (input.outcome === 'passed') {
      if (input.pageDimensions.length !== input.pageCount) {
        throw new DomainError('SIGN_INVALID_INSPECT', 422, 'pageDimensions length must equal pageCount');
      }
      for (const tag of input.detectedTags) {
        if (tag.pageNumber > input.pageCount) {
          throw new DomainError(
            'SIGN_INVALID_INSPECT',
            422,
            `Detected tag pageNumber ${tag.pageNumber} exceeds pageCount ${input.pageCount}`,
          );
        }
      }
      await ctx.trx
        .updateTable('crove_sign.template')
        .set({
          inspect_status: 'passed',
          inspect_error: null,
          page_count: input.pageCount,
          page_dimensions_json: JSON.stringify(input.pageDimensions),
          detected_tags_json: JSON.stringify(input.detectedTags),
          version: nextVersion,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      ctx.audit({
        templateId: row.id,
        inspectStatus: 'passed',
        pageCount: input.pageCount,
        detectedTagCount: input.detectedTags.length,
      });
      return { templateId: row.id, inspectStatus: 'passed' as const, pageCount: input.pageCount, version: nextVersion };
    }

    await ctx.trx
      .updateTable('crove_sign.template')
      .set({
        inspect_status: 'failed',
        inspect_error: input.error,
        page_count: null,
        page_dimensions_json: null,
        detected_tags_json: null,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    ctx.audit({ templateId: row.id, inspectStatus: 'failed' });
    return { templateId: row.id, inspectStatus: 'failed' as const, pageCount: null, version: nextVersion };
  },
});

export const templateUpdate = defineCommand({
  name: 'sign.template.update',
  input: zSignTemplateUpdateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template', [
      'title',
      'description',
      'routing_mode',
      'allow_delegation',
      'subject',
      'message',
      'expires_in_hours',
      'status',
      'version',
      'updated_at',
    ]),
    TEMPLATE_DIRECT_LINK_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
  ],
  handler: async (ctx, input) => {
    userIdOf(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    assertTemplateEditable(row.status);

    if (input.status === 'active' && row.inspect_status !== 'passed') {
      throw new DomainError('SIGN_TEMPLATE_NOT_INSPECTED', 409, 'Source PDF must pass inspection before template becomes active');
    }
    if (input.status === 'draft' && row.status === 'active') {
      await sql`SELECT crove_sign.template_direct_link_revoke_for_template(${row.id}::uuid)`.execute(ctx.trx);
    }

    const nextVersion = row.version + 1;
    const nextStatus = input.status ?? row.status;
    await ctx.trx
      .updateTable('crove_sign.template')
      .set({
        title: input.title ?? row.title,
        description: input.description === undefined ? row.description : input.description,
        routing_mode: input.routingMode ?? row.routing_mode,
        allow_delegation: input.allowDelegation ?? row.allow_delegation,
        subject: input.subject === undefined ? row.subject : input.subject,
        message: input.message === undefined ? row.message : input.message,
        expires_in_hours: input.expiresInHours === undefined ? row.expires_in_hours : input.expiresInHours,
        status: nextStatus,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    ctx.audit({ templateId: row.id, status: nextStatus, version: nextVersion });
    return { templateId: row.id, status: nextStatus, version: nextVersion };
  },
});

export const templateRolesSet = defineCommand({
  name: 'sign.template.roles_set',
  input: zSignTemplateRolesSetInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template_role', [
      'org_id',
      'template_id',
      'role_key',
      'signer_role',
      'role_label',
      'routing_order',
      'delivery_mode',
      'require_email_otp',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'template_field', ['id']),
    tableWrite(signManifest.tables, 'crove_sign', 'template', ['version', 'updated_at']),
    TEMPLATE_DIRECT_LINK_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
  ],
  handler: async (ctx, input) => {
    userIdOf(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    assertTemplateEditable(row.status);

    const seenKeys = new Set<string>();
    const seenIds = new Set<string>();
    for (const r of input.roles) {
      if (seenKeys.has(r.roleKey)) {
        throw new DomainError('SIGN_DUPLICATE_ROLE_KEY', 422, `Duplicate roleKey ${r.roleKey}`);
      }
      if (r.signerRole === 'cc' && r.requireEmailOtp) {
        throw new DomainError('SIGN_INVALID_SIGNER', 422, 'CC recipients cannot require email OTP');
      }
      seenKeys.add(r.roleKey);
      if (r.id) {
        if (seenIds.has(r.id)) throw new DomainError('SIGN_DUPLICATE_ROLE_ID', 422, `Duplicate role id ${r.id}`);
        seenIds.add(r.id);
      }
    }

    const existingRoles = await ctx.trx
      .selectFrom('crove_sign.template_role')
      .select(['id', 'role_key', 'signer_role'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', row.id)
      .forUpdate()
      .execute();

    const fieldCountsByRole = new Map<string, number>();
    const existingFields = await ctx.trx
      .selectFrom('crove_sign.template_field')
      .select(['template_role_id'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', row.id)
      .forUpdate()
      .execute();
    for (const f of existingFields) {
      fieldCountsByRole.set(f.template_role_id, (fieldCountsByRole.get(f.template_role_id) ?? 0) + 1);
    }

    const existingById = new Map(existingRoles.map((r) => [r.id, r]));
    const existingByKey = new Map(existingRoles.map((r) => [r.role_key, r]));

    const matchedExistingIds = new Set<string>();
    type RoleOp =
      | { kind: 'update'; existingId: string; role: (typeof input.roles)[number] }
      | { kind: 'insert'; role: (typeof input.roles)[number] };
    const byIdMatch = new Map<number, RoleOp>();

    // Match explicit ids across all entries before falling back to roleKey so key renames or swaps do not collide.
    input.roles.forEach((r, idx) => {
      if (!r.id) return;
      const matched = existingById.get(r.id);
      if (matched && !matchedExistingIds.has(matched.id)) {
        matchedExistingIds.add(matched.id);
        byIdMatch.set(idx, { kind: 'update', existingId: matched.id, role: r });
      }
    });

    const operations: RoleOp[] = input.roles.map((r, idx) => {
      const explicit = byIdMatch.get(idx);
      if (explicit) return explicit;
      const matched = existingByKey.get(r.roleKey);
      if (matched && !matchedExistingIds.has(matched.id)) {
        matchedExistingIds.add(matched.id);
        return { kind: 'update', existingId: matched.id, role: r };
      }
      return { kind: 'insert', role: r };
    });

    for (const op of operations) {
      if (op.kind === 'update' && op.role.signerRole === 'cc' && (fieldCountsByRole.get(op.existingId) ?? 0) > 0) {
        throw new DomainError('SIGN_INVALID_FIELD', 422, `Role ${op.role.roleKey} has placed fields and cannot become CC`);
      }
    }

    const toDeleteIds = existingRoles.filter((r) => !matchedExistingIds.has(r.id)).map((r) => r.id);
    if (toDeleteIds.length > 0) {
      await ctx.trx
        .deleteFrom('crove_sign.template_field')
        .where('org_id', '=', ctx.orgId)
        .where('template_id', '=', row.id)
        .where('template_role_id', 'in', toDeleteIds)
        .execute();
      await ctx.trx
        .deleteFrom('crove_sign.template_role')
        .where('org_id', '=', ctx.orgId)
        .where('template_id', '=', row.id)
        .where('id', 'in', toDeleteIds)
        .execute();
    }

    // Two-phase key swap if surviving role keys are renamed across one another to avoid UNIQUE(template_id, role_key) collision.
    const survivingUpdates = operations.filter((op): op is { kind: 'update'; existingId: string; role: (typeof input.roles)[number] } => op.kind === 'update');
    for (const op of survivingUpdates) {
      await ctx.trx
        .updateTable('crove_sign.template_role')
        .set({
          role_key: `swap-${op.existingId.replace(/-/g, '')}`,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', op.existingId)
        .execute();
    }

    for (const op of survivingUpdates) {
      await ctx.trx
        .updateTable('crove_sign.template_role')
        .set({
          role_key: op.role.roleKey,
          signer_role: op.role.signerRole,
          role_label: op.role.roleLabel,
          routing_order: op.role.routingOrder,
          delivery_mode: op.role.deliveryMode,
          require_email_otp: op.role.requireEmailOtp,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', op.existingId)
        .execute();
    }

    const inserts = operations.filter((op): op is { kind: 'insert'; role: (typeof input.roles)[number] } => op.kind === 'insert');
    if (inserts.length > 0) {
      await ctx.trx
        .insertInto('crove_sign.template_role')
        .values(
          inserts.map((op) => ({
            org_id: ctx.orgId,
            template_id: row.id,
            role_key: op.role.roleKey,
            signer_role: op.role.signerRole,
            role_label: op.role.roleLabel,
            routing_order: op.role.routingOrder,
            delivery_mode: op.role.deliveryMode,
            require_email_otp: op.role.requireEmailOtp,
            created_at: ctx.now,
            updated_at: ctx.now,
          })),
        )
        .execute();
    }

    const nonCcCount = input.roles.filter((r) => r.signerRole !== 'cc').length;
    if (nonCcCount !== 1) {
      await sql`SELECT crove_sign.template_direct_link_revoke_for_template(${row.id}::uuid)`.execute(ctx.trx);
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.template')
      .set({ version: nextVersion, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    const savedRoles = await loadTemplateRoles(ctx, row.id);
    ctx.audit({ templateId: row.id, roleCount: savedRoles.length, version: nextVersion });
    return {
      templateId: row.id,
      version: nextVersion,
      roles: savedRoles.map((r) => ({
        id: r.id,
        roleKey: r.role_key,
        signerRole: r.signer_role,
        roleLabel: r.role_label,
        routingOrder: r.routing_order,
        deliveryMode: r.delivery_mode,
        requireEmailOtp: r.require_email_otp,
      })),
    };
  },
});

export const templateFieldsSet = defineCommand({
  name: 'sign.template.fields_set',
  input: zSignTemplateFieldsSetInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template_field', [
      'org_id',
      'template_id',
      'template_role_id',
      'field_type',
      'page_number',
      'x_norm',
      'y_norm',
      'w_norm',
      'h_norm',
      'label',
      'required',
      'font_size_pt',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'template', ['version', 'updated_at']),
  ],
  handler: async (ctx, input) => {
    userIdOf(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    assertTemplateEditable(row.status);
    if (row.inspect_status === 'failed') {
      throw new DomainError('SIGN_INSPECT_FAILED', 409, 'Cannot place fields on a template whose PDF inspection failed');
    }

    const roles = await ctx.trx
      .selectFrom('crove_sign.template_role')
      .select(['id', 'role_key', 'signer_role'])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', row.id)
      .forShare()
      .execute();
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const roleByKey = new Map(roles.map((r) => [r.role_key, r]));

    const resolvedFields = input.fields.map((f) => {
      let targetRole: (typeof roles)[number];
      if (f.templateRoleId) {
        const byId = roleById.get(f.templateRoleId);
        if (!byId) {
          throw new DomainError('SIGN_ROLE_NOT_FOUND', 422, `Template role ${f.templateRoleId} not found`);
        }
        if (f.roleKey && byId.role_key !== f.roleKey) {
          throw new DomainError('SIGN_INVALID_FIELD', 422, 'templateRoleId and roleKey point to different template roles');
        }
        targetRole = byId;
      } else {
        const byKey = f.roleKey ? roleByKey.get(f.roleKey) : undefined;
        if (!byKey) {
          throw new DomainError('SIGN_ROLE_NOT_FOUND', 422, `Template role ${f.roleKey ?? 'unknown'} not found`);
        }
        targetRole = byKey;
      }
      if (targetRole.signer_role === 'cc') {
        throw new DomainError('SIGN_INVALID_FIELD', 422, 'Fields cannot be assigned to CC template roles');
      }
      return { ...f, resolvedRoleId: targetRole.id };
    });

    const normalized = normalizeNormalizedFieldBoxes(resolvedFields, row.page_count);

    await ctx.trx
      .deleteFrom('crove_sign.template_field')
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', row.id)
      .execute();

    if (normalized.length > 0) {
      await ctx.trx
        .insertInto('crove_sign.template_field')
        .values(
          normalized.map((f) => ({
            org_id: ctx.orgId,
            template_id: row.id,
            template_role_id: f.resolvedRoleId,
            field_type: f.fieldType,
            page_number: f.pageNumber,
            x_norm: f.xStr,
            y_norm: f.yStr,
            w_norm: f.wStr,
            h_norm: f.hStr,
            label: f.label ?? null,
            required: f.required,
            font_size_pt: f.fontSizePt ?? null,
            created_at: ctx.now,
            updated_at: ctx.now,
          })),
        )
        .execute();
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.template')
      .set({ version: nextVersion, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    ctx.audit({ templateId: row.id, fieldCount: normalized.length, version: nextVersion });
    return { templateId: row.id, fieldCount: normalized.length, version: nextVersion };
  },
});

export const templateArchive = defineCommand({
  name: 'sign.template.archive',
  input: zSignTemplateArchiveInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template', ['status', 'archived_at', 'archived_by', 'version', 'updated_at']),
    TEMPLATE_DIRECT_LINK_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    if (row.status === 'archived') {
      return { templateId: row.id, status: 'archived' as const, version: row.version, revokedLinks: 0 };
    }

    const { rows: revoked } = await sql<{ count: number }>`
      SELECT crove_sign.template_direct_link_revoke_for_template(${row.id}::uuid) AS count
    `.execute(ctx.trx);
    const revokedLinks = Number(revoked[0]?.count ?? 0);

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.template')
      .set({
        status: 'archived',
        archived_at: ctx.now,
        archived_by: userId,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    ctx.audit({ templateId: row.id, status: 'archived', revokedLinks, version: nextVersion });
    return { templateId: row.id, status: 'archived' as const, version: nextVersion, revokedLinks };
  },
});

export const templateDirectLinkSet = defineCommand({
  name: 'sign.template.direct_link_set',
  input: zSignTemplateDirectLinkSetInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  // Returns raw direct signing link capability token once on enable; never store plaintext in idempotency replay records.
  noIdempotency: true,
  target: templateTarget,
  writes: [TEMPLATE_DIRECT_LINK_WRITE, SIGNING_OTP_INVALIDATE_WRITE],
  handler: async (ctx, input) => {
    userIdOf(ctx);
    if (!input.enabled) {
      await lockTemplate(ctx, input.templateId);
      const { rows } = await sql<{ res: DirectLinkMutationSqlResult }>`
        SELECT crove_sign.template_direct_link_set(
          ${input.templateId}::uuid,
          false,
          ${input.requireEmailOtp ?? false},
          NULL::text
        ) AS res
      `.execute(ctx.trx);
      const res = rows[0]?.res;
      ctx.audit({ templateId: input.templateId, enabled: false, revokedCount: res?.revokedCount ?? 0 });
      return {
        templateId: input.templateId,
        enabled: false,
        requireEmailOtp: false,
        maxUses: null,
        usesCount: 0,
        expiresAt: null,
        url: null,
        token: null,
        lastRotatedAt: null,
      };
    }

    const parsedExpiresAt =
      input.expiresAt !== undefined ? (input.expiresAt ? new Date(input.expiresAt) : null) : undefined;
    if (parsedExpiresAt && parsedExpiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }

    await assertDirectLinkEligible(ctx, input.templateId);

    const { rows: existingRows } = await sql<{ state: unknown }>`
      SELECT crove_sign.template_direct_link_state(${input.templateId}::uuid) AS state
    `.execute(ctx.trx);
    const existingState = parseDirectLinkJson(existingRows[0]?.state ?? null);

    if (existingState?.enabled) {
      const nextOtp = input.requireEmailOtp ?? existingState.requireEmailOtp;
      const updateLimits = input.maxUses !== undefined || input.expiresAt !== undefined;
      const nextMaxUses = input.maxUses !== undefined ? input.maxUses : (existingState.maxUses ?? null);
      const nextExpiresAt =
        parsedExpiresAt !== undefined
          ? parsedExpiresAt
          : existingState.expiresAt
            ? new Date(existingState.expiresAt)
            : null;
      if (nextMaxUses !== null && nextMaxUses < (existingState.usesCount ?? 0)) {
        throw new DomainError(
          'SIGN_DIRECT_LINK_MAX_USES_EXCEEDED',
          422,
          'maxUses cannot be lower than current usesCount',
        );
      }
      const { rows } = await sql<{ res: DirectLinkMutationSqlResult }>`
        SELECT crove_sign.template_direct_link_set_v2(
          ${input.templateId}::uuid,
          true,
          ${nextOtp},
          NULL::text,
          ${nextMaxUses}::integer,
          ${nextExpiresAt}::timestamptz,
          ${updateLimits}::boolean
        ) AS res
      `.execute(ctx.trx);
      const res = rows[0]?.res;
      ctx.audit({ templateId: input.templateId, enabled: true, requireEmailOtp: nextOtp, minted: false });
      return {
        templateId: input.templateId,
        enabled: true,
        requireEmailOtp: nextOtp,
        maxUses: res?.maxUses ?? nextMaxUses,
        usesCount: res?.usesCount ?? existingState.usesCount ?? 0,
        expiresAt: res?.expiresAt ?? (nextExpiresAt ? nextExpiresAt.toISOString() : null),
        url: null,
        token: null,
        lastRotatedAt: res?.lastRotatedAt ?? existingState.lastRotatedAt,
      };
    }

    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const nextOtp = input.requireEmailOtp ?? false;
    const nextMaxUses = input.maxUses ?? null;
    const nextExpiresAt = parsedExpiresAt ?? null;
    const { rows } = await sql<{ res: DirectLinkMutationSqlResult }>`
      SELECT crove_sign.template_direct_link_set_v2(
        ${input.templateId}::uuid,
        true,
        ${nextOtp},
        ${tokenHash},
        ${nextMaxUses}::integer,
        ${nextExpiresAt}::timestamptz,
        true
      ) AS res
    `.execute(ctx.trx);
    const res = rows[0]?.res;
    ctx.audit({ templateId: input.templateId, enabled: true, requireEmailOtp: nextOtp, minted: true });
    return {
      templateId: input.templateId,
      enabled: true,
      requireEmailOtp: nextOtp,
      maxUses: res?.maxUses ?? nextMaxUses,
      usesCount: res?.usesCount ?? 0,
      expiresAt: res?.expiresAt ?? (nextExpiresAt ? nextExpiresAt.toISOString() : null),
      url: `${SIGN_DIRECT_PAGE_PATH}#${rawToken}`,
      token: rawToken,
      lastRotatedAt: res?.lastRotatedAt ?? null,
    };
  },
});

export const templateDirectLinkRotate = defineCommand({
  name: 'sign.template.direct_link_rotate',
  input: zSignTemplateDirectLinkRotateInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  // Returns rotated raw direct signing link capability token once; never persist plaintext tokens.
  noIdempotency: true,
  target: templateTarget,
  writes: [TEMPLATE_DIRECT_LINK_WRITE, SIGNING_OTP_INVALIDATE_WRITE],
  handler: async (ctx, input) => {
    userIdOf(ctx);
    const parsedExpiresAt =
      input.expiresAt !== undefined ? (input.expiresAt ? new Date(input.expiresAt) : null) : undefined;
    if (parsedExpiresAt && parsedExpiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }
    await assertDirectLinkEligible(ctx, input.templateId);

    const { rows: existingRows } = await sql<{ state: unknown }>`
      SELECT crove_sign.template_direct_link_state(${input.templateId}::uuid) AS state
    `.execute(ctx.trx);
    const existingState = parseDirectLinkJson(existingRows[0]?.state ?? null);
    const updateLimits = input.maxUses !== undefined || input.expiresAt !== undefined;
    const nextMaxUses = input.maxUses !== undefined ? input.maxUses : (existingState?.maxUses ?? null);
    const nextExpiresAt =
      parsedExpiresAt !== undefined
        ? parsedExpiresAt
        : existingState?.expiresAt
          ? new Date(existingState.expiresAt)
          : null;

    const rawToken = generateRawSigningToken();
    const tokenHash = hashSigningToken(rawToken);
    const { rows } = await sql<{ res: DirectLinkMutationSqlResult }>`
      SELECT crove_sign.template_direct_link_rotate_v2(
        ${input.templateId}::uuid,
        ${tokenHash},
        ${input.requireEmailOtp ?? null}::boolean,
        ${nextMaxUses}::integer,
        ${nextExpiresAt}::timestamptz,
        ${updateLimits}::boolean
      ) AS res
    `.execute(ctx.trx);
    const res = rows[0]?.res;
    ctx.audit({ templateId: input.templateId, rotated: true, revokedCount: res?.revokedCount ?? 0 });
    return {
      templateId: input.templateId,
      enabled: true,
      requireEmailOtp: Boolean(res?.requireEmailOtp),
      maxUses: res?.maxUses ?? nextMaxUses,
      usesCount: res?.usesCount ?? 0,
      expiresAt: res?.expiresAt ?? (nextExpiresAt ? nextExpiresAt.toISOString() : null),
      url: `${SIGN_DIRECT_PAGE_PATH}#${rawToken}`,
      token: rawToken,
      lastRotatedAt: res?.lastRotatedAt ?? ctx.now.toISOString(),
    };
  },
});

export const templateInstantiate = defineCommand({
  name: 'sign.template.instantiate',
  input: zSignTemplateInstantiateInput,
  risk: 'R2',
  sideEffect: 'external',
  access: SIGN_WRITERS,
  // autoSend may return minted one-time signing tokens; disable idempotency replay persistence.
  noIdempotency: true,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'envelope', [
      'org_id',
      'title',
      'subject',
      'message',
      'status',
      'routing_mode',
      'allow_delegation',
      'source_kind',
      'source_id',
      'source_file_id',
      'source_storage_key',
      'source_generation',
      'source_sha256',
      'inspect_status',
      'page_count',
      'page_dimensions_json',
      'detected_tags_json',
      'share_summary_with_signers',
      'shared_summary_json',
      'expires_at',
      'sent_at',
      'version',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'signer', [
      'org_id',
      'envelope_id',
      'role_key',
      'routing_order',
      'signer_role',
      'role_label',
      'name',
      'email',
      'phone',
      'delivery_mode',
      'require_email_otp',
      'status',
      'created_at',
      'updated_at',
    ]),
    tableWrite(signManifest.tables, 'crove_sign', 'field', [
      'org_id',
      'envelope_id',
      'signer_id',
      'field_type',
      'page_number',
      'x_norm',
      'y_norm',
      'w_norm',
      'h_norm',
      'label',
      'required',
      'proposed_by_ai',
      'font_size_pt',
      'created_at',
      'updated_at',
    ]),
    SIGNING_TOKEN_WRITE,
    SIGNING_OTP_INVALIDATE_WRITE,
    SIGNING_EVENT_WRITE,
    MAIL_MESSAGE_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const sourceKind = input.sourceKind ?? 'standalone';
    const sourceId = input.sourceId ?? null;
    if (sourceKind === 'standalone' && sourceId !== null) {
      throw new DomainError('SIGN_INVALID_SOURCE', 422, 'Standalone envelopes cannot specify sourceId');
    }
    if (sourceKind !== 'standalone' && sourceId === null) {
      throw new DomainError('SIGN_INVALID_SOURCE', 422, 'Linked envelopes require sourceId');
    }
    assertCanCreateEnvelopeForSource(ctx, sourceKind);

    const tpl = await ctx.trx
      .selectFrom('crove_sign.template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .forShare()
      .executeTakeFirst();
    if (!tpl) throw new DomainError('SIGN_TEMPLATE_NOT_FOUND', 404, 'Template not found');
    if (tpl.status === 'archived') {
      throw new DomainError('SIGN_TEMPLATE_ARCHIVED', 409, 'Archived templates cannot instantiate envelopes');
    }
    if (tpl.inspect_status === 'failed') {
      throw new DomainError('SIGN_INSPECT_FAILED', 409, 'Template PDF failed inspection and cannot create envelopes');
    }

    const expiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
          ? new Date(input.expiresAt)
          : null
        : tpl.expires_in_hours
          ? new Date(ctx.now.getTime() + tpl.expires_in_hours * 3_600_000)
          : null;
    if (expiresAt !== null && expiresAt.getTime() <= ctx.now.getTime()) {
      throw new DomainError('SIGN_INVALID_EXPIRY', 422, 'expiresAt must be in the future');
    }

    const roles = await loadTemplateRoles(ctx, tpl.id);
    const roleByKey = new Map(roles.map((r) => [r.role_key, r]));
    const recipientByKey = new Map<string, (typeof input.recipients)[number]>();
    for (const rec of input.recipients) {
      if (!roleByKey.has(rec.roleKey)) {
        throw new DomainError('SIGN_UNKNOWN_ROLE_KEY', 422, `Unknown template roleKey ${rec.roleKey}`);
      }
      if (recipientByKey.has(rec.roleKey)) {
        throw new DomainError('SIGN_DUPLICATE_ROLE_KEY', 422, `Duplicate recipient for roleKey ${rec.roleKey}`);
      }
      recipientByKey.set(rec.roleKey, rec);
    }

    const resolvedRoles = roles.flatMap((role) => {
      const rec = recipientByKey.get(role.role_key);
      if (!rec) {
        if (role.signer_role !== 'cc') {
          throw new DomainError('SIGN_RECIPIENT_REQUIRED', 422, `Recipient is required for role ${role.role_label} (${role.role_key})`);
        }
        return [];
      }
      const deliveryMode = rec.deliveryMode ?? role.delivery_mode;
      const requireEmailOtp = rec.requireEmailOtp ?? role.require_email_otp;
      if (role.signer_role === 'cc' && requireEmailOtp) {
        throw new DomainError('SIGN_INVALID_SIGNER', 422, 'CC recipients cannot require email OTP');
      }
      const email = rec.email ? rec.email.trim().toLowerCase() : null;
      if ((deliveryMode === 'email' || requireEmailOtp) && !email) {
        throw new DomainError('SIGN_EMAIL_REQUIRED', 422, `Email address is required for role ${role.role_label}`);
      }
      return [
        {
          templateRoleId: role.id,
          roleKey: role.role_key,
          routingOrder: role.routing_order,
          signerRole: role.signer_role,
          roleLabel: role.role_label,
          name: rec.name,
          email,
          phone: rec.phone ?? null,
          deliveryMode,
          requireEmailOtp,
        },
      ];
    });

    const fields = await ctx.trx
      .selectFrom('crove_sign.template_field')
      .select([
        'id',
        'template_role_id',
        'field_type',
        'page_number',
        'x_norm',
        'y_norm',
        'w_norm',
        'h_norm',
        'label',
        'required',
        'font_size_pt',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('template_id', '=', tpl.id)
      .orderBy('page_number', 'asc')
      .orderBy('id', 'asc')
      .execute();

    if (input.autoSend) {
      if (tpl.inspect_status !== 'passed' || tpl.page_count === null) {
        throw new DomainError('SIGN_DOCUMENT_NOT_INSPECTED', 409, 'Document must pass PDF inspection before sending');
      }
      if (resolvedRoles.filter((r) => r.signerRole !== 'cc').length === 0) {
        throw new DomainError('SIGN_NO_SIGNERS', 409, 'Template requires at least one signer or approver role before sending');
      }
    }

    const inheritedSummary = parseSharedSummary(tpl.shared_summary_json, tpl.page_count);
    const inheritedShareFlag = Boolean(tpl.share_summary_with_signers && inheritedSummary !== null);

    const env = await ctx.trx
      .insertInto('crove_sign.envelope')
      .values({
        org_id: ctx.orgId,
        title: input.title ?? tpl.title,
        subject: input.subject === undefined ? tpl.subject : input.subject,
        message: input.message === undefined ? tpl.message : input.message,
        status: 'draft',
        routing_mode: tpl.routing_mode,
        allow_delegation: input.allowDelegation ?? tpl.allow_delegation,
        source_kind: sourceKind,
        source_id: sourceId,
        source_file_id: tpl.source_file_id,
        source_storage_key: tpl.source_storage_key,
        source_generation: tpl.source_generation,
        source_sha256: tpl.source_sha256,
        inspect_status: 'pending',
        share_summary_with_signers: inheritedShareFlag,
        shared_summary_json: inheritedSummary ? JSON.stringify(inheritedSummary) : null,
        expires_at: expiresAt,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: env.id,
      eventType: 'envelope_created',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOfCtx(ctx),
      documentSha256: env.source_sha256,
      payloadJson: {
        routingMode: env.routing_mode,
        sourceKind,
        ...(sourceId ? { sourceId } : {}),
        templateId: tpl.id,
      },
      occurredAt: ctx.now,
    });

    const signerByTemplateRoleId = new Map<
      string,
      {
        id: string;
        routing_order: number;
        signer_role: string;
        role_label: string;
        email: string | null;
        delivery_mode: string;
        created_at: Date;
      }
    >();

    if (resolvedRoles.length > 0) {
      const insertedSigners = await ctx.trx
        .insertInto('crove_sign.signer')
        .values(
          resolvedRoles.map((r) => ({
            org_id: ctx.orgId,
            envelope_id: env.id,
            role_key: r.roleKey,
            routing_order: r.routingOrder,
            signer_role: r.signerRole,
            role_label: r.roleLabel,
            name: r.name,
            email: r.email,
            phone: r.phone,
            delivery_mode: r.deliveryMode,
            require_email_otp: r.requireEmailOtp,
            status: 'waiting' as const,
            created_at: ctx.now,
            updated_at: ctx.now,
          })),
        )
        .returning(['id', 'routing_order', 'signer_role', 'role_label', 'email', 'delivery_mode', 'created_at'])
        .execute();

      resolvedRoles.forEach((r, idx) => {
        const s = insertedSigners[idx];
        if (s) signerByTemplateRoleId.set(r.templateRoleId, s);
      });
    }

    const fieldInsertValues = fields.flatMap((f) => {
      const signer = signerByTemplateRoleId.get(f.template_role_id);
      if (!signer) return [];
      return [
        {
          org_id: ctx.orgId,
          envelope_id: env.id,
          signer_id: signer.id,
          field_type: f.field_type,
          page_number: f.page_number,
          x_norm: formatSignMicroNorm(toSignMicroNorm(Number(f.x_norm))),
          y_norm: formatSignMicroNorm(toSignMicroNorm(Number(f.y_norm))),
          w_norm: formatSignMicroNorm(toSignMicroNorm(Number(f.w_norm))),
          h_norm: formatSignMicroNorm(toSignMicroNorm(Number(f.h_norm))),
          label: f.label,
          required: f.required,
          proposed_by_ai: false,
          font_size_pt: f.font_size_pt,
          created_at: ctx.now,
          updated_at: ctx.now,
        },
      ];
    });

    const insertedFields =
      fieldInsertValues.length > 0
        ? await ctx.trx
            .insertInto('crove_sign.field')
            .values(fieldInsertValues)
            .returning(['id', 'signer_id', 'field_type', 'page_number'])
            .execute()
        : [];

    let effectiveInspectStatus = env.inspect_status;
    let effectivePageCount = env.page_count;
    if (tpl.inspect_status === 'passed' && tpl.page_count !== null) {
      const { rows: inheritRows } = await sql<{ inherited: boolean }>`
        SELECT crove_sign.template_inherit_inspect(${tpl.id}::uuid, ${env.id}::uuid) AS inherited
      `.execute(ctx.trx);
      if (inheritRows[0]?.inherited) {
        effectiveInspectStatus = 'passed';
        effectivePageCount = tpl.page_count;
      }
    }

    if (effectiveInspectStatus !== 'passed') {
      await ctx.emit('sign.envelope.inspect_queued', { envelopeId: env.id });
    }

    let links: IssuedSigningLink[] = [];
    let finalStatus: 'draft' | 'sent' = 'draft';
    let finalVersion = env.version;

    if (input.autoSend) {
      const sent = await sendDraftEnvelope(ctx, {
        envelope: {
          id: env.id,
          title: env.title,
          routing_mode: env.routing_mode,
          inspect_status: effectiveInspectStatus,
          page_count: effectivePageCount,
          expires_at: env.expires_at,
          source_sha256: env.source_sha256,
          version: env.version,
        },
        signers: Array.from(signerByTemplateRoleId.values()),
        fields: insertedFields,
        userId,
      });
      links = sent.links;
      finalStatus = sent.status;
      finalVersion = sent.version;
    }

    ctx.audit({ templateId: tpl.id, envelopeId: env.id, autoSend: input.autoSend, status: finalStatus });
    return {
      envelopeId: env.id,
      status: finalStatus,
      version: finalVersion,
      links,
    };
  },
});

export const templateSharedSummarySet = defineCommand({
  name: 'sign.template.shared_summary_set',
  input: z.strictObject({
    templateId: zId,
    shareSummaryWithSigners: z.boolean(),
    sharedSummary: zSignSharedSummary.nullable(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  target: templateTarget,
  writes: [
    tableWrite(signManifest.tables, 'crove_sign', 'template', [
      'share_summary_with_signers',
      'shared_summary_json',
      'version',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await lockTemplate(ctx, input.templateId);
    assertTemplateEditable(row.status);
    if (ctx.role !== 'owner' && ctx.role !== 'admin' && row.created_by !== userId) {
      throw new DomainError(
        'SIGN_FORBIDDEN',
        403,
        'Only the template creator, organization owner, or admin can update the counterparty summary',
      );
    }

    const cleanSummary = sanitizeSharedSummaryForWrite(input.sharedSummary, row.page_count);
    if (input.shareSummaryWithSigners && cleanSummary === null) {
      throw new DomainError('VALIDATION', 422, 'sharedSummary is required when shareSummaryWithSigners is true');
    }

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('crove_sign.template')
      .set({
        share_summary_with_signers: input.shareSummaryWithSigners,
        shared_summary_json: cleanSummary ? JSON.stringify(cleanSummary) : null,
        version: nextVersion,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    ctx.audit({
      templateId: row.id,
      shareSummaryWithSigners: input.shareSummaryWithSigners,
      keyTermCount: cleanSummary?.keyTerms.length ?? 0,
      version: nextVersion,
    });

    return {
      templateId: row.id,
      shareSummaryWithSigners: input.shareSummaryWithSigners,
      sharedSummary: cleanSummary,
      version: nextVersion,
    };
  },
});

export const signTemplateCommands = [
  templateCreate,
  templateInspectComplete,
  templateUpdate,
  templateSharedSummarySet,
  templateRolesSet,
  templateFieldsSet,
  templateArchive,
  templateDirectLinkSet,
  templateDirectLinkRotate,
  templateInstantiate,
];

export const signTemplateQueries = [templateList, templateGet, templateInspectJobData];
