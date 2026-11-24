// SPDX-License-Identifier: AGPL-3.0-only
// Multi-document signing packet commands and AI source query (#4722, Slice 6c).
// Manages 1-5 PDF documents per draft envelope with lazy doc 1 materialization,
// 25 MiB aggregate size ceiling, confidentiality gating, and safe reorder swaps.
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import {
  SIGN_MAX_PACKET_DOCS,
  tableWrite,
  zId,
  zSignEnvelopeDocumentAddInput,
  zSignEnvelopeDocumentRemoveInput,
  zSignEnvelopeDocumentReorderInput,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { isSignAiStoppedOnTrx } from './ai.ts';
import { verifySourceDocxProvenance } from './docx-convert.ts';
import { appendSigningEvent } from './events.ts';
import { assertCanAccessEnvelopeRow } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import {
  assertCanAccessMeetingMinutesEnvelopeRow,
  assertCanActOnMeetingMinutesEnvelope,
} from './meeting-visibility.ts';
import {
  ENVELOPE_VERSION_WRITE,
  SIGNING_EVENT_WRITE,
  SIGN_WRITERS,
  actorLabelOfCtx,
  assertDraftEnvelopeStatus,
  assertSignSourceFileConfidentiality,
  requireSignSourceFile,
  userIdOf,
} from './shared.ts';

function cleanDocumentTitle(rawTitle: string | undefined, fallbackFilename: string): string {
  const raw = (rawTitle ?? '').replace(/[\r\n\t\0]/g, ' ').trim();
  if (raw.length > 0) return raw.slice(0, 300);
  const leaf = fallbackFilename.split(/[\\/]/).pop() ?? '';
  const stripped = leaf.replace(/[\r\n\t\0]/g, ' ').trim();
  return (stripped || 'Tài liệu').slice(0, 300);
}

async function lockDraftEnvelope(ctx: CommandContext, envelopeId: string) {
  const row = await ctx.trx
    .selectFrom('ludy_sign.envelope')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', envelopeId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
  assertCanAccessEnvelopeRow(ctx, row);
  await assertCanAccessMeetingMinutesEnvelopeRow(ctx, row);
  assertCanActOnMeetingMinutesEnvelope(ctx, row, userIdOf(ctx));
  assertDraftEnvelopeStatus(row.status);
  return row;
}

const ENVELOPE_DOCUMENT_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'envelope_document', [
  'org_id',
  'envelope_id',
  'doc_index',
  'title',
  'file_id',
  'storage_key',
  'generation',
  'source_sha256',
  'inspect_status',
  'inspect_error',
  'page_count',
  'page_dimensions_json',
  'detected_tags_json',
  'created_at',
  'updated_at',
]);

