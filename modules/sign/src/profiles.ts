// SPDX-License-Identifier: AGPL-3.0-only
// Runtime.execute() command and query handlers for eSign Slice 4a (#3817):
//   - Member-private saved signature and initials profiles (ludy_sign.member_signature, author-only RLS).
//   - Corporate and title stamp profiles (ludy_sign.org_stamp, owner/admin write, SIGN_WRITERS read).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  SIGN_MAX_ORG_STAMPS,
  SIGN_SIGNATURE_PNG_MAX_BYTES,
  tableWrite,
  zSignMemberSignatureDeleteInput,
  zSignMemberSignatureListInput,
  zSignMemberSignatureUpsertInput,
  zSignOrgStampArchiveInput,
  zSignOrgStampCreateInput,
  zSignOrgStampListInput,
  type SignMemberSignatureRecord,
  type SignOrgStampRecord,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';
import { signManifest } from './manifest.ts';
import { validateSignaturePngBase64 } from './png.ts';
import { SIGN_WRITERS, assertUserQuery, userIdOf } from './shared.ts';

const SIGN_ADMINS: readonly MemberRole[] = ['owner', 'admin'];

function cleanInlineLabel(value: string, maxChars: number): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x00) {
      throw new DomainError('VALIDATION', 422, 'NUL character is not allowed');
    }
    if (code <= 0x1f || code === 0x7f) {
      out += ' ';
    } else {
      out += value[i];
    }
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || collapsed.length > maxChars) {
    throw new DomainError('VALIDATION', 422, `Label must be between 1 and ${maxChars} characters`);
  }
  return collapsed;
}

function assertOrgStampAdmin(ctx: CommandContext): string {
  const userId = userIdOf(ctx);
  if (ctx.actor.type !== 'user' || (ctx.role !== 'owner' && ctx.role !== 'admin')) {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace owners and admins can manage organization stamps');
  }
  return userId;
}

