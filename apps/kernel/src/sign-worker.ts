// SPDX-License-Identifier: AGPL-3.0-only
// Worker handlers and scheduled sweeps for @crove/mod-sign (#3323, ADR-0053).
// Inspect and seal jobs check crove_kernel.org_app_on(orgId, 'sign') (ADR-0053 'work'); expiry and cleanup sweeps
// run across all active orgs (ADR-0053 'keeping') so sent envelopes expire and stale secrets prune when disabled.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { EXTRACT_LIMITS, INPUT_ERROR_CODES, type ExtractClient } from '@crove/extract-contract';
import {
  BlobIntegrityError,
  BlobTooLargeError,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import {
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealInputBytes,
  generateCertificateCode,
  verifyEventChain,
  type SignInspectJobData,
  type SignSealJobData,
} from '@crove/mod-sign';

export const SIGN_ACTOR = { type: 'system' as const, component: 'sign.worker' };
export const SIGN_EXPIRE_SWEEP_CRON = '*/5 * * * *';
export const SIGN_CLEANUP_CRON = '20 3 * * *';
export const SIGN_JOB_RETRY_LIMIT = 3;
const SWEEP_ORG_BATCH = 100;
const RETENTION_DAYS = 90;

export interface SignEnvelopeJob {
  orgId: string;
  envelopeId: string;
}

export interface SignWorkerDeps {
  workerDb: Db;
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

export type SignSweepDeps = Pick<SignWorkerDeps, 'workerDb' | 'runtime'>;

async function isSignAppEnabled(db: Db, orgId: string): Promise<boolean> {
  const { rows } = await sql<{ enabled: boolean }>`
    SELECT crove_kernel.org_app_on(${orgId}::uuid, 'sign') AS enabled
  `.execute(db);
  return rows[0]?.enabled === true;
}

function safeArtifactBase(title: string): string {
  const cleaned = title
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'document';
}

export async function runSignPdfInspectJob(
  deps: SignWorkerDeps,
  job: SignEnvelopeJob,
): Promise<{ status: 'skipped_app_off' | 'skipped_not_pending' | 'passed' | 'failed'; pageCount?: number }> {
  if (!(await isSignAppEnabled(deps.workerDb, job.orgId))) {
    return { status: 'skipped_app_off' };
  }

  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  const data = await deps.runtime.query<SignInspectJobData | null>(
    'sign.envelope.inspect_job_data',
    { envelopeId: job.envelopeId },
    options,
  );
  if (!data || data.inspectStatus !== 'pending') {
    return { status: 'skipped_not_pending' };
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await readVerified(
      deps.store,
      { key: data.sourceStorageKey, generation: data.sourceGeneration, sha256: data.sourceSha256 },
      EXTRACT_LIMITS.maxFileBytes,
    );
  } catch (error) {
    if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
      await deps.runtime.execute(
        'sign.envelope.inspect_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: error.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw error;
  }

  const res = await deps.extract.extract('pdf_inspect', pdfBytes);
  if (!res.ok) {
    if (INPUT_ERROR_CODES.includes(res.code)) {
      await deps.runtime.execute(
        'sign.envelope.inspect_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: res.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw new Error(`crove-extract pdf_inspect ${res.code}: ${res.message}`);
  }

  await deps.runtime.execute(
    'sign.envelope.inspect_complete',
    {
      envelopeId: job.envelopeId,
      outcome: 'passed',
      pageCount: res.pageCount,
      pageDimensions: res.pages.map((p) => ({
        page: p.page,
        widthPt: p.widthPt,
        heightPt: p.heightPt,
        rotation: p.rotation,
      })),
    },
    options,
  );
  return { status: 'passed', pageCount: res.pageCount };
}

export async function runSignPdfSealJob(
  deps: SignWorkerDeps,
  job: SignEnvelopeJob,
): Promise<{ status: 'skipped_app_off' | 'skipped' | 'sealed' | 'failed'; certificateCode?: string }> {
  if (!(await isSignAppEnabled(deps.workerDb, job.orgId))) {
    return { status: 'skipped_app_off' };
  }

  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  const data = await deps.runtime.query<SignSealJobData | null>(
    'sign.envelope.seal_job_data',
    { envelopeId: job.envelopeId },
    options,
  );
  if (!data) return { status: 'skipped' };

  const { envelope, signers, fields, events } = data;
  if (envelope.status !== 'completed' || envelope.sealStatus === 'sealed' || envelope.pageCount === null) {
    return { status: 'skipped' };
  }

  const chain = verifyEventChain(events);
  if (!chain.valid || !chain.tipHash) {
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: job.envelopeId,
        outcome: 'failed',
        error: (chain.reason ?? 'Event hash chain verification failed before sealing').slice(0, 500),
      },
      options,
    );
    return { status: 'failed' };
  }

  let sourcePdfBytes: Uint8Array;
  try {
    sourcePdfBytes = await readVerified(
      deps.store,
      {
        key: envelope.sourceStorageKey,
        generation: envelope.sourceGeneration,
        sha256: envelope.sourceSha256,
      },
      EXTRACT_LIMITS.maxFileBytes,
    );
  } catch (error) {
    if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
      await deps.runtime.execute(
        'sign.envelope.seal_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: error.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw error;
  }

  if (!envelope.completedAtIso) {
    throw new Error(`Completed envelope ${envelope.id} is missing completed_at timestamp`);
  }
  const completedAtIso = envelope.completedAtIso;
  const certificateCode = generateCertificateCode(envelope.id, completedAtIso, chain.tipHash);

  let certificate;
  let sealInputBytes: Uint8Array;
  try {
    certificate = buildPdfSealCertificate({
      certificateCode,
      envelopeTitle: envelope.title,
      sourceSha256: envelope.sourceSha256,
      completedAtIso,
      eventChainTipHash: chain.tipHash,
      signers,
    });
    sealInputBytes = buildPdfSealInputBytes({
      sourcePdfBytes,
      pageCount: envelope.pageCount,
      fields,
      certificate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid seal payload';
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      { envelopeId: job.envelopeId, outcome: 'failed', error: message.slice(0, 500) },
      options,
    );
    return { status: 'failed' };
  }

  const res = await deps.extract.extract('pdf_seal', sealInputBytes);
  if (!res.ok) {
    if (INPUT_ERROR_CODES.includes(res.code)) {
      await deps.runtime.execute(
        'sign.envelope.seal_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: res.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw new Error(`crove-extract pdf_seal ${res.code}: ${res.message}`);
  }

  const sealedBytes = Buffer.from(res.sealedPdfBase64, 'base64');
  if (sealedBytes.byteLength === 0) {
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      { envelopeId: job.envelopeId, outcome: 'failed', error: 'pdf_seal returned empty PDF bytes' },
      options,
    );
    return { status: 'failed' };
  }

  const sealedSha256 = sha256Hex(sealedBytes);
  const sealedStorageKey = fileKey(job.orgId, sealedSha256);
  const sealedGeneration = await putFile(deps.store, sealedStorageKey, sealedBytes, 'application/pdf', sealedSha256);

  const certArtifact = buildCanonicalCertificateArtifact({
    envelopeId: envelope.id,
    orgId: job.orgId,
    certificateCode,
    envelopeTitle: envelope.title,
    sourceSha256: envelope.sourceSha256,
    sealedSha256,
    completedAtIso,
    eventChainTipHash: chain.tipHash,
    signers: certificate.signers,
    events: events.map((ev) => ({
      seq: ev.seq,
      eventType: ev.event_type,
      signerId: ev.signer_id,
      actorType: ev.actor_type,
      documentSha256: ev.document_sha256,
      prevEventHash: ev.prev_event_hash,
      eventHash: ev.event_hash,
      occurredAtIso: new Date(ev.occurred_at).toISOString(),
    })),
  });

  const certStorageKey = fileKey(job.orgId, certArtifact.sha256);
  const certGeneration = await putFile(
    deps.store,
    certStorageKey,
    certArtifact.bytes,
    'application/json',
    certArtifact.sha256,
  );

  const base = safeArtifactBase(envelope.title);
  const sealedIngest = await deps.runtime.execute<{ fileId: string }>(
    'kernel.file.ingest',
    {
      filename: `${base}-signed.pdf`,
      contentType: 'application/pdf',
      sizeBytes: sealedBytes.byteLength,
      sha256: sealedSha256,
      storageKey: sealedStorageKey,
      generation: sealedGeneration,
      source: 'sign_sealed',
    },
    options,
  );
  const certIngest = await deps.runtime.execute<{ fileId: string }>(
    'kernel.file.ingest',
    {
      filename: `${base}-certificate.json`,
      contentType: 'application/json',
      sizeBytes: certArtifact.bytes.byteLength,
      sha256: certArtifact.sha256,
      storageKey: certStorageKey,
      generation: certGeneration,
      source: 'sign_certificate',
    },
    options,
  );
  await deps.runtime.execute(
    'sign.envelope.seal_complete',
    {
      envelopeId: job.envelopeId,
      outcome: 'sealed',
      certificateCode,
      sealedFileId: sealedIngest.fileId,
      certificateFileId: certIngest.fileId,
    },
    options,
  );

  return { status: 'sealed', certificateCode };
}

export async function sweepSignExpire(deps: SignSweepDeps): Promise<number> {
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.expire_sweep_due_orgs(${SWEEP_ORG_BATCH})
  `.execute(deps.workerDb);
  let total = 0;
  for (const row of orgs) {
    const res = await deps.runtime.execute<{ expiredCount: number }>(
      'sign.envelope.expire_sweep',
      {},
      { actor: SIGN_ACTOR, orgId: row.org_id },
    );
    total += res.expiredCount;
  }
  return total;
}

export async function sweepSignCleanup(deps: SignSweepDeps): Promise<{
  orgs: number;
  otps: number;
  tokens: number;
  drafts: number;
  draftEvents: number;
}> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.cleanup_due_orgs(${cutoff}::timestamptz, ${cutoff}::timestamptz, ${SWEEP_ORG_BATCH})
  `.execute(deps.workerDb);
  const totals = { orgs: 0, otps: 0, tokens: 0, drafts: 0, draftEvents: 0 };
  for (const row of orgs) {
    const res = await deps.runtime.execute<{ otps: number; tokens: number; drafts: number; draftEvents: number }>(
      'sign.org.cleanup',
      { draftRetentionDays: RETENTION_DAYS, secretRetentionDays: RETENTION_DAYS },
      { actor: SIGN_ACTOR, orgId: row.org_id },
    );
    totals.orgs += 1;
    totals.otps += res.otps;
    totals.tokens += res.tokens;
    totals.drafts += res.drafts;
    totals.draftEvents += res.draftEvents;
  }
  return totals;
}

export interface SignPendingWorkDeps {
  workerDb: Db;
  enqueueInspect: (orgId: string, envelopeId: string) => Promise<void>;
  enqueueSeal: (orgId: string, envelopeId: string) => Promise<void>;
  orgId?: string;
  olderThan?: Date;
}

export async function sweepSignPendingWork(deps: SignPendingWorkDeps): Promise<{ inspect: number; seal: number }> {
  const olderThan = deps.olderThan ?? new Date(Date.now() - 60_000);
  const { rows } = await sql<{ work_kind: 'inspect' | 'seal'; org_id: string; envelope_id: string }>`
    SELECT work_kind, org_id, envelope_id
    FROM crove_sign.work_recovery_candidates(${olderThan}::timestamptz, ${SWEEP_ORG_BATCH}, ${deps.orgId ?? null}::uuid)
  `.execute(deps.workerDb);
  let inspect = 0;
  let seal = 0;
  for (const row of rows) {
    if (row.work_kind === 'inspect') {
      await deps.enqueueInspect(row.org_id, row.envelope_id);
      inspect += 1;
    } else {
      await deps.enqueueSeal(row.org_id, row.envelope_id);
      seal += 1;
    }
  }
  return { inspect, seal };
}