export const envelopeDocumentAdd = defineCommand({
  name: 'sign.envelope.document.add',
  input: zSignEnvelopeDocumentAddInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [
    ENVELOPE_DOCUMENT_WRITE,
    tableWrite(signManifest.tables, 'ludy_sign', 'field', ['document_id', 'updated_at']),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await lockDraftEnvelope(ctx, input.envelopeId);

    const file = await requireSignSourceFile(ctx, input.sourceFileId);
    await assertSignSourceFileConfidentiality(ctx, {
      fileId: file.id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      envelopeCreatedAt: row.created_at,
      allowTemplate: true,
    });

    if (input.sourceDocxSha256) {
      await verifySourceDocxProvenance(ctx, input.sourceDocxSha256, file.sha256);
    }

    const existingDocs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document as ed')
      .innerJoin('ludy_kernel.file as f', (join) =>
        join.onRef('f.org_id', '=', 'ed.org_id').onRef('f.id', '=', 'ed.file_id'),
      )
      .select(['ed.id', 'ed.doc_index', 'f.size_bytes'])
      .where('ed.org_id', '=', ctx.orgId)
      .where('ed.envelope_id', '=', row.id)
      .orderBy('ed.doc_index', 'asc')
      .orderBy('ed.id', 'asc')
      .forUpdate('ed')
      .execute();

    let nextIndex: number;
    if (existingDocs.length === 0) {
      const baseFile = await ctx.trx
        .selectFrom('ludy_kernel.file')
        .select(['size_bytes'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.source_file_id)
        .executeTakeFirst();
      const baseBytes = baseFile ? Number(baseFile.size_bytes) : 0;
      if (baseBytes + file.sizeBytes > EXTRACT_LIMITS.maxFileBytes) {
        throw new DomainError(
          'SIGN_PACKET_SIZE_LIMIT',
          422,
          'Total PDF size across packet documents exceeds 25 MiB limit',
        );
      }

      const doc1 = await ctx.trx
        .insertInto('ludy_sign.envelope_document')
        .values({
          org_id: ctx.orgId,
          envelope_id: row.id,
          doc_index: 1,
          title: row.title,
          file_id: row.source_file_id,
          storage_key: row.source_storage_key,
          generation: row.source_generation,
          source_sha256: row.source_sha256,
          inspect_status: row.inspect_status,
          inspect_error: row.inspect_error,
          page_count: row.page_count,
          page_dimensions_json:
            row.page_dimensions_json === null ? null : JSON.stringify(row.page_dimensions_json),
          detected_tags_json:
            row.detected_tags_json === null ? null : JSON.stringify(row.detected_tags_json),
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await ctx.trx
        .updateTable('ludy_sign.field')
        .set({ document_id: doc1.id, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', row.id)
        .where('document_id', 'is', null)
        .execute();

      nextIndex = 2;
    } else {
      if (existingDocs.length >= SIGN_MAX_PACKET_DOCS) {
        throw new DomainError(
          'SIGN_PACKET_DOC_LIMIT',
          422,
          `A signing packet can contain at most ${SIGN_MAX_PACKET_DOCS} PDF documents`,
        );
      }
      const existingBytes = existingDocs.reduce((acc, doc) => acc + Number(doc.size_bytes), 0);
      if (existingBytes + file.sizeBytes > EXTRACT_LIMITS.maxFileBytes) {
        throw new DomainError(
          'SIGN_PACKET_SIZE_LIMIT',
          422,
          'Total PDF size across packet documents exceeds 25 MiB limit',
        );
      }
      // Normalize indices if any non-contiguous gap existed before adding next document.
      nextIndex = existingDocs.length + 1;
    }

    const docTitle = cleanDocumentTitle(input.title, file.filename);
    const inserted = await ctx.trx
      .insertInto('ludy_sign.envelope_document')
      .values({
        org_id: ctx.orgId,
        envelope_id: row.id,
        doc_index: nextIndex,
        title: docTitle,
        file_id: file.id,
        storage_key: file.storage_key,
        generation: file.generation,
        source_sha256: file.sha256,
        inspect_status: 'pending',
        inspect_error: null,
        page_count: null,
        page_dimensions_json: null,
        detected_tags_json: null,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'doc_index', 'title'])
      .executeTakeFirstOrThrow();

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('ludy_sign.envelope')
      .set({ version: nextVersion, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'document_added',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOfCtx(ctx),
      documentSha256: file.sha256,
      payloadJson: {
        documentId: inserted.id,
        docIndex: inserted.doc_index,
        title: inserted.title,
        fileId: file.id,
      },
      occurredAt: ctx.now,
    });

    await ctx.emit('sign.envelope.document_inspect_queued', {
      envelopeId: row.id,
      documentId: inserted.id,
    });

    ctx.audit({
      envelopeId: row.id,
      documentId: inserted.id,
      docIndex: inserted.doc_index,
      fileId: file.id,
    });

    return {
      envelopeId: row.id,
      documentId: inserted.id,
      docIndex: inserted.doc_index,
      version: nextVersion,
    };
  },
});

export const envelopeDocumentRemove = defineCommand({
  name: 'sign.envelope.document.remove',
  input: zSignEnvelopeDocumentRemoveInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [
    tableWrite(signManifest.tables, 'ludy_sign', 'field', ['id']),
    tableWrite(signManifest.tables, 'ludy_sign', 'envelope_document', ['id', 'doc_index', 'updated_at']),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await lockDraftEnvelope(ctx, input.envelopeId);

    const existingDocs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['id', 'doc_index', 'title', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const target = existingDocs.find((d) => d.id === input.documentId);
    if (!target) {
      throw new DomainError('SIGN_DOCUMENT_NOT_FOUND', 404, 'Packet document not found');
    }
    if (existingDocs.length <= 1) {
      throw new DomainError('SIGN_PACKET_MIN_DOCS', 409, 'A signing packet must keep at least 1 document');
    }

    await ctx.trx
      .deleteFrom('ludy_sign.field')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('document_id', '=', target.id)
      .execute();

    await ctx.trx
      .deleteFrom('ludy_sign.envelope_document')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .where('id', '=', target.id)
      .execute();

    const remaining = existingDocs.filter((d) => d.id !== target.id);
    await sql`SET CONSTRAINTS ludy_sign.envelope_document_envelope_index_uq DEFERRED`.execute(ctx.trx);
    for (let idx = 0; idx < remaining.length; idx++) {
      const doc = remaining[idx]!;
      const desiredIndex = idx + 1;
      if (doc.doc_index !== desiredIndex) {
        await ctx.trx
          .updateTable('ludy_sign.envelope_document')
          .set({ doc_index: desiredIndex, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', doc.id)
          .execute();
      }
    }
    await sql`SET CONSTRAINTS ludy_sign.envelope_document_envelope_index_uq IMMEDIATE`.execute(ctx.trx);

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('ludy_sign.envelope')
      .set({ version: nextVersion, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'document_removed',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOfCtx(ctx),
      documentSha256: target.source_sha256,
      payloadJson: {
        documentId: target.id,
        removedDocIndex: target.doc_index,
      },
      occurredAt: ctx.now,
    });

    ctx.audit({ envelopeId: row.id, removedDocumentId: target.id, remainingCount: remaining.length });
    return {
      envelopeId: row.id,
      removedDocumentId: target.id,
      version: nextVersion,
    };
  },
});

export const envelopeDocumentReorder = defineCommand({
  name: 'sign.envelope.document.reorder',
  input: zSignEnvelopeDocumentReorderInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [
    tableWrite(signManifest.tables, 'ludy_sign', 'envelope_document', ['doc_index', 'updated_at']),
    ENVELOPE_VERSION_WRITE,
    SIGNING_EVENT_WRITE,
  ],
  handler: async (ctx, input) => {
    const userId = userIdOf(ctx);
    const row = await lockDraftEnvelope(ctx, input.envelopeId);

    const existingDocs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['id', 'doc_index'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', row.id)
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const uniqueIds = new Set(input.documentIds);
    if (
      uniqueIds.size !== input.documentIds.length ||
      uniqueIds.size !== existingDocs.length ||
      !existingDocs.every((d) => uniqueIds.has(d.id))
    ) {
      throw new DomainError(
        'SIGN_INVALID_DOCUMENT_ORDER',
        422,
        'documentIds must list every document in the packet exactly once',
      );
    }

    await sql`SET CONSTRAINTS ludy_sign.envelope_document_envelope_index_uq DEFERRED`.execute(ctx.trx);
    for (let idx = 0; idx < input.documentIds.length; idx++) {
      const docId = input.documentIds[idx]!;
      await ctx.trx
        .updateTable('ludy_sign.envelope_document')
        .set({ doc_index: idx + 1, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', docId)
        .execute();
    }
    await sql`SET CONSTRAINTS ludy_sign.envelope_document_envelope_index_uq IMMEDIATE`.execute(ctx.trx);

    const nextVersion = row.version + 1;
    await ctx.trx
      .updateTable('ludy_sign.envelope')
      .set({ version: nextVersion, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();

    await appendSigningEvent(ctx.trx, {
      orgId: ctx.orgId,
      envelopeId: row.id,
      eventType: 'documents_reordered',
      actorType: 'user',
      actorId: userId,
      actorLabel: actorLabelOfCtx(ctx),
      documentSha256: row.source_sha256,
      payloadJson: { documentIds: input.documentIds },
      occurredAt: ctx.now,
    });

    ctx.audit({ envelopeId: row.id, count: input.documentIds.length });
    return {
      envelopeId: row.id,
      documentIds: input.documentIds,
      version: nextVersion,
    };
  },
});

export interface SignPacketConsistencySource {
  envelopeId: string;
  title: string;
  status: string;
  inspectStatus: string;
  aiStopped: boolean;
  documents: Array<{
    id: string | null;
    docIndex: number;
    title: string;
    storageKey: string;
    generation: string;
    sourceSha256: string;
    inspectStatus: string;
    pageCount: number | null;
  }>;
  signers: Array<{
    id: string;
    roleLabel: string;
    signerRole: string;
  }>;
  fields: Array<{
    id: string;
    documentId: string | null;
    signerId: string;
    fieldType: string;
  }>;
}

export const packetConsistencySource = defineQuery({
  name: 'sign.packet.consistency_source',
  input: z.strictObject({ envelopeId: zId }),
  access: SIGN_WRITERS,
  handler: async (ctx: QueryContext, input): Promise<SignPacketConsistencySource> => {
    if (ctx.actor.type !== 'user' && ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Workspace user or system context required');
    }
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'title',
        'status',
        'source_kind',
        'source_id',
        'source_storage_key',
        'source_generation',
        'source_sha256',
        'inspect_status',
        'page_count',
        'created_by',
        'retained_org_visible',
        'retained_reader_ids',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    if (ctx.actor.type === 'user') {
      assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
      await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');
    }

    const docs = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['id', 'doc_index', 'title', 'storage_key', 'generation', 'source_sha256', 'inspect_status', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const signers = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['id', 'role_label', 'signer_role'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const fields = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select(['id', 'document_id', 'signer_id', 'field_type'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .execute();

    const resolvedDocs =
      docs.length > 0
        ? docs.map((d) => ({
            id: d.id,
            docIndex: d.doc_index,
            title: d.title,
            storageKey: d.storage_key,
            generation: d.generation,
            sourceSha256: d.source_sha256,
            inspectStatus: d.inspect_status,
            pageCount: d.page_count,
          }))
        : [
            {
              id: null,
              docIndex: 1,
              title: env.title,
              storageKey: env.source_storage_key,
              generation: env.source_generation,
              sourceSha256: env.source_sha256,
              inspectStatus: env.inspect_status,
              pageCount: env.page_count,
            },
          ];

    return {
      envelopeId: env.id,
      title: env.title,
      status: env.status,
      inspectStatus: env.inspect_status,
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
      documents: resolvedDocs,
      signers: signers.map((s) => ({
        id: s.id,
        roleLabel: s.role_label,
        signerRole: s.signer_role,
      })),
      fields: fields.map((f) => ({
        id: f.id,
        documentId: f.document_id ?? null,
        signerId: f.signer_id,
        fieldType: f.field_type,
      })),
    };
  },
});

export const signEnvelopeDocumentCommands = [
  envelopeDocumentAdd,
  envelopeDocumentRemove,
  envelopeDocumentReorder,
];

export const signEnvelopeDocumentQueries = [packetConsistencySource];
