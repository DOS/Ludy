// SPDX-License-Identifier: AGPL-3.0-only
// Worker handlers and scheduled sweeps for @crove/mod-sign (#3323, ADR-0053).
// Inspect and seal jobs check runtime.appOn(orgId, 'sign', { fresh: true }) (ADR-0053 'work'); expiry and
// cleanup sweeps run across all active orgs (ADR-0053 'keeping') so sent envelopes expire and stale secrets prune when disabled.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { EXTRACT_LIMITS, INPUT_ERROR_CODES, type ExtractClient } from '@crove/extract-contract';
import {
  BlobIntegrityError,
  BlobTooLargeError,
  DomainError,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import {
  DEFAULT_OTP_RETENTION_HOURS,
  DEFAULT_RETENTION_DAYS,
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealInputBytes,
  generateCertificateCode,
  verifyEventChain,
  type SignInspectJobData,
  type SignPreExpirySweepResult,
  type SignSealJobData,
} from '@crove/mod-sign';

export const SIGN_ACTOR = { type: 'system' as const, component: 'sign.worker' };
export const SIGN_EXPIRE_SWEEP_CRON = '*/5 * * * *';
export const SIGN_CLEANUP_CRON = '20 3 * * *';
export const SIGN_JOB_RETRY_LIMIT = 3;
const SWEEP_ORG_BATCH = 100;

export interface SignEnvelopeJob {
  orgId: string;
  envelopeId: string;
}

export interface SignTemplateInspectJob {
  orgId: string;
  targetKind: 'template';
  templateId: string;
}

export type SignPdfInspectJob = SignEnvelopeJob | SignTemplateInspectJob;

export function isSignTemplateInspectJob(job: SignPdfInspectJob): job is SignTemplateInspectJob {
  return 'targetKind' in job && job.targetKind === 'template';
}

export interface SignWorkerDeps {
  workerDb: Db;
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

export type SignSweepDeps = Pick<SignWorkerDeps, 'workerDb' | 'runtime'> & {
  log?: Pick<Console, 'error'>;
  now?: Date;
};

function safeArtifactBase(title: string): string {
  const cleaned = title
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'document';
}

export async function runSignPdfInspectJob(
  deps: SignWorkerDeps,
  job: SignPdfInspectJob,
): Promise<{ status: 'skipped_app_off' | 'skipped_not_pending' | 'passed' | 'failed'; pageCount?: number }> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    return { status: 'skipped_app_off' };
  }

  const isTemplate = isSignTemplateInspectJob(job);
  const targetField = isSignTemplateInspectJob(job) ? { templateId: job.templateId } : { envelopeId: job.envelopeId };
  const queryName = isTemplate ? 'sign.template.inspect_job_data' : 'sign.envelope.inspect_job_data';
  const completeCommand = isTemplate ? 'sign.template.inspect_complete' : 'sign.envelope.inspect_complete';
  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  const data = await deps.runtime.query<SignInspectJobData | null>(queryName, targetField, options);
  const validStatus = isTemplate ? data?.status === 'draft' || data?.status === 'active' : data?.status === 'draft';
  if (!data || !validStatus || data.inspectStatus !== 'pending') {
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
        completeCommand,
        { ...targetField, outcome: 'failed', error: error.message.slice(0, 500) },
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
        completeCommand,
        { ...targetField, outcome: 'failed', error: res.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw new Error(`crove-extract pdf_inspect ${res.code}: ${res.message}`);
  }

  await deps.runtime.execute(
    completeCommand,
    {
      ...targetField,
      outcome: 'passed',
      pageCount: res.pageCount,
      pageDimensions: res.pages.map((p) => ({
        page: p.page,
        widthPt: p.widthPt,
        heightPt: p.heightPt,
        rotation: p.rotation,
      })),
      detectedTags: res.detectedTags ?? [],
    },
    options,
  );
  return { status: 'passed', pageCount: res.pageCount };
}

export async function runSignPdfSealJob(
  deps: SignWorkerDeps,
  job: SignEnvelopeJob,
): Promise<{ status: 'skipped_app_off' | 'skipped' | 'sealed' | 'failed'; certificateCode?: string }> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
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

function sweepErrorLabel(error: unknown): string {
  return error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error';
}

export async function sweepSignExpire(deps: SignSweepDeps): Promise<number> {
  const log = deps.log ?? console;
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.expire_sweep_due_orgs(${SWEEP_ORG_BATCH}) ORDER BY org_id ASC
  `.execute(deps.workerDb);
  let total = 0;
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ expiredCount: number }>(
        'sign.envelope.expire_sweep',
        {},
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      total += res.expiredCount;
    } catch (error) {
      log.error(`[sign-expire-sweep] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return total;
}

export interface SignPreExpirySweepTotals {
  orgs: number;
  envelopes: number;
  remindedSigners: number;
  queuedEmails: number;
  suppressedEmails: number;
}

// ADR-0053 'work': sends at most one 24h pre-expiry reminder email per eligible active email signer
// when org_app_on(org_id, 'sign') is true. Unlike sweepSignExpire ('keeping'), disabled orgs never send mail.
export async function sweepSignPreExpiryReminders(deps: SignSweepDeps): Promise<SignPreExpirySweepTotals> {
  const log = deps.log ?? console;
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id
    FROM crove_sign.pre_expiry_remind_due_orgs(${SWEEP_ORG_BATCH}, ${deps.now ?? null}::timestamptz)
    ORDER BY org_id ASC
  `.execute(deps.workerDb);
  const totals: SignPreExpirySweepTotals = {
    orgs: 0,
    envelopes: 0,
    remindedSigners: 0,
    queuedEmails: 0,
    suppressedEmails: 0,
  };
  for (const row of orgs) {
    try {
      if (!(await deps.runtime.appOn(row.org_id, 'sign', { fresh: true }))) {
        continue;
      }
      const res = await deps.runtime.execute<SignPreExpirySweepResult>(
        'sign.envelope.pre_expiry_remind_sweep',
        deps.now ? { now: deps.now.toISOString() } : {},
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.envelopes += res.envelopesReminded;
      totals.remindedSigners += res.remindedSigners;
      totals.queuedEmails += res.queuedEmails;
      totals.suppressedEmails += res.suppressedEmails;
    } catch (error) {
      log.error(`[sign-pre-expiry-remind] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return totals;
}

export async function sweepSignCleanup(deps: SignSweepDeps): Promise<{
  orgs: number;
  otps: number;
  tokens: number;
  drafts: number;
  draftEvents: number;
}> {
  const log = deps.log ?? console;
  const nowMs = (deps.now ?? new Date()).getTime();
  const otpCutoff = new Date(nowMs - DEFAULT_OTP_RETENTION_HOURS * 3_600_000);
  const tokenCutoff = new Date(nowMs - DEFAULT_RETENTION_DAYS * 86_400_000);
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.cleanup_due_orgs_secrets(${otpCutoff}::timestamptz, ${tokenCutoff}::timestamptz, ${SWEEP_ORG_BATCH}) ORDER BY org_id ASC
  `.execute(deps.workerDb);
  const totals = { orgs: 0, otps: 0, tokens: 0, drafts: 0, draftEvents: 0 };
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ otps: number; tokens: number; drafts: number; draftEvents: number }>(
        'sign.org.cleanup',
        { tokenRetentionDays: DEFAULT_RETENTION_DAYS, otpRetentionHours: DEFAULT_OTP_RETENTION_HOURS },
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.otps += res.otps;
      totals.tokens += res.tokens;
      totals.drafts += res.drafts;
      totals.draftEvents += res.draftEvents;
    } catch (error) {
      log.error(`[sign-cleanup] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return totals;
}

const MAX_RECOVERY_PAGES = 100;

interface RecoveryCursor {
  updatedAt: string;
  orgId: string;
  envelopeId: string;
}

interface TemplateRecoveryCursor {
  updatedAt: string;
  orgId: string;
  templateId: string;
}

async function fetchSignRecoveryPage(
  workerDb: Db,
  olderThan: Date,
  batchSize: number,
  orgId: string | null,
  after: RecoveryCursor | null,
) {
  const { rows } = await sql<{
    work_kind: 'inspect' | 'seal';
    org_id: string;
    envelope_id: string;
    updated_at_cursor: string;
  }>`
    SELECT work_kind, org_id, envelope_id, updated_at::text AS updated_at_cursor
    FROM crove_sign.work_recovery_candidates(
      ${olderThan}::timestamptz,
      ${batchSize},
      ${orgId}::uuid,
      ${after?.updatedAt ?? null}::timestamptz,
      ${after?.orgId ?? null}::uuid,
      ${after?.envelopeId ?? null}::uuid
    )
  `.execute(workerDb);
  return rows;
}

async function fetchTemplateRecoveryPage(
  workerDb: Db,
  olderThan: Date,
  batchSize: number,
  orgId: string | null,
  after: TemplateRecoveryCursor | null,
) {
  const { rows } = await sql<{
    org_id: string;
    template_id: string;
    updated_at_cursor: string;
  }>`
    SELECT org_id, template_id, updated_at::text AS updated_at_cursor
    FROM crove_sign.template_work_recovery_candidates(
      ${olderThan}::timestamptz,
      ${batchSize},
      ${orgId}::uuid,
      ${after?.updatedAt ?? null}::timestamptz,
      ${after?.orgId ?? null}::uuid,
      ${after?.templateId ?? null}::uuid
    )
  `.execute(workerDb);
  return rows;
}

export interface SignPendingWorkDeps {
  workerDb: Db;
  appOn?: (orgId: string) => Promise<boolean>;
  enqueueInspect: (orgId: string, envelopeId: string) => Promise<void>;
  enqueueSeal: (orgId: string, envelopeId: string) => Promise<void>;
  enqueueTemplateInspect?: (orgId: string, templateId: string) => Promise<void>;
  orgId?: string;
  olderThan?: Date;
  batchSize?: number;
  maxPages?: number;
}

export async function sweepSignPendingWork(deps: SignPendingWorkDeps): Promise<{ inspect: number; seal: number }> {
  const olderThan = deps.olderThan ?? new Date(Date.now() - 60_000);
  const batchSize = Math.min(Math.max(Math.trunc(deps.batchSize ?? SWEEP_ORG_BATCH), 1), 500);
  const maxPages = Math.max(Math.trunc(deps.maxPages ?? MAX_RECOVERY_PAGES), 1);
  const enabledCache = new Map<string, boolean>();
  const isEnabled = async (orgId: string) => {
    if (!deps.appOn) return true;
    const cached = enabledCache.get(orgId);
    if (cached !== undefined) return cached;
    const enabled = await deps.appOn(orgId);
    enabledCache.set(orgId, enabled);
    return enabled;
  };
  let inspect = 0;
  let seal = 0;
  let after: RecoveryCursor | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchSignRecoveryPage(deps.workerDb, olderThan, batchSize, deps.orgId ?? null, after);
    for (const row of rows) {
      if (!(await isEnabled(row.org_id))) continue;
      if (row.work_kind === 'inspect') {
        await deps.enqueueInspect(row.org_id, row.envelope_id);
        inspect += 1;
      } else {
        await deps.enqueueSeal(row.org_id, row.envelope_id);
        seal += 1;
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) break;
    after = { updatedAt: last.updated_at_cursor, orgId: last.org_id, envelopeId: last.envelope_id };
  }
  if (deps.enqueueTemplateInspect) {
    let tplAfter: TemplateRecoveryCursor | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const tplRows = await fetchTemplateRecoveryPage(deps.workerDb, olderThan, batchSize, deps.orgId ?? null, tplAfter);
      for (const row of tplRows) {
        if (!(await isEnabled(row.org_id))) continue;
        await deps.enqueueTemplateInspect(row.org_id, row.template_id);
        inspect += 1;
      }
      const last = tplRows.at(-1);
      if (!last || tplRows.length < batchSize) break;
      tplAfter = { updatedAt: last.updated_at_cursor, orgId: last.org_id, templateId: last.template_id };
    }
  }
  return { inspect, seal };
}