function toMemberSignatureRecord(row: {
  id: string;
  kind: 'signature' | 'initials';
  signature_kind: 'draw' | 'type';
  signature_typed_text: string | null;
  signature_png_base64: string;
  image_sha256: string;
  width_px: number;
  height_px: number;
  created_at: Date | string;
  updated_at: Date | string;
}): SignMemberSignatureRecord {
  return {
    id: row.id,
    kind: row.kind,
    signatureKind: row.signature_kind,
    signatureTypedText: row.signature_typed_text,
    signaturePngBase64: row.signature_png_base64,
    imageSha256: row.image_sha256,
    widthPx: row.width_px,
    heightPx: row.height_px,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toOrgStampRecord(row: {
  id: string;
  name: string;
  stamp_kind: 'company' | 'title' | 'custom';
  file_id: string | null;
  stamp_png_base64: string;
  image_sha256: string;
  width_px: number;
  height_px: number;
  status: 'active' | 'archived';
  archived_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}): SignOrgStampRecord {
  return {
    id: row.id,
    name: row.name,
    stampKind: row.stamp_kind,
    fileId: row.file_id,
    stampPngBase64: row.stamp_png_base64,
    imageSha256: row.image_sha256,
    widthPx: row.width_px,
    heightPx: row.height_px,
    status: row.status,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const memberSignatureList = defineQuery({
  name: 'sign.member_signature.list',
  input: zSignMemberSignatureListInput,
  access: SIGN_WRITERS,
  handler: async (ctx) => {
    assertUserQuery(ctx);
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Saved signatures are scoped to a signed-in member');
    }
    const rows = await ctx.trx
      .selectFrom('ludy_sign.member_signature')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .orderBy('kind', 'asc')
      .execute();

    return {
      items: rows.map(toMemberSignatureRecord),
    };
  },
});

export const orgStampList = defineQuery({
  name: 'sign.stamp.list',
  input: zSignOrgStampListInput,
  access: SIGN_WRITERS,
  handler: async (ctx, input) => {
    assertUserQuery(ctx);
    const canManage = ctx.actor.type === 'user' && (ctx.role === 'owner' || ctx.role === 'admin');
    if (!canManage && input.status === 'archived') {
      return { items: [], canManage: false };
    }
    const effectiveStatus = input.status ?? (canManage ? undefined : 'active');
    let q = ctx.trx
      .selectFrom('ludy_sign.org_stamp')
      .selectAll()
      .where('org_id', '=', ctx.orgId);

    if (effectiveStatus) {
      q = q.where('status', '=', effectiveStatus);
    }

    const rows = await q
      .orderBy('status', 'asc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100)
      .execute();

    return {
      items: rows.map(toOrgStampRecord),
      canManage,
    };
  },
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const memberSignatureUpsert = defineCommand({
  name: 'sign.member_signature.upsert',
  input: zSignMemberSignatureUpsertInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [
    tableWrite(signManifest.tables, 'ludy_sign', 'member_signature', [
      'org_id',
      'user_id',
      'kind',
      'signature_kind',
      'signature_typed_text',
      'signature_png_base64',
      'image_sha256',
      'width_px',
      'height_px',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const validated = validateSignaturePngBase64(input.signaturePngBase64);
    const imageSha256 = createHash('sha256').update(Buffer.from(validated.base64, 'base64')).digest('hex');

    let typedLabel: string | null = null;
    if (input.signatureTypedText !== undefined && input.signatureTypedText !== null) {
      typedLabel = cleanInlineLabel(input.signatureTypedText, 200);
    } else if (input.signatureKind === 'type') {
      throw new DomainError('VALIDATION', 422, 'Typed signature text is required when signatureKind is type');
    }

    const row = await ctx.trx
      .insertInto('ludy_sign.member_signature')
      .values({
        org_id: ctx.orgId,
        user_id: userId,
        kind: input.kind,
        signature_kind: input.signatureKind,
        signature_typed_text: typedLabel,
        signature_png_base64: validated.base64,
        image_sha256: imageSha256,
        width_px: validated.width,
        height_px: validated.height,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'user_id', 'kind']).doUpdateSet({
          signature_kind: input.signatureKind,
          signature_typed_text: typedLabel,
          signature_png_base64: validated.base64,
          image_sha256: imageSha256,
          width_px: validated.width,
          height_px: validated.height,
          updated_at: ctx.now,
        }),
      )
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new DomainError('INTERNAL', 500, 'Failed to save member signature');
    }

    ctx.audit({
      memberSignatureId: row.id,
      kind: row.kind,
      signatureKind: row.signature_kind,
      imageSha256,
    });

    return {
      id: row.id,
      kind: row.kind,
      signatureKind: row.signature_kind,
      imageSha256: row.image_sha256,
      widthPx: row.width_px,
      heightPx: row.height_px,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  },
});

export const memberSignatureDelete = defineCommand({
  name: 'sign.member_signature.delete',
  input: zSignMemberSignatureDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [tableWrite(signManifest.tables, 'ludy_sign', 'member_signature', ['id'])],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const deletedRow = await ctx.trx
      .deleteFrom('ludy_sign.member_signature')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('kind', '=', input.kind)
      .returning(['id'])
      .executeTakeFirst();

    ctx.audit({
      kind: input.kind,
      deleted: Boolean(deletedRow),
    });

    return {
      deleted: Boolean(deletedRow),
    };
  },
});

export const orgStampCreate = defineCommand({
  name: 'sign.stamp.create',
  input: zSignOrgStampCreateInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_ADMINS,
  writes: [
    tableWrite(signManifest.tables, 'ludy_sign', 'org_stamp', [
      'org_id',
      'name',
      'stamp_kind',
      'file_id',
      'stamp_png_base64',
      'image_sha256',
      'width_px',
      'height_px',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    const userId = assertOrgStampAdmin(ctx);
    const stampTitle = cleanInlineLabel(input.name, 120);
    const validated = validateSignaturePngBase64(input.stampPngBase64);
    const imageSha256 = createHash('sha256').update(Buffer.from(validated.base64, 'base64')).digest('hex');

    if (input.fileId) {
      const fileRow = await ctx.trx
        .selectFrom('ludy_kernel.file')
        .select(['id', 'content_type', 'size_bytes', 'sha256', 'source'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.fileId)
        .executeTakeFirst();
      if (!fileRow || fileRow.source === 'meeting_audio' || fileRow.source === 'meeting_video') {
        throw new DomainError('SIGN_STAMP_FILE_NOT_FOUND', 404, 'Stamp image file was not found');
      }
      if (
        fileRow.source === 'sign_document' ||
        fileRow.source === 'sign_sealed' ||
        fileRow.source === 'sign_certificate' ||
        fileRow.source === 'sign_attachment'
      ) {
        const { rows } = await sql<{ allowed: boolean }>`
          SELECT ludy_sign.can_read_sign_file(${fileRow.id}::uuid) AS allowed
        `.execute(ctx.trx);
        if (!rows[0]?.allowed) {
          throw new DomainError('SIGN_STAMP_FILE_NOT_FOUND', 404, 'Stamp image file was not found');
        }
      }
      // Reject eSign document/evidence/attachment sources (including unattached non-owner sign_document uploads
      // that remain hidden from org exports and owner kernel.file.get) after 404 confidentiality gating.
      if (
        (fileRow.source !== 'upload' && fileRow.source !== 'social') ||
        fileRow.content_type !== 'image/png' ||
        Number(fileRow.size_bytes) > SIGN_SIGNATURE_PNG_MAX_BYTES ||
        fileRow.sha256 !== imageSha256
      ) {
        throw new DomainError(
          'SIGN_INVALID_SIGNATURE_PNG',
          422,
          'Stamp image file must be a matching PNG <= 256 KB',
        );
      }
    }

    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`sign.stamp.create:${ctx.orgId}`}, 0))`.execute(
      ctx.trx,
    );

    const activeCountRow = await ctx.trx
      .selectFrom('ludy_sign.org_stamp')
      .select((eb) => eb.fn.countAll<string>().as('cnt'))
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (Number(activeCountRow?.cnt ?? 0) >= SIGN_MAX_ORG_STAMPS) {
      throw new DomainError('SIGN_ORG_STAMPS_MAX', 422, `Workspace can have at most ${SIGN_MAX_ORG_STAMPS} active stamps`);
    }

    const existingActive = await ctx.trx
      .selectFrom('ludy_sign.org_stamp')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .where('name', '=', stampTitle)
      .executeTakeFirst();
    if (existingActive) {
      throw new DomainError('SIGN_STAMP_NAME_TAKEN', 409, 'An active organization stamp already uses this name');
    }

    const inserted = await ctx.trx
      .insertInto('ludy_sign.org_stamp')
      .values({
        org_id: ctx.orgId,
        name: stampTitle,
        stamp_kind: input.stampKind,
        file_id: input.fileId ?? null,
        stamp_png_base64: validated.base64,
        image_sha256: imageSha256,
        width_px: validated.width,
        height_px: validated.height,
        status: 'active',
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returningAll()
      .executeTakeFirst();

    if (!inserted) {
      throw new DomainError('INTERNAL', 500, 'Failed to create organization stamp');
    }

    ctx.audit({
      stampId: inserted.id,
      stampKind: inserted.stamp_kind,
      imageSha256,
      hasFile: inserted.file_id !== null,
    });

    return {
      id: inserted.id,
      name: inserted.name,
      stampKind: inserted.stamp_kind,
      fileId: inserted.file_id,
      imageSha256: inserted.image_sha256,
      widthPx: inserted.width_px,
      heightPx: inserted.height_px,
      status: inserted.status,
      createdAt: new Date(inserted.created_at).toISOString(),
      updatedAt: new Date(inserted.updated_at).toISOString(),
    };
  },
});

const stampTarget = (input: { stampId: string }) => ({ type: 'sign.org_stamp', id: input.stampId });

export const orgStampArchive = defineCommand({
  name: 'sign.stamp.archive',
  input: zSignOrgStampArchiveInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: SIGN_ADMINS,
  target: stampTarget,
  writes: [
    tableWrite(signManifest.tables, 'ludy_sign', 'org_stamp', [
      'status',
      'archived_at',
      'archived_by',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input) => {
    const userId = assertOrgStampAdmin(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_sign.org_stamp')
      .select(['id', 'status', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.stampId)
      .forUpdate()
      .executeTakeFirst();

    if (!existing) {
      throw new DomainError('SIGN_STAMP_NOT_FOUND', 404, 'Organization stamp not found');
    }

    if (existing.status === 'archived' && existing.archived_at) {
      return {
        stampId: existing.id,
        status: 'archived' as const,
        archivedAt: new Date(existing.archived_at).toISOString(),
      };
    }

    await ctx.trx
      .updateTable('ludy_sign.org_stamp')
      .set({
        status: 'archived',
        archived_at: ctx.now,
        archived_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      stampId: existing.id,
      status: 'archived',
    });

    return {
      stampId: existing.id,
      status: 'archived' as const,
      archivedAt: ctx.now.toISOString(),
    };
  },
});

export const signProfileQueries = [memberSignatureList, orgStampList];
export const signProfileCommands = [
  memberSignatureUpsert,
  memberSignatureDelete,
  orgStampCreate,
  orgStampArchive,
];
